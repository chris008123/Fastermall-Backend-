import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { OrderStatus, OrderType } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { MarketplaceService } from '../marketplace/marketplace.service';
import { FoodService } from '../food/food.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';
import * as bcrypt from 'bcrypt';
import { randomInt } from 'crypto';
import {
  encryptDeliveryCode,
  decryptDeliveryCode,
} from '../../shared/utils/delivery-code-encryption';

// Largest quantity of one product/menu item in a single order.
const MAX_LINE_QUANTITY = 100;
// How often the unpaid-order sweep runs.
const EXPIRY_SWEEP_MS = 5 * 60 * 1000;
// An online payment that was started but never finished is only expired after this long.
const STARTED_PAYMENT_EXPIRY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class OrdersService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('OrdersService');
  private sweepTimer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly marketplace: MarketplaceService,
    private readonly food: FoodService,
    private readonly events: EventEmitter2,
    private readonly config: ConfigService,
  ) {}

  onModuleInit() {
    this.sweepTimer = setInterval(() => {
      this.expireUnpaidOrders().catch((e) =>
        this.logger.error(`Unpaid-order sweep failed: ${(e as Error).message}`),
      );
    }, EXPIRY_SWEEP_MS);
    this.sweepTimer.unref();
  }

  onModuleDestroy() {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }

  // Same product/menu item listed twice is one line with the summed quantity,
  // so a stock check can't be dodged by splitting a quantity across lines.
  private mergeItems(
    items: CreateOrderDto['items'],
    key: 'productId' | 'menuItemId',
  ) {
    const merged = new Map<string, { productId?: string; menuItemId?: string; quantity: number }>();
    for (const item of items) {
      const id = item[key];
      if (!id) {
        throw new BadRequestException(`Every item needs a ${key}`);
      }
      const line = merged.get(id) ?? { [key]: id, quantity: 0 };
      line.quantity += item.quantity;
      if (line.quantity > MAX_LINE_QUANTITY) {
        throw new BadRequestException(
          `You can order at most ${MAX_LINE_QUANTITY} of one item`,
        );
      }
      merged.set(id, line);
    }
    return [...merged.values()];
  }

  async createOrder(customerId: string, dto: CreateOrderDto) {
    if (dto.items.length === 0) {
      throw new BadRequestException(
        'An order must contain at least one item',
      );
    }

    const items = this.mergeItems(
      dto.items,
      dto.type === OrderType.MARKETPLACE ? 'productId' : 'menuItemId',
    );

    // dto.deliveryFee is still accepted (older app versions send it) but is
    // ignored: the fee is always read from the vendor on the server.
    let serverDeliveryFee = 0;

    let lineItems: {
      productId?: string;
      menuItemId?: string;
      quantity: number;
      unitPrice: number;
    }[];

    if (dto.type === OrderType.MARKETPLACE) {
      const ids = items.map((item) => item.productId as string);

      const products = await this.marketplace.getProductsByIds(ids);

      lineItems = items.map((item) => {
        const product = products.find(
          (product) => product.id === item.productId,
        );

        if (!product) {
          throw new NotFoundException(
            `Product ${item.productId} not found`,
          );
        }

        if (product.stock < item.quantity) {
          throw new BadRequestException(
            `Insufficient stock for ${product.name}`,
          );
        }

        return {
          productId: product.id,
          quantity: item.quantity,
          unitPrice: Number(product.price),
        };
      });
    } else {
      const ids = items.map((item) => item.menuItemId as string);

      const menuItems = await this.food.getMenuItemsByIds(ids);

      const vendorIds = [...new Set(menuItems.map((m) => m.vendorId))];
      if (vendorIds.length > 1) {
        throw new BadRequestException(
          'A food order can only contain items from one vendor',
        );
      }
      if (vendorIds.length === 1) {
        const vendor = await this.prisma.foodVendor.findUnique({
          where: { id: vendorIds[0] },
        });
        serverDeliveryFee = Number(vendor?.deliveryFee ?? 0);
      }

      lineItems = items.map((item) => {
        const menuItem = menuItems.find(
          (menuItem) => menuItem.id === item.menuItemId,
        );

        if (!menuItem) {
          throw new NotFoundException(
            `Menu item ${item.menuItemId} not found`,
          );
        }

        if (!menuItem.isAvailable) {
          throw new BadRequestException(
            `${menuItem.name} is currently unavailable`,
          );
        }

        return {
          menuItemId: menuItem.id,
          quantity: item.quantity,
          unitPrice: Number(menuItem.price),
        };
      });
    }

    const subtotal = lineItems.reduce(
      (sum, item) => sum + item.unitPrice * item.quantity,
      0,
    );

    // Food: the vendor's own fee. Marketplace: one flat fee from config (the
    // app shows the same amount at checkout). Always decided here, never by
    // the client.
    const deliveryFee =
      dto.type === OrderType.FOOD
        ? serverDeliveryFee
        : dto.type === OrderType.MARKETPLACE
          ? Number(this.config.get<number>('orders.marketplaceDeliveryFee') ?? 0)
          : 0;

    const totalAmount = subtotal + deliveryFee;

    // Take the stock first, atomically (all lines or none). If anything
    // below fails, give it back.
    const reserved =
      dto.type === OrderType.MARKETPLACE
        ? lineItems.map((item) => ({
            productId: item.productId as string,
            quantity: item.quantity,
          }))
        : [];
    if (reserved.length > 0) {
      await this.marketplace.reserveStock(reserved);
    }

    let orderWithDelivery;
    let createdOrderId: string | undefined;
    try {
    const order = await this.prisma.order.create({
      data: {
        customerId,
        type: dto.type,
        totalAmount,
        deliveryFee,
        vendorName: dto.vendorName,
        addressLabel: dto.addressLabel,
        paymentMethod: dto.paymentMethod,
        notes: dto.notes,
        items: { create: lineItems },
      },
      include: {
        items: {
          include: {
            product: true,
            menuItem: true,
          },
        },
        payment: true,
        delivery: {
          select: {
            id: true,
            orderId: true,
            laundryOrderId: true,
            partnerId: true,
            status: true,
            pickupLat: true,
            pickupLng: true,
            dropoffLat: true,
            dropoffLng: true,
            distanceKm: true,
            createdAt: true,
            updatedAt: true,
          },
        },
      },
    });

    createdOrderId = order.id;

    if (
      dto.type === OrderType.FOOD ||
      dto.type === OrderType.MARKETPLACE
    ) {
      const deliveryCode = randomInt(100000, 1000000).toString();

      const deliveryCodeHash = await bcrypt.hash(
        deliveryCode,
        10,
      );

      const deliveryCodeEncrypted =
        encryptDeliveryCode(deliveryCode);

      const createdDelivery = await this.prisma.delivery.create({
        data: {
          orderId: order.id,
          status: 'ASSIGNED',
          deliveryCodeHash,
          deliveryCodeEncrypted,
        },
      });

      // Lets Notifications tell available delivery partners about the new job.
      this.events.emit('delivery.created', {
        deliveryId: createdDelivery?.id,
        orderId: order.id,
      });
    }

    orderWithDelivery = await this.prisma.order.findUnique({
      where: { id: order.id },
      include: {
        items: {
          include: {
            product: true,
            menuItem: true,
          },
        },
        payment: true,
        delivery: {
          select: {
            id: true,
            orderId: true,
            laundryOrderId: true,
            partnerId: true,
            status: true,
            pickupLat: true,
            pickupLng: true,
            dropoffLat: true,
            dropoffLng: true,
            distanceKm: true,
            createdAt: true,
            updatedAt: true,
          },
        },
      },
    });

    } catch (error) {
      // The order row may exist already. Cancel it (without restocking, the
      // stock is returned just below) so the expiry sweep can't return it twice.
      if (createdOrderId) {
        await this.prisma.order
          .updateMany({
            where: { id: createdOrderId },
            data: { status: OrderStatus.CANCELLED },
          })
          .catch(() => undefined);
      }
      if (reserved.length > 0) {
        await this.marketplace
          .releaseStock(reserved)
          .catch((e) =>
            this.logger.error(`Could not release stock after failed order: ${(e as Error).message}`),
          );
      }
      throw error;
    }

    this.events.emit('order.created', orderWithDelivery);

    return orderWithDelivery;
  }

  async findMyOrders(customerId: string) {
    const orders = await this.prisma.order.findMany({
      where: { customerId },
      include: {
        items: {
          include: {
            product: true,
            menuItem: true,
          },
        },
        payment: true,
        delivery: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    // The stored code hash and encrypted code never leave the server in a
    // list. (A customer sees their code only when opening one order.)
    return orders.map((order) => {
      if (!order.delivery) return order;
      const { deliveryCodeHash, deliveryCodeEncrypted, ...safeDelivery } =
        order.delivery;
      return { ...order, delivery: safeDelivery };
    });
  }

  async findOne(id: string, customerId: string) {
    const order = await this.prisma.order.findFirst({
      where: {
        id,
        customerId,
      },
      include: {
        items: {
          include: {
            product: true,
            menuItem: true,
          },
        },
        payment: true,
        delivery: true,
      },
    });

    if (!order) {
      throw new NotFoundException('Order not found');
    }

    let delivery = order.delivery;

    if (delivery?.deliveryCodeEncrypted) {
      const code = decryptDeliveryCode(
        delivery.deliveryCodeEncrypted,
      );

      delivery = {
        ...delivery,
        code,
      } as typeof delivery & { code: string };
    }

    if (delivery) {
      const {
        deliveryCodeHash,
        deliveryCodeEncrypted,
        ...safeDelivery
      } = delivery;

      return {
        ...order,
        delivery: safeDelivery,
      };
    }

    return order;
  }

  async updateStatus(id: string, dto: UpdateOrderStatusDto) {
    const existingOrder = await this.prisma.order.findUnique({
      where: { id },
      include: { items: true },
    });

    if (!existingOrder) {
      throw new NotFoundException('Order not found');
    }

    // Cancelling an order that has not left the shop puts its stock back,
    // once (the status flip inside is conditional).
    if (dto.status === OrderStatus.CANCELLED) {
      await this.cancelAndRestock(existingOrder, [
        OrderStatus.PENDING,
        OrderStatus.CONFIRMED,
        OrderStatus.PREPARING,
      ]);
    }

    const updated = await this.prisma.order.update({
      where: { id },
      data: { status: dto.status },
      include: {
        items: {
          include: {
            product: true,
            menuItem: true,
          },
        },
        payment: true,
        delivery: true,
      },
    });

    this.events.emit('order.status.updated', updated);

    return updated;
  }

  /**
   * Cancels an order and returns marketplace stock, but only if the order is
   * still in one of `allowedFrom`. The conditional update makes it safe to
   * call twice or from two servers: only the first call restocks.
   */
  private async cancelAndRestock(
    order: {
      id: string;
      type: OrderType;
      items: { productId: string | null; quantity: number }[];
    },
    allowedFrom: OrderStatus[],
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const flipped = await tx.order.updateMany({
        where: { id: order.id, status: { in: allowedFrom } },
        data: { status: OrderStatus.CANCELLED },
      });
      if (flipped.count !== 1) return false;

      await tx.delivery.updateMany({
        where: { orderId: order.id, status: { not: 'DELIVERED' } },
        data: { status: 'FAILED' },
      });

      if (order.type === OrderType.MARKETPLACE) {
        for (const item of order.items) {
          if (item.productId) {
            await tx.product.update({
              where: { id: item.productId },
              data: { stock: { increment: item.quantity } },
            });
          }
        }
      }
      return true;
    });
  }

  /**
   * Cancels orders nobody paid for, so they stop holding stock:
   * - no payment attempt and not cash: after ORDER_PAYMENT_TIMEOUT_MINUTES
   * - online payment started but never finished: after 24 hours
   * Cash orders and paid orders are never touched.
   */
  async expireUnpaidOrders(now = new Date()): Promise<number> {
    const idleMinutes = this.config.get<number>('orders.paymentTimeoutMinutes') ?? 30;
    const idleCutoff = new Date(now.getTime() - idleMinutes * 60_000);
    const startedCutoff = new Date(now.getTime() - STARTED_PAYMENT_EXPIRY_MS);

    const stale = await this.prisma.order.findMany({
      where: {
        status: OrderStatus.PENDING,
        OR: [
          {
            createdAt: { lt: idleCutoff },
            OR: [
              { payment: { is: null } },
              {
                payment: {
                  is: {
                    reference: null,
                    method: { not: 'CASH' },
                    status: { not: 'SUCCESSFUL' },
                  },
                },
              },
            ],
          },
          {
            createdAt: { lt: startedCutoff },
            payment: {
              is: { method: { not: 'CASH' }, status: { not: 'SUCCESSFUL' } },
            },
          },
        ],
      },
      include: { items: true },
      take: 200,
    });

    let cancelled = 0;
    for (const order of stale) {
      if (await this.cancelAndRestock(order, [OrderStatus.PENDING])) cancelled++;
    }
    if (cancelled > 0) {
      this.logger.log(`Expired ${cancelled} unpaid order(s) and returned their stock`);
    }
    return cancelled;
  }
}
