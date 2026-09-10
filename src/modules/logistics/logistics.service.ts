import { Injectable, NotFoundException } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { PrismaService } from '../../database/prisma.service';
import { UpdatePartnerStatusDto } from './dto/update-partner-status.dto';
import { UpdateDeliveryStatusDto } from './dto/update-delivery-status.dto';

// Short-distance deliveries go to walking partners, longer ones need a motorcycle.
// Distance isn't tracked yet at the order level (no vendor/customer coordinates
// wired up), so this defaults to WALKING for now — swap in real distance-based
// logic here once pickup/dropoff coordinates are captured on the order.
const WALKING_MAX_DISTANCE_KM = 2;

@Injectable()
export class LogisticsService {
  constructor(private readonly prisma: PrismaService) {}

  @OnEvent('payment.successful')
  async handlePaymentSuccessful(payment: { orderId?: string; laundryOrderId?: string }) {
    if (payment.orderId) {
      await this.prisma.delivery.create({ data: { orderId: payment.orderId, status: 'ASSIGNED' } });
    } else if (payment.laundryOrderId) {
      await this.prisma.delivery.create({ data: { laundryOrderId: payment.laundryOrderId, status: 'ASSIGNED' } });
    }
  }

  determinePartnerType(distanceKm: number): 'WALKING' | 'MOTORCYCLE' {
    return distanceKm <= WALKING_MAX_DISTANCE_KM ? 'WALKING' : 'MOTORCYCLE';
  }

  findUnassigned() {
    return this.prisma.delivery.findMany({
      where: { partnerId: null },
      include: { order: true, laundryOrder: true },
    });
  }

  // userId here is the StaffUser id from the JWT (@CurrentUser().userId) —
  // DeliveryPartnerProfile.staffUserId links back to that same StaffUser row.
  async claim(deliveryId: string, userId: string) {
    const profile = await this.prisma.deliveryPartnerProfile.findUnique({ where: { staffUserId: userId } });
    if (!profile) throw new NotFoundException('You are not registered as a delivery partner');

    const delivery = await this.prisma.delivery.findUnique({ where: { id: deliveryId } });
    if (!delivery) throw new NotFoundException('Delivery not found');

    return this.prisma.delivery.update({
      where: { id: deliveryId },
      data: { partnerId: profile.id, status: 'EN_ROUTE_TO_PICKUP' },
    });
  }

  async updateStatus(deliveryId: string, dto: UpdateDeliveryStatusDto) {
    const delivery = await this.prisma.delivery.findUnique({ where: { id: deliveryId } });
    if (!delivery) throw new NotFoundException('Delivery not found');
    const updated = await this.prisma.delivery.update({
      where: { id: deliveryId },
      data: { status: dto.status },
    });

    if (dto.status === 'DELIVERED' && delivery.partnerId) {
      await this.prisma.driverEarning.create({
        data: { partnerId: delivery.partnerId, amount: 15, note: `Delivery ${deliveryId}` },
      });
    }
    return updated;
  }

  async updatePartnerStatus(userId: string, dto: UpdatePartnerStatusDto) {
    const profile = await this.prisma.deliveryPartnerProfile.findUnique({ where: { staffUserId: userId } });
    if (!profile) throw new NotFoundException('You are not registered as a delivery partner');
    return this.prisma.deliveryPartnerProfile.update({ where: { staffUserId: userId }, data: dto });
  }

  async myDeliveries(userId: string) {
    const profile = await this.prisma.deliveryPartnerProfile.findUnique({ where: { staffUserId: userId } });
    if (!profile) throw new NotFoundException('You are not registered as a delivery partner');
    return this.prisma.delivery.findMany({
      where: { partnerId: profile.id },
      include: { order: true, laundryOrder: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async myEarnings(userId: string) {
    const profile = await this.prisma.deliveryPartnerProfile.findUnique({ where: { staffUserId: userId } });
    if (!profile) throw new NotFoundException('You are not registered as a delivery partner');
    const earnings = await this.prisma.driverEarning.findMany({ where: { partnerId: profile.id } });
    const total = earnings.reduce((sum, e) => sum + Number(e.amount), 0);
    return { total, earnings };
  }
}
