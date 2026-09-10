import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';

// TODO: implement Notifications business logic here.
// Keep this service the single place that owns Notifications rules —
// controllers stay thin, repositories/prisma calls happen here.
@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  findAll() {
    // TODO: replace with real query once Notifications models are finalized
    return { message: 'Notifications module scaffolded — implement findAll()' };
  }
}
