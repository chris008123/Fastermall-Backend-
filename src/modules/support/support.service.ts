import {
  BadRequestException,
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

const REPLY_INCLUDE = { staffUser: { select: { id: true, fullName: true } } } as const;

// Replies carry `message` (admin console) and `body` (partner app): the
// same text under both names.
const presentReply = <T extends { message: string }>(r: T) => ({ ...r, body: r.message });

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
        targetType: dto.targetType,
        targetId: dto.targetId,
        reason: dto.reason,
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

  /**
   * One ticket with its replies (as `replies`, and again as `messages` for
   * the partner app). Owner or admin only; anyone else gets 404, so ids
   * can't be probed. Admins also see who opened it.
   */
  async findOne(id: string, user: SupportUser) {
    const admin = this.isAdmin(user);
    const ticket = await this.prisma.supportTicket.findFirst({
      where: { id, ...(admin ? {} : this.ownerWhere(user)) },
      include: {
        replies: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], include: REPLY_INCLUDE },
        delivery: { select: { id: true, status: true } },
        user: admin ? { select: { id: true, fullName: true, email: true, phone: true } } : false,
        staffUser: admin ? { select: { id: true, fullName: true, phone: true, role: true } } : false,
      },
    });
    if (!ticket) throw new NotFoundException('Ticket not found');
    const replies = ticket.replies.map(presentReply);
    return { ...ticket, replies, messages: replies };
  }

  /**
   * Adds a reply. An admin can answer any ticket; anyone else only their
   * own. Closed tickets refuse replies. A first answer from support moves an
   * OPEN ticket to IN_PROGRESS; a reply from the owner reopens a RESOLVED
   * one. The owner is notified of support's answers.
   */
  async reply(id: string, user: SupportUser, text: string) {
    const body = (text ?? '').trim();
    if (!body) throw new BadRequestException('Reply cannot be empty');

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

    let nextStatus: TicketStatus | undefined;
    if (admin && ticket.status === TicketStatus.OPEN) nextStatus = TicketStatus.IN_PROGRESS;
    if (!admin && ticket.status === TicketStatus.RESOLVED) nextStatus = TicketStatus.OPEN;

    const [reply] = await this.prisma.$transaction([
      this.prisma.supportTicketReply.create({
        data: {
          ticketId: id,
          fromAdmin: admin,
          authorId: user.userId,
          staffUserId: admin ? user.userId : null,
          message: body,
        },
        include: REPLY_INCLUDE,
      }),
      this.prisma.supportTicket.update({
        where: { id },
        data: { ...(nextStatus ? { status: nextStatus } : {}), updatedAt: new Date() },
      }),
    ]);

    if (admin) {
      this.events.emit('support.reply.created', {
        ticketId: id,
        userId: ticket.userId ?? undefined,
        staffUserId: ticket.staffUserId ?? undefined,
        subject: ticket.subject,
        replyId: reply.id,
      });
    }

    return presentReply(reply);
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
