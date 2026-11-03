import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  DeliveryStatus,
  LaundryStatus,
  OrderStatus,
  OrderType,
  PaymentStatus,
  Prisma,
  StaffRole,
} from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { SAFE_DELIVERY_SELECT } from '../../shared/utils/delivery-secrets';
import { AdminListQueryDto } from './dto/admin-list-query.dto';

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
  constructor(private readonly prisma: PrismaService) {}

  async dashboardStats() {
    const [users, products, orders, laundryOrders, openTickets, pendingPayments] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.product.count(),
      this.prisma.order.count(),
      this.prisma.laundryOrder.count(),
      this.prisma.supportTicket.count({ where: { status: 'OPEN' } }),
      this.prisma.payment.count({ where: { status: 'PENDING' } }),
    ]);

    return { users, products, orders, laundryOrders, openTickets, pendingPayments };
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
    const where: Prisma.OrderWhereInput = {
      status: enumFilter(query.status, OrderStatus, 'status'),
      type: enumFilter(query.type, OrderType, 'type'),
    };
    return this.paged(
      query,
      () => this.prisma.order.count({ where }),
      (skip, take) =>
        this.prisma.order.findMany({
          where,
          include: ORDER_INCLUDE,
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
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
    const [active, completed, earnings] = profileIds.length
      ? await Promise.all([
          this.prisma.delivery.groupBy({
            by: ['partnerId'],
            where: {
              partnerId: { in: profileIds },
              status: {
                in: [
                  DeliveryStatus.ASSIGNED,
                  DeliveryStatus.EN_ROUTE_TO_PICKUP,
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
        ])
      : [[], [], []];

    const countBy = (rows: { partnerId: string | null; _count: { _all: number } }[]) =>
      new Map(rows.map((r) => [r.partnerId, r._count._all]));
    const activeBy = countBy(active);
    const completedBy = countBy(completed);
    const earningsBy = new Map(earnings.map((r) => [r.partnerId, r._sum.amount]));

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
    }));
  }
}
