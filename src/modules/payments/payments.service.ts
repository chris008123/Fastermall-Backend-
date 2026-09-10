import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';

// TODO: implement Payments business logic here.
// Keep this service the single place that owns Payments rules —
// controllers stay thin, repositories/prisma calls happen here.
@Injectable()
export class PaymentsService {
  constructor(private readonly prisma: PrismaService) {}

  findAll() {
    // TODO: replace with real query once Payments models are finalized
    return { message: 'Payments module scaffolded — implement findAll()' };
  }
}
