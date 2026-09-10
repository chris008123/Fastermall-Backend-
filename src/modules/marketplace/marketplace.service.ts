import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';

// TODO: implement Marketplace business logic here.
// Keep this service the single place that owns Marketplace rules —
// controllers stay thin, repositories/prisma calls happen here.
@Injectable()
export class MarketplaceService {
  constructor(private readonly prisma: PrismaService) {}

  findAll() {
    // TODO: replace with real query once Marketplace models are finalized
    return { message: 'Marketplace module scaffolded — implement findAll()' };
  }
}
