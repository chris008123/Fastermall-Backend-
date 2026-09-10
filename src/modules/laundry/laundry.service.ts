import { Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../database/prisma.service';
import { CreateLaundryOrderDto } from './dto/create-laundry-order.dto';
import { UpdateLaundryStatusDto } from './dto/update-laundry-status.dto';

// Flat per-item price for MVP — replace with a real pricing table per package later
const PACKAGE_PRICES: Record<string, number> = {
  standard: 5,
  express: 8,
  premium: 12,
};

@Injectable()
export class LaundryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {}

  async createOrder(customerId: string, dto: CreateLaundryOrderDto) {
    const pricePerItem = PACKAGE_PRICES[dto.servicePackage.toLowerCase()] ?? PACKAGE_PRICES.standard;
    const totalAmount = pricePerItem * dto.items.length;

    const order = await this.prisma.laundryOrder.create({
      data: {
        customerId,
        servicePackage: dto.servicePackage,
        instructions: dto.instructions,
        pickupAt: dto.pickupAt ? new Date(dto.pickupAt) : undefined,
        totalAmount,
        items: { create: dto.items.map((description) => ({ description })) },
      },
      include: { items: true },
    });

    // Domain Event Bus: Payment/Logistics/Notification modules react to this
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

  async findOne(id: string) {
    const order = await this.prisma.laundryOrder.findUnique({
      where: { id },
      include: { items: true },
    });
    if (!order) throw new NotFoundException('Laundry order not found');
    return order;
  }

  // Staff-only — moves an order through the pickup -> wash -> deliver pipeline
  async updateStatus(id: string, dto: UpdateLaundryStatusDto) {
    await this.findOne(id);
    const updated = await this.prisma.laundryOrder.update({
      where: { id },
      data: { status: dto.status },
    });
    this.events.emit('laundry.status.updated', updated);
    return updated;
  }
}
