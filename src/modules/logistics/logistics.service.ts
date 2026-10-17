import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  DeliveryStatus,
  OrderStatus,
  StaffRole,
} from '@prisma/client';

import { PrismaService } from '../../database/prisma.service';
import { UpdatePartnerStatusDto } from './dto/update-partner-status.dto';
import { UpdateDeliveryStatusDto } from './dto/update-delivery-status.dto';
import * as bcrypt from 'bcrypt';
// Short-distance deliveries go to walking partners, longer ones need a motorcycle.
// Distance isn't tracked yet at the order level because GPS/maps are not part of
// the current MVP.
const WALKING_MAX_DISTANCE_KM = 2;

// Wrong delivery codes allowed before the delivery is locked, and how long the lock lasts.
const MAX_CODE_ATTEMPTS = 5;
const CODE_LOCK_MS = 5 * 60 * 1000;

// A courier moves a delivery forward only: pickup -> picked up -> on the way.
// DELIVERED is reached only through the delivery code, never through here.
const STATUS_RANK: Partial<Record<DeliveryStatus, number>> = {
  [DeliveryStatus.EN_ROUTE_TO_PICKUP]: 1,
  [DeliveryStatus.PICKED_UP]: 2,
  [DeliveryStatus.EN_ROUTE_TO_CUSTOMER]: 3,
};

// A courier may only see or claim an order delivery once the customer has
// really paid online (SUCCESSFUL) or chosen to pay cash on delivery.
// Laundry deliveries are only created after payment succeeds, so they have
// no orderId and are not filtered here.
const PAID_OR_CASH = {
  OR: [
    { status: 'SUCCESSFUL' as const },
    { method: 'CASH' as const },
  ],
};

@Injectable()
export class LogisticsService {
  constructor(private readonly prisma: PrismaService) {}

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
        await this.prisma.delivery.create({
          data: {
            orderId: payment.orderId,
            status: DeliveryStatus.ASSIGNED,
          },
        });
      }
    } else if (payment.laundryOrderId) {
      const existing = await this.prisma.delivery.findUnique({
        where: {
          laundryOrderId: payment.laundryOrderId,
        },
      });

      if (!existing) {
        await this.prisma.delivery.create({
          data: {
            laundryOrderId: payment.laundryOrderId,
            status: DeliveryStatus.ASSIGNED,
          },
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
   */
  findUnassigned() {
    return this.prisma.delivery.findMany({
      where: {
        partnerId: null,
        status: DeliveryStatus.ASSIGNED,
        OR: [
          { orderId: null },
          { order: { payment: PAID_OR_CASH } },
        ],
      },
      include: {
        order: {
          include: {
            payment: {
              select: { method: true, status: true },
            },
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
  }

  /**
   * Delivery partner claims a delivery.
   */
  async claim(
    deliveryId: string,
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
      });

    if (!delivery) {
      throw new NotFoundException(
        'Delivery not found',
      );
    }

    if (delivery.partnerId) {
      throw new BadRequestException(
        'This delivery has already been claimed',
      );
    }

    if (delivery.status !== DeliveryStatus.ASSIGNED) {
      throw new BadRequestException(
        'This delivery is no longer available',
      );
    }

    // Never hand out an order that has not been paid for (or set to cash).
    if (delivery.orderId) {
      const payment = await this.prisma.payment.findUnique({
        where: { orderId: delivery.orderId },
      });

      const payable =
        payment &&
        (payment.status === 'SUCCESSFUL' ||
          payment.method === 'CASH');

      if (!payable) {
        throw new BadRequestException(
          'This order has not been paid for yet',
        );
      }
    }

    return this.prisma.$transaction(
      async (tx) => {
        // Only one courier can win: the update matches only while the
        // delivery is still unclaimed, so a second courier gets count 0.
        const won = await tx.delivery.updateMany({
          where: {
            id: deliveryId,
            partnerId: null,
            status: DeliveryStatus.ASSIGNED,
          },
          data: {
            partnerId: profile.id,
            status: DeliveryStatus.EN_ROUTE_TO_PICKUP,
          },
        });

        if (won.count !== 1) {
          throw new BadRequestException(
            'This delivery has already been claimed',
          );
        }

        const updated = await tx.delivery.findUniqueOrThrow({
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
          },
        });

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

        return updated;
      },
    );
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

    if (!delivery.deliveryCodeHash) {
      throw new BadRequestException(
        'No delivery verification code exists',
      );
    }

    // If an earlier lock has run out, start a fresh set of attempts.
    // (Only one of several simultaneous requests can match this.)
    await this.prisma.delivery.updateMany({
      where: {
        id: deliveryId,
        deliveryCodeLockedUntil: { lt: new Date() },
      },
      data: {
        deliveryCodeAttempts: 0,
        deliveryCodeLockedUntil: null,
      },
    });

    // Use up one attempt BEFORE checking the code. The update only matches
    // while fewer than MAX_CODE_ATTEMPTS have been used, and the database
    // applies it one at a time, so a burst of parallel guesses cannot get
    // more than MAX_CODE_ATTEMPTS tries in total.
    const reserved = await this.prisma.delivery.updateMany({
      where: {
        id: deliveryId,
        partnerId: profile.id,
        deliveryCodeUsed: false,
        deliveryCodeAttempts: { lt: MAX_CODE_ATTEMPTS },
      },
      data: {
        deliveryCodeAttempts: { increment: 1 },
      },
    });

    if (reserved.count !== 1) {
      throw new BadRequestException(
        'Too many incorrect attempts. Try again in 5 minutes.',
      );
    }

    const valid = await bcrypt.compare(
      code,
      delivery.deliveryCodeHash,
    );

    if (!valid) {
      // Start the lock once the last attempt has been used.
      await this.prisma.delivery.updateMany({
        where: {
          id: deliveryId,
          deliveryCodeAttempts: { gte: MAX_CODE_ATTEMPTS },
          deliveryCodeLockedUntil: null,
        },
        data: {
          deliveryCodeLockedUntil: new Date(Date.now() + CODE_LOCK_MS),
        },
      });

      throw new BadRequestException('Invalid delivery code');
    }

    return this.prisma.$transaction(
      async (tx) => {
        // The code works once: only the request that flips deliveryCodeUsed
        // from false to true goes on to mark the delivery done and pay.
        const done = await tx.delivery.updateMany({
          where: {
            id: deliveryId,
            partnerId: profile.id,
            deliveryCodeUsed: false,
          },
          data: {
            status: DeliveryStatus.DELIVERED,
            deliveryCodeUsed: true,
            verifiedAt: new Date(),
          },
        });

        if (done.count !== 1) {
          throw new BadRequestException(
            'This delivery code has already been used',
          );
        }

        const updated = await tx.delivery.findUniqueOrThrow({
          where: {
            id: deliveryId,
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
                amount: 15,
                note: `Delivery ${deliveryId}`,
              },
            });
          }
        }

        return updated;
      },
    );
  }

  /**
   * Updates the status of a delivery.
   */
  async updateStatus(
    deliveryId: string,
    dto: UpdateDeliveryStatusDto,
    userId?: string,
  ) {
    const delivery =
      await this.prisma.delivery.findUnique({
        where: {
          id: deliveryId,
        },
      });

    if (!delivery) {
      throw new NotFoundException(
        'Delivery not found',
      );
    }

    // If called by a delivery partner, make sure
    // they own this delivery.
    if (userId) {
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

      if (delivery.partnerId !== profile.id) {
        throw new BadRequestException(
          'You are not assigned to this delivery',
        );
      }
    }

    const newRank = STATUS_RANK[dto.status];
    const currentRank = STATUS_RANK[delivery.status];

    if (newRank === undefined) {
      throw new BadRequestException(
        'Invalid delivery status',
      );
    }

    // A courier can only move a delivery they hold forward. A delivery that is
    // unclaimed, delivered or failed cannot be changed from here, and nothing
    // can be moved backwards.
    if (currentRank === undefined || newRank < currentRank) {
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
        OrderStatus.OUT_FOR_DELIVERY
    };

    const orderStatus =
      orderStatusMap[dto.status];

    const result =
      await this.prisma.$transaction(
        async (tx) => {
          // Write only if nobody changed the status since we read it.
          const moved = await tx.delivery.updateMany({
            where: {
              id: deliveryId,
              status: delivery.status,
            },
            data: {
              status: dto.status,
            },
          });

          if (moved.count !== 1) {
            throw new BadRequestException(
              'This delivery was just updated. Please refresh and try again.',
            );
          }

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

    

    return result;
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
   * Returns deliveries assigned to the current partner.
   */
  async myDeliveries(userId: string) {
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

    return this.prisma.delivery.findMany({
      where: {
        partnerId: profile.id,
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
        createdAt: 'desc',
      },
    });
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
