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
import * as bcrypt from 'bcrypt';
import {
  stripDeliveriesSecrets,
  stripDeliverySecrets,
} from '../../shared/utils/delivery-secrets';
// Short-distance deliveries go to walking partners, longer ones need a motorcycle.
// Distance isn't tracked yet at the order level because GPS/maps are not part of
// the current MVP.
const WALKING_MAX_DISTANCE_KM = 2;

// The only forward moves a partner can make with PATCH /deliveries/:id/status.
// DELIVERED only comes from verify-code, so it never appears as a target here.
// ASSIGNED -> EN_ROUTE_TO_PICKUP is for a delivery an admin assigned to the
// partner; unclaimed deliveries have no partnerId, so the ownership check in
// updateStatus sends them through claim instead. Anything not listed (skipping
// a step, going backwards, touching a DELIVERED or FAILED job) is rejected.
const NEXT_STATUS: Partial<Record<DeliveryStatus, DeliveryStatus>> = {
  [DeliveryStatus.ASSIGNED]: DeliveryStatus.EN_ROUTE_TO_PICKUP,
  [DeliveryStatus.EN_ROUTE_TO_PICKUP]: DeliveryStatus.PICKED_UP,
  [DeliveryStatus.PICKED_UP]: DeliveryStatus.EN_ROUTE_TO_CUSTOMER,
};

// A partner can give up on a delivery from any in-progress stage. The order's
// status is left as-is so an admin can cancel, refund or re-dispatch it.
const FAILABLE_FROM: DeliveryStatus[] = [
  DeliveryStatus.EN_ROUTE_TO_PICKUP,
  DeliveryStatus.PICKED_UP,
  DeliveryStatus.EN_ROUTE_TO_CUSTOMER,
];

// Deliveries that still occupy one of the partner's slots. ASSIGNED counts
// because a delivery with a partnerId in ASSIGNED was given to them by an admin.
const UNFINISHED_STATUSES: DeliveryStatus[] = [
  DeliveryStatus.ASSIGNED,
  DeliveryStatus.EN_ROUTE_TO_PICKUP,
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

const DELIVERY_DETAIL_INCLUDE = {
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
} satisfies Prisma.DeliveryInclude;

@Injectable()
export class LogisticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
    @Optional() private readonly settings?: SettingsService,
  ) {}

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
   * Delivery partners only ever see FOOD deliveries. Marketplace and
   * laundry deliveries are visible to admins only.
   */
  async findUnassigned(role?: string) {
    const rows = await this.prisma.delivery.findMany({
      where: {
        partnerId: null,
        claimedByStaffId: null,
        status: DeliveryStatus.ASSIGNED,
        ...(role === StaffRole.ADMIN
          ? {}
          : { order: { type: OrderType.FOOD } }),
      },
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
      orderBy: {
        createdAt: 'asc',
      },
    });
    return stripDeliveriesSecrets(rows);
  }

  /**
   * Accepts a delivery.
   *
   * Food deliveries are claimed by delivery partners (at most a few at once).
   * Marketplace and laundry deliveries are run by admins, who accept them the
   * same way but have no partner profile, so the admin's own id is recorded.
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
    if (delivery.partnerId || delivery.claimedByStaffId) {
      throw new ConflictException(
        'This delivery has already been claimed',
      );
    }

    if (delivery.status !== DeliveryStatus.ASSIGNED) {
      throw new ConflictException(
        'This delivery is no longer available',
      );
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
          throw new ConflictException(
            'This delivery has already been claimed',
          );
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

    return stripDeliverySecrets(claimed);
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
      throw new BadRequestException(
        'You are not assigned to this delivery',
      );
    }

    if (delivery.deliveryCodeUsed) {
      throw new BadRequestException(
        'This delivery code has already been used',
      );
    }

    if (
      delivery.deliveryCodeLockedUntil &&
      delivery.deliveryCodeLockedUntil > new Date()
    ) {
      throw new BadRequestException(
        'Delivery code verification is temporarily locked',
      );
    }

    if (!delivery.deliveryCodeHash) {
      throw new BadRequestException(
        'No delivery verification code exists',
      );
    }

    const valid = await bcrypt.compare(
      code,
      delivery.deliveryCodeHash,
    );

    if (!valid) {
      const attempts =
        delivery.deliveryCodeAttempts + 1;

      await this.prisma.delivery.update({
        where: {
          id: deliveryId,
        },
        data: {
          deliveryCodeAttempts: attempts,
          deliveryCodeLockedUntil:
            attempts >= 5
              ? new Date(Date.now() + 5 * 60 * 1000)
              : null,
        },
      });

      throw new BadRequestException(
        attempts >= 5
          ? 'Too many incorrect attempts. Try again in 5 minutes.'
          : 'Invalid delivery code',
      );
    }

    // Read before the transaction: an admin setting, default 15.
    const earningAmount = this.settings ? await this.settings.get('partnerEarningPerDelivery') : 15;

    const verified = await this.prisma.$transaction(
      async (tx) => {
        const updated =
          await tx.delivery.update({
            where: {
              id: deliveryId,
            },
            data: {
              status: DeliveryStatus.DELIVERED,
              deliveryCodeUsed: true,
              verifiedAt: new Date(),
            },
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
   * Updates the status of a delivery.
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
    const isAllowedFinish =
      runByAdmin &&
      delivery.status === DeliveryStatus.EN_ROUTE_TO_CUSTOMER &&
      dto.status === DeliveryStatus.DELIVERED;
    const isAllowedStep =
      NEXT_STATUS[delivery.status] === dto.status || isAllowedFinish;
    const isAllowedFailure =
      dto.status === DeliveryStatus.FAILED &&
      FAILABLE_FROM.includes(delivery.status);

    if (!isAllowedStep && !isAllowedFailure) {
      throw new BadRequestException(
        `Cannot change a delivery from ${delivery.status} to ${dto.status}`,
      );
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
            throw new BadRequestException(
              'Delivery status has changed. Refresh and try again.',
            );
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
                statusEvents: {
                  orderBy: { createdAt: 'asc' },
                },
              },
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

    return stripDeliverySecrets(result);
  }

  /**
   * Makes sure the caller is the person who accepted this delivery:
   * the admin for marketplace/laundry, the partner for food.
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
        throw new BadRequestException(
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
      throw new BadRequestException(
        'You are not assigned to this delivery',
      );
    }
  }

  /**
   * Updates whether the delivery partner is available.
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

    return this.prisma.deliveryPartnerProfile.update({
      where: {
        staffUserId: userId,
      },
      data: dto,
    });
  }

  /**
   * Returns deliveries assigned to the current partner, or for an admin,
   * the marketplace and laundry deliveries they accepted.
   */
  async myDeliveries(userId: string, role?: string) {
    let where: Prisma.DeliveryWhereInput;

    if (role === StaffRole.ADMIN) {
      where = { claimedByStaffId: userId };
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

      where = { partnerId: profile.id };
    }

    const rows = await this.prisma.delivery.findMany({
      where,
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
        statusEvents: {
          orderBy: { createdAt: 'asc' },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });
    return stripDeliveriesSecrets(rows);
  }

  /**
   * Returns the partner's earnings.
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
      earnings,
    };
  }
}
