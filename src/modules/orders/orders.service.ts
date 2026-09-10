import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
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
      throw new BadRequestException('An order must contain at least one item');
    }

    // Business Layer validates every item exists and belongs to the right domain
    // before any money or stock is touched — matches the doc's request lifecycle.
    let lineItems: { productId?: string; menuItemId?: string; quantity: number; unitPrice: number }[];

    if (dto.type === OrderType.MARKETPLACE) {
      const ids = dto.items.map((i) => i.productId).filter(Boolean) as string[];
      const products = await this.marketplace.getProductsByIds(ids);
      lineItems = dto.items.map((item) => {
        const product = products.find((p) => p.id === item.productId);
        if (!product) throw new NotFoundException(`Product ${item.productId} not found`);
        if (product.stock < item.quantity) {
          throw new BadRequestException(`Insufficient stock for ${product.name}`);
        }
        return { productId: product.id, quantity: item.quantity, unitPrice: Number(product.price) };
      });
    } else {
      const ids = dto.items.map((i) => i.menuItemId).filter(Boolean) as string[];
      const menuItems = await this.food.getMenuItemsByIds(ids);
      lineItems = dto.items.map((item) => {
        const menuItem = menuItems.find((m) => m.id === item.menuItemId);
        if (!menuItem) throw new NotFoundException(`Menu item ${item.menuItemId} not found`);
        if (!menuItem.isAvailable) throw new BadRequestException(`${menuItem.name} is currently unavailable`);
        return { menuItemId: menuItem.id, quantity: item.quantity, unitPrice: Number(menuItem.price) };
      });
    }

    const totalAmount = lineItems.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0);

    const order = await this.prisma.order.create({
      data: {
        customerId,
        type: dto.type,
        totalAmount,
        items: { create: lineItems },
      },
      include: { items: true },
    });

    if (dto.type === OrderType.MARKETPLACE) {
      for (const item of lineItems) {
        if (item.productId) await this.marketplace.decrementStock(item.productId, item.quantity);
      }
    }

    // Domain Event Bus — Payment, Logistics, Notification modules subscribe to this
    // instead of OrdersService calling them directly (loose coupling per the doc).
    this.events.emit('order.created', order);

    return order;
  }

  findMyOrders(customerId: string) {
    return this.prisma.order.findMany({
      where: { customerId },
      include: { items: true, payment: true, delivery: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: { items: true, payment: true, delivery: true },
    });
    if (!order) throw new NotFoundException('Order not found');
    return order;
  }

  async updateStatus(id: string, dto: UpdateOrderStatusDto) {
    await this.findOne(id);
    const updated = await this.prisma.order.update({ where: { id }, data: { status: dto.status } });
    this.events.emit('order.status.updated', updated);
    return updated;
  }
}
