import { NotFoundException, BadRequestException } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../../database/prisma.service';
import { NotificationsService } from './notifications.service';
import { PushService } from './push.service';

const TOKEN = 'ExponentPushToken[abcdefghijklmnopqrstuv]';
const customer = { userId: 'c1', role: 'CUSTOMER' };
const partner = { userId: 's1', role: 'DELIVERY_PARTNER' };

describe('NotificationsService', () => {
  let svc: NotificationsService;
  let events: EventEmitter2;
  let prisma: any;
  let push: { sendToOwners: jest.Mock };

  beforeEach(async () => {
    prisma = {
      notification: {
        create: jest.fn().mockResolvedValue({}),
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn(),
        findUnique: jest.fn(),
        count: jest.fn().mockResolvedValue(0),
        deleteMany: jest.fn(),
      },
      device: {
        upsert: jest.fn().mockImplementation(({ create }) => Promise.resolve({ id: 'd1', ...create })),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      deliveryPartnerProfile: { findMany: jest.fn().mockResolvedValue([]) },
      delivery: { findUnique: jest.fn().mockResolvedValue({ order: { type: 'FOOD' } }) },
      order: { findUnique: jest.fn() },
      laundryOrder: { findUnique: jest.fn() },
    };
    push = { sendToOwners: jest.fn().mockResolvedValue(undefined) };

    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ ignoreEnvFile: true }), EventEmitterModule.forRoot()],
      providers: [
        NotificationsService,
        { provide: PrismaService, useValue: prisma },
        { provide: PushService, useValue: push },
      ],
    }).compile();
    await moduleRef.init();

    svc = moduleRef.get(NotificationsService);
    events = moduleRef.get(EventEmitter2);
  });

  describe('reading', () => {
    it('lists customer notifications by userId and staff notifications by staffUserId', async () => {
      await svc.findMine(customer);
      expect(prisma.notification.findMany.mock.calls[0][0].where).toEqual({ userId: 'c1' });
      await svc.findMine(partner);
      expect(prisma.notification.findMany.mock.calls[1][0].where).toEqual({ staffUserId: 's1' });
    });

    it("refuses to mark someone else's notification as read", async () => {
      prisma.notification.updateMany.mockResolvedValue({ count: 0 });
      await expect(svc.markRead('n1', customer)).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.notification.updateMany).toHaveBeenCalledWith({
        where: { id: 'n1', userId: 'c1' },
        data: { isRead: true },
      });
    });

    it('marks an owned notification as read', async () => {
      prisma.notification.updateMany.mockResolvedValue({ count: 1 });
      prisma.notification.findUnique.mockResolvedValue({ id: 'n1', isRead: true });
      await expect(svc.markRead('n1', partner)).resolves.toEqual({ id: 'n1', isRead: true });
      expect(prisma.notification.updateMany.mock.calls[0][0].where).toEqual({ id: 'n1', staffUserId: 's1' });
    });
  });

  describe('devices', () => {
    it('rejects tokens that are not Expo push tokens', async () => {
      await expect(svc.registerDevice(customer, { token: 'abc' })).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.device.upsert).not.toHaveBeenCalled();
    });

    it('registers a customer device and a staff device under the right owner', async () => {
      await svc.registerDevice(customer, { token: TOKEN, platform: 'android' });
      expect(prisma.device.upsert.mock.calls[0][0].create).toMatchObject({ userId: 'c1', staffUserId: null, platform: 'android' });

      await svc.registerDevice(partner, { token: TOKEN, platform: 'ios' });
      expect(prisma.device.upsert.mock.calls[1][0].update).toMatchObject({ userId: null, staffUserId: 's1' });
    });

    it('removes the previous token only for the same owner when a token rotates', async () => {
      const old = 'ExponentPushToken[zzzzzzzzzzzzzzzzzzzzzz]';
      await svc.registerDevice(customer, { token: TOKEN, previousToken: old });
      expect(prisma.device.deleteMany).toHaveBeenCalledWith({ where: { token: old, userId: 'c1' } });
    });

    it('only deletes a token owned by the caller on logout', async () => {
      await expect(svc.removeDevice(customer, TOKEN)).resolves.toEqual({ removed: 1 });
      expect(prisma.device.deleteMany).toHaveBeenCalledWith({ where: { token: TOKEN, userId: 'c1' } });
    });
  });

  describe('event wiring', () => {
    const flush = () => new Promise((r) => setImmediate(r));

    it('stores and pushes a customer notification when a delivery moves', async () => {
      await events.emitAsync('delivery.status.updated', {
        deliveryId: 'd1',
        status: 'PICKED_UP',
        customerId: 'c1',
        orderId: 'o1',
      });
      expect(prisma.notification.create.mock.calls[0][0].data).toMatchObject({
        userId: 'c1',
        type: 'DELIVERY_STATUS_UPDATED',
        data: { deliveryId: 'd1', orderId: 'o1', status: 'PICKED_UP' },
      });
      expect(push.sendToOwners).toHaveBeenCalledWith(
        { userIds: ['c1'] },
        expect.objectContaining({ data: expect.objectContaining({ type: 'DELIVERY_STATUS_UPDATED', orderId: 'o1' }) }),
      );
    });

    it('stays quiet for delivery statuses the customer does not need', async () => {
      await events.emitAsync('delivery.status.updated', { deliveryId: 'd1', status: 'FAILED', customerId: 'c1' });
      expect(prisma.notification.create).not.toHaveBeenCalled();
      expect(push.sendToOwners).not.toHaveBeenCalled();
    });

    it('notifies customers when an order status changes', async () => {
      await events.emitAsync('order.status.updated', { id: 'abcdef1234', customerId: 'c1', status: 'OUT_FOR_DELIVERY' });
      expect(prisma.notification.create.mock.calls[0][0].data.body).toContain('out for delivery');
    });

    it('never alerts partners about marketplace or laundry deliveries', async () => {
      prisma.deliveryPartnerProfile.findMany.mockResolvedValue([{ staffUserId: 's1' }]);

      prisma.delivery.findUnique.mockResolvedValue({ order: { type: 'MARKETPLACE' } });
      await events.emitAsync('delivery.created', { deliveryId: 'd1', orderId: 'o1' });

      prisma.delivery.findUnique.mockResolvedValue({ order: null }); // laundry delivery
      await events.emitAsync('delivery.created', { deliveryId: 'd2', laundryOrderId: 'l1' });
      await flush();

      expect(prisma.notification.createMany).not.toHaveBeenCalled();
      expect(push.sendToOwners).not.toHaveBeenCalled();
    });

    it('pushes a new food delivery only to available partners', async () => {
      prisma.deliveryPartnerProfile.findMany.mockResolvedValue([{ staffUserId: 's1' }, { staffUserId: 's2' }]);
      await events.emitAsync('delivery.created', { deliveryId: 'd1', orderId: 'o1' });
      await flush();
      expect(prisma.deliveryPartnerProfile.findMany).toHaveBeenCalledWith({
        where: { isAvailable: true, staffUser: { isActive: true } },
        select: { staffUserId: true, preferences: true },
      });
      expect(prisma.notification.createMany.mock.calls[0][0].data).toHaveLength(2);
      expect(push.sendToOwners).toHaveBeenCalledWith(
        { staffUserIds: ['s1', 's2'] },
        expect.objectContaining({ data: expect.objectContaining({ type: 'DELIVERY_AVAILABLE', deliveryId: 'd1', jobId: 'd1' }) }),
      );
    });

    it('respects partner settings: no push when new-job alerts are off, silent push when sound is off', async () => {
      prisma.deliveryPartnerProfile.findMany.mockResolvedValue([
        { staffUserId: 's1', preferences: null },
        { staffUserId: 's2', preferences: { notifications: { newJobs: false } } },
        { staffUserId: 's3', preferences: { notifications: { sound: false } } },
      ]);
      await events.emitAsync('delivery.created', { deliveryId: 'd1', orderId: 'o1' });
      await flush();
      // everyone still gets the in-app notification
      expect(prisma.notification.createMany.mock.calls[0][0].data).toHaveLength(3);
      expect(push.sendToOwners).toHaveBeenCalledTimes(2);
      expect(push.sendToOwners).toHaveBeenCalledWith({ staffUserIds: ['s1'] }, expect.not.objectContaining({ sound: false }));
      expect(push.sendToOwners).toHaveBeenCalledWith({ staffUserIds: ['s3'] }, expect.objectContaining({ sound: false }));
      const all = push.sendToOwners.mock.calls.flatMap((c: any) => c[0].staffUserIds);
      expect(all).not.toContain('s2');
    });

    it('does not break the event when the database write fails', async () => {
      prisma.notification.create.mockRejectedValue(new Error('db down'));
      await expect(
        events.emitAsync('order.created', { id: 'abcdef1234', customerId: 'c1' }),
      ).resolves.toBeDefined();
    });
  });

  describe('reading, unread and cleanup', () => {
    it('stays a plain array without paging, and pages with a limit', async () => {
      prisma.notification.findMany.mockResolvedValue([{ id: 'n1', createdAt: new Date() }]);
      expect(Array.isArray(await svc.findMine(customer))).toBe(true);
      const at = new Date('2026-10-24T10:00:00Z');
      prisma.notification.findMany.mockResolvedValue([{ id: 'n3', createdAt: at }, { id: 'n2', createdAt: at }]);
      const page: any = await svc.findMine(customer, { limit: 1 });
      expect(prisma.notification.findMany.mock.calls.at(-1)[0].take).toBe(2);
      expect(page.items).toHaveLength(1);
      expect(page.nextCursor).toEqual(expect.any(String));
    });

    it('filters to unread only', async () => {
      await svc.findMine(partner, { unread: true });
      expect(prisma.notification.findMany.mock.calls.at(-1)[0].where).toEqual({ staffUserId: 's1', isRead: false });
    });

    it('counts unread for the owner only', async () => {
      prisma.notification.count.mockResolvedValue(4);
      await expect(svc.unreadCount(partner)).resolves.toEqual({ unread: 4 });
      expect(prisma.notification.count).toHaveBeenCalledWith({ where: { staffUserId: 's1', isRead: false } });
    });

    it('can mark one notification unread again', async () => {
      prisma.notification.updateMany.mockResolvedValue({ count: 1 });
      prisma.notification.findUnique.mockResolvedValue({ id: 'n1', isRead: false });
      await svc.setRead('n1', partner, false);
      expect(prisma.notification.updateMany).toHaveBeenCalledWith({ where: { id: 'n1', staffUserId: 's1' }, data: { isRead: false } });
    });

    it('marks all read for the owner only', async () => {
      prisma.notification.updateMany.mockResolvedValue({ count: 3 });
      await expect(svc.markAllRead(customer)).resolves.toEqual({ updated: 3 });
      expect(prisma.notification.updateMany).toHaveBeenCalledWith({ where: { userId: 'c1', isRead: false }, data: { isRead: true } });
    });

    it('deletes only the owner\'s notification, and 404s for someone else\'s', async () => {
      prisma.notification.deleteMany.mockResolvedValueOnce({ count: 1 });
      await expect(svc.remove('n1', partner)).resolves.toEqual({ removed: true });
      expect(prisma.notification.deleteMany).toHaveBeenCalledWith({ where: { id: 'n1', staffUserId: 's1' } });
      prisma.notification.deleteMany.mockResolvedValueOnce({ count: 0 });
      await expect(svc.remove('n2', partner)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('document review', () => {
    const flush = () => new Promise((r) => setImmediate(r));

    it('tells the partner when a document is approved or rejected, with the reason', async () => {
      await events.emitAsync('partner.document.reviewed', { staffUserId: 's1', documentId: 'doc1', documentLabel: "Driver's licence", status: 'REJECTED', reason: 'Blurry' });
      await flush();
      expect(prisma.notification.create.mock.calls.at(-1)[0].data).toMatchObject({ staffUserId: 's1', type: 'DOCUMENT_REVIEWED', title: 'Document rejected' });
      expect(prisma.notification.create.mock.calls.at(-1)[0].data.body).toContain('Blurry');
      expect(push.sendToOwners).toHaveBeenCalledWith({ staffUserIds: ['s1'] }, expect.objectContaining({ data: expect.objectContaining({ type: 'DOCUMENT_REVIEWED', documentId: 'doc1' }) }));

      await events.emitAsync('partner.document.reviewed', { staffUserId: 's1', documentId: 'doc2', documentLabel: 'ID card', status: 'APPROVED' });
      await flush();
      expect(prisma.notification.create.mock.calls.at(-1)[0].data.title).toBe('Document approved');
    });
  });
});
