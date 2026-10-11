import { Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../database/prisma.service';
import { CreateLaundryOrderDto } from './dto/create-laundry-order.dto';
import { UpdateLaundryStatusDto } from './dto/update-laundry-status.dto';

// Flat per-item price for MVP — replace with a real pricing table per package later


@Injectable()
export class LaundryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {}

  async getCatalog() {
    return this.prisma.laundryCatalogItem.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' },
    });
  }

  async createOrder(customerId: string, dto: CreateLaundryOrderDto) {
    const catalogIds = dto.items.map((item) => item.catalogItemId);

    const catalogItems = await this.prisma.laundryCatalogItem.findMany({
      where: {
        id: { in: catalogIds },
        isActive: true,
      },
    });

    if (catalogItems.length !== new Set(catalogIds).size) {
      throw new NotFoundException(
        'One or more laundry catalog items were not found',
      );
    }

    const catalogMap = new Map(
      catalogItems.map((item) => [item.id, item]),
    );

    const laundryItems = dto.items.map((item) => {
      const catalogItem = catalogMap.get(item.catalogItemId);

      if (!catalogItem) {
        throw new NotFoundException(
          `Laundry catalog item ${item.catalogItemId} not found`,
        );
      }

      const unitPrice = Number(catalogItem.unitPrice);
      const lineTotal = unitPrice * item.quantity;

      return {
        catalogItemId: catalogItem.id,
        description: catalogItem.name,
        quantity: item.quantity,
        unitPrice,
        lineTotal,
      };
    });

    const laundryTotal = laundryItems.reduce(
      (sum, item) => sum + item.lineTotal,
      0,
    );

    const deliveryFee = dto.pickupMode?.toLowerCase() === 'pickup' ? 5 : 0;

    const totalAmount = laundryTotal + deliveryFee;

    const order = await this.prisma.laundryOrder.create({
      data: {
        customerId,
        instructions: dto.instructions,
        pickupMode: dto.pickupMode,
        pickupAt: dto.pickupAt ? new Date(dto.pickupAt) : undefined,
        deliverAt: dto.deliverAt ? new Date(dto.deliverAt) : undefined,
        estimatedKg: dto.estimatedKg
          ? Number(dto.estimatedKg)
          : undefined,
        laundryTotal,
        deliveryFee,
        totalAmount,
        items: {
          create: laundryItems,
        },
      },
      include: {
        items: {
          include: {
            catalogItem: true,
          },
        },
      },
    });

    this.events.emit('laundry.created', order);

    return order;
  }
  
  findMyOrders(customerId: string) {
    return this.prisma.laundryOrder.findMany({
      where: { customerId },
      include: { items: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  private async getOrThrow(id: string) {
    const order = await this.prisma.laundryOrder.findUnique({
      where: { id },
      include: { items: true },
    });
    if (!order) throw new NotFoundException('Laundry order not found');
    return order;
  }

  // Customers can only read their own orders; laundry staff and admins can
  // read any. A stranger's order answers "not found", not "forbidden", so ids
  // can't be probed.
  async findOne(id: string, requester: { userId: string; role?: string }) {
    const order = await this.getOrThrow(id);
    const isStaff = requester.role === 'ADMIN' || requester.role === 'LAUNDRY_STAFF';
    if (!isStaff && order.customerId !== requester.userId) {
      throw new NotFoundException('Laundry order not found');
    }
    return order;
  }

  // Staff-only — moves an order through the pickup -> wash -> deliver pipeline
  async updateStatus(id: string, dto: UpdateLaundryStatusDto) {
    await this.getOrThrow(id);
    const updated = await this.prisma.laundryOrder.update({
      where: { id },
      data: { status: dto.status },
    });
    this.events.emit('laundry.status.updated', updated);
    return updated;
  }
}
