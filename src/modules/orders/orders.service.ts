import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
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
import {
  encryptDeliveryCode,
  decryptDeliveryCode,
} from '../../shared/utils/delivery-code-encryption';

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly marketplace: MarketplaceService,
    private readonly food: FoodService,
    private readonly events: EventEmitter2,
    private readonly config: ConfigService,
  ) {}

  async createOrder(customerId: string, dto: CreateOrderDto) {
    if (dto.items.length === 0) {
      throw new BadRequestException(
        'An order must contain at least one item',
      );
    }

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
          ? Number(this.config.get<number>('orders.marketplaceDeliveryFee') ?? 0)
          : 0;

    const totalAmount = subtotal + deliveryFee;

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

      await this.prisma.delivery.create({
        data: {
          orderId: order.id,
          status: 'ASSIGNED',
          deliveryCodeHash,
          deliveryCodeEncrypted,
        },
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

    return updated;
  }
}
