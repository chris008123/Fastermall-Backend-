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

// Short-distance deliveries go to walking partners, longer ones need a motorcycle.
// Distance isn't tracked yet at the order level because GPS/maps are not part of
// the current MVP.
const WALKING_MAX_DISTANCE_KM = 2;

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

    return this.prisma.$transaction(
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

    const allowedStatuses: DeliveryStatus[] = [
      DeliveryStatus.EN_ROUTE_TO_PICKUP,
      DeliveryStatus.PICKED_UP,
      DeliveryStatus.EN_ROUTE_TO_CUSTOMER,
      DeliveryStatus.DELIVERED,
    ];

    if (
      !allowedStatuses.includes(dto.status)
    ) {
      throw new BadRequestException(
        'Invalid delivery status',
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

      [DeliveryStatus.DELIVERED]:
        OrderStatus.DELIVERED,
    };

    const orderStatus =
      orderStatusMap[dto.status];

    const result =
      await this.prisma.$transaction(
        async (tx) => {
          const updated =
            await tx.delivery.update({
              where: {
                id: deliveryId,
              },
              data: {
                status: dto.status,
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

    // Give the partner the delivery earning
    // once, when the delivery is completed.
    if (
      dto.status === DeliveryStatus.DELIVERED &&
      delivery.partnerId
    ) {
      const existingEarning =
        await this.prisma.driverEarning.findFirst({
          where: {
            partnerId: delivery.partnerId,
            note: `Delivery ${deliveryId}`,
          },
        });

      if (!existingEarning) {
        await this.prisma.driverEarning.create({
          data: {
            partnerId: delivery.partnerId,
            amount: 15,
            note: `Delivery ${deliveryId}`,
          },
        });
      }
    }

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
