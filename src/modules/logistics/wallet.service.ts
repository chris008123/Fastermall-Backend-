import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PayoutStatus } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { maskNumber } from '../../shared/mask';
import { StaffService } from '../staff/staff.service';
import { afterCursor, encodeCursor } from '../../shared/pagination/cursor';
import { SetPayoutDestinationDto } from './dto/set-payout-destination.dto';

/** A Decimal (GHS, 2 places) as whole pesewas. */
export function toPesewas(value: { toString(): string } | number | string | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return Math.round(Number(value.toString()) * 100);
}

/**
 * The delivery partner's wallet. All money here is whole pesewas
 * (GHS 25.50 = 2550) with a currency code, never a floating-point amount.
 *
 * balance = everything earned
 *           - cash-outs that are PENDING or PAID (amount + fee)
 *           - payouts an admin recorded by hand
 * A FAILED cash-out gives its money back.
 */
@Injectable()
export class WalletService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly staff: StaffService,
  ) {}

  private get currency() {
    return this.config.get<string>('wallet.currency') ?? 'GHS';
  }
  private get minCashOut() {
    return this.config.get<number>('wallet.minCashOutPesewas') ?? 1000;
  }
  private get fee() {
    return this.config.get<number>('wallet.cashOutFeePesewas') ?? 0;
  }

  private async profileFor(userId: string) {
    const profile = await this.prisma.deliveryPartnerProfile.findUnique({
      where: { staffUserId: userId },
    });
    if (!profile) {
      throw new NotFoundException('You are not registered as a delivery partner');
    }
    return profile;
  }

  /**
   * The partner's money, in pesewas. Payouts an admin recorded by hand
   * (POST /admin/partners/:id/payouts, PartnerPayout) count as paid out too,
   * so the same money can never be cashed out twice. AdminService uses the
   * same rule for the balance it shows and checks.
   */
  private async figures(partnerId: string, db: any = this.prisma) {
    const [earned, payouts, recorded] = await Promise.all([
      db.driverEarning.aggregate({ where: { partnerId }, _sum: { amount: true } }),
      db.payoutRequest.groupBy({
        by: ['status'],
        where: { partnerId },
        _sum: { amountPesewas: true, feePesewas: true },
      }),
      db.partnerPayout.aggregate({ where: { partnerId }, _sum: { amount: true } }),
    ]);

    const spent = (status: PayoutStatus) => {
      const row = payouts.find((p: any) => p.status === status);
      return (row?._sum.amountPesewas ?? 0) + (row?._sum.feePesewas ?? 0);
    };

    const earnedPesewas = toPesewas(earned._sum.amount);
    const pendingPesewas = spent('PENDING' as PayoutStatus);
    const recordedPayoutsPesewas = toPesewas(recorded?._sum?.amount);
    const paidOutPesewas = spent('PAID' as PayoutStatus) + recordedPayoutsPesewas;

    return {
      earnedPesewas,
      pendingPesewas,
      paidOutPesewas,
      recordedPayoutsPesewas,
      balancePesewas: earnedPesewas - pendingPesewas - paidOutPesewas,
    };
  }

  async getWallet(userId: string) {
    const profile = await this.profileFor(userId);
    const f = await this.figures(profile.id);
    return {
      currency: this.currency,
      ...f,
      minCashOutPesewas: this.minCashOut,
      cashOutFeePesewas: this.fee,
      payoutDestination: this.destinationOf(profile),
    };
  }

  /** Earnings and cash-outs together, newest first, with cursor paging. */
  async ledger(userId: string, limit = 20, cursor?: string) {
    const profile = await this.profileFor(userId);
    const take = limit + 1;

    const where: any = {
      partnerId: profile.id,
      ...(cursor ? afterCursor(cursor, 'desc') : {}),
    };
    const orderBy = [{ createdAt: 'desc' as const }, { id: 'desc' as const }];

    const [earnings, payouts, recorded] = await Promise.all([
      this.prisma.driverEarning.findMany({ where, orderBy, take }),
      this.prisma.payoutRequest.findMany({ where, orderBy, take }),
      this.prisma.partnerPayout.findMany({ where, orderBy, take }),
    ]);

    const merged = [
      ...earnings.map((e) => ({
        id: e.id,
        type: 'EARNING' as const,
        amountPesewas: toPesewas(e.amount),
        feePesewas: 0,
        currency: this.currency,
        status: 'COMPLETED',
        note: e.note ?? null,
        createdAt: e.createdAt,
      })),
      ...payouts.map((p) => ({
        id: p.id,
        type: 'CASH_OUT' as const,
        amountPesewas: -p.amountPesewas,
        feePesewas: p.feePesewas,
        currency: p.currency,
        status: p.status as string,
        note: p.failureReason ?? p.destinationMasked,
        createdAt: p.createdAt,
      })),
      // Money an admin sent and recorded by hand.
      ...(recorded ?? []).map((r: any) => ({
        id: r.id,
        type: 'PAYOUT' as const,
        amountPesewas: -toPesewas(r.amount),
        feePesewas: 0,
        currency: this.currency,
        status: 'PAID',
        note: r.note ?? r.reference ?? null,
        createdAt: r.createdAt,
      })),
    ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1));

    const page = merged.slice(0, limit);
    const last = page[page.length - 1];

    return {
      entries: page,
      nextCursor: merged.length > limit && last ? encodeCursor(last.createdAt, last.id) : null,
    };
  }

  private destinationOf(profile: { payoutNetwork: string | null; payoutNumber: string | null }) {
    if (!profile.payoutNetwork || !profile.payoutNumber) return null;
    return { network: profile.payoutNetwork, numberMasked: maskNumber(profile.payoutNumber) };
  }

  async getPayoutDestination(userId: string) {
    return this.destinationOf(await this.profileFor(userId));
  }

  async setPayoutDestination(userId: string, dto: SetPayoutDestinationDto) {
    const profile = await this.profileFor(userId);
    await this.staff.assertCurrentPassword(userId, dto.password);
    const updated = await this.prisma.deliveryPartnerProfile.update({
      where: { id: profile.id },
      data: { payoutNetwork: dto.network, payoutNumber: dto.number },
    });
    return this.destinationOf(updated);
  }

  async removePayoutDestination(userId: string, password: string) {
    const profile = await this.profileFor(userId);
    await this.staff.assertCurrentPassword(userId, password);
    await this.prisma.deliveryPartnerProfile.update({
      where: { id: profile.id },
      data: { payoutNetwork: null, payoutNumber: null },
    });
    return { removed: true };
  }

  /**
   * Starts a cash-out. The partner row is locked while the balance is checked
   * and the request written, so two cash-outs at the same moment cannot spend
   * the same money.
   */
  async cashOut(userId: string, amountPesewas: number) {
    const profile = await this.profileFor(userId);

    if (!profile.payoutNetwork || !profile.payoutNumber) {
      throw new BadRequestException({
        message: 'Add a payout destination before cashing out',
        code: 'NO_PAYOUT_DESTINATION',
      });
    }

    if (amountPesewas < this.minCashOut) {
      throw new BadRequestException({
        message: `The smallest cash-out is ${this.minCashOut} pesewas`,
        code: 'BELOW_MINIMUM',
      });
    }

    const fee = this.fee;

    const payout = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM delivery_partner_profiles WHERE id = ${profile.id} FOR UPDATE`;

      const { balancePesewas } = await this.figures(profile.id, tx);

      if (amountPesewas + fee > balancePesewas) {
        throw new BadRequestException({
          message: 'Your balance is too low for this cash-out',
          code: 'INSUFFICIENT_BALANCE',
        });
      }

      return tx.payoutRequest.create({
        data: {
          partnerId: profile.id,
          amountPesewas,
          feePesewas: fee,
          currency: this.currency,
          network: profile.payoutNetwork!,
          destinationNumber: profile.payoutNumber!,
          destinationMasked: maskNumber(profile.payoutNumber!),
        },
      });
    });

    return this.toView(payout);
  }

  private toView(p: any) {
    return {
      id: p.id,
      amountPesewas: p.amountPesewas,
      feePesewas: p.feePesewas,
      currency: p.currency,
      status: p.status,
      network: p.network,
      destinationMasked: p.destinationMasked,
      failureReason: p.failureReason ?? null,
      createdAt: p.createdAt,
    };
  }

  // ---- Admin: process cash-outs --------------------------------------

  async adminListPayouts(status?: PayoutStatus, limit = 50) {
    const rows = await this.prisma.payoutRequest.findMany({
      where: status ? { status } : {},
      orderBy: { createdAt: 'asc' },
      take: limit,
      include: {
        partner: { include: { staffUser: { select: { fullName: true, phone: true } } } },
      },
    });
    // Admins need the full number to send the money.
    return rows.map((p) => ({
      ...this.toView(p),
      destinationNumber: p.destinationNumber,
      partnerName: p.partner.staffUser.fullName,
      partnerPhone: p.partner.staffUser.phone,
    }));
  }

  /** Marks a PENDING cash-out PAID or FAILED. FAILED gives the money back. */
  async adminSetPayoutStatus(id: string, status: 'PAID' | 'FAILED', failureReason?: string) {
    const changed = await this.prisma.payoutRequest.updateMany({
      where: { id, status: 'PENDING' as PayoutStatus },
      data: { status: status as PayoutStatus, failureReason: status === 'FAILED' ? (failureReason ?? 'Payment failed') : null },
    });

    if (changed.count === 0) {
      const exists = await this.prisma.payoutRequest.findUnique({ where: { id }, select: { id: true } });
      if (!exists) throw new NotFoundException('Cash-out not found');
      throw new ConflictException({
        message: 'This cash-out was already processed',
        code: 'PAYOUT_ALREADY_PROCESSED',
      });
    }

    return this.toView(await this.prisma.payoutRequest.findUniqueOrThrow({ where: { id } }));
  }
}
