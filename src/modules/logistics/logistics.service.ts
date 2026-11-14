import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import {
  DeliveryStatus,
  OrderStatus,
  OrderType,
  Prisma,
  StaffRole,
} from '@prisma/client';

import { PrismaService } from '../../database/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { UpdatePartnerStatusDto } from './dto/update-partner-status.dto';
import { UpdateDeliveryStatusDto } from './dto/update-delivery-status.dto';
import { DeliveryListQueryDto } from './dto/delivery-list-query.dto';
import { CLEARED_LOCATION } from './presence.service';
import * as bcrypt from 'bcrypt';
import { maskNumber } from '../../shared/mask';
import { afterCursor, toPage } from '../../shared/pagination/cursor';
import { withCustomerPhoneRule } from '../../shared/utils/customer-phone';
import { stripDeliverySecrets } from '../../shared/utils/delivery-secrets';

// Short-distance deliveries go to walking partners, longer ones need a motorcycle.
// Distance isn't tracked yet at the order level because GPS/maps are not part of
// the current MVP.
const WALKING_MAX_DISTANCE_KM = 2;

// Wrong handover-code guesses allowed before the job locks for a few minutes.
const MAX_CODE_ATTEMPTS = 5;
const CODE_LOCK_MS = 5 * 60 * 1000;

// Where a delivery may go next with PATCH /deliveries/:id/status.
// - ASSIGNED -> EN_ROUTE_TO_PICKUP is for a delivery an admin assigned to the
//   partner; unclaimed deliveries have no partnerId, so the ownership check
//   sends them through claim instead.
// - PAY_VENDOR (paying the restaurant or shop) is optional: a partner may go
//   straight from heading to the vendor to picked up, which keeps older app
//   versions working.
// - DELIVERED is not here on purpose: food deliveries only reach it by
//   verifying the customer's handover code (admin-run ones: see updateStatus).
// Anything not listed (skipping a step, going backwards, touching a DELIVERED
// or FAILED job) is rejected.
const NEXT_STATUS: Partial<Record<DeliveryStatus, DeliveryStatus[]>> = {
  [DeliveryStatus.ASSIGNED]: [DeliveryStatus.EN_ROUTE_TO_PICKUP],
  [DeliveryStatus.EN_ROUTE_TO_PICKUP]: [DeliveryStatus.PAY_VENDOR, DeliveryStatus.PICKED_UP],
  [DeliveryStatus.PAY_VENDOR]: [DeliveryStatus.PICKED_UP],
  [DeliveryStatus.PICKED_UP]: [DeliveryStatus.EN_ROUTE_TO_CUSTOMER],
};

// A partner can give up on a delivery from any in-progress stage. The order's
// status is left as-is so an admin can cancel, refund or re-dispatch it.
const FAILABLE_FROM: DeliveryStatus[] = [
  DeliveryStatus.EN_ROUTE_TO_PICKUP,
  DeliveryStatus.PAY_VENDOR,
  DeliveryStatus.PICKED_UP,
  DeliveryStatus.EN_ROUTE_TO_CUSTOMER,
];

// Deliveries that still occupy one of the partner's slots. ASSIGNED counts
// because a delivery with a partnerId in ASSIGNED was given to them by an admin.
const UNFINISHED_STATUSES: DeliveryStatus[] = [
  DeliveryStatus.ASSIGNED,
  DeliveryStatus.EN_ROUTE_TO_PICKUP,
  DeliveryStatus.PAY_VENDOR,
  DeliveryStatus.PICKED_UP,
  DeliveryStatus.EN_ROUTE_TO_CUSTOMER,
];

// Marketplace and laundry deliveries (anything that isn't a food order) are
// run by admins: they accept them like partners do and finish them without
// the customer's handover code.
function isRunByAdmin(delivery: {
  order?: { type: OrderType } | null;
}): boolean {
  return delivery.order?.type !== OrderType.FOOD;
}

const DEFAULT_MAX_ACTIVE_FOOD_DELIVERIES = 3;

// Read on each claim so the limit can be changed through the environment.
// Keep in step with MAX_ACTIVE_FOOD_JOBS in the partner app.
function maxActiveFoodDeliveries(): number {
  const fromEnv = Number.parseInt(
    process.env.MAX_ACTIVE_FOOD_DELIVERIES ?? '',
    10,
  );
  return Number.isInteger(fromEnv) && fromEnv > 0
    ? fromEnv
    : DEFAULT_MAX_ACTIVE_FOOD_DELIVERIES;
}

const JOB_ALREADY_TAKEN = {
  message: 'This delivery has already been taken',
  code: 'JOB_ALREADY_TAKEN',
};

const DELIVERY_DETAIL_INCLUDE = {
  order: {
    include: {
      customer: {
        select: {
          id: true,
          fullName: true,
          // Only kept in responses while a partner is carrying the order
          // (withCustomerPhoneRule in withStageHistory).
          phone: true,
        },
      },
      items: {
        include: {
          menuItem: true,
          product: true,
        },
      },
    },
  },
  laundryOrder: true,
  statusEvents: {
    orderBy: { createdAt: 'asc' },
  },
} satisfies Prisma.DeliveryInclude;

@Injectable()
export class LogisticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
    @Optional() private readonly settings?: SettingsService,
  ) {}

  // The partner's own profile. The full payout number never leaves the server;
  // only a masked copy is shown (the wallet endpoints manage the real one).
  // Location fields are dropped too (live location was removed).
  private publicProfile<T extends { payoutNetwork?: string | null; payoutNumber?: string | null }>(
    profile: T,
  ) {
    const { payoutNetwork, payoutNumber, ...rest } = profile as T & Record<string, unknown>;
    for (const key of Object.keys(CLEARED_LOCATION)) delete (rest as Record<string, unknown>)[key];
    return {
      ...rest,
      payoutDestination:
        payoutNetwork && payoutNumber
          ? { network: payoutNetwork, numberMasked: maskNumber(payoutNumber) }
          : null,
    };
  }

  // A delivery as the apps see it: no handover-code secrets, no location
  // (see stripDeliverySecrets), plus the timeline as [{ stage, at }], oldest
  // first. `statusEvents` is left in place for older clients.
  // The customer's phone is only kept while a partner is carrying the order.
  private withStageHistory<
    T extends {
      statusEvents?: { status: DeliveryStatus; createdAt: Date }[];
      partnerId?: string | null;
      status: DeliveryStatus;
      order?: { customer?: ({ phone?: string | null } & Record<string, unknown>) | null } | null;
    },
  >(delivery: T) {
    return {
      ...stripDeliverySecrets(withCustomerPhoneRule(delivery)),
      stageHistory: (delivery.statusEvents ?? []).map((e) => ({
        stage: e.status,
        at: e.createdAt,
      })),
    };
  }

  /**
   * One delivery, with its stage history. An admin can open any delivery (for
   * support). A partner can open their own, or a food job that is still
   * waiting to be taken (so tapping a "new delivery" push can open it).
   * Anything else answers "not found", so ids cannot be probed.
   */
  async findOne(id: string, userId: string, role?: string) {
    const delivery = await this.prisma.delivery.findUnique({
      where: { id },
      include: {
        ...DELIVERY_DETAIL_INCLUDE,
        partner: { select: { id: true, staffUserId: true } },
      },
    });
    if (!delivery) throw new NotFoundException('Delivery not found');

    if (role !== StaffRole.ADMIN) {
      const mine = delivery.partner?.staffUserId === userId;
      const open =
        !delivery.partnerId &&
        delivery.status === DeliveryStatus.ASSIGNED &&
        delivery.order?.type === OrderType.FOOD;
      if (!mine && !open) throw new NotFoundException('Delivery not found');
    }

    return this.withStageHistory(delivery);
  }

  /**
   * The signed-in partner's own profile (used by the app on start-up and for
   * the online switch).
   */
  async getMyProfile(userId: string) {
    const profile =
      await this.prisma.deliveryPartnerProfile.findUnique({
        where: { staffUserId: userId },
        include: {
          staffUser: {
            select: {
              id: true,
              fullName: true,
              email: true,
              phone: true,
              role: true,
            },
          },
        },
      });

    if (!profile) {
      throw new NotFoundException(
        'You are not registered as a delivery partner',
      );
    }

    return this.publicProfile(profile);
  }

  // Tells Notifications that a delivery moved forward, so the customer can be
  // pushed. Called after the database transaction has committed.
  private emitStatusUpdated(
    delivery: {
      id: string;
      status: DeliveryStatus;
      orderId: string | null;
      laundryOrderId: string | null;
    },
    customerId?: string | null,
  ) {
    if (!customerId) return;
    this.events.emit('delivery.status.updated', {
      deliveryId: delivery.id,
      status: delivery.status,
      customerId,
      orderId: delivery.orderId ?? undefined,
      laundryOrderId: delivery.laundryOrderId ?? undefined,
    });
  }

  /**
   * Creates a delivery after a successful payment.
   *
   * This is kept for the eventual real payment flow.
   * The check prevents duplicate deliveries because FOOD orders currently
   * create their delivery directly when the order is created.
   */
  @OnEvent('payment.successful')
  async handlePaymentSuccessful(payment: {
    orderId?: string;
    laundryOrderId?: string;
  }) {
    if (payment.orderId) {
      const existing = await this.prisma.delivery.findUnique({
        where: {
          orderId: payment.orderId,
        },
      });

      if (!existing) {
        const created = await this.prisma.delivery.create({
          data: {
            orderId: payment.orderId,
            status: DeliveryStatus.ASSIGNED,
          },
        });
        this.events.emit('delivery.created', {
          deliveryId: created.id,
          orderId: payment.orderId,
        });
      }
    } else if (payment.laundryOrderId) {
      const existing = await this.prisma.delivery.findUnique({
        where: {
          laundryOrderId: payment.laundryOrderId,
        },
      });

      if (!existing) {
        const created = await this.prisma.delivery.create({
          data: {
            laundryOrderId: payment.laundryOrderId,
            status: DeliveryStatus.ASSIGNED,
          },
        });
        this.events.emit('delivery.created', {
          deliveryId: created.id,
          laundryOrderId: payment.laundryOrderId,
        });
      }
    }
  }

  determinePartnerType(
    distanceKm: number,
  ): 'WALKING' | 'MOTORCYCLE' {
    return distanceKm <= WALKING_MAX_DISTANCE_KM
      ? 'WALKING'
      : 'MOTORCYCLE';
  }

  /**
   * Returns deliveries that have not yet been claimed.
   *
   * Delivery partners only ever see FOOD deliveries. Admins see every
   * unclaimed delivery, including the marketplace and laundry ones they run.
   * Without paging options the answer is the plain array older apps expect.
   */
  async findUnassigned(role?: string, query: DeliveryListQueryDto = {}) {
    const rows = await this.prisma.delivery.findMany({
      where: {
        partnerId: null,
        claimedByStaffId: null,
        status: DeliveryStatus.ASSIGNED,
        ...(role === StaffRole.ADMIN
          ? {}
          : { order: { type: OrderType.FOOD } }),
        ...(query.cursor ? afterCursor(query.cursor, 'asc') : {}),
      },
      ...(query.limit ? { take: query.limit + 1 } : {}),
      include: {
        order: {
          include: {
            customer: {
              select: {
                id: true,
                fullName: true,
              },
            },
            items: {
              include: {
                menuItem: true,
                product: true,
              },
            },
          },
        },
        laundryOrder: true,
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });

    const safe = rows.map((d) => stripDeliverySecrets(d));
    return query.limit || query.cursor ? toPage(safe, query.limit ?? 20) : safe;
  }

  /**
   * A delivery partner claims a food delivery, or an admin a marketplace or
   * laundry one. Two people tapping Accept at the same moment: exactly one
   * wins, the other gets 409 JOB_ALREADY_TAKEN.
   */
  async claim(
    deliveryId: string,
    userId: string,
    role?: string,
  ) {
    const delivery =
      await this.prisma.delivery.findUnique({
        where: {
          id: deliveryId,
        },
        include: {
          order: { select: { type: true } },
        },
      });

    if (!delivery) {
      throw new NotFoundException(
        'Delivery not found',
      );
    }

    const runByAdmin = isRunByAdmin(delivery);

    // Delivery partners can only take food deliveries. Marketplace and
    // laundry deliveries are handled by admins.
    if (runByAdmin && role !== StaffRole.ADMIN) {
      throw new ForbiddenException(
        'Only food deliveries can be claimed by delivery partners',
      );
    }

    const profile = runByAdmin
      ? null
      : await this.prisma.deliveryPartnerProfile.findUnique({
          where: {
            staffUserId: userId,
          },
        });

    if (!runByAdmin && !profile) {
      throw new NotFoundException(
        'You are not registered as a delivery partner',
      );
    }

    // 409 so the app can tell "someone else got it" apart from other errors.
    if (
      delivery.partnerId ||
      delivery.claimedByStaffId ||
      delivery.status !== DeliveryStatus.ASSIGNED
    ) {
      throw new ConflictException(JOB_ALREADY_TAKEN);
    }

    const claimed = await this.prisma.$transaction(
      async (tx) => {
        if (profile && role !== StaffRole.ADMIN) {
          // Lock this partner's profile row so two claims sent at the same
          // moment by the same partner run one after the other, and the
          // second one sees the first in its count.
          await tx.$queryRaw`SELECT id FROM "delivery_partner_profiles" WHERE id = ${profile.id} FOR UPDATE`;

          const max = maxActiveFoodDeliveries();
          const activeFood = await tx.delivery.count({
            where: {
              partnerId: profile.id,
              status: { in: UNFINISHED_STATUSES },
              order: { type: OrderType.FOOD },
            },
          });

          if (activeFood >= max) {
            throw new BadRequestException(
              `You can carry up to ${max} food orders at once. Finish one before accepting another.`,
            );
          }
        }

        // Only take the delivery if it is still unclaimed. If two people
        // claim at once, Postgres re-checks this condition for the second
        // one after the first commits, so only one update succeeds.
        const taken = await tx.delivery.updateMany({
          where: profile
            ? {
                id: deliveryId,
                partnerId: null,
                status: DeliveryStatus.ASSIGNED,
              }
            : {
                id: deliveryId,
                partnerId: null,
                claimedByStaffId: null,
                status: DeliveryStatus.ASSIGNED,
              },
          data: profile
            ? {
                partnerId: profile.id,
                status: DeliveryStatus.EN_ROUTE_TO_PICKUP,
              }
            : {
                claimedByStaffId: userId,
                status: DeliveryStatus.EN_ROUTE_TO_PICKUP,
              },
        });

        if (taken.count !== 1) {
          throw new ConflictException(JOB_ALREADY_TAKEN);
        }

        if (delivery.orderId) {
          await tx.order.update({
            where: {
              id: delivery.orderId,
            },
            data: {
              status: OrderStatus.PREPARING,
            },
          });
        }

        await tx.deliveryStatusEvent.create({
          data: {
            deliveryId,
            status: DeliveryStatus.EN_ROUTE_TO_PICKUP,
          },
        });

        return tx.delivery.findUniqueOrThrow({
          where: { id: deliveryId },
          include: DELIVERY_DETAIL_INCLUDE,
        });
      },
    );

    this.emitStatusUpdated(
      claimed,
      claimed.order?.customer?.id ?? claimed.laundryOrder?.customerId,
    );
    // Lets Notifications remove the other partners' now-stale job alerts.
    this.events.emit('delivery.claimed', { deliveryId, staffUserId: userId });

    return this.withStageHistory(claimed);
  }

  async verifyDeliveryCode(
    deliveryId: string,
    code: string,
    userId: string,
  ) {
    const profile =
      await this.prisma.deliveryPartnerProfile.findUnique({
        where: {
          staffUserId: userId,
        },
      });

    if (!profile) {
      throw new NotFoundException(
        'You are not registered as a delivery partner',
      );
    }

    const delivery =
      await this.prisma.delivery.findUnique({
        where: {
          id: deliveryId,
        },
        include: {
          order: { select: { customerId: true } },
          laundryOrder: { select: { customerId: true } },
        },
      });

    if (!delivery) {
      throw new NotFoundException(
        'Delivery not found',
      );
    }

    if (delivery.partnerId !== profile.id) {
      throw new ForbiddenException(
        'You are not assigned to this delivery',
      );
    }

    if (delivery.deliveryCodeUsed) {
      throw new BadRequestException(
        'This delivery code has already been used',
      );
    }

    // The code is only checked at the customer, after pickup. This stops a
    // partner marking a job delivered straight after accepting it.
    if (
      delivery.status !== DeliveryStatus.PICKED_UP &&
      delivery.status !== DeliveryStatus.EN_ROUTE_TO_CUSTOMER
    ) {
      throw new BadRequestException(
        `Cannot verify the code while the delivery is ${delivery.status}`,
      );
    }

    if (!delivery.deliveryCodeHash) {
      throw new BadRequestException(
        'No delivery verification code exists',
      );
    }

    const now = new Date();

    if (
      delivery.deliveryCodeLockedUntil &&
      delivery.deliveryCodeLockedUntil > now
    ) {
      throw new BadRequestException(
        'Delivery code verification is temporarily locked',
      );
    }

    // A lock that has run out starts a fresh set of attempts.
    if (delivery.deliveryCodeLockedUntil) {
      await this.prisma.delivery.updateMany({
        where: {
          id: deliveryId,
          deliveryCodeLockedUntil: { lte: now },
        },
        data: {
          deliveryCodeAttempts: 0,
          deliveryCodeLockedUntil: null,
        },
      });
    }

    // Count the attempt BEFORE comparing, in one atomic step, so many
    // guesses sent at once cannot all slip past the limit.
    const { deliveryCodeAttempts: attempts } =
      await this.prisma.delivery.update({
        where: { id: deliveryId },
        data: { deliveryCodeAttempts: { increment: 1 } },
        select: { deliveryCodeAttempts: true },
      });

    if (attempts > MAX_CODE_ATTEMPTS) {
      await this.prisma.delivery.update({
        where: { id: deliveryId },
        data: {
          deliveryCodeLockedUntil: new Date(Date.now() + CODE_LOCK_MS),
        },
      });
      throw new BadRequestException(
        'Too many incorrect attempts. Try again in 5 minutes.',
      );
    }

    const valid = await bcrypt.compare(
      code,
      delivery.deliveryCodeHash,
    );

    if (!valid) {
      if (attempts >= MAX_CODE_ATTEMPTS) {
        await this.prisma.delivery.update({
          where: { id: deliveryId },
          data: {
            deliveryCodeLockedUntil: new Date(Date.now() + CODE_LOCK_MS),
          },
        });
        throw new BadRequestException(
          'Too many incorrect attempts. Try again in 5 minutes.',
        );
      }
      throw new BadRequestException('Invalid delivery code');
    }

    // Read before the transaction: an admin setting, default 15.
    const earningAmount = this.settings
      ? await this.settings.get('partnerEarningPerDelivery')
      : 15;

    const verified = await this.prisma.$transaction(
      async (tx) => {
        // Only the first successful verification wins; a repeat or a
        // parallel request matches nothing and gets a 409.
        const done = await tx.delivery.updateMany({
          where: {
            id: deliveryId,
            partnerId: profile.id,
            deliveryCodeUsed: false,
          },
          data: {
            status: DeliveryStatus.DELIVERED,
            deliveryCodeUsed: true,
            deliveryCodeAttempts: 0,
            verifiedAt: new Date(),
          },
        });

        if (done.count === 0) {
          throw new ConflictException({
            message: 'This delivery was already completed',
            code: 'JOB_ALREADY_COMPLETED',
          });
        }

        const updated =
          await tx.delivery.findUniqueOrThrow({
            where: { id: deliveryId },
          });

        if (delivery.orderId) {
          await tx.order.update({
            where: {
              id: delivery.orderId,
            },
            data: {
              status: OrderStatus.DELIVERED,
            },
          });
        }

        await tx.deliveryStatusEvent.create({
          data: {
            deliveryId,
            status: DeliveryStatus.DELIVERED,
          },
        });

        if (delivery.partnerId) {
          const existingEarning =
            await tx.driverEarning.findFirst({
              where: {
                partnerId: delivery.partnerId,
                note: `Delivery ${deliveryId}`,
              },
            });

          if (!existingEarning) {
            await tx.driverEarning.create({
              data: {
                partnerId: delivery.partnerId,
                amount: earningAmount,
                note: `Delivery ${deliveryId}`,
              },
            });
          }
        }

        return updated;
      },
    );

    this.emitStatusUpdated(
      verified,
      delivery.order?.customerId ?? delivery.laundryOrder?.customerId,
    );

    return stripDeliverySecrets(verified);
  }

  /**
   * Moves a delivery to its next stage, or to FAILED from any in-progress
   * stage. Only the person who accepted it may move it.
   */
  async updateStatus(
    deliveryId: string,
    dto: UpdateDeliveryStatusDto,
    userId?: string,
    role?: string,
  ) {
    const delivery =
      await this.prisma.delivery.findUnique({
        where: {
          id: deliveryId,
        },
        include: {
          order: { select: { type: true } },
        },
      });

    if (!delivery) {
      throw new NotFoundException(
        'Delivery not found',
      );
    }

    const runByAdmin = isRunByAdmin(delivery);

    if (userId) {
      await this.assertHandledBy(delivery, userId, role);
    }

    // A repeated tap (slow network, double press) is not an error.
    if (delivery.status === dto.status) {
      return stripDeliverySecrets(delivery);
    }

    // Admin-run deliveries have no handover code for now, so the admin
    // finishes them here. Food deliveries finish only through verify-code.
    const allowed: DeliveryStatus[] = [
      ...(NEXT_STATUS[delivery.status] ?? []),
      ...(runByAdmin && delivery.status === DeliveryStatus.EN_ROUTE_TO_CUSTOMER
        ? [DeliveryStatus.DELIVERED]
        : []),
      ...(FAILABLE_FROM.includes(delivery.status) ? [DeliveryStatus.FAILED] : []),
    ];

    if (!allowed.includes(dto.status)) {
      throw new BadRequestException({
        message: `Cannot change a delivery from ${delivery.status} to ${dto.status}`,
        code: 'INVALID_STAGE_TRANSITION',
        allowed,
      });
    }

    const orderStatusMap: Partial<
      Record<DeliveryStatus, OrderStatus>
    > = {
      [DeliveryStatus.EN_ROUTE_TO_PICKUP]:
        OrderStatus.PREPARING,

      [DeliveryStatus.PICKED_UP]:
        OrderStatus.OUT_FOR_DELIVERY,

      [DeliveryStatus.EN_ROUTE_TO_CUSTOMER]:
        OrderStatus.OUT_FOR_DELIVERY,

      // Only reachable for admin-run (marketplace) deliveries; food orders
      // are marked delivered in verifyDeliveryCode.
      [DeliveryStatus.DELIVERED]:
        OrderStatus.DELIVERED,
    };

    const orderStatus =
      orderStatusMap[dto.status];

    const result =
      await this.prisma.$transaction(
        async (tx) => {
          // Only move the delivery if nobody changed it since we read it.
          const moved = await tx.delivery.updateMany({
            where: {
              id: deliveryId,
              status: delivery.status,
            },
            data: {
              status: dto.status,
            },
          });

          if (moved.count === 0) {
            throw new ConflictException({
              message: 'Delivery status has changed. Refresh and try again.',
              code: 'DELIVERY_STATE_CHANGED',
            });
          }

          await tx.deliveryStatusEvent.create({
            data: {
              deliveryId,
              status: dto.status,
            },
          });

          const updated =
            await tx.delivery.findUniqueOrThrow({
              where: {
                id: deliveryId,
              },
              include: DELIVERY_DETAIL_INCLUDE,
            });

          if (
            delivery.orderId &&
            orderStatus
          ) {
            await tx.order.update({
              where: {
                id: delivery.orderId,
              },
              data: {
                status: orderStatus,
              },
            });
          }

          return updated;
        },
      );

    this.emitStatusUpdated(
      result,
      result.order?.customer?.id ?? result.laundryOrder?.customerId,
    );

    return this.withStageHistory(result);
  }

  /**
   * Makes sure the caller is the person who accepted this delivery:
   * the admin for marketplace/laundry, the partner for food. 403 otherwise.
   */
  private async assertHandledBy(
    delivery: {
      partnerId: string | null;
      claimedByStaffId: string | null;
      order?: { type: OrderType } | null;
    },
    userId: string,
    role?: string,
  ) {
    if (isRunByAdmin(delivery)) {
      if (role !== StaffRole.ADMIN) {
        throw new ForbiddenException(
          'Marketplace and laundry deliveries are handled by admins',
        );
      }

      if (delivery.claimedByStaffId !== userId) {
        throw new ForbiddenException(
          'You are not assigned to this delivery',
        );
      }
      return;
    }

    const profile =
      await this.prisma.deliveryPartnerProfile.findUnique({
        where: {
          staffUserId: userId,
        },
      });

    if (!profile) {
      throw new NotFoundException(
        'You are not registered as a delivery partner',
      );
    }

    if (delivery.partnerId !== profile.id) {
      throw new ForbiddenException(
        'You are not assigned to this delivery',
      );
    }
  }

  /**
   * Updates whether the delivery partner is available. Going online counts
   * as being seen right now; going offline clears any stored location.
   */
  async updatePartnerStatus(
    userId: string,
    dto: UpdatePartnerStatusDto,
  ) {
    const profile =
      await this.prisma.deliveryPartnerProfile.findUnique(
        {
          where: {
            staffUserId: userId,
          },
        },
      );

    if (!profile) {
      throw new NotFoundException(
        'You are not registered as a delivery partner',
      );
    }

    const updated = await this.prisma.deliveryPartnerProfile.update({
      where: {
        staffUserId: userId,
      },
      data: {
        // Only the online switch is handled here; other profile fields go
        // through ProfileService, which checks them.
        ...(dto.isAvailable !== undefined ? { isAvailable: dto.isAvailable } : {}),
        ...(dto.isAvailable === true ? { lastSeenAt: new Date() } : {}),
        ...(dto.isAvailable === false ? CLEARED_LOCATION : {}),
      },
    });

    return this.publicProfile(updated);
  }

  /**
   * Returns deliveries assigned to the current partner, or for an admin,
   * the marketplace and laundry deliveries they accepted. Optional filters:
   * status, updatedSince, and cursor paging (which switches the answer to
   * { items, nextCursor }).
   */
  async myDeliveries(userId: string, role?: string, query: DeliveryListQueryDto = {}) {
    let owner: Prisma.DeliveryWhereInput;

    if (role === StaffRole.ADMIN) {
      owner = { claimedByStaffId: userId };
    } else {
      const profile =
        await this.prisma.deliveryPartnerProfile.findUnique(
          {
            where: {
              staffUserId: userId,
            },
          },
        );

      if (!profile) {
        throw new NotFoundException(
          'You are not registered as a delivery partner',
        );
      }

      owner = { partnerId: profile.id };
    }

    const rows = await this.prisma.delivery.findMany({
      where: {
        ...owner,
        ...(query.status?.length ? { status: { in: query.status } } : {}),
        ...(query.updatedSince
          ? { updatedAt: { gt: new Date(query.updatedSince) } }
          : {}),
        ...(query.cursor ? afterCursor(query.cursor, 'desc') : {}),
      },
      ...(query.limit ? { take: query.limit + 1 } : {}),
      include: DELIVERY_DETAIL_INCLUDE,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });

    const shaped = rows.map((d) => this.withStageHistory(d));

    // No paging asked for: the plain array the app already understands.
    return query.limit || query.cursor ? toPage(shaped, query.limit ?? 20) : shaped;
  }

  /**
   * Returns the partner's earnings, in cedis and in pesewas.
   */
  async myEarnings(userId: string) {
    const profile =
      await this.prisma.deliveryPartnerProfile.findUnique(
        {
          where: {
            staffUserId: userId,
          },
        },
      );

    if (!profile) {
      throw new NotFoundException(
        'You are not registered as a delivery partner',
      );
    }

    const earnings =
      await this.prisma.driverEarning.findMany({
        where: {
          partnerId: profile.id,
        },
        orderBy: {
          createdAt: 'desc',
        },
      });

    const total = earnings.reduce(
      (sum, earning) =>
        sum + Number(earning.amount),
      0,
    );

    return {
      total,
      totalPesewas: earnings.reduce(
        (sum, earning) => sum + Math.round(Number(earning.amount) * 100),
        0,
      ),
      currency: 'GHS',
      earnings: earnings.map((earning) => ({
        ...earning,
        amountPesewas: Math.round(Number(earning.amount) * 100),
      })),
    };
  }
}
