import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { toPesewas, WalletService } from './wallet.service';

describe('toPesewas', () => {
  it('converts decimals to whole pesewas without float drift', () => {
    expect(toPesewas('25.50')).toBe(2550);
    expect(toPesewas('0.29')).toBe(29);
    expect(toPesewas('1234567.89')).toBe(123456789);
    expect(toPesewas(null)).toBe(0);
    expect(toPesewas(15)).toBe(1500);
  });
});

describe('WalletService', () => {
  let svc: WalletService;
  let prisma: any;
  let staff: any;
  let tx: any;
  const cfg: any = { get: (k: string) => ({ 'wallet.currency': 'GHS', 'wallet.minCashOutPesewas': 1000, 'wallet.cashOutFeePesewas': 50 } as any)[k] };
  const profile = { id: 'p1', staffUserId: 's1', payoutNetwork: 'MTN', payoutNumber: '0241234567' };

  // earned GHS 100.00, 30.00 pending, 20.00 paid  -> balance 50.00
  const figures = (earned = '100.00', rows: any[] = [
    { status: 'PENDING', _sum: { amountPesewas: 2900, feePesewas: 100 } },
    { status: 'PAID', _sum: { amountPesewas: 1950, feePesewas: 50 } },
  ]) => ({
    driverEarning: { aggregate: jest.fn().mockResolvedValue({ _sum: { amount: earned } }) },
    payoutRequest: { groupBy: jest.fn().mockResolvedValue(rows) },
  });

  beforeEach(() => {
    const f = figures();
    tx = { ...f, $queryRaw: jest.fn().mockResolvedValue([]), payoutRequest: { ...f.payoutRequest, create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'po1', status: 'PENDING', createdAt: new Date(), failureReason: null, ...data })) } };
    prisma = {
      ...figures(),
      deliveryPartnerProfile: { findUnique: jest.fn().mockResolvedValue(profile), update: jest.fn().mockImplementation(({ data }) => Promise.resolve({ ...profile, ...data })) },
      driverEarning: { aggregate: jest.fn().mockResolvedValue({ _sum: { amount: '100.00' } }), findMany: jest.fn().mockResolvedValue([]) },
      payoutRequest: { groupBy: jest.fn().mockResolvedValue([{ status: 'PENDING', _sum: { amountPesewas: 2900, feePesewas: 100 } }, { status: 'PAID', _sum: { amountPesewas: 1950, feePesewas: 50 } }]), findMany: jest.fn().mockResolvedValue([]), updateMany: jest.fn(), findUnique: jest.fn(), findUniqueOrThrow: jest.fn() },
      $transaction: jest.fn().mockImplementation((fn: any) => fn(tx)),
    };
    staff = { assertCurrentPassword: jest.fn().mockResolvedValue(undefined) };
    svc = new WalletService(prisma, cfg, staff);
  });

  describe('wallet', () => {
    it('reports balance in pesewas with currency and a masked destination', async () => {
      const w: any = await svc.getWallet('s1');
      expect(w).toMatchObject({ currency: 'GHS', earnedPesewas: 10000, pendingPesewas: 3000, paidOutPesewas: 2000, balancePesewas: 5000, minCashOutPesewas: 1000, cashOutFeePesewas: 50 });
      expect(w.payoutDestination).toEqual({ network: 'MTN', numberMasked: '024****567' });
      expect(JSON.stringify(w)).not.toContain('0241234567');
    });

    it('404s for an account with no partner profile', async () => {
      prisma.deliveryPartnerProfile.findUnique.mockResolvedValue(null);
      await expect(svc.getWallet('x')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('cashOut', () => {
    it('creates a PENDING request with a masked destination snapshot, after locking the partner row', async () => {
      const out: any = await svc.cashOut('s1', 4000);
      expect(tx.$queryRaw).toHaveBeenCalled();
      expect(tx.payoutRequest.create.mock.calls[0][0].data).toMatchObject({ partnerId: 'p1', amountPesewas: 4000, feePesewas: 50, network: 'MTN', destinationNumber: '0241234567', destinationMasked: '024****567' });
      expect(out).toMatchObject({ status: 'PENDING', amountPesewas: 4000, feePesewas: 50, currency: 'GHS', destinationMasked: '024****567' });
      expect(JSON.stringify(out)).not.toContain('0241234567');
    });

    it('allows spending the exact balance (amount + fee)', async () => {
      await expect(svc.cashOut('s1', 4950)).resolves.toMatchObject({ amountPesewas: 4950 });
    });

    it('refuses more than the balance (amount + fee)', async () => {
      const err: any = await svc.cashOut('s1', 4951).catch((e) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getResponse().code).toBe('INSUFFICIENT_BALANCE');
      expect(tx.payoutRequest.create).not.toHaveBeenCalled();
    });

    it('refuses below the minimum, and with no destination, before touching the database', async () => {
      expect((await svc.cashOut('s1', 999).catch((e) => e)).getResponse().code).toBe('BELOW_MINIMUM');
      prisma.deliveryPartnerProfile.findUnique.mockResolvedValue({ ...profile, payoutNetwork: null, payoutNumber: null });
      expect((await svc.cashOut('s1', 2000).catch((e) => e)).getResponse().code).toBe('NO_PAYOUT_DESTINATION');
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('a FAILED cash-out gives the money back (only PENDING and PAID count)', async () => {
      tx.payoutRequest.groupBy.mockResolvedValue([{ status: 'FAILED', _sum: { amountPesewas: 9000, feePesewas: 50 } }]);
      await expect(svc.cashOut('s1', 9000)).resolves.toBeDefined();
    });
  });

  describe('payout destination', () => {
    it('needs the password, saves it and returns only the masked number', async () => {
      const out = await svc.setPayoutDestination('s1', { network: 'TELECEL', number: '0201112222', password: 'pw' });
      expect(staff.assertCurrentPassword).toHaveBeenCalledWith('s1', 'pw');
      expect(out).toEqual({ network: 'TELECEL', numberMasked: '020****222' });
    });

    it('does not save when the password is wrong', async () => {
      staff.assertCurrentPassword.mockRejectedValue(new BadRequestException('no'));
      await expect(svc.setPayoutDestination('s1', { network: 'MTN', number: '0241234567', password: 'bad' })).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.deliveryPartnerProfile.update).not.toHaveBeenCalled();
    });

    it('removing needs the password too', async () => {
      await svc.removePayoutDestination('s1', 'pw');
      expect(staff.assertCurrentPassword).toHaveBeenCalledWith('s1', 'pw');
      expect(prisma.deliveryPartnerProfile.update).toHaveBeenCalledWith({ where: { id: 'p1' }, data: { payoutNetwork: null, payoutNumber: null } });
    });
  });

  describe('ledger', () => {
    const t = (m: number) => new Date(Date.UTC(2026, 9, 24, 12, m));

    it('merges earnings and cash-outs newest first, signed in pesewas, with a cursor when there is more', async () => {
      prisma.driverEarning.findMany.mockResolvedValue([{ id: 'e2', amount: '15.00', note: 'Delivery', createdAt: t(30) }, { id: 'e1', amount: '15.00', note: null, createdAt: t(10) }]);
      prisma.payoutRequest.findMany.mockResolvedValue([{ id: 'p9', amountPesewas: 1000, feePesewas: 50, currency: 'GHS', status: 'PAID', failureReason: null, destinationMasked: '024****567', createdAt: t(20) }]);
      const page: any = await svc.ledger('s1', 2);
      expect(page.entries.map((e: any) => e.id)).toEqual(['e2', 'p9']);
      expect(page.entries[0]).toMatchObject({ type: 'EARNING', amountPesewas: 1500 });
      expect(page.entries[1]).toMatchObject({ type: 'CASH_OUT', amountPesewas: -1000, feePesewas: 50, status: 'PAID' });
      expect(page.nextCursor).toEqual(expect.any(String));
    });

    it('has no cursor on the last page, and uses the cursor to continue', async () => {
      prisma.driverEarning.findMany.mockResolvedValue([{ id: 'e1', amount: '15.00', note: null, createdAt: t(10) }]);
      const last: any = await svc.ledger('s1', 5);
      expect(last.nextCursor).toBeNull();

      const cursor = Buffer.from(`${t(20).toISOString()}|p9`).toString('base64url');
      await svc.ledger('s1', 5, cursor);
      const where = prisma.driverEarning.findMany.mock.calls.at(-1)[0].where;
      expect(where.OR).toEqual([{ createdAt: { lt: t(20) } }, { createdAt: t(20), id: { lt: 'p9' } }]);
    });

    it('rejects a garbage cursor', async () => {
      await expect(svc.ledger('s1', 5, '%%%')).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('admin', () => {
    it('marks a PENDING cash-out PAID, once', async () => {
      prisma.payoutRequest.updateMany.mockResolvedValue({ count: 1 });
      prisma.payoutRequest.findUniqueOrThrow.mockResolvedValue({ id: 'po1', status: 'PAID', amountPesewas: 1000, feePesewas: 0, currency: 'GHS', network: 'MTN', destinationMasked: 'x', createdAt: new Date() });
      await expect(svc.adminSetPayoutStatus('po1', 'PAID')).resolves.toMatchObject({ status: 'PAID' });
      expect(prisma.payoutRequest.updateMany.mock.calls[0][0].where).toEqual({ id: 'po1', status: 'PENDING' });
    });

    it('409s when already processed, 404s when unknown', async () => {
      prisma.payoutRequest.updateMany.mockResolvedValue({ count: 0 });
      prisma.payoutRequest.findUnique.mockResolvedValue({ id: 'po1' });
      await expect(svc.adminSetPayoutStatus('po1', 'FAILED')).rejects.toBeInstanceOf(ConflictException);
      prisma.payoutRequest.findUnique.mockResolvedValue(null);
      await expect(svc.adminSetPayoutStatus('nope', 'FAILED')).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
