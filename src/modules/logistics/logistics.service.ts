import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import {
  DeliveryStatus,
  OrderStatus,
  OrderType,
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

// The only moves a partner can make with PATCH /deliveries/:id/status.
// Claiming sets EN_ROUTE_TO_PICKUP, and DELIVERED only comes from verify-code,
// so neither appears as a target here. Anything not listed (skipping a step,
// going backwards, touching a DELIVERED or FAILED job) is rejected.
const NEXT_STATUS: Partial<Record<DeliveryStatus, DeliveryStatus>> = {
  [DeliveryStatus.EN_ROUTE_TO_PICKUP]: DeliveryStatus.PICKED_UP,
  [DeliveryStatus.PICKED_UP]: DeliveryStatus.EN_ROUTE_TO_CUSTOMER,
};

@Injectable()
export class LogisticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
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
  findUnassigned(role?: string) {
    return this.prisma.delivery.findMany({
      where: {
        partnerId: null,
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
  }

  /**
   * Delivery partner claims a delivery.
   */
  async claim(
    deliveryId: string,
    userId: string,
    role?: string,
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
          order: { select: { type: true } },
        },
      });

    if (!delivery) {
      throw new NotFoundException(
        'Delivery not found',
      );
    }

    // Delivery partners can only take food deliveries. Marketplace and
    // laundry deliveries are handled by admins.
    if (
      role !== StaffRole.ADMIN &&
      delivery.order?.type !== OrderType.FOOD
    ) {
      throw new ForbiddenException(
        'Only food deliveries can be claimed by delivery partners',
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

    const claimed = await this.prisma.$transaction(
      async (tx) => {
        const updated =
          await tx.delivery.update({
            where: {
              id: deliveryId,
            },
            data: {
              partnerId: profile.id,
              status:
                DeliveryStatus.EN_ROUTE_TO_PICKUP,
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

        await tx.deliveryStatusEvent.create({
          data: {
            deliveryId,
            status: DeliveryStatus.EN_ROUTE_TO_PICKUP,
          },
        });

        return updated;
      },
    );

    this.emitStatusUpdated(
      claimed,
      claimed.order?.customer?.id ?? claimed.laundryOrder?.customerId,
    );

    return claimed;
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
                amount: 15,
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

    return verified;
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

    // A repeated tap (slow network, double press) is not an error.
    if (delivery.status === dto.status) {
      return delivery;
    }

    if (NEXT_STATUS[delivery.status] !== dto.status) {
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
        statusEvents: {
          orderBy: { createdAt: 'asc' },
        },
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
