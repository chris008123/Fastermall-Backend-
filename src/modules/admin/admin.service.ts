import { BadRequestException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CreatePayoutDto } from './dto/create-payout.dto';
import {
  DeliveryStatus,
  LaundryStatus,
  OrderStatus,
  OrderType,
  PaymentStatus,
  PayoutStatus,
  Prisma,
  StaffRole,
} from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { SAFE_DELIVERY_SELECT } from '../../shared/utils/delivery-secrets';
import { AdminListQueryDto } from './dto/admin-list-query.dto';

// A partner's own cash-outs (whole pesewas, amount + fee) as cedis.
const cashOutTotal = (sum: { amountPesewas: number | null; feePesewas: number | null } | null | undefined) =>
  new Prisma.Decimal((sum?.amountPesewas ?? 0) + (sum?.feePesewas ?? 0)).dividedBy(100);

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

// Who a delivery is with: a partner (food) or the admin who accepted it
// (marketplace / laundry). Names only.
const DELIVERY_PEOPLE = {
  partner: {
    select: {
      id: true,
      type: true,
      staffUser: { select: { id: true, fullName: true, phone: true } },
    },
  },
  claimedBy: { select: { id: true, fullName: true } },
} satisfies Prisma.DeliveryInclude;

const CUSTOMER_SELECT = {
  select: { id: true, fullName: true, email: true, phone: true },
} as const;

const ORDER_INCLUDE = {
  customer: CUSTOMER_SELECT,
  items: {
    include: {
      product: { select: { id: true, name: true } },
      menuItem: { select: { id: true, name: true } },
    },
  },
  payment: true,
  delivery: { select: { ...SAFE_DELIVERY_SELECT, ...DELIVERY_PEOPLE } },
} satisfies Prisma.OrderInclude;

const LAUNDRY_INCLUDE = {
  customer: CUSTOMER_SELECT,
  items: true,
  payment: true,
  delivery: { select: { ...SAFE_DELIVERY_SELECT, ...DELIVERY_PEOPLE } },
} satisfies Prisma.LaundryOrderInclude;

export interface Paged<T> {
  data: T[];
  page: number;
  pageSize: number;
  hasMore: boolean;
  total: number;
}

/** Validate an optional enum filter; unknown values are a 400, not "match nothing". */
function enumFilter<E extends Record<string, string>>(
  value: string | undefined,
  allowed: E,
  name: string,
): E[keyof E] | undefined {
  if (value === undefined || value === '') return undefined;
  if (!(Object.values(allowed) as string[]).includes(value)) {
    throw new BadRequestException(
      `${name} must be one of: ${Object.values(allowed).join(', ')}`,
    );
  }
  return value as E[keyof E];
}

export function pageParams(query: AdminListQueryDto) {
  const page = Math.max(query.page ?? 1, 1);
  const pageSize = Math.min(Math.max(query.pageSize ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly events?: EventEmitter2,
  ) {}

  async dashboardStats(now = new Date()) {
    const since30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    // First day of the month, five months back: six months including this one.
    const since6m = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 5, 1));
    const [users, products, orders, laundryOrders, openTickets, pendingPayments, total, last30, refunded, monthly] =
      await Promise.all([
        this.prisma.user.count(),
        this.prisma.product.count(),
        this.prisma.order.count(),
        this.prisma.laundryOrder.count(),
        this.prisma.supportTicket.count({ where: { status: 'OPEN' } }),
        this.prisma.payment.count({ where: { status: 'PENDING' } }),
        this.prisma.payment.aggregate({ where: { status: 'SUCCESSFUL' }, _sum: { amount: true } }),
        this.prisma.payment.aggregate({ where: { status: 'SUCCESSFUL', paidAt: { gte: since30 } }, _sum: { amount: true } }),
        this.prisma.payment.aggregate({ where: { status: 'REFUNDED' }, _sum: { amount: true } }),
        this.prisma.$queryRaw<{ month: string; amount: string }[]>`
          SELECT to_char(date_trunc('month', "paidAt"), 'YYYY-MM') AS month, SUM(amount)::text AS amount
          FROM payments
          WHERE status = 'SUCCESSFUL' AND "paidAt" >= ${since6m}
          GROUP BY 1 ORDER BY 1`,
      ]);

    // Every one of the six months is present, with "0" when nothing was paid.
    const byMonth = new Map(monthly.map((m) => [m.month, m.amount]));
    const revenueByMonth = Array.from({ length: 6 }, (_, i) => {
      const d = new Date(Date.UTC(since6m.getUTCFullYear(), since6m.getUTCMonth() + i, 1));
      const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
      return { month, amount: byMonth.get(month) ?? '0' };
    });

    // Revenue = successful payments (refunded ones are excluded). Decimal
    // strings, like every other money field.
    return {
      users,
      products,
      orders,
      laundryOrders,
      openTickets,
      pendingPayments,
      revenueTotal: (total._sum.amount ?? new Prisma.Decimal(0)).toString(),
      revenueLast30Days: (last30._sum.amount ?? new Prisma.Decimal(0)).toString(),
      refundedTotal: (refunded._sum.amount ?? new Prisma.Decimal(0)).toString(),
      revenueByMonth,
    };
  }

  findAllUsers() {
    return this.prisma.user.findMany({
      select: { id: true, email: true, fullName: true, isVerified: true, createdAt: true },
    });
  }

  private async paged<T>(
    query: AdminListQueryDto,
    count: () => Promise<number>,
    find: (skip: number, take: number) => Promise<T[]>,
  ): Promise<Paged<T>> {
    const { page, pageSize, skip, take } = pageParams(query);
    const [total, data] = await Promise.all([count(), find(skip, take)]);
    return { data, page, pageSize, hasMore: page * pageSize < total, total };
  }

  /** Every marketplace and food order, newest first. */
  listOrders(query: AdminListQueryDto) {
    // Ghana time is UTC, so a Ghana day is one UTC day.
    const day = query.deliveryDate ? new Date(`${query.deliveryDate}T00:00:00.000Z`) : null;
    if (day && Number.isNaN(day.getTime())) throw new BadRequestException('deliveryDate is not a real date');
    const where: Prisma.OrderWhereInput = {
      status: enumFilter(query.status, OrderStatus, 'status'),
      type: enumFilter(query.type, OrderType, 'type'),
      ...(day
        ? { deliveryWindowStart: { gte: day, lt: new Date(day.getTime() + 24 * 60 * 60 * 1000) } }
        : {}),
    };
    return this.paged(
      query,
      () => this.prisma.order.count({ where }),
      (skip, take) =>
        this.prisma.order.findMany({
          where,
          include: ORDER_INCLUDE,
          // For a delivery day, the run sheet order: by window, then oldest.
          orderBy: day
            ? [{ deliveryWindowStart: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }]
            : [{ createdAt: 'desc' }, { id: 'asc' }],
          skip,
          take,
        }),
    );
  }

  /** One order, any customer, with its delivery timeline. */
  async getOrder(id: string) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: {
        ...ORDER_INCLUDE,
        delivery: {
          select: {
            ...SAFE_DELIVERY_SELECT,
            ...DELIVERY_PEOPLE,
            statusEvents: { orderBy: { createdAt: 'asc' } },
          },
        },
      },
    });
    if (!order) throw new NotFoundException('Order not found');
    return order;
  }

  listLaundryOrders(query: AdminListQueryDto) {
    const where: Prisma.LaundryOrderWhereInput = {
      status: enumFilter(query.status, LaundryStatus, 'status'),
    };
    return this.paged(
      query,
      () => this.prisma.laundryOrder.count({ where }),
      (skip, take) =>
        this.prisma.laundryOrder.findMany({
          where,
          include: LAUNDRY_INCLUDE,
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
          skip,
          take,
        }),
    );
  }

  /** Every delivery (food, marketplace and laundry), newest first. */
  listDeliveries(query: AdminListQueryDto) {
    const where: Prisma.DeliveryWhereInput = {
      status: enumFilter(query.status, DeliveryStatus, 'status'),
    };
    return this.paged(
      query,
      () => this.prisma.delivery.count({ where }),
      (skip, take) =>
        this.prisma.delivery.findMany({
          where,
          select: {
            ...SAFE_DELIVERY_SELECT,
            ...DELIVERY_PEOPLE,
            order: {
              select: {
                id: true,
                type: true,
                status: true,
                totalAmount: true,
                vendorName: true,
                addressLabel: true,
                customer: { select: { id: true, fullName: true } },
              },
            },
            laundryOrder: {
              select: {
                id: true,
                status: true,
                totalAmount: true,
                addressLabel: true,
                customer: { select: { id: true, fullName: true } },
              },
            },
            statusEvents: { orderBy: { createdAt: 'asc' } },
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
          skip,
          take,
        }),
    );
  }

  listPayments(query: AdminListQueryDto) {
    const where: Prisma.PaymentWhereInput = {
      status: enumFilter(query.status, PaymentStatus, 'status'),
    };
    return this.paged(
      query,
      () => this.prisma.payment.count({ where }),
      (skip, take) =>
        this.prisma.payment.findMany({
          where,
          include: {
            order: {
              select: { id: true, type: true, customer: { select: { id: true, fullName: true } } },
            },
            laundryOrder: {
              select: { id: true, customer: { select: { id: true, fullName: true } } },
            },
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
          skip,
          take,
        }),
    );
  }

  /**
   * Delivery partners with their profile and work so far: deliveries in
   * progress, deliveries completed, and total earnings.
   */
  async listPartners() {
    const staff = await this.prisma.staffUser.findMany({
      where: { role: StaffRole.DELIVERY_PARTNER },
      select: {
        id: true,
        email: true,
        phone: true,
        fullName: true,
        isVerified: true,
        createdAt: true,
        deliveryProfile: {
          select: { id: true, type: true, isAvailable: true, vehiclePlate: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const profileIds = staff.map((s) => s.deliveryProfile?.id).filter((id): id is string => !!id);
    const [active, completed, earnings, payouts, cashOuts] = profileIds.length
      ? await Promise.all([
          this.prisma.delivery.groupBy({
            by: ['partnerId'],
            where: {
              partnerId: { in: profileIds },
              status: {
                in: [
                  DeliveryStatus.ASSIGNED,
                  DeliveryStatus.EN_ROUTE_TO_PICKUP,
                  DeliveryStatus.PAY_VENDOR,
                  DeliveryStatus.PICKED_UP,
                  DeliveryStatus.EN_ROUTE_TO_CUSTOMER,
                ],
              },
            },
            _count: { _all: true },
          }),
          this.prisma.delivery.groupBy({
            by: ['partnerId'],
            where: { partnerId: { in: profileIds }, status: DeliveryStatus.DELIVERED },
            _count: { _all: true },
          }),
          this.prisma.driverEarning.groupBy({
            by: ['partnerId'],
            where: { partnerId: { in: profileIds } },
            _sum: { amount: true },
          }),
          this.prisma.partnerPayout.groupBy({
            by: ['partnerId'],
            where: { partnerId: { in: profileIds } },
            _sum: { amount: true },
          }),
          // Cash-outs the partner asked for in the app (pending or paid).
          this.prisma.payoutRequest.groupBy({
            by: ['partnerId'],
            where: { partnerId: { in: profileIds }, status: { in: [PayoutStatus.PENDING, PayoutStatus.PAID] } },
            _sum: { amountPesewas: true, feePesewas: true },
          }),
        ])
      : [[], [], [], [], []];

    const countBy = (rows: { partnerId: string | null; _count: { _all: number } }[]) =>
      new Map(rows.map((r) => [r.partnerId, r._count._all]));
    const activeBy = countBy(active);
    const completedBy = countBy(completed);
    const earningsBy = new Map(earnings.map((r) => [r.partnerId, r._sum.amount]));
    const dec = (v: Prisma.Decimal | null | undefined) => new Prisma.Decimal(v ?? 0);
    const cashOutsBy = new Map(
      cashOuts.map((r) => [r.partnerId, cashOutTotal(r._sum)]),
    );
    // Paid out = payouts recorded here + the partner's own cash-outs.
    const payoutsBy = new Map(
      profileIds.map((id) => [
        id,
        dec(payouts.find((r) => r.partnerId === id)?._sum.amount).plus(cashOutsBy.get(id) ?? 0),
      ]),
    );

    return staff.map(({ deliveryProfile, ...s }) => ({
      ...s,
      profile: deliveryProfile
        ? {
            type: deliveryProfile.type,
            isAvailable: deliveryProfile.isAvailable,
            vehiclePlate: deliveryProfile.vehiclePlate,
          }
        : null,
      activeDeliveries: deliveryProfile ? activeBy.get(deliveryProfile.id) ?? 0 : 0,
      completedDeliveries: deliveryProfile ? completedBy.get(deliveryProfile.id) ?? 0 : 0,
      // Decimal, serialised as a string like the other money fields.
      totalEarnings: deliveryProfile ? earningsBy.get(deliveryProfile.id) ?? '0' : '0',
      totalPaidOut: deliveryProfile ? dec(payoutsBy.get(deliveryProfile.id)).toString() : '0',
      // Owed to the partner: earned minus already paid out.
      balance: deliveryProfile
        ? dec(earningsBy.get(deliveryProfile.id)).minus(dec(payoutsBy.get(deliveryProfile.id))).toString()
        : '0',
    }));
  }

  private async partnerProfile(staffId: string) {
    const profile = await this.prisma.deliveryPartnerProfile.findUnique({
      where: { staffUserId: staffId },
      select: { id: true },
    });
    if (!profile) throw new NotFoundException('Delivery partner not found');
    return profile;
  }

  /** A partner's payouts, newest first. */
  async listPayouts(staffId: string) {
    const profile = await this.partnerProfile(staffId);
    return this.prisma.partnerPayout.findMany({
      where: { partnerId: profile.id },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  /**
   * Records money sent to a partner. It can't exceed what they're owed. The
   * balance check and insert run in one serializable transaction so two
   * admins can't both pay out the same balance.
   */
  async createPayout(staffId: string, dto: CreatePayoutDto, adminId: string) {
    const profile = await this.partnerProfile(staffId);
    const amount = new Prisma.Decimal(dto.amount);
    const payout = await this.prisma.$transaction(
      async (tx) => {
        // Same lock as a partner cash-out (WalletService.cashOut), so the two
        // can't spend the same balance at the same moment.
        await tx.$queryRaw`SELECT id FROM delivery_partner_profiles WHERE id = ${profile.id} FOR UPDATE`;
        const [earned, paid, cashOuts] = await Promise.all([
          tx.driverEarning.aggregate({ where: { partnerId: profile.id }, _sum: { amount: true } }),
          tx.partnerPayout.aggregate({ where: { partnerId: profile.id }, _sum: { amount: true } }),
          tx.payoutRequest.aggregate({
            where: { partnerId: profile.id, status: { in: [PayoutStatus.PENDING, PayoutStatus.PAID] } },
            _sum: { amountPesewas: true, feePesewas: true },
          }),
        ]);
        const balance = new Prisma.Decimal(earned._sum.amount ?? 0)
          .minus(paid._sum.amount ?? 0)
          .minus(cashOutTotal(cashOuts._sum));
        if (amount.greaterThan(balance)) {
          throw new BadRequestException(`That's more than this partner is owed (GHS ${balance.toFixed(2)})`);
        }
        return tx.partnerPayout.create({
          data: {
            partnerId: profile.id,
            amount,
            method: dto.method ?? 'MOBILE_MONEY',
            reference: dto.reference?.trim() || null,
            note: dto.note?.trim() || null,
            createdById: adminId,
          },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    // Told after the commit (push respects the partner's "payments" switch).
    this.events?.emit('partner.payout.recorded', {
      staffUserId: staffId,
      payoutId: payout.id,
      amount: String(payout.amount),
    });
    return payout;
  }

  /** Admin actions, newest first (written by AuditInterceptor). */
  listAuditLogs(query: AdminListQueryDto) {
    return this.paged(
      query,
      () => this.prisma.adminAuditLog.count(),
      (skip, take) =>
        this.prisma.adminAuditLog.findMany({
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
          skip,
          take,
        }),
    );
  }
}
