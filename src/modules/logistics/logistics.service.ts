import { maskNumber } from '../../shared/mask';
import { CLEARED_LOCATION } from './presence.service';
import { afterCursor, toPage } from '../../shared/pagination/cursor';
import { DeliveryListQueryDto } from './dto/delivery-list-query.dto';
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

// Where a delivery may go next. PAY_VENDOR (paying the restaurant or shop) is
// optional: a partner may go straight from heading to the vendor to picked up,
// which keeps older app versions working. DELIVERED is not here on purpose:
// it is only reached by verifying the customer's handover code.
const NEXT_STATUS: Partial<Record<DeliveryStatus, DeliveryStatus[]>> = {
  [DeliveryStatus.EN_ROUTE_TO_PICKUP]: [DeliveryStatus.PAY_VENDOR, DeliveryStatus.PICKED_UP],
  [DeliveryStatus.PAY_VENDOR]: [DeliveryStatus.PICKED_UP],
  [DeliveryStatus.PICKED_UP]: [DeliveryStatus.EN_ROUTE_TO_CUSTOMER],
};

// Fields that must never reach a partner's phone. The handover code is only
// stored as a hash, and a 6-digit code's hash can be cracked in seconds, so
// leaking it would let a partner "deliver" without the customer.
const SECRET_DELIVERY_FIELDS = [
  'deliveryCodeHash',
  'deliveryCodeEncrypted',
  'deliveryCodeAttempts',
  'deliveryCodeLockedUntil',
] as const;

@Injectable()
export class LogisticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {}

  // The app's timeline wants [{ stage, at }]. Built from the status events,
  // oldest first. `statusEvents` is left in place for older clients.
  // The partner's own profile. The full payout number never leaves the server;
  // only a masked copy is shown (the wallet endpoints manage the real one).
  private publicProfile<T extends { payoutNetwork?: string | null; payoutNumber?: string | null }>(
    profile: T,
  ) {
    const { payoutNetwork, payoutNumber, ...rest } = profile;
    return {
      ...rest,
      payoutDestination:
        payoutNetwork && payoutNumber
          ? { network: payoutNetwork, numberMasked: maskNumber(payoutNumber) }
          : null,
    };
  }

  private publicDelivery<T extends Record<string, any>>(delivery: T) {
    const copy: Record<string, any> = { ...delivery };
    for (const field of SECRET_DELIVERY_FIELDS) delete copy[field];
    return copy as Omit<T, (typeof SECRET_DELIVERY_FIELDS)[number]>;
  }

  private withStageHistory<T extends { statusEvents?: { status: DeliveryStatus; createdAt: Date }[] }>(
    delivery: T,
  ) {
    return {
      ...this.publicDelivery(delivery),
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
        order: {
          include: {
            customer: { select: { id: true, fullName: true } },
            items: { include: { menuItem: true, product: true } },
          },
        },
        laundryOrder: true,
        partner: { select: { id: true, staffUserId: true } },
        statusEvents: { orderBy: { createdAt: 'asc' } },
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
   * Delivery partners only ever see FOOD deliveries. Marketplace and
   * laundry deliveries are visible to admins only.
   */
  async findUnassigned(role?: string, query: DeliveryListQueryDto = {}) {
    const rows = await this.prisma.delivery.findMany({
      where: {
        partnerId: null,
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

    // No paging asked for: the plain array the app already understands.
    const safe = rows.map((d) => this.publicDelivery(d));
    return query.limit || query.cursor ? toPage(safe, query.limit ?? 20) : safe;
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
              statusEvents: {
                orderBy: { createdAt: 'asc' },
              },
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

    return this.publicDelivery(verified);
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
      return this.publicDelivery(delivery);
    }

    const allowed = NEXT_STATUS[delivery.status] ?? [];
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

    return this.withStageHistory(result);
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

    // Going online counts as being seen right now; going offline clears the
    // stored position.
    const updated = await this.prisma.deliveryPartnerProfile.update({
      where: {
        staffUserId: userId,
      },
      data: {
        ...dto,
        ...(dto.isAvailable === true ? { lastSeenAt: new Date() } : {}),
        ...(dto.isAvailable === false ? CLEARED_LOCATION : {}),
      },
    });

    return this.publicProfile(updated);
  }

  /**
   * Returns deliveries assigned to the current partner.
   */
  async myDeliveries(userId: string, query: DeliveryListQueryDto = {}) {
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

    const deliveries = await this.prisma.delivery.findMany({
      where: {
        partnerId: profile.id,
        ...(query.status?.length ? { status: { in: query.status } } : {}),
        ...(query.updatedSince
          ? { updatedAt: { gt: new Date(query.updatedSince) } }
          : {}),
        ...(query.cursor ? afterCursor(query.cursor, 'desc') : {}),
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
        statusEvents: {
          orderBy: { createdAt: 'asc' },
        },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });

    const shaped = deliveries.map((d) => this.withStageHistory(d));

    // No paging asked for: the plain array the app already understands.
    return query.limit || query.cursor ? toPage(shaped, query.limit ?? 20) : shaped;
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
