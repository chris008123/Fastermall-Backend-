import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';

// TODO: implement Food business logic here.
// Keep this service the single place that owns Food rules —
// controllers stay thin, repositories/prisma calls happen here.
@Injectable()
export class FoodService {
  constructor(private readonly prisma: PrismaService) {}

  findAll() {
    // TODO: replace with real query once Food models are finalized
    return { message: 'Food module scaffolded — implement findAll()' };
  }
}
