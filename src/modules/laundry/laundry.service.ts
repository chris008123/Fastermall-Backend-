import { BadRequestException, ConflictException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { SettingsService } from '../settings/settings.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../database/prisma.service';
import { CreateLaundryOrderDto } from './dto/create-laundry-order.dto';
import { UpdateLaundryStatusDto } from './dto/update-laundry-status.dto';
import { isUniqueViolation } from '../../shared/utils/idempotency';
import {
  AddressesService,
  formatAddressLabel,
} from '../addresses/addresses.service';

// The original in-house laundry. Existing catalog, orders and laundry staff
// without a vendor belong to it (see the multivendor migration).
export const DEFAULT_LAUNDRY_VENDOR_ID = 'fastermall-laundry';

export type LaundryRequester = { userId: string; role?: string };


@Injectable()
export class LaundryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
    private readonly addresses: AddressesService,
    @Optional() private readonly settings?: SettingsService,
  ) {}

  /**
   * One vendor's active services. Without a vendor id: Fastermall Laundry,
   * which is what GET /laundry/catalog always returned (older apps).
   */
  async getCatalog(vendorId: string = DEFAULT_LAUNDRY_VENDOR_ID) {
    return this.prisma.laundryCatalogItem.findMany({
      where: { isActive: true, vendorId },
      orderBy: { name: 'asc' },
    });
  }

  /** The vendor a laundry staff member works for (null vendor = Fastermall). */
  async staffVendorId(staffUserId: string) {
    const staff = await this.prisma.staffUser.findUnique({
      where: { id: staffUserId },
      select: { laundryVendorId: true },
    });
    return staff?.laundryVendorId ?? DEFAULT_LAUNDRY_VENDOR_ID;
  }

  async createOrder(
    customerId: string,
    dto: CreateLaundryOrderDto,
    idempotencyKey?: string,
  ) {
    // A retry of a request we already handled gets the original order back.
    if (idempotencyKey) {
      const existing = await this.findByIdempotencyKey(customerId, idempotencyKey);
      if (existing) return existing;
    }

    // Maintenance mode (admin setting) stops new laundry orders.
    await this.settings?.assertOrderingOpen();

    // A saved address is copied onto the order, so later edits to it don't
    // change where an existing order is collected from.
    const addressLabel = dto.addressId
      ? formatAddressLabel(
          await this.addresses.getOwned(customerId, dto.addressId),
        )
      : dto.addressLabel;

    const catalogIds = dto.items.map((item) => item.catalogItemId);

    const catalogItems = await this.prisma.laundryCatalogItem.findMany({
      where: {
        id: { in: catalogIds },
        isActive: true,
      },
    });

    if (catalogItems.length !== new Set(catalogIds).size) {
      throw new NotFoundException(
        'One or more laundry catalog items were not found',
      );
    }

    // One vendor washes the whole order.
    const vendorIds = [...new Set(catalogItems.map((item) => item.vendorId))];
    if (vendorIds.length > 1) {
      throw new BadRequestException({
        message: 'A laundry order can only use one laundry vendor',
        code: 'MIXED_LAUNDRY_VENDORS',
      });
    }
    const vendorId = vendorIds[0];
    if (dto.vendorId && dto.vendorId !== vendorId) {
      throw new BadRequestException({
        message: 'These items are not from the chosen laundry vendor',
        code: 'WRONG_LAUNDRY_VENDOR',
      });
    }
    const vendor = await this.prisma.laundryVendor.findUnique({
      where: { id: vendorId },
      select: { status: true, isOpen: true, name: true },
    });
    if (!vendor || vendor.status !== 'APPROVED') {
      throw new NotFoundException('Laundry vendor not found');
    }
    if (!vendor.isOpen) {
      throw new ConflictException({
        message: `${vendor.name} is not taking orders right now`,
        code: 'LAUNDRY_VENDOR_CLOSED',
      });
    }

    const catalogMap = new Map(
      catalogItems.map((item) => [item.id, item]),
    );

    const laundryItems = dto.items.map((item) => {
      const catalogItem = catalogMap.get(item.catalogItemId);

      if (!catalogItem) {
        throw new NotFoundException(
          `Laundry catalog item ${item.catalogItemId} not found`,
        );
      }

      const unitPrice = Number(catalogItem.unitPrice);
      const lineTotal = unitPrice * item.quantity;

      return {
        catalogItemId: catalogItem.id,
        description: catalogItem.name,
        quantity: item.quantity,
        unitPrice,
        lineTotal,
      };
    });

    const laundryTotal = laundryItems.reduce(
      (sum, item) => sum + item.lineTotal,
      0,
    );

    const pickupFee = this.settings ? await this.settings.get('laundryPickupFee') : 5;
    const deliveryFee = dto.pickupMode?.toLowerCase() === 'pickup' ? pickupFee : 0;

    const totalAmount = laundryTotal + deliveryFee;

    let order;
    try {
      order = await this.prisma.laundryOrder.create({
        data: {
          customerId,
          idempotencyKey,
          vendorId,
          addressLabel,
          instructions: dto.instructions,
          pickupMode: dto.pickupMode,
          pickupAt: dto.pickupAt ? new Date(dto.pickupAt) : undefined,
          deliverAt: dto.deliverAt ? new Date(dto.deliverAt) : undefined,
          estimatedKg: dto.estimatedKg
            ? Number(dto.estimatedKg)
            : undefined,
          laundryTotal,
          deliveryFee,
          totalAmount,
          items: {
            create: laundryItems,
          },
        },
        include: {
          items: {
            include: {
              catalogItem: true,
            },
          },
        },
      });
    } catch (error) {
      // Two retries with the same key arrived together and the other won.
      if (idempotencyKey && isUniqueViolation(error)) {
        const existing = await this.findByIdempotencyKey(customerId, idempotencyKey);
        if (existing) return existing;
      }
      throw error;
    }

    this.events.emit('laundry.created', order);

    return order;
  }

  private findByIdempotencyKey(customerId: string, idempotencyKey: string) {
    return this.prisma.laundryOrder.findUnique({
      where: { customerId_idempotencyKey: { customerId, idempotencyKey } },
      include: { items: { include: { catalogItem: true } } },
    });
  }

  findMyOrders(customerId: string) {
    return this.prisma.laundryOrder.findMany({
      where: { customerId },
      include: { items: true, vendor: { select: { id: true, name: true, logoUrl: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  private async getOrThrow(id: string) {
    const order = await this.prisma.laundryOrder.findUnique({
      where: { id },
      include: { items: true, vendor: { select: { id: true, name: true, logoUrl: true } } },
    });
    if (!order) throw new NotFoundException('Laundry order not found');
    return order;
  }

  // Who may see / work on an order: admins any; laundry staff only their own
  // vendor's; customers only their own. Anything else answers "not found",
  // so ids can't be probed.
  private async assertCanSee(
    order: { customerId: string; vendorId: string | null },
    requester: LaundryRequester,
  ) {
    if (requester.role === 'ADMIN') return;
    if (requester.role === 'LAUNDRY_STAFF') {
      const vendorId = await this.staffVendorId(requester.userId);
      if ((order.vendorId ?? DEFAULT_LAUNDRY_VENDOR_ID) === vendorId) return;
    } else if (order.customerId === requester.userId) {
      return;
    }
    throw new NotFoundException('Laundry order not found');
  }

  async findOne(id: string, requester: LaundryRequester) {
    const order = await this.getOrThrow(id);
    await this.assertCanSee(order, requester);
    return order;
  }

  /**
   * Laundry staff: their vendor's orders. Admins: every order, or one
   * vendor's with ?vendorId. Newest first, optionally by status.
   */
  async staffOrders(requester: LaundryRequester, query: { status?: string; vendorId?: string } = {}) {
    const vendorId =
      requester.role === 'ADMIN' ? query.vendorId : await this.staffVendorId(requester.userId);
    return this.prisma.laundryOrder.findMany({
      where: {
        ...(vendorId ? { vendorId } : {}),
        ...(query.status ? { status: query.status as any } : {}),
      },
      include: { items: true, customer: { select: { id: true, fullName: true, phone: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 200,
    });
  }

  // Staff only: moves an order through the pickup -> wash -> deliver pipeline.
  // Laundry staff can only move their own vendor's orders.
  async updateStatus(id: string, dto: UpdateLaundryStatusDto, requester?: LaundryRequester) {
    const order = await this.getOrThrow(id);
    if (requester) await this.assertCanSee(order, requester);
    const updated = await this.prisma.laundryOrder.update({
      where: { id },
      data: { status: dto.status },
    });
    this.events.emit('laundry.status.updated', updated);
    return updated;
  }
}
