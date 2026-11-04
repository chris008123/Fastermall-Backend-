import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { LoginStaffDto } from './dto/login-staff.dto';
import { CreateStaffDto } from './dto/create-staff.dto';
import { BootstrapAdminDto } from './dto/bootstrap-admin.dto';
import { UpdateStaffDto } from './dto/update-staff.dto';

const SAFE_STAFF_SELECT = {
  id: true,
  email: true,
  phone: true,
  fullName: true,
  role: true,
  isVerified: true,
  isActive: true,
  deactivatedAt: true,
  createdAt: true,
} as const;

@Injectable()
export class StaffService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private config: ConfigService,
  ) {}

  async login(dto: LoginStaffDto) {
    const staffUser = await this.prisma.staffUser.findUnique({ where: { email: dto.email } });
    if (!staffUser) throw new UnauthorizedException('Invalid email or password');

    const passwordMatches = await bcrypt.compare(dto.password, staffUser.passwordHash);
    if (!passwordMatches) throw new UnauthorizedException('Invalid email or password');
    // Checked after the password so a guesser can't learn the account exists.
    if (!staffUser.isActive) throw new UnauthorizedException('This account has been deactivated');

    return this.buildAuthResponse(staffUser);
  }

  // Admin-only — the normal way every staff account after the first admin gets created
  async createStaff(dto: CreateStaffDto) {
    const existing = await this.prisma.staffUser.findUnique({ where: { email: dto.email } });
    if (existing) throw new ConflictException('A staff account with this email already exists');

    const passwordHash = await bcrypt.hash(dto.password, 10);

    const staffUser = await this.prisma.staffUser.create({
      data: {
        email: dto.email,
        phone: dto.phone,
        fullName: dto.fullName,
        role: dto.role,
        passwordHash,
      },
    });

    if (dto.role === 'DELIVERY_PARTNER') {
      await this.prisma.deliveryPartnerProfile.create({
        data: {
          staffUserId: staffUser.id,
          type: dto.partnerType ?? 'WALKING',
        },
      });
    }

    const { passwordHash: _, ...safeStaffUser } = staffUser;
    return safeStaffUser;
  }

  // One-time bootstrap for your very first admin. Once any ADMIN exists,
  // this closes itself — further staff accounts must go through
  // createStaff() above, authenticated as that admin.
  async bootstrapAdmin(dto: BootstrapAdminDto) {
    const expectedSecret = this.config.get<string>('adminBootstrapSecret');
    if (!expectedSecret || dto.secret !== expectedSecret) {
      throw new ForbiddenException('Invalid bootstrap secret');
    }

    const existingAdmin = await this.prisma.staffUser.findFirst({ where: { role: 'ADMIN' } });
    if (existingAdmin) {
      throw new BadRequestException(
        'An admin already exists. Use an authenticated admin account to create more staff.',
      );
    }

    const existing = await this.prisma.staffUser.findUnique({ where: { email: dto.email } });
    if (existing) throw new ConflictException('A staff account with this email already exists');

    const passwordHash = await bcrypt.hash(dto.password, 10);
    const staffUser = await this.prisma.staffUser.create({
      data: { email: dto.email, fullName: dto.fullName, role: 'ADMIN', passwordHash },
    });

    return this.buildAuthResponse(staffUser);
  }

  findAll() {
    return this.prisma.staffUser.findMany({ select: SAFE_STAFF_SELECT });
  }

  // Admin-only. Empty strings clear the phone; name and email can't be cleared.
  async updateStaff(id: string, dto: UpdateStaffDto) {
    const data: Prisma.StaffUserUpdateInput = {};
    if (dto.fullName !== undefined) data.fullName = dto.fullName.trim();
    if (dto.email !== undefined) data.email = dto.email.trim(); // login matches email exactly, as createStaff stores it
    if (dto.phone !== undefined) data.phone = dto.phone.trim() || null;
    if (data.fullName === '') throw new BadRequestException('Name cannot be empty');
    if (Object.keys(data).length === 0) throw new BadRequestException('Nothing to update');

    try {
      return await this.prisma.staffUser.update({ where: { id }, data, select: SAFE_STAFF_SELECT });
    } catch (e) {
      throw this.mapWriteError(e);
    }
  }

  // Admin-only. Sets a new password for a staff member who is locked out.
  // Tokens already issued stay valid until they expire.
  async resetPassword(id: string, password: string) {
    const passwordHash = await bcrypt.hash(password, 10);
    try {
      await this.prisma.staffUser.update({ where: { id }, data: { passwordHash }, select: { id: true } });
    } catch (e) {
      throw this.mapWriteError(e);
    }
    return { id, passwordReset: true };
  }

  // Admin-only. Deactivated staff can't sign in and their tokens are refused
  // (see JwtStrategy). History (deliveries, replies) is kept.
  async setActive(id: string, isActive: boolean, actorId: string) {
    if (!isActive && id === actorId) {
      throw new BadRequestException("You can't deactivate your own account");
    }
    const target = await this.prisma.staffUser.findUnique({
      where: { id },
      select: { id: true, role: true, isActive: true },
    });
    if (!target) throw new NotFoundException('Staff account not found');

    if (!isActive && target.role === 'ADMIN' && target.isActive) {
      const activeAdmins = await this.prisma.staffUser.count({ where: { role: 'ADMIN', isActive: true } });
      if (activeAdmins <= 1) throw new BadRequestException("You can't deactivate the last active admin");
    }

    return this.prisma.staffUser.update({
      where: { id },
      data: { isActive, deactivatedAt: isActive ? null : new Date() },
      select: SAFE_STAFF_SELECT,
    });
  }

  private mapWriteError(e: unknown) {
    if (e instanceof Prisma.PrismaClientKnownRequestError) {
      if (e.code === 'P2025') return new NotFoundException('Staff account not found');
      if (e.code === 'P2002') return new ConflictException('Another staff account already uses this email or phone');
    }
    return e;
  }

  async getProfile(staffUserId: string) {
    const staffUser = await this.prisma.staffUser.findUnique({
      where: { id: staffUserId },
      include: {
        deliveryProfile: true,
      },
    });

    if (!staffUser || !staffUser.isActive) {
      throw new UnauthorizedException();
    }

    const { passwordHash, ...safe } = staffUser;

    return safe;
  }

    private buildAuthResponse(staffUser: {
    id: string;
    email: string | null;
    fullName: string;
    role: string;
  }) {
    const accessToken = this.jwt.sign({
      sub: staffUser.id,
      email: staffUser.email,
      role: staffUser.role,
    });

    return {
      accessToken,
      user: {
        id: staffUser.id,
        email: staffUser.email,
        fullName: staffUser.fullName,
        role: staffUser.role,
      },
    };
  }

}
