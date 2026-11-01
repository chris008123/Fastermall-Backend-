import { ConflictException, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { SupportService } from './support.service';

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
        update: jest.fn().mockResolvedValue({}),
      },
      supportMessage: { create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'm1', ...data })) },
      delivery: { findUnique: jest.fn() },
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

    it('opens only my own ticket (404 otherwise), but any ticket for an admin', async () => {
      prisma.supportTicket.findFirst.mockResolvedValue(null);
      await expect(svc.findOne('t1', partner)).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.supportTicket.findFirst.mock.calls[0][0].where).toEqual({ id: 't1', staffUserId: 's1' });
      prisma.supportTicket.findFirst.mockResolvedValue({ id: 't1' });
      await svc.findOne('t1', admin);
      expect(prisma.supportTicket.findFirst.mock.calls[1][0].where).toEqual({ id: 't1' });
    });
  });

  describe('reply', () => {
    const ticket = (over: any = {}) => ({ id: 't1', status: 'OPEN', userId: null, staffUserId: 's1', subject: 'Late payout', ...over });

    it('records the owner reply without notifying anyone, and reopens a resolved ticket', async () => {
      prisma.supportTicket.findFirst.mockResolvedValue(ticket({ status: 'RESOLVED' }));
      await svc.reply('t1', partner, 'Still waiting');
      expect(prisma.supportMessage.create.mock.calls[0][0].data).toEqual({ ticketId: 't1', fromAdmin: false, authorId: 's1', body: 'Still waiting' });
      expect(prisma.supportTicket.update.mock.calls[0][0].data.status).toBe('OPEN');
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('an admin reply moves an open ticket to in-progress and notifies the owner', async () => {
      prisma.supportTicket.findFirst.mockResolvedValue(ticket());
      await svc.reply('t1', admin, 'On it');
      expect(prisma.supportMessage.create.mock.calls[0][0].data.fromAdmin).toBe(true);
      expect(prisma.supportTicket.update.mock.calls[0][0].data.status).toBe('IN_PROGRESS');
      expect(events.emit).toHaveBeenCalledWith('support.ticket.replied', { ticketId: 't1', userId: undefined, staffUserId: 's1', subject: 'Late payout' });
    });

    it("an admin reply does not change a status that is already further along", async () => {
      prisma.supportTicket.findFirst.mockResolvedValue(ticket({ status: 'RESOLVED' }));
      await svc.reply('t1', admin, 'Done');
      expect(prisma.supportTicket.update.mock.calls[0][0].data).not.toHaveProperty('status');
    });

    it('refuses a reply on a closed ticket, and on one that is not yours', async () => {
      prisma.supportTicket.findFirst.mockResolvedValue(ticket({ status: 'CLOSED' }));
      const err: any = await svc.reply('t1', partner, 'hi').catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse().code).toBe('TICKET_CLOSED');
      prisma.supportTicket.findFirst.mockResolvedValue(null);
      await expect(svc.reply('t2', partner, 'hi')).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.supportMessage.create).not.toHaveBeenCalled();
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
