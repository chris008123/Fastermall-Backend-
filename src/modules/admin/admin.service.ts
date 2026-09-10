import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';

@Injectable()
export class AdminService {
  constructor(private readonly prisma: PrismaService) {}

  async dashboardStats() {
    const [users, products, orders, laundryOrders, openTickets, pendingPayments] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.product.count(),
      this.prisma.order.count(),
      this.prisma.laundryOrder.count(),
      this.prisma.supportTicket.count({ where: { status: 'OPEN' } }),
      this.prisma.payment.count({ where: { status: 'PENDING' } }),
    ]);

    return { users, products, orders, laundryOrders, openTickets, pendingPayments };
  }

  findAllUsers() {
    return this.prisma.user.findMany({
      select: { id: true, email: true, fullName: true, isVerified: true, createdAt: true },
    });
  }
}
