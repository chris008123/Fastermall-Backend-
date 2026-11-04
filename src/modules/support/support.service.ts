import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../database/prisma.service';
import { CreateTicketDto } from './dto/create-ticket.dto';
import { UpdateTicketStatusDto } from './dto/update-ticket-status.dto';

const REPLIES_INCLUDE = {
  orderBy: { createdAt: 'asc' as const },
  include: { staffUser: { select: { id: true, fullName: true } } },
};

@Injectable()
export class SupportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {}

  create(userId: string, dto: CreateTicketDto) {
    return this.prisma.supportTicket.create({ data: { userId, ...dto } });
  }

  findMine(userId: string) {
    return this.prisma.supportTicket.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } });
  }

  findAll() {
    return this.prisma.supportTicket.findMany({ orderBy: { createdAt: 'desc' } });
  }

  /**
   * One ticket with its replies. Admins can open any ticket; everyone else
   * only their own (a missing and a foreign ticket both answer 404).
   */
  async findOne(id: string, caller: { userId: string; role?: string }) {
    const isAdmin = caller.role === 'ADMIN';
    const ticket = await this.prisma.supportTicket.findFirst({
      where: isAdmin ? { id } : { id, userId: caller.userId },
      include: {
        replies: REPLIES_INCLUDE,
        user: isAdmin ? { select: { id: true, fullName: true, email: true, phone: true } } : false,
      },
    });
    if (!ticket) throw new NotFoundException('Ticket not found');
    return ticket;
  }

  async updateStatus(id: string, dto: UpdateTicketStatusDto) {
    const ticket = await this.prisma.supportTicket.findUnique({ where: { id } });
    if (!ticket) throw new NotFoundException('Ticket not found');
    return this.prisma.supportTicket.update({ where: { id }, data: { status: dto.status } });
  }

  /**
   * Admin answer to a ticket. An OPEN ticket moves to IN_PROGRESS; a CLOSED
   * one can't be replied to. The customer is notified.
   */
  async reply(ticketId: string, staffUserId: string, message: string) {
    const text = message.trim();
    if (!text) throw new BadRequestException('Reply cannot be empty');

    const ticket = await this.prisma.supportTicket.findUnique({ where: { id: ticketId } });
    if (!ticket) throw new NotFoundException('Ticket not found');
    if (ticket.status === 'CLOSED') throw new BadRequestException('This ticket is closed. Reopen it to reply.');

    const createReply = this.prisma.supportTicketReply.create({
      data: { ticketId, staffUserId, message: text },
      include: { staffUser: { select: { id: true, fullName: true } } },
    });
    const reply =
      ticket.status === 'OPEN'
        ? (
            await this.prisma.$transaction([
              createReply,
              this.prisma.supportTicket.update({ where: { id: ticketId }, data: { status: 'IN_PROGRESS' } }),
            ])
          )[0]
        : await createReply;

    this.events.emit('support.reply.created', {
      ticketId,
      userId: ticket.userId,
      subject: ticket.subject,
      replyId: reply.id,
    });
    return reply;
  }
}
