import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';

// TODO: implement Admin business logic here.
// Keep this service the single place that owns Admin rules —
// controllers stay thin, repositories/prisma calls happen here.
@Injectable()
export class AdminService {
  constructor(private readonly prisma: PrismaService) {}

  findAll() {
    // TODO: replace with real query once Admin models are finalized
    return { message: 'Admin module scaffolded — implement findAll()' };
  }
}
