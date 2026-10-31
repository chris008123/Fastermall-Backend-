<<<<<<< HEAD
import { NotFoundException } from '@nestjs/common';
import { NotificationsService } from './notifications.service';

function setup() {
  const prisma: any = {
    notification: { updateMany: jest.fn(), findFirst: jest.fn() },
  };
  return { svc: new NotificationsService(prisma), prisma };
}

describe('NotificationsService.markRead', () => {
  it('marks only the caller\'s own notification', async () => {
    const { svc, prisma } = setup();
    prisma.notification.updateMany.mockResolvedValue({ count: 1 });
    prisma.notification.findFirst.mockResolvedValue({ id: 'n1', isRead: true });

    await svc.markRead('u1', 'n1');

    expect(prisma.notification.updateMany).toHaveBeenCalledWith({
      where: { id: 'n1', userId: 'u1' },
      data: { isRead: true },
    });
  });

  it("says 'not found' for someone else's notification and returns nothing from it", async () => {
    const { svc, prisma } = setup();
    prisma.notification.updateMany.mockResolvedValue({ count: 0 });

    await expect(svc.markRead('attacker', 'n1')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.notification.findFirst).not.toHaveBeenCalled();
=======
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
        where: { isAvailable: true },
        select: { staffUserId: true },
      });
      expect(prisma.notification.createMany.mock.calls[0][0].data).toHaveLength(2);
      expect(push.sendToOwners).toHaveBeenCalledWith(
        { staffUserIds: ['s1', 's2'] },
        expect.objectContaining({ data: expect.objectContaining({ type: 'DELIVERY_AVAILABLE', deliveryId: 'd1' }) }),
      );
    });

    it('does not break the event when the database write fails', async () => {
      prisma.notification.create.mockRejectedValue(new Error('db down'));
      await expect(
        events.emitAsync('order.created', { id: 'abcdef1234', customerId: 'c1' }),
      ).resolves.toBeDefined();
    });
>>>>>>> 8cc658926c7d41e19e8b66cee7d6673a28dec153
  });
});
