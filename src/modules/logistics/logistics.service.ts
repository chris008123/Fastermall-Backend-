import {
  BadRequestException,
  ConflictException,
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
// Wrong handover-code guesses allowed before the job locks for a few minutes.
const MAX_CODE_ATTEMPTS = 5;
const CODE_LOCK_MS = 5 * 60 * 1000;

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

    if (
      delivery.partnerId ||
      delivery.status !== DeliveryStatus.ASSIGNED
    ) {
      throw new ConflictException({
        message: 'This delivery has already been taken',
        code: 'JOB_ALREADY_TAKEN',
      });
    }

    const claimed = await this.prisma.$transaction(
      async (tx) => {
        // Claim only if it is still free. Two partners tapping Accept at the
        // same moment: exactly one update matches, the other gets a 409.
        const taken = await tx.delivery.updateMany({
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

        if (taken.count === 0) {
          throw new ConflictException({
            message: 'This delivery has already been taken',
            code: 'JOB_ALREADY_TAKEN',
          });
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
        throw new ForbiddenException(
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
