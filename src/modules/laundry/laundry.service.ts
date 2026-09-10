import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';

// TODO: implement Laundry business logic here.
// Keep this service the single place that owns Laundry rules —
// controllers stay thin, repositories/prisma calls happen here.
@Injectable()
export class LaundryService {
  constructor(private readonly prisma: PrismaService) {}

  findAll() {
    // TODO: replace with real query once Laundry models are finalized
    return { message: 'Laundry module scaffolded — implement findAll()' };
  }
}
