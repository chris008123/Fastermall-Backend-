import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { SettingsService } from '../settings/settings.service';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DeliveryStatus, OrderStatus, OrderType, Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { MarketplaceService } from '../marketplace/marketplace.service';
import { FoodService } from '../food/food.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';
import * as bcrypt from 'bcrypt';
import { randomInt } from 'crypto';
import { isUniqueViolation } from '../../shared/utils/idempotency';
import {
  AddressesService,
  formatAddressLabel,
} from '../addresses/addresses.service';
import {
  encryptDeliveryCode,
  decryptDeliveryCode,
} from '../../shared/utils/delivery-code-encryption';
import {
  SAFE_DELIVERY_SELECT,
  stripDeliverySecrets,
} from '../../shared/utils/delivery-secrets';
import { normalizeOrderPaymentMethod } from '../payments/payment-methods';
import { lineKey, OptionChoice, priceWithOptions } from '../food/menu-options';
import {
  allowedWindows,
  assignWindow,
  DeliveryWindow,
  presentWindow,
  windowStartingAt,
} from '../../shared/utils/delivery-windows';

// Largest quantity of one product/menu item in a single order.
const MAX_LINE_QUANTITY = 100;
// How often the unpaid-order sweep runs.
const EXPIRY_SWEEP_MS = 5 * 60 * 1000;
// An online payment that was started but never finished is only expired after this long.
const STARTED_PAYMENT_EXPIRY_MS = 24 * 60 * 60 * 1000;

// A delivery can be moved while the order is still being prepared and the
// rider has not picked it up yet.
const RESCHEDULABLE_ORDER_STATUSES: OrderStatus[] = [
  OrderStatus.PENDING,
  OrderStatus.CONFIRMED,
  OrderStatus.PREPARING,
];
const RESCHEDULABLE_DELIVERY_STATUSES: DeliveryStatus[] = [
  DeliveryStatus.ASSIGNED,
  DeliveryStatus.EN_ROUTE_TO_PICKUP,
  DeliveryStatus.PAY_VENDOR,
];

type WindowFields = {
  deliveryWindowStart?: Date | null;
  deliveryWindowEnd?: Date | null;
};

/** Adds `deliveryWindow` ({ slot, start, end, label }, or null) to an order. */
export function withDeliveryWindow<T extends WindowFields>(order: T) {
  const window = order.deliveryWindowStart ? windowStartingAt(order.deliveryWindowStart) : null;
  return { ...order, deliveryWindow: window ? presentWindow(window) : null };
}

@Injectable()
export class OrdersService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OrdersService.name);
  private sweepTimer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly marketplace: MarketplaceService,
    private readonly food: FoodService,
    private readonly events: EventEmitter2,
    private readonly config: ConfigService,
    private readonly addresses: AddressesService,
    @Optional() private readonly settings?: SettingsService,
  ) {}

  /** The current time. A method so tests can pin it. */
  protected now() {
    return new Date();
  }

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
  // A customisable food item is "the same" only with the same choices: Gɔbɛ
  // with egg and Gɔbɛ with sausage stay two lines.
  private mergeItems(
    items: CreateOrderDto['items'],
    key: 'productId' | 'menuItemId',
  ) {
    const merged = new Map<
      string,
      { productId?: string; menuItemId?: string; quantity: number; options?: OptionChoice[] }
    >();
    for (const item of items) {
      const id = item[key];
      if (!id) {
        throw new BadRequestException(`Every item needs a ${key}`);
      }
      if (key === 'productId' && item.options?.length) {
        throw new BadRequestException('Marketplace products have no options');
      }
      const lk = key === 'menuItemId' ? lineKey(id, item.options) : id;
      const line = merged.get(lk) ?? { [key]: id, quantity: 0, options: item.options };
      line.quantity += item.quantity;
      if (line.quantity > MAX_LINE_QUANTITY) {
        throw new BadRequestException(
          `You can order at most ${MAX_LINE_QUANTITY} of one item`,
        );
      }
      merged.set(lk, line);
    }
    return [...merged.values()];
  }

  async createOrder(
    customerId: string,
    dto: CreateOrderDto,
    idempotencyKey?: string,
  ) {
    // A retry of a request we already handled gets the original order back,
    // so a timeout followed by a retry never creates a second order.
    if (idempotencyKey) {
      const existing = await this.prisma.order.findUnique({
        where: { customerId_idempotencyKey: { customerId, idempotencyKey } },
        select: { id: true },
      });
      if (existing) return this.findOne(existing.id, customerId);
    }

    // Maintenance mode (admin setting) stops new orders; retries above still
    // get their original order back.
    await this.settings?.assertOrderingOpen();

    // A saved address is copied onto the order, so later edits to it don't
    // change where an existing order goes.
    const savedAddress = dto.addressId
      ? await this.addresses.getOwned(customerId, dto.addressId)
      : null;
    const addressLabel = savedAddress
      ? formatAddressLabel(savedAddress)
      : dto.addressLabel;

    if (dto.items.length === 0) {
      throw new BadRequestException(
        'An order must contain at least one item',
      );
    }

    // Cash was removed: any cash choice is refused before anything is saved.
    const paymentMethod = normalizeOrderPaymentMethod(dto.paymentMethod);

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
      selectedOptions?: Prisma.InputJsonValue;
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

        // Base price plus the chosen options, from the menu (never from the
        // app). Throws a 400 for a missing required choice or a bad option.
        const { unitPrice, selectedOptions } = priceWithOptions(menuItem, item.options);

        return {
          menuItemId: menuItem.id,
          quantity: item.quantity,
          unitPrice,
          ...(selectedOptions
            ? { selectedOptions: selectedOptions as unknown as Prisma.InputJsonValue }
            : {}),
        };
      });
    }

    const subtotal = lineItems.reduce(
      (sum, item) => sum + item.unitPrice * item.quantity,
      0,
    );

    // Food: the vendor's own fee. Marketplace: one flat fee from the admin
    // settings (the app shows the same amount at checkout). Always decided
    // here, never by the client.
    const deliveryFee =
      dto.type === OrderType.FOOD
        ? serverDeliveryFee
        : dto.type === OrderType.MARKETPLACE
          ? this.settings
            ? await this.settings.get('marketplaceDeliveryFee')
            : Number(this.config.get<number>('orders.marketplaceDeliveryFee') ?? 0)
          : 0;

    const totalAmount = subtotal + deliveryFee;

    // Marketplace orders are delivered in a fixed window decided by the time
    // the order is placed (food orders are delivered straight away).
    const window =
      dto.type === OrderType.MARKETPLACE ? assignWindow(this.now()) : null;

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
    const releaseReserved = async () => {
      if (reserved.length === 0) return;
      await this.marketplace
        .releaseStock(reserved)
        .catch((e) =>
          this.logger.error(`Could not release stock after failed order: ${(e as Error).message}`),
        );
    };

    let order;
    try {
      order = await this.prisma.order.create({
        data: {
          customerId,
          idempotencyKey,
          type: dto.type,
          totalAmount,
          deliveryFee,
          vendorName: dto.vendorName,
          addressLabel,
          paymentMethod,
          notes: dto.notes,
          items: { create: lineItems },
          ...(window
            ? {
                deliveryWindowStart: window.start,
                deliveryWindowEnd: window.end,
                originalWindowStart: window.start,
              }
            : {}),
        },
      });
    } catch (error) {
      await releaseReserved();
      // Two retries with the same key arrived together and the other one
      // created the order. This request's stock was just given back, so
      // return that order.
      if (idempotencyKey && isUniqueViolation(error)) {
        const existing = await this.prisma.order.findUnique({
          where: { customerId_idempotencyKey: { customerId, idempotencyKey } },
          select: { id: true },
        });
        if (existing) return this.findOne(existing.id, customerId);
      }
      throw error;
    }

    let orderWithDelivery;
    try {
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
            // Stored for a future map; never returned (see delivery-secrets).
            dropoffLat: savedAddress?.lat ?? undefined,
            dropoffLng: savedAddress?.lng ?? undefined,
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
          delivery: { select: SAFE_DELIVERY_SELECT },
        },
      });
    } catch (error) {
      // The order row exists. Cancel it (without restocking, the stock is
      // returned just below) so the expiry sweep can't return it twice.
      await this.prisma.order
        .updateMany({
          where: { id: order.id },
          data: { status: OrderStatus.CANCELLED },
        })
        .catch(() => undefined);
      await releaseReserved();
      throw error;
    }

    this.events.emit('order.created', orderWithDelivery);

    return orderWithDelivery ? withDeliveryWindow(orderWithDelivery) : orderWithDelivery;
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

    // The code secrets and location fields never leave the server. (A
    // customer sees their code only when opening one order.)
    return orders.map((order) =>
      withDeliveryWindow(
        order.delivery
          ? { ...order, delivery: stripDeliverySecrets(order.delivery) }
          : order,
      ),
    );
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
      const code = await this.revealDeliveryCode(delivery);

      delivery = {
        ...delivery,
        code,
      } as typeof delivery & { code?: string };
    }

    if (delivery) {
      return withDeliveryWindow({
        ...order,
        delivery: stripDeliverySecrets(delivery),
      });
    }

    return withDeliveryWindow(order);
  }

  // ───────── Delivery windows (marketplace) ─────────

  private async ownWindowedOrder(orderId: string, customerId: string) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, customerId },
      select: {
        id: true,
        type: true,
        status: true,
        deliveryWindowStart: true,
        originalWindowStart: true,
        rescheduleCount: true,
        delivery: { select: { status: true, claimedByStaffId: true } },
      },
    });
    if (!order) throw new NotFoundException('Order not found');

    const current = order.deliveryWindowStart ? windowStartingAt(order.deliveryWindowStart) : null;
    const original = order.originalWindowStart ? windowStartingAt(order.originalWindowStart) : null;
    if (!current || !original) {
      throw new BadRequestException({
        message: 'This order has no delivery window',
        code: 'NO_DELIVERY_WINDOW',
      });
    }
    return { order, current, original };
  }

  // Why the delivery can't be moved right now, or null if it can.
  private rescheduleBlocker(
    order: { status: OrderStatus; delivery: { status: DeliveryStatus } | null },
    current: DeliveryWindow,
    now: Date,
  ): { code: string; message: string } | null {
    if (!RESCHEDULABLE_ORDER_STATUSES.includes(order.status)) {
      return { code: 'ORDER_NOT_RESCHEDULABLE', message: `This order is ${order.status.toLowerCase().replace(/_/g, ' ')} and can no longer be rescheduled` };
    }
    if (order.delivery && !RESCHEDULABLE_DELIVERY_STATUSES.includes(order.delivery.status)) {
      return { code: 'ALREADY_ON_THE_WAY', message: 'Your order has been picked up and can no longer be rescheduled' };
    }
    if (current.start.getTime() <= now.getTime()) {
      return { code: 'WINDOW_STARTED', message: 'Your delivery window has already started, so it can no longer be changed' };
    }
    return null;
  }

  /**
   * The delivery window and the only windows the customer may pick: the
   * original one and the two after it. Windows that have already started
   * are listed but not available.
   */
  async getDeliveryWindows(orderId: string, customerId: string) {
    const { order, current, original } = await this.ownWindowedOrder(orderId, customerId);
    const now = this.now();
    const blocker = this.rescheduleBlocker(order, current, now);

    return {
      orderId: order.id,
      current: presentWindow(current),
      original: presentWindow(original),
      rescheduleCount: order.rescheduleCount,
      canReschedule: !blocker,
      reason: blocker?.message ?? null,
      options: allowedWindows(original).map((w) => ({
        ...presentWindow(w),
        isCurrent: w.start.getTime() === current.start.getTime(),
        isOriginal: w.start.getTime() === original.start.getTime(),
        available: !blocker && w.start.getTime() > now.getTime(),
      })),
    };
  }

  /**
   * Moves the delivery to another window. Only the original window and the
   * two after it are accepted; any other date or time is refused. Allowed
   * until the current window starts and while the order has not been picked
   * up. Picking the current window again is a no-op.
   */
  async rescheduleDelivery(orderId: string, customerId: string, windowStart: string) {
    const { order, current, original } = await this.ownWindowedOrder(orderId, customerId);
    const now = this.now();

    const blocker = this.rescheduleBlocker(order, current, now);
    if (blocker) throw new ConflictException(blocker);

    const wanted = new Date(windowStart);
    const allowed = allowedWindows(original);
    const target = allowed.find((w) => w.start.getTime() === wanted.getTime());
    if (!target) {
      throw new BadRequestException({
        message: 'Choose one of the delivery windows offered for this order',
        code: 'WINDOW_NOT_ALLOWED',
        allowed: allowed.map(presentWindow),
      });
    }
    if (target.start.getTime() <= now.getTime()) {
      throw new BadRequestException({
        message: 'That delivery window has already started',
        code: 'WINDOW_IN_THE_PAST',
      });
    }

    if (target.start.getTime() === current.start.getTime()) {
      return this.getDeliveryWindows(orderId, customerId);
    }

    // Only if nobody changed it since we read it (a double tap, two phones).
    const moved = await this.prisma.order.updateMany({
      where: {
        id: order.id,
        customerId,
        deliveryWindowStart: current.start,
        status: { in: RESCHEDULABLE_ORDER_STATUSES },
      },
      data: {
        deliveryWindowStart: target.start,
        deliveryWindowEnd: target.end,
        rescheduledAt: now,
        rescheduleCount: { increment: 1 },
      },
    });
    if (moved.count !== 1) {
      throw new ConflictException({
        message: 'This order just changed. Refresh and try again.',
        code: 'ORDER_CHANGED',
      });
    }

    this.events.emit('order.delivery.rescheduled', {
      orderId: order.id,
      customerId,
      claimedByStaffId: order.delivery?.claimedByStaffId ?? undefined,
      from: presentWindow(current),
      to: presentWindow(target),
    });

    return this.getDeliveryWindows(orderId, customerId);
  }

  /**
   * The customer's delivery code in plain text. A code stored under another
   * encryption key (the key was changed, or the order was created by a
   * server with a different key) can't be read back. Rather than failing the
   * whole order with a 500, the customer gets a fresh code: only they ever
   * see it, and the rider checks whatever the customer reads out against the
   * new hash. A code that was already used is simply left out.
   */
  private async revealDeliveryCode(delivery: {
    id: string;
    deliveryCodeEncrypted: string | null;
    deliveryCodeUsed: boolean;
  }): Promise<string | undefined> {
    if (!delivery.deliveryCodeEncrypted) return undefined;
    try {
      return decryptDeliveryCode(delivery.deliveryCodeEncrypted);
    } catch (error) {
      this.logger.warn(
        `Delivery ${delivery.id}: stored code could not be decrypted (${(error as Error).message})`,
      );
    }
    if (delivery.deliveryCodeUsed) return undefined;

    const code = randomInt(100000, 1000000).toString();
    await this.prisma.delivery.update({
      where: { id: delivery.id },
      data: {
        deliveryCodeHash: await bcrypt.hash(code, 10),
        deliveryCodeEncrypted: encryptDeliveryCode(code),
      },
    });
    return code;
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

    return updated.delivery
      ? { ...updated, delivery: stripDeliverySecrets(updated.delivery) }
      : updated;
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
    let takenFrom: { deliveryId: string; staffUserId: string } | null = null;

    const cancelled = await this.prisma.$transaction(async (tx) => {
      const flipped = await tx.order.updateMany({
        where: { id: order.id, status: { in: allowedFrom } },
        data: { status: OrderStatus.CANCELLED },
      });
      if (flipped.count !== 1) return false;

      // A partner already on the way is told (after the commit, below).
      const active = await tx.delivery.findFirst({
        where: { orderId: order.id, partnerId: { not: null }, status: { notIn: ['DELIVERED', 'FAILED'] } },
        select: { id: true, partner: { select: { staffUserId: true } } },
      });
      if (active?.partner) takenFrom = { deliveryId: active.id, staffUserId: active.partner.staffUserId };

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

    if (cancelled && takenFrom) {
      const { deliveryId, staffUserId } = takenFrom;
      this.events.emit('delivery.cancelled', { deliveryId, orderId: order.id, staffUserId });
    }
    return cancelled;
  }

  /**
   * Cancels orders nobody paid for, so they stop holding stock:
   * - no payment attempt and not cash: after ORDER_PAYMENT_TIMEOUT_MINUTES
   * - online payment started but never finished: after 24 hours
   * Cash orders (chosen before cash was removed) and paid orders are never touched.
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
