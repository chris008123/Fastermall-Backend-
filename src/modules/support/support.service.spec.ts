import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { StaffRole } from '@prisma/client';
import { SupportService } from './support.service';
import { SupportController } from './support.controller';
import { ROLES_KEY } from '../../shared/decorators/roles.decorator';
import { RolesGuard } from '../../shared/guards/roles.guard';

function setup(ticket: any = { id: 't1', userId: 'c1', subject: 'Late order', status: 'OPEN' }) {
  const prisma: any = {
    supportTicket: {
      findUnique: jest.fn().mockResolvedValue(ticket),
      findFirst: jest.fn().mockResolvedValue(ticket),
      update: jest.fn().mockReturnValue('update-op'),
    },
    supportTicketReply: { create: jest.fn() },
    $transaction: jest.fn(),
  };
  const events = { emit: jest.fn() };
  return { svc: new SupportService(prisma, events as any), prisma, events };
}

describe('SupportService.reply', () => {
  it('saves the reply, moves an OPEN ticket to IN_PROGRESS atomically, and notifies the customer', async () => {
    const { svc, prisma, events } = setup();
    const saved = { id: 'r1', message: 'On its way', staffUser: { id: 'a1', fullName: 'Ama' } };
    prisma.supportTicketReply.create.mockReturnValue('create-op');
    prisma.$transaction.mockResolvedValue([saved, {}]);

    expect(await svc.reply('t1', 'a1', '  On its way  ')).toBe(saved);
    expect(prisma.supportTicketReply.create.mock.calls[0][0].data).toEqual({ ticketId: 't1', staffUserId: 'a1', message: 'On its way' });
    expect(prisma.supportTicket.update).toHaveBeenCalledWith({ where: { id: 't1' }, data: { status: 'IN_PROGRESS' } });
    expect(prisma.$transaction).toHaveBeenCalledWith(['create-op', 'update-op']);
    expect(events.emit).toHaveBeenCalledWith('support.reply.created', { ticketId: 't1', userId: 'c1', subject: 'Late order', replyId: 'r1' });
  });

  it('leaves the status alone when the ticket is already being handled', async () => {
    const { svc, prisma } = setup({ id: 't1', userId: 'c1', subject: 's', status: 'RESOLVED' });
    prisma.supportTicketReply.create.mockResolvedValue({ id: 'r2' });
    await svc.reply('t1', 'a1', 'Follow-up');
    expect(prisma.supportTicket.update).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('refuses blank replies, missing tickets and closed tickets without notifying', async () => {
    const { svc, prisma, events } = setup({ id: 't1', userId: 'c1', subject: 's', status: 'CLOSED' });
    await expect(svc.reply('t1', 'a1', '   ')).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.reply('t1', 'a1', 'Hi')).rejects.toBeInstanceOf(BadRequestException);
    prisma.supportTicket.findUnique.mockResolvedValueOnce(null);
    await expect(svc.reply('nope', 'a1', 'Hi')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.supportTicketReply.create).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });
});

describe('SupportService.findOne', () => {
  it('lets admins open any ticket, with the customer', async () => {
    const { svc, prisma } = setup();
    await svc.findOne('t1', { userId: 'a1', role: 'ADMIN' });
    const arg = prisma.supportTicket.findFirst.mock.calls[0][0];
    expect(arg.where).toEqual({ id: 't1' });
    expect(arg.include.user).toBeTruthy();
    expect(arg.include.replies).toBeTruthy();
  });

  it("scopes everyone else to their own tickets, and 404s on someone else's", async () => {
    const { svc, prisma } = setup();
    await svc.findOne('t1', { userId: 'c1' });
    const arg = prisma.supportTicket.findFirst.mock.calls[0][0];
    expect(arg.where).toEqual({ id: 't1', userId: 'c1' });
    expect(arg.include.user).toBe(false);

    prisma.supportTicket.findFirst.mockResolvedValueOnce(null);
    await expect(svc.findOne('t1', { userId: 'intruder' })).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('SupportController guards', () => {
  it.each(['reply', 'updateStatus', 'findAll'])('%s is ADMIN only', (name) => {
    const handler = (SupportController.prototype as any)[name];
    expect(new Reflector().get(ROLES_KEY, handler)).toEqual([StaffRole.ADMIN]);
    expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toContain(RolesGuard);
  });
});
