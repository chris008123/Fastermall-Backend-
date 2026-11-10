import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { StaffService } from '../staff/staff.service';
import { UpdatePartnerStatusDto } from './dto/update-partner-status.dto';

// Vehicle papers that belong to one specific vehicle. If the vehicle changes
// they no longer prove anything, so an admin has to see new ones.
const VEHICLE_DOCUMENTS = ['VEHICLE_REGISTRATION', 'INSURANCE'];
const ACTIVE_STATUSES = ['EN_ROUTE_TO_PICKUP', 'PAY_VENDOR', 'PICKED_UP', 'EN_ROUTE_TO_CUSTOMER'];

export const VEHICLE_CHANGED_REASON =
  'Your vehicle details changed. Upload this document for your current vehicle.';

/**
 * A partner editing their own details.
 *
 *  - Plate or vehicle type: needs re-verification. The approved vehicle
 *    registration and insurance are sent back (REJECTED, with the reason
 *    above), so the partner uploads new ones and an admin approves them.
 *    Not allowed while a delivery is running.
 *  - Phone number: no re-verification (there is no SMS check), but it needs
 *    the password, and the number must not belong to anyone else.
 *  - Photo: it is the PROFILE_PHOTO document; use the documents flow.
 */
@Injectable()
export class ProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly staff: StaffService,
  ) {}

  async update(userId: string, dto: UpdatePartnerStatusDto) {
    const touchesProfile =
      dto.vehiclePlate !== undefined || dto.vehicleType !== undefined || dto.phone !== undefined;
    if (!touchesProfile) return null;

    const profile = await this.prisma.deliveryPartnerProfile.findUnique({
      where: { staffUserId: userId },
      include: { staffUser: { select: { phone: true } } },
    });
    if (!profile) throw new NotFoundException('You are not registered as a delivery partner');

    // ---- Vehicle ----
    const nextType = dto.vehicleType ?? profile.type;
    const suppliedPlate = dto.vehiclePlate?.trim().toUpperCase().replace(/\s+/g, ' ');

    if (nextType === 'WALKING' && suppliedPlate) {
      throw new BadRequestException({
        message: 'A walking partner has no vehicle plate',
        code: 'VEHICLE_PLATE_NOT_ALLOWED',
      });
    }

    const nextPlate = nextType === 'WALKING' ? null : (suppliedPlate ?? profile.vehiclePlate);

    if (nextType === 'MOTORCYCLE' && !nextPlate) {
      throw new BadRequestException({
        message: 'Enter the plate number of your motorcycle',
        code: 'PLATE_REQUIRED',
      });
    }

    const vehicleChanged = nextType !== profile.type || nextPlate !== (profile.vehiclePlate ?? null);

    if (vehicleChanged) {
      const active = await this.prisma.delivery.count({
        where: { partnerId: profile.id, status: { in: ACTIVE_STATUSES as any } },
      });
      if (active > 0) {
        throw new ConflictException({
          message: 'Finish your current deliveries before changing your vehicle',
          code: 'ACTIVE_DELIVERIES',
        });
      }
    }

    // ---- Phone ----
    const phoneChanged = dto.phone !== undefined && dto.phone !== profile.staffUser.phone;
    if (phoneChanged) {
      if (!dto.currentPassword) {
        throw new BadRequestException({
          message: 'Enter your password to change your phone number',
          code: 'PASSWORD_REQUIRED',
        });
      }
      await this.staff.assertCurrentPassword(userId, dto.currentPassword);
    }

    if (!vehicleChanged && !phoneChanged) {
      return { changed: [] as string[], reverification: { required: false, documentsReset: [] as string[] } };
    }

    // Papers for the old vehicle stop counting.
    const toReset = vehicleChanged
      ? await this.prisma.partnerDocument.findMany({
          where: { partnerId: profile.id, type: { in: VEHICLE_DOCUMENTS as any }, status: 'APPROVED' as any },
          select: { id: true, type: true },
        })
      : [];

    const ops: any[] = [];
    if (vehicleChanged) {
      ops.push(
        this.prisma.deliveryPartnerProfile.update({
          where: { id: profile.id },
          data: { type: nextType, vehiclePlate: nextPlate },
        }),
      );
      if (toReset.length) {
        ops.push(
          this.prisma.partnerDocument.updateMany({
            where: { id: { in: toReset.map((d) => d.id) } },
            data: { status: 'REJECTED' as any, rejectionReason: VEHICLE_CHANGED_REASON, reviewedAt: new Date() },
          }),
        );
      }
    }
    if (phoneChanged) {
      ops.push(this.prisma.staffUser.update({ where: { id: userId }, data: { phone: dto.phone } }));
    }

    try {
      await this.prisma.$transaction(ops);
    } catch (error: any) {
      if (error?.code === 'P2002') {
        throw new ConflictException({
          message: 'That phone number is already used by another account',
          code: 'PHONE_IN_USE',
        });
      }
      throw error;
    }

    return {
      changed: [vehicleChanged ? 'vehicle' : null, phoneChanged ? 'phone' : null].filter(Boolean) as string[],
      reverification: {
        required: vehicleChanged,
        documentsReset: toReset.map((d) => d.type as string),
      },
    };
  }
}
