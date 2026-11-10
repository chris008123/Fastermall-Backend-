import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { SettingsService } from '../settings/settings.service';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { OrderType } from '@prisma/client';
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
import { stripDeliverySecrets } from '../../shared/utils/delivery-secrets';
import { normalizeOrderPaymentMethod } from '../payments/payment-methods';

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly marketplace: MarketplaceService,
    private readonly food: FoodService,
    private readonly events: EventEmitter2,
    private readonly config: ConfigService,
    private readonly addresses: AddressesService,
    @Optional() private readonly settings?: SettingsService,
  ) {}

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
      const ids = dto.items
        .map((item) => item.productId)
        .filter(Boolean) as string[];

      const products = await this.marketplace.getProductsByIds(ids);

      lineItems = dto.items.map((item) => {
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
      const ids = dto.items
        .map((item) => item.menuItemId)
        .filter(Boolean) as string[];

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

      lineItems = dto.items.map((item) => {
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
          ? this.settings
            ? await this.settings.get('marketplaceDeliveryFee')
            : Number(this.config.get<number>('orders.marketplaceDeliveryFee') ?? 0)
          : 0;

    const totalAmount = subtotal + deliveryFee;

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
            distanceKm: true,
            createdAt: true,
            updatedAt: true,
          },
        },
      },
      });
    } catch (error) {
      // Two retries with the same key arrived together and the other one
      // created the order. Nothing else (delivery, stock) has happened yet
      // for this request, so just return that order.
      if (idempotencyKey && isUniqueViolation(error)) {
        const existing = await this.prisma.order.findUnique({
          where: { customerId_idempotencyKey: { customerId, idempotencyKey } },
          select: { id: true },
        });
        if (existing) return this.findOne(existing.id, customerId);
      }
      throw error;
    }

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

    const orderWithDelivery = await this.prisma.order.findUnique({
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
            distanceKm: true,
            createdAt: true,
            updatedAt: true,
          },
        },
      },
    });

    if (dto.type === OrderType.MARKETPLACE) {
      for (const item of lineItems) {
        if (item.productId) {
          await this.marketplace.decrementStock(
            item.productId,
            item.quantity,
          );
        }
      }
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

    // The code secrets and location fields never leave the server. (A
    // customer sees their code only when opening one order.)
    return orders.map((order) =>
      order.delivery
        ? { ...order, delivery: stripDeliverySecrets(order.delivery) }
        : order,
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
      return {
        ...order,
        delivery: stripDeliverySecrets(delivery),
      };
    }

    return order;
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
    });

    if (!existingOrder) {
      throw new NotFoundException('Order not found');
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
}
