import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Prisma, StaffRole } from '@prisma/client';
import { AdminService, pageParams } from './admin.service';
import { AdminController } from './admin.controller';
import { ROLES_KEY } from '../../shared/decorators/roles.decorator';
import { RolesGuard } from '../../shared/guards/roles.guard';
import { JwtAuthGuard } from '../../shared/guards/jwt-auth.guard';
import { SAFE_DELIVERY_SELECT } from '../../shared/utils/delivery-secrets';

const SECRET_FIELDS = ['deliveryCodeHash', 'deliveryCodeEncrypted', 'deliveryCodeAttempts', 'deliveryCodeLockedUntil'];

function model(rows: any[] = [], total = rows.length) {
  return {
    count: jest.fn().mockResolvedValue(total),
    findMany: jest.fn().mockResolvedValue(rows),
    findUnique: jest.fn().mockResolvedValue(rows[0] ?? null),
    groupBy: jest.fn().mockResolvedValue([]),
  };
}

function setup() {
  const prisma: any = {
    order: model([{ id: 'o1' }], 45),
    laundryOrder: model([{ id: 'l1' }], 3),
    delivery: model([{ id: 'd1' }], 1),
    payment: model([{ id: 'p1' }], 1),
    staffUser: model([]),
    driverEarning: model([]),
    partnerPayout: model([]),
    adminAuditLog: model([{ id: 'log1' }], 1),
    deliveryPartnerProfile: model([]),
    user: model([]),
    product: model([]),
    supportTicket: model([]),
  };
  return { svc: new AdminService(prisma), prisma };
}

/** Walk a Prisma include/select tree and collect every key that is set. */
function keysDeep(obj: unknown, out = new Set<string>()): Set<string> {
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      out.add(k);
      keysDeep(v, out);
    }
  }
  return out;
}

describe('pageParams', () => {
  it('defaults to page 1 of 20 and caps the page size at 100', () => {
    expect(pageParams({})).toEqual({ page: 1, pageSize: 20, skip: 0, take: 20 });
    expect(pageParams({ page: 3, pageSize: 500 })).toEqual({ page: 3, pageSize: 100, skip: 200, take: 100 });
  });
});

describe('AdminService lists', () => {
  it('returns the paged envelope the console expects', async () => {
    const { svc, prisma } = setup();
    const res = await svc.listOrders({ page: 2, pageSize: 20 });
    expect(res).toEqual({ data: [{ id: 'o1' }], page: 2, pageSize: 20, hasMore: true, total: 45 });
    expect(prisma.order.findMany.mock.calls[0][0]).toMatchObject({ skip: 20, take: 20 });

    const last = await svc.listOrders({ page: 3, pageSize: 20 });
    expect(last.hasMore).toBe(false);
  });

  it('passes valid filters through and rejects unknown values', async () => {
    const { svc, prisma } = setup();
    await svc.listOrders({ status: 'PENDING', type: 'FOOD' });
    expect(prisma.order.findMany.mock.calls[0][0].where).toEqual({ status: 'PENDING', type: 'FOOD' });
    expect(prisma.order.count.mock.calls[0][0].where).toEqual({ status: 'PENDING', type: 'FOOD' });

    expect(() => svc.listOrders({ status: 'SHIPPED' })).toThrow(BadRequestException);
    expect(() => svc.listOrders({ type: 'LAUNDRY' })).toThrow(BadRequestException);
    expect(() => svc.listLaundryOrders({ status: 'PENDING' })).toThrow(BadRequestException);
    expect(() => svc.listDeliveries({ status: 'LOST' })).toThrow(BadRequestException);
    expect(() => svc.listPayments({ status: 'PAID' })).toThrow(BadRequestException);
  });

  it('an empty filter means no filter', async () => {
    const { svc, prisma } = setup();
    await svc.listPayments({ status: '' });
    expect(prisma.payment.findMany.mock.calls[0][0].where).toEqual({ status: undefined });
  });

  it('never selects handover-code secrets for nested or listed deliveries', async () => {
    const { svc, prisma } = setup();
    await svc.listOrders({});
    await svc.getOrder('o1');
    await svc.listLaundryOrders({});
    await svc.listDeliveries({});

    const queries = [
      prisma.order.findMany.mock.calls[0][0],
      prisma.order.findUnique.mock.calls[0][0],
      prisma.laundryOrder.findMany.mock.calls[0][0],
      prisma.delivery.findMany.mock.calls[0][0],
    ];
    for (const q of queries) {
      const keys = keysDeep(q);
      for (const secret of SECRET_FIELDS) expect(keys.has(secret)).toBe(false);
    }
    // Deliveries use an explicit select, never a bare include of the row.
    expect(prisma.order.findMany.mock.calls[0][0].include.delivery).toHaveProperty('select');
    expect(prisma.delivery.findMany.mock.calls[0][0]).toHaveProperty('select');
    for (const secret of SECRET_FIELDS) expect(SAFE_DELIVERY_SELECT).not.toHaveProperty(secret);
  });

  it('getOrder finds any customer\'s order and 404s on a missing one', async () => {
    const { svc, prisma } = setup();
    await expect(svc.getOrder('o1')).resolves.toEqual({ id: 'o1' });
    expect(prisma.order.findUnique.mock.calls[0][0].where).toEqual({ id: 'o1' }); // no customerId scope
    prisma.order.findUnique.mockResolvedValueOnce(null);
    await expect(svc.getOrder('nope')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('AdminService.listPartners', () => {
  it('merges profile, active/completed counts and earnings per partner', async () => {
    const { svc, prisma } = setup();
    prisma.staffUser.findMany.mockResolvedValue([
      { id: 's1', fullName: 'Kofi', email: 'k@x.com', phone: null, isVerified: true, createdAt: 't', deliveryProfile: { id: 'p1', type: 'MOTORCYCLE', isAvailable: true, vehiclePlate: 'GR-1' } },
      { id: 's2', fullName: 'Ama', email: null, phone: null, isVerified: false, createdAt: 't', deliveryProfile: null },
    ]);
    prisma.delivery.groupBy
      .mockResolvedValueOnce([{ partnerId: 'p1', _count: { _all: 2 } }]) // active
      .mockResolvedValueOnce([{ partnerId: 'p1', _count: { _all: 9 } }]); // completed
    prisma.driverEarning.groupBy.mockResolvedValue([{ partnerId: 'p1', _sum: { amount: new Prisma.Decimal('135.00') } }]);
    prisma.partnerPayout.groupBy.mockResolvedValue([{ partnerId: 'p1', _sum: { amount: new Prisma.Decimal('100.50') } }]);

    const [kofi, ama] = await svc.listPartners();
    expect(kofi).toMatchObject({
      id: 's1',
      profile: { type: 'MOTORCYCLE', isAvailable: true, vehiclePlate: 'GR-1' },
      activeDeliveries: 2,
      completedDeliveries: 9,
      totalPaidOut: '100.5',
      balance: '34.5',
    });
    expect(String(kofi.totalEarnings)).toBe('135');
    expect(kofi).not.toHaveProperty('deliveryProfile');
    expect(ama).toMatchObject({ profile: null, activeDeliveries: 0, completedDeliveries: 0, totalEarnings: '0', totalPaidOut: '0', balance: '0' });
    expect(prisma.staffUser.findMany.mock.calls[0][0].select).not.toHaveProperty('passwordHash');
  });

  it('skips the aggregate queries when there are no partner profiles', async () => {
    const { svc, prisma } = setup();
    await expect(svc.listPartners()).resolves.toEqual([]);
    expect(prisma.delivery.groupBy).not.toHaveBeenCalled();
  });
});

describe('AdminController access', () => {
  it('every route requires a signed-in ADMIN', () => {
    const reflector = new Reflector();
    const guards = Reflect.getMetadata(GUARDS_METADATA, AdminController);
    expect(guards).toEqual([JwtAuthGuard, RolesGuard]);

    const routes = Object.getOwnPropertyNames(AdminController.prototype).filter((n) => n !== 'constructor');
    expect(routes.length).toBeGreaterThanOrEqual(8);
    for (const name of routes) {
      const handler = (AdminController.prototype as any)[name];
      const roles = reflector.getAllAndOverride<StaffRole[]>(ROLES_KEY, [handler, AdminController]);
      expect(roles).toEqual([StaffRole.ADMIN]);
    }
  });

  it('RolesGuard turns away non-admins and customers', () => {
    const guard = new RolesGuard(new Reflector());
    const ctx = (user: any) =>
      ({
        getHandler: () => AdminController.prototype.listOrders,
        getClass: () => AdminController,
        switchToHttp: () => ({ getRequest: () => ({ user }) }),
      }) as any;
    expect(guard.canActivate(ctx({ userId: 'a', role: 'ADMIN' }))).toBe(true);
    expect(() => guard.canActivate(ctx({ userId: 'v', role: 'VENDOR' }))).toThrow();
    expect(() => guard.canActivate(ctx({ userId: 'c' }))).toThrow(); // customer token: no role claim
  });
});

describe('AdminService.dashboardStats revenue', () => {
  it('sums successful payments, the last 30 days, refunds, and fills all six months', async () => {
    const { svc, prisma } = setup();
    prisma.payment.aggregate = jest
      .fn()
      .mockResolvedValueOnce({ _sum: { amount: new Prisma.Decimal('1200.50') } })
      .mockResolvedValueOnce({ _sum: { amount: new Prisma.Decimal('300') } })
      .mockResolvedValueOnce({ _sum: { amount: null } });
    prisma.$queryRaw = jest.fn().mockResolvedValue([{ month: '2026-09', amount: '450.00' }, { month: '2026-11', amount: '300.00' }]);

    const res = await svc.dashboardStats(new Date('2026-11-04T12:00:00Z'));
    expect(res).toMatchObject({ revenueTotal: '1200.5', revenueLast30Days: '300', refundedTotal: '0' });
    expect(res.revenueByMonth).toEqual([
      { month: '2026-06', amount: '0' },
      { month: '2026-07', amount: '0' },
      { month: '2026-08', amount: '0' },
      { month: '2026-09', amount: '450.00' },
      { month: '2026-10', amount: '0' },
      { month: '2026-11', amount: '300.00' },
    ]);
    expect(prisma.payment.aggregate.mock.calls[0][0].where).toEqual({ status: 'SUCCESSFUL' });
    expect(prisma.payment.aggregate.mock.calls[2][0].where).toEqual({ status: 'REFUNDED' });
  });
});

describe('AdminService payouts', () => {
  function withTx(earned: string | null, paid: string | null) {
    const ctx = setup();
    const tx: any = {
      driverEarning: { aggregate: jest.fn().mockResolvedValue({ _sum: { amount: earned && new Prisma.Decimal(earned) } }) },
      partnerPayout: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { amount: paid && new Prisma.Decimal(paid) } }),
        create: jest.fn().mockImplementation(({ data }) => ({ id: 'po1', ...data })),
      },
    };
    ctx.prisma.deliveryPartnerProfile.findUnique.mockResolvedValue({ id: 'p1' });
    ctx.prisma.$transaction = jest.fn((fn: any, opts: any) => fn(tx));
    return { ...ctx, tx };
  }

  it('records a payout up to the balance, serializably', async () => {
    const { svc, prisma, tx } = withTx('150', '100');
    const po = await svc.createPayout('s1', { amount: 50, reference: ' MM123 ' }, 'admin1');
    expect(tx.partnerPayout.create.mock.calls[0][0].data).toMatchObject({ partnerId: 'p1', method: 'MOBILE_MONEY', reference: 'MM123', createdById: 'admin1' });
    expect(String(po.amount)).toBe('50');
    expect(prisma.$transaction.mock.calls[0][1]).toEqual({ isolationLevel: 'Serializable' });
  });

  it('refuses more than is owed, and unknown partners', async () => {
    const { svc, prisma, tx } = withTx('150', '100');
    await expect(svc.createPayout('s1', { amount: 50.01 }, 'a')).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.partnerPayout.create).not.toHaveBeenCalled();
    prisma.deliveryPartnerProfile.findUnique.mockResolvedValue(null);
    await expect(svc.createPayout('nope', { amount: 1 }, 'a')).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.listPayouts('nope')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('AdminService.listAuditLogs', () => {
  it('is paged newest first', async () => {
    const { svc, prisma } = setup();
    const res = await svc.listAuditLogs({ page: 1, pageSize: 50 });
    expect(res).toMatchObject({ data: [{ id: 'log1' }], total: 1, hasMore: false });
    expect(prisma.adminAuditLog.findMany.mock.calls[0][0].orderBy[0]).toEqual({ createdAt: 'desc' });
  });
});
