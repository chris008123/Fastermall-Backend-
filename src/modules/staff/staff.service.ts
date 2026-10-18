import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { createHash, timingSafeEqual } from 'crypto';
import { PrismaService } from '../../database/prisma.service';
import { LoginStaffDto } from './dto/login-staff.dto';
import { CreateStaffDto } from './dto/create-staff.dto';
import { BootstrapAdminDto } from './dto/bootstrap-admin.dto';
import {
  DUMMY_PASSWORD_HASH,
  LOGIN_LOCK_MS,
  MAX_LOGIN_FAILURES,
  isLocked,
  tooManyAttempts,
} from '../../shared/utils/lockout';

@Injectable()
export class StaffService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private config: ConfigService,
  ) {}

  async login(dto: LoginStaffDto) {
    const staffUser = await this.prisma.staffUser.findUnique({ where: { email: dto.email } });
    if (!staffUser) {
      await bcrypt.compare(dto.password, DUMMY_PASSWORD_HASH);
      throw new UnauthorizedException('Invalid email or password');
    }

    if (isLocked(staffUser.loginLockedUntil)) {
      throw tooManyAttempts('Too many failed login attempts. Try again in 15 minutes.');
    }

    const passwordMatches = await bcrypt.compare(dto.password, staffUser.passwordHash);
    if (!passwordMatches) {
      const after = await this.prisma.staffUser.update({
        where: { id: staffUser.id },
        data: { loginFailures: { increment: 1 } },
        select: { loginFailures: true },
      });
      if ((after?.loginFailures ?? 0) >= MAX_LOGIN_FAILURES) {
        await this.prisma.staffUser.update({
          where: { id: staffUser.id },
          data: { loginFailures: 0, loginLockedUntil: new Date(Date.now() + LOGIN_LOCK_MS) },
        });
      }
      throw new UnauthorizedException('Invalid email or password');
    }

    if (staffUser.loginFailures > 0) {
      await this.prisma.staffUser.update({
        where: { id: staffUser.id },
        data: { loginFailures: 0, loginLockedUntil: null },
      });
    }

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
    // Compare fixed-length digests in constant time so response timing
    // can't be used to guess the secret one character at a time.
    const digest = (v: string) => createHash('sha256').update(v).digest();
    if (
      !expectedSecret ||
      !timingSafeEqual(digest(dto.secret), digest(expectedSecret))
    ) {
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
    return this.prisma.staffUser.findMany({
      select: { id: true, email: true, fullName: true, role: true, isVerified: true, createdAt: true },
    });
  }

  async getProfile(staffUserId: string) {
    const staffUser = await this.prisma.staffUser.findUnique({
      where: { id: staffUserId },
      include: {
        deliveryProfile: true,
      },
    });

    if (!staffUser) {
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
    // Staff tokens (admin, vendor, courier) are shorter-lived than customer
    // ones because they carry more power.
    const accessToken = this.jwt.sign(
      {
        sub: staffUser.id,
        email: staffUser.email,
        role: staffUser.role,
      },
      { expiresIn: this.config.get<string>('jwt.staffExpiresIn') ?? '12h' },
    );

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
