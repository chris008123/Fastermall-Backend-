import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { StaffRole, TicketStatus } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { CreateTicketDto } from './dto/create-ticket.dto';
import { UpdateTicketStatusDto } from './dto/update-ticket-status.dto';

export interface SupportUser {
  userId: string;
  role?: string;
}

/**
 * Support tickets for customers AND staff (delivery partners). The signed-in
 * account's role decides which owner column is used, the same way
 * notifications do. An admin can read and answer any ticket.
 */
@Injectable()
export class SupportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {}

  private isStaff(user: SupportUser) {
    return Object.values(StaffRole).includes(user.role as StaffRole);
  }
  private isAdmin(user: SupportUser) {
    return user.role === StaffRole.ADMIN;
  }
  private ownerWhere(user: SupportUser) {
    return this.isStaff(user) ? { staffUserId: user.userId } : { userId: user.userId };
  }

  // A ticket may only point at a delivery the person is involved in.
  private async assertOwnDelivery(user: SupportUser, deliveryId: string) {
    const d = await this.prisma.delivery.findUnique({
      where: { id: deliveryId },
      select: {
        partner: { select: { staffUserId: true } },
        order: { select: { customerId: true } },
        laundryOrder: { select: { customerId: true } },
      },
    });
    const mine = this.isStaff(user)
      ? d?.partner?.staffUserId === user.userId
      : (d?.order?.customerId ?? d?.laundryOrder?.customerId) === user.userId;
    if (!d || !mine) throw new NotFoundException('Delivery not found');
  }

  async create(user: SupportUser, dto: CreateTicketDto) {
    if (dto.deliveryId) await this.assertOwnDelivery(user, dto.deliveryId);
    return this.prisma.supportTicket.create({
      data: {
        ...(this.isStaff(user) ? { staffUserId: user.userId } : { userId: user.userId }),
        subject: dto.subject,
        message: dto.message,
        deliveryId: dto.deliveryId,
      },
    });
  }

  findMine(user: SupportUser) {
    return this.prisma.supportTicket.findMany({
      where: this.ownerWhere(user),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 100,
    });
  }

  /** One ticket with its replies. Owner or admin only; anyone else gets 404. */
  async findOne(id: string, user: SupportUser) {
    const ticket = await this.prisma.supportTicket.findFirst({
      where: { id, ...(this.isAdmin(user) ? {} : this.ownerWhere(user)) },
      include: {
        messages: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
        delivery: { select: { id: true, status: true } },
      },
    });
    if (!ticket) throw new NotFoundException('Ticket not found');
    return ticket;
  }

  async reply(id: string, user: SupportUser, body: string) {
    const admin = this.isAdmin(user);
    const ticket = await this.prisma.supportTicket.findFirst({
      where: { id, ...(admin ? {} : this.ownerWhere(user)) },
    });
    if (!ticket) throw new NotFoundException('Ticket not found');

    if (ticket.status === TicketStatus.CLOSED) {
      throw new ConflictException({
        message: 'This ticket is closed. Open a new one.',
        code: 'TICKET_CLOSED',
      });
    }

    const message = await this.prisma.supportMessage.create({
      data: { ticketId: id, fromAdmin: admin, authorId: user.userId, body },
    });

    // A reply from the owner reopens a resolved ticket; a first answer from
    // support moves an open ticket to in progress.
    const nextStatus = admin
      ? ticket.status === TicketStatus.OPEN ? TicketStatus.IN_PROGRESS : undefined
      : ticket.status === TicketStatus.RESOLVED ? TicketStatus.OPEN : undefined;
    await this.prisma.supportTicket.update({
      where: { id },
      data: { ...(nextStatus ? { status: nextStatus } : {}), updatedAt: new Date() },
    });

    if (admin) {
      this.events.emit('support.ticket.replied', {
        ticketId: id,
        userId: ticket.userId ?? undefined,
        staffUserId: ticket.staffUserId ?? undefined,
        subject: ticket.subject,
      });
    }

    return message;
  }

  findAll(status?: TicketStatus, limit = 100) {
    return this.prisma.supportTicket.findMany({
      where: status ? { status } : {},
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
      include: {
        user: { select: { fullName: true, phone: true } },
        staffUser: { select: { fullName: true, phone: true, role: true } },
      },
    });
  }

  async updateStatus(id: string, dto: UpdateTicketStatusDto) {
    const ticket = await this.prisma.supportTicket.findUnique({ where: { id } });
    if (!ticket) throw new NotFoundException('Ticket not found');
    return this.prisma.supportTicket.update({ where: { id }, data: { status: dto.status } });
  }
}
