import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { OrderType } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { MarketplaceService } from '../marketplace/marketplace.service';
import { FoodService } from '../food/food.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly marketplace: MarketplaceService,
    private readonly food: FoodService,
    private readonly events: EventEmitter2,
  ) {}

  async createOrder(customerId: string, dto: CreateOrderDto) {
    if (dto.items.length === 0) {
      throw new BadRequestException(
        'An order must contain at least one item',
      );
    }

    if (dto.deliveryFee !== undefined && dto.deliveryFee < 0) {
      throw new BadRequestException('Delivery fee cannot be negative');
    }

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

    const deliveryFee =
      dto.type === OrderType.FOOD
        ? Number(dto.deliveryFee ?? 0)
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
        delivery: true,
      },
    });

    if (dto.type === OrderType.FOOD) {
      await this.prisma.delivery.create({
        data: {
          orderId: order.id,
          status: 'ASSIGNED',
        },
      });
    }

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
    this.events.emit('order.created', order);

    return order;
  }

  findMyOrders(customerId: string) {
    return this.prisma.order.findMany({
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
  }

  async findOne(id: string) {
    const order = await this.prisma.order.findUnique({
      where: { id },
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

    return order;
  }

  async updateStatus(id: string, dto: UpdateOrderStatusDto) {
    await this.findOne(id);

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
