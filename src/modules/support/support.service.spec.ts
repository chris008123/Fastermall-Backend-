import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { StaffRole } from '@prisma/client';
import { SupportService } from './support.service';
import { SupportController } from './support.controller';
import { ROLES_KEY } from '../../shared/decorators/roles.decorator';
import { RolesGuard } from '../../shared/guards/roles.guard';

const customer = { userId: 'c1', role: 'CUSTOMER' };
const partner = { userId: 's1', role: 'DELIVERY_PARTNER' };
const admin = { userId: 'a1', role: 'ADMIN' };

describe('SupportService', () => {
  let svc: SupportService;
  let prisma: any;
  let events: { emit: jest.Mock };

  beforeEach(() => {
    prisma = {
      supportTicket: {
        create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 't1', ...data })),
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn().mockReturnValue('update-op'),
      },
      supportTicketReply: { create: jest.fn().mockReturnValue('create-op') },
      delivery: { findUnique: jest.fn() },
      $transaction: jest.fn(),
    };
    events = { emit: jest.fn() };
    svc = new SupportService(prisma, events as unknown as EventEmitter2);
  });

  describe('create', () => {
    it('files a customer ticket under userId and a partner ticket under staffUserId', async () => {
      await svc.create(customer, { subject: 'Hello', message: 'Need help' });
      expect(prisma.supportTicket.create.mock.calls[0][0].data).toMatchObject({ userId: 'c1' });
      expect(prisma.supportTicket.create.mock.calls[0][0].data).not.toHaveProperty('staffUserId');

      await svc.create(partner, { subject: 'Hello', message: 'Need help' });
      expect(prisma.supportTicket.create.mock.calls[1][0].data).toMatchObject({ staffUserId: 's1' });
      expect(prisma.supportTicket.create.mock.calls[1][0].data).not.toHaveProperty('userId');
    });

    it('keeps the "Report a problem" fields', async () => {
      await svc.create(customer, { subject: 'Bad listing', message: 'Wrong photo', targetType: 'LISTING', targetId: 'p1', reason: 'MISLEADING' });
      expect(prisma.supportTicket.create.mock.calls[0][0].data).toMatchObject({ targetType: 'LISTING', targetId: 'p1', reason: 'MISLEADING' });
    });

    it('attaches a delivery the partner is assigned to', async () => {
      prisma.delivery.findUnique.mockResolvedValue({ partner: { staffUserId: 's1' }, order: { customerId: 'c9' }, laundryOrder: null });
      await svc.create(partner, { subject: 'Problem', message: 'Customer not answering', deliveryId: 'd1' });
      expect(prisma.supportTicket.create.mock.calls[0][0].data.deliveryId).toBe('d1');
    });

    it("refuses someone else's delivery, for partners and customers alike (404)", async () => {
      prisma.delivery.findUnique.mockResolvedValue({ partner: { staffUserId: 'other' }, order: { customerId: 'c9' }, laundryOrder: null });
      await expect(svc.create(partner, { subject: 'x y z', message: 'abcde', deliveryId: 'd1' })).rejects.toBeInstanceOf(NotFoundException);
      await expect(svc.create(customer, { subject: 'x y z', message: 'abcde', deliveryId: 'd1' })).rejects.toBeInstanceOf(NotFoundException);
      prisma.delivery.findUnique.mockResolvedValue(null);
      await expect(svc.create(partner, { subject: 'x y z', message: 'abcde', deliveryId: 'nope' })).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.supportTicket.create).not.toHaveBeenCalled();
    });

    it('lets a customer attach their own order delivery, including laundry', async () => {
      prisma.delivery.findUnique.mockResolvedValue({ partner: null, order: null, laundryOrder: { customerId: 'c1' } });
      await expect(svc.create(customer, { subject: 'x y z', message: 'abcde', deliveryId: 'd1' })).resolves.toBeDefined();
    });
  });

  describe('reading', () => {
    it('lists only my own tickets, by the right column', async () => {
      await svc.findMine(customer);
      expect(prisma.supportTicket.findMany.mock.calls[0][0].where).toEqual({ userId: 'c1' });
      await svc.findMine(partner);
      expect(prisma.supportTicket.findMany.mock.calls[1][0].where).toEqual({ staffUserId: 's1' });
    });

    it('opens only my own ticket (404 otherwise), without the owner details', async () => {
      prisma.supportTicket.findFirst.mockResolvedValue(null);
      await expect(svc.findOne('t1', partner)).rejects.toBeInstanceOf(NotFoundException);
      const arg = prisma.supportTicket.findFirst.mock.calls[0][0];
      expect(arg.where).toEqual({ id: 't1', staffUserId: 's1' });
      expect(arg.include.user).toBe(false);
      expect(arg.include.staffUser).toBe(false);
    });

    it('lets an admin open any ticket, with who opened it', async () => {
      prisma.supportTicket.findFirst.mockResolvedValue({ id: 't1', replies: [] });
      await svc.findOne('t1', admin);
      const arg = prisma.supportTicket.findFirst.mock.calls[0][0];
      expect(arg.where).toEqual({ id: 't1' });
      expect(arg.include.user).toBeTruthy();
      expect(arg.include.staffUser).toBeTruthy();
    });

    it('returns the replies as `replies` and `messages`, each with `message` and `body`', async () => {
      prisma.supportTicket.findFirst.mockResolvedValue({ id: 't1', replies: [{ id: 'r1', message: 'Hi', fromAdmin: true }] });
      const out: any = await svc.findOne('t1', customer);
      expect(out.replies).toEqual([{ id: 'r1', message: 'Hi', body: 'Hi', fromAdmin: true }]);
      expect(out.messages).toBe(out.replies);
    });
  });

  describe('reply', () => {
    const ticket = (over: any = {}) => ({ id: 't1', status: 'OPEN', userId: null, staffUserId: 's1', subject: 'Late payout', ...over });
    const saved = (over: any = {}) => ({ id: 'r1', message: 'x', ...over });

    it('records the owner reply without notifying anyone, and reopens a resolved ticket', async () => {
      prisma.supportTicket.findFirst.mockResolvedValue(ticket({ status: 'RESOLVED' }));
      prisma.$transaction.mockResolvedValue([saved({ message: 'Still waiting' }), {}]);
      const out: any = await svc.reply('t1', partner, '  Still waiting ');
      expect(prisma.supportTicketReply.create.mock.calls[0][0].data).toEqual({
        ticketId: 't1',
        fromAdmin: false,
        authorId: 's1',
        staffUserId: null,
        message: 'Still waiting',
      });
      expect(prisma.supportTicket.update.mock.calls[0][0].data.status).toBe('OPEN');
      expect(out.body).toBe('Still waiting');
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('an admin reply is saved with the status change atomically and notifies the owner', async () => {
      prisma.supportTicket.findFirst.mockResolvedValue(ticket({ userId: 'c1', staffUserId: null, subject: 'Late order' }));
      prisma.$transaction.mockResolvedValue([saved(), {}]);
      await svc.reply('t1', admin, 'On it');
      expect(prisma.supportTicketReply.create.mock.calls[0][0].data).toMatchObject({ fromAdmin: true, staffUserId: 'a1', authorId: 'a1' });
      expect(prisma.supportTicket.update.mock.calls[0][0].data.status).toBe('IN_PROGRESS');
      expect(prisma.$transaction).toHaveBeenCalledWith(['create-op', 'update-op']);
      expect(events.emit).toHaveBeenCalledWith('support.reply.created', {
        ticketId: 't1',
        userId: 'c1',
        staffUserId: undefined,
        subject: 'Late order',
        replyId: 'r1',
      });
    });

    it('an admin can answer any ticket; owners only their own', async () => {
      prisma.supportTicket.findFirst.mockResolvedValue(ticket());
      prisma.$transaction.mockResolvedValue([saved(), {}]);
      await svc.reply('t1', admin, 'Hi');
      expect(prisma.supportTicket.findFirst.mock.calls[0][0].where).toEqual({ id: 't1' });
      await svc.reply('t1', partner, 'Hi');
      expect(prisma.supportTicket.findFirst.mock.calls[1][0].where).toEqual({ id: 't1', staffUserId: 's1' });
    });

    it('an admin reply does not change a status that is already further along', async () => {
      prisma.supportTicket.findFirst.mockResolvedValue(ticket({ status: 'RESOLVED' }));
      prisma.$transaction.mockResolvedValue([saved(), {}]);
      await svc.reply('t1', admin, 'Done');
      expect(prisma.supportTicket.update.mock.calls[0][0].data).not.toHaveProperty('status');
    });

    it('refuses blank replies, closed tickets (409 TICKET_CLOSED) and tickets that are not yours', async () => {
      await expect(svc.reply('t1', partner, '   ')).rejects.toBeInstanceOf(BadRequestException);
      prisma.supportTicket.findFirst.mockResolvedValue(ticket({ status: 'CLOSED' }));
      const err: any = await svc.reply('t1', partner, 'hi').catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse().code).toBe('TICKET_CLOSED');
      prisma.supportTicket.findFirst.mockResolvedValue(null);
      await expect(svc.reply('t2', partner, 'hi')).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.supportTicketReply.create).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();
    });
  });

  describe('admin list and status', () => {
    it('filters by status and includes who asked', async () => {
      await svc.findAll('OPEN' as any, 20);
      const arg = prisma.supportTicket.findMany.mock.calls[0][0];
      expect(arg.where).toEqual({ status: 'OPEN' });
      expect(arg.take).toBe(20);
      expect(arg.include).toHaveProperty('staffUser');
    });

    it('404s when updating an unknown ticket', async () => {
      prisma.supportTicket.findUnique.mockResolvedValue(null);
      await expect(svc.updateStatus('nope', { status: 'CLOSED' as any })).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});

describe('SupportController guards', () => {
  it.each(['adminReply', 'updateStatus', 'findAll'])('%s is ADMIN only', (name) => {
    const handler = (SupportController.prototype as any)[name];
    expect(new Reflector().get(ROLES_KEY, handler)).toEqual([StaffRole.ADMIN]);
    expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toContain(RolesGuard);
  });

  it('owners can post /messages (no role restriction beyond login)', () => {
    expect(new Reflector().get(ROLES_KEY, (SupportController.prototype as any).postMessage)).toBeUndefined();
  });
});
