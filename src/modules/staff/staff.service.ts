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
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../../database/prisma.service';
import { LoginStaffDto } from './dto/login-staff.dto';
import { CreateStaffDto } from './dto/create-staff.dto';
import { BootstrapAdminDto } from './dto/bootstrap-admin.dto';

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

    if (!staffUser.isActive) {
      throw new ForbiddenException({
        message: 'This account has been disabled. Contact support.',
        code: 'ACCOUNT_DISABLED',
      });
    }

    return this.buildAuthResponse(staffUser);
  }

  /**
   * Swaps a refresh token for a new access token and a new refresh token.
   * Each refresh token works once. If an old one is shown again, someone may
   * have copied it, so every session of that account is ended.
   */
  async refresh(refreshToken: string) {
    const session = await this.prisma.staffSession.findUnique({
      where: { refreshTokenHash: this.hashToken(refreshToken) },
      include: { staffUser: true },
    });

    if (!session) {
      throw new UnauthorizedException({ message: 'Session ended', code: 'SESSION_INVALID' });
    }

    if (session.revokedAt) {
      await this.prisma.staffSession.updateMany({
        where: { staffUserId: session.staffUserId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      throw new UnauthorizedException({ message: 'Session ended', code: 'SESSION_REUSED' });
    }

    if (session.expiresAt <= new Date() || !session.staffUser.isActive) {
      throw new UnauthorizedException({ message: 'Session ended', code: 'SESSION_INVALID' });
    }

    // Retire the old session; if a parallel request got there first, stop.
    const retired = await this.prisma.staffSession.updateMany({
      where: { id: session.id, revokedAt: null },
      data: { revokedAt: new Date(), lastUsedAt: new Date() },
    });
    if (retired.count === 0) {
      throw new UnauthorizedException({ message: 'Session ended', code: 'SESSION_INVALID' });
    }

    return this.buildAuthResponse(session.staffUser);
  }

  /** Ends the session the request was made with (this device only). */
  async logout(sessionId?: string) {
    if (sessionId) {
      await this.prisma.staffSession.updateMany({
        where: { id: sessionId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
    return { loggedOut: true };
  }

  /** Admin: disable or re-enable an account. Disabling ends every session. */
  async setActive(staffUserId: string, isActive: boolean, actingAdminId: string) {
    if (staffUserId === actingAdminId && !isActive) {
      throw new BadRequestException('You cannot disable your own account');
    }

    const existing = await this.prisma.staffUser.findUnique({ where: { id: staffUserId } });
    if (!existing) throw new NotFoundException('Staff account not found');

    await this.prisma.staffUser.update({ where: { id: staffUserId }, data: { isActive } });

    if (!isActive) {
      await this.prisma.staffSession.updateMany({
        where: { staffUserId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }

    return { id: staffUserId, isActive };
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
    return this.prisma.staffUser.findMany({
      select: { id: true, email: true, fullName: true, role: true, isVerified: true, isActive: true, createdAt: true },
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

  private hashToken(token: string) {
    return createHash('sha256').update(token).digest('hex');
  }

  // Creates a session (one per device), then the short access token that
  // points at it and the one-time refresh token that renews it.
  private async buildAuthResponse(staffUser: {
    id: string;
    email: string | null;
    fullName: string;
    role: string;
  }) {
    const refreshToken = randomBytes(48).toString('base64url');
    const days = this.config.get<number>('jwt.staffRefreshDays') ?? 30;

    const session = await this.prisma.staffSession.create({
      data: {
        staffUserId: staffUser.id,
        refreshTokenHash: this.hashToken(refreshToken),
        expiresAt: new Date(Date.now() + days * 24 * 60 * 60 * 1000),
      },
    });

    const accessToken = this.jwt.sign(
      {
        sub: staffUser.id,
        email: staffUser.email,
        role: staffUser.role,
        sid: session.id,
      },
      { expiresIn: this.config.get<string>('jwt.staffAccessExpiresIn') ?? '15m' },
    );

    const decoded = this.jwt.decode(accessToken) as { exp: number; iat: number } | null;

    return {
      accessToken,
      refreshToken,
      expiresIn: decoded ? decoded.exp - decoded.iat : undefined, // seconds
      user: {
        id: staffUser.id,
        email: staffUser.email,
        fullName: staffUser.fullName,
        role: staffUser.role,
      },
    };
  }
}
