import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Address } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { CreateAddressDto, UpdateAddressDto } from './dto/address.dto';

export const MAX_ADDRESSES_PER_CUSTOMER = 20;

// The one-line text riders and admins see on an order.
export function formatAddressLabel(
  address: Pick<Address, 'hostel' | 'room' | 'landmark'>,
): string {
  const parts = [address.hostel, `Room ${address.room}`];
  if (address.landmark) parts.push(`near ${address.landmark}`);
  return parts.join(', ');
}

function assertCoordinatesPaired(dto: { lat?: number; lng?: number }) {
  if ((dto.lat === undefined) !== (dto.lng === undefined)) {
    throw new BadRequestException('Send both lat and lng, or neither');
  }
}

/**
 * A customer's saved delivery addresses. At most one is the default: the
 * first address saved becomes the default, choosing another default moves
 * it, and deleting the default hands it to the oldest remaining address.
 */
@Injectable()
export class AddressesService {
  constructor(private readonly prisma: PrismaService) {}

  list(userId: string) {
    return this.prisma.address.findMany({
      where: { userId },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    });
  }

  async create(userId: string, dto: CreateAddressDto) {
    assertCoordinatesPaired(dto);

    return this.prisma.$transaction(async (tx) => {
      const count = await tx.address.count({ where: { userId } });
      if (count >= MAX_ADDRESSES_PER_CUSTOMER) {
        throw new BadRequestException(
          `You can save up to ${MAX_ADDRESSES_PER_CUSTOMER} addresses. Delete one to add another.`,
        );
      }

      const isDefault = count === 0 || dto.isDefault === true;
      if (isDefault) {
        await tx.address.updateMany({
          where: { userId, isDefault: true },
          data: { isDefault: false },
        });
      }

      return tx.address.create({
        data: { ...trimmed(dto), userId, isDefault },
      });
    });
  }

  async update(userId: string, id: string, dto: UpdateAddressDto) {
    const existing = await this.getOwned(userId, id);

    // Coordinates are replaced as a pair.
    if (dto.lat !== undefined || dto.lng !== undefined) {
      assertCoordinatesPaired(dto);
    }

    return this.prisma.$transaction(async (tx) => {
      if (dto.isDefault === true && !existing.isDefault) {
        await tx.address.updateMany({
          where: { userId, isDefault: true },
          data: { isDefault: false },
        });
      }

      return tx.address.update({
        where: { id },
        data: trimmed(dto),
      });
    });
  }

  async remove(userId: string, id: string) {
    const existing = await this.getOwned(userId, id);

    await this.prisma.$transaction(async (tx) => {
      await tx.address.delete({ where: { id } });

      if (existing.isDefault) {
        const next = await tx.address.findFirst({
          where: { userId },
          orderBy: { createdAt: 'asc' },
          select: { id: true },
        });
        if (next) {
          await tx.address.update({
            where: { id: next.id },
            data: { isDefault: true },
          });
        }
      }
    });

    return { deleted: true };
  }

  // Someone else's address answers "not found", so ids can't be probed.
  async getOwned(userId: string, id: string) {
    const address = await this.prisma.address.findFirst({
      where: { id, userId },
    });
    if (!address) {
      throw new NotFoundException('Address not found');
    }
    return address;
  }
}

function trimmed<T extends Partial<CreateAddressDto>>(dto: T): T {
  const out = { ...dto };
  for (const key of ['label', 'hostel', 'room', 'landmark'] as const) {
    const value = out[key];
    if (typeof value === 'string') {
      (out as Partial<CreateAddressDto>)[key] = value.trim();
    }
  }
  return out;
}
