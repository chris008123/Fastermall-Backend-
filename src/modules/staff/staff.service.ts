import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { createHash, randomBytes, randomInt } from 'crypto';
import { PrismaService } from '../../database/prisma.service';
import { LoginStaffDto } from './dto/login-staff.dto';
import { CreateStaffDto } from './dto/create-staff.dto';
import { BootstrapAdminDto } from './dto/bootstrap-admin.dto';
import { ForgotStaffPasswordDto } from './dto/forgot-staff-password.dto';
import { ResetStaffPasswordDto } from './dto/reset-staff-password.dto';
import { ChangeStaffPasswordDto } from './dto/change-staff-password.dto';
import { EmailService } from '../../shared/email/email.service';

// Wrong passwords allowed before the account locks, and for how long.
const MAX_LOGIN_ATTEMPTS = 5;
const LOCK_MINUTES = 15;
// Password reset codes: lifetime, wrong guesses allowed, and the gap between
// two emails for the same account.
const RESET_EXPIRY_MINUTES = 15;
const MAX_RESET_ATTEMPTS = 5;
const RESET_RESEND_SECONDS = 60;

// Compared against when the email is unknown, so "no such account" takes as
// long as "wrong password" and the two cannot be told apart by timing.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

@Injectable()
export class StaffService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private config: ConfigService,
    private email: EmailService,
  ) {}

  async login(dto: LoginStaffDto) {
    const staffUser = await this.prisma.staffUser.findUnique({ where: { email: dto.email } });
    if (!staffUser) {
      await bcrypt.compare(dto.password, DUMMY_HASH);
      throw new UnauthorizedException('Invalid email or password');
    }

    if (!(await this.verifyPassword(staffUser, dto.password))) {
      throw new UnauthorizedException('Invalid email or password');
    }

    if (!staffUser.isActive) {
      throw new ForbiddenException({
        message: 'This account has been disabled. Contact support.',
        code: 'ACCOUNT_DISABLED',
      });
    }

    return this.buildAuthResponse(staffUser);
  }

  /**
   * Checks a password with lockout. After 5 wrong tries in a row the account
   * is locked for 15 minutes (429 + Retry-After), even for the right password.
   * Returns false for a wrong password; throws while locked.
   */
  private async verifyPassword(
    user: {
      id: string;
      passwordHash: string;
      failedLoginAttempts: number;
      lockedUntil: Date | null;
    },
    password: string,
  ): Promise<boolean> {
    const now = new Date();

    if (user.lockedUntil && user.lockedUntil > now) {
      this.throwLocked(user.lockedUntil);
    }

    // A lock that has run out starts a fresh set of tries.
    if (user.lockedUntil) {
      await this.prisma.staffUser.update({
        where: { id: user.id },
        data: { failedLoginAttempts: 0, lockedUntil: null },
      });
    }

    if (await bcrypt.compare(password, user.passwordHash)) {
      if (user.failedLoginAttempts > 0 && !user.lockedUntil) {
        await this.prisma.staffUser.update({
          where: { id: user.id },
          data: { failedLoginAttempts: 0 },
        });
      }
      return true;
    }

    // Counted in one atomic step so parallel guesses cannot dodge the limit.
    const bumped = await this.prisma.staffUser.update({
      where: { id: user.id },
      data: { failedLoginAttempts: { increment: 1 } },
      select: { failedLoginAttempts: true },
    });

    if (bumped.failedLoginAttempts >= MAX_LOGIN_ATTEMPTS) {
      const until = new Date(Date.now() + LOCK_MINUTES * 60 * 1000);
      await this.prisma.staffUser.update({
        where: { id: user.id },
        data: { lockedUntil: until },
      });
      this.throwLocked(until);
    }

    return false;
  }

  private throwLocked(until: Date): never {
    const retryAfterSeconds = Math.max(1, Math.ceil((until.getTime() - Date.now()) / 1000));
    throw new HttpException(
      {
        message: 'Too many failed attempts. Try again later.',
        code: 'ACCOUNT_LOCKED',
        retryAfterSeconds,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  /**
   * Emails a 6-digit reset code. Always answers the same way, so it cannot be
   * used to find out which emails have accounts.
   */
  async forgotPassword(dto: ForgotStaffPasswordDto) {
    const generic = {
      message: 'If an account exists for that email, a reset code has been sent.',
    };

    const user = await this.prisma.staffUser.findUnique({ where: { email: dto.email } });
    if (!user || !user.isActive) return generic;

    // One email a minute per account, so it cannot be used to flood an inbox.
    if (user.resetExpiresAt) {
      const sentAt = user.resetExpiresAt.getTime() - RESET_EXPIRY_MINUTES * 60 * 1000;
      if (Date.now() - sentAt < RESET_RESEND_SECONDS * 1000) return generic;
    }

    const code = randomInt(100000, 1000000).toString();
    await this.prisma.staffUser.update({
      where: { id: user.id },
      data: {
        resetCodeHash: await bcrypt.hash(code, 10),
        resetExpiresAt: new Date(Date.now() + RESET_EXPIRY_MINUTES * 60 * 1000),
        resetAttempts: 0,
      },
    });

    try {
      await this.email.sendPasswordResetEmail(dto.email, code);
    } catch {
      // Already logged by the email service. The answer stays the same.
    }
    return generic;
  }

  async resetPassword(dto: ResetStaffPasswordDto) {
    const invalid = () =>
      new BadRequestException({ message: 'Invalid or expired code', code: 'INVALID_RESET_CODE' });

    const user = await this.prisma.staffUser.findUnique({ where: { email: dto.email } });
    if (
      !user ||
      !user.isActive ||
      !user.resetCodeHash ||
      !user.resetExpiresAt ||
      user.resetExpiresAt < new Date()
    ) {
      throw invalid();
    }

    // Count the try first, atomically, then compare.
    const { resetAttempts } = await this.prisma.staffUser.update({
      where: { id: user.id },
      data: { resetAttempts: { increment: 1 } },
      select: { resetAttempts: true },
    });

    const burnCode = () =>
      this.prisma.staffUser.update({
        where: { id: user.id },
        data: { resetCodeHash: null, resetExpiresAt: null, resetAttempts: 0 },
      });

    if (resetAttempts > MAX_RESET_ATTEMPTS) {
      await burnCode();
      throw invalid();
    }

    if (!(await bcrypt.compare(dto.code, user.resetCodeHash))) {
      if (resetAttempts >= MAX_RESET_ATTEMPTS) await burnCode();
      throw invalid();
    }

    const passwordHash = await bcrypt.hash(dto.newPassword, 10);
    await this.prisma.$transaction([
      this.prisma.staffUser.update({
        where: { id: user.id },
        data: {
          passwordHash,
          resetCodeHash: null,
          resetExpiresAt: null,
          resetAttempts: 0,
          failedLoginAttempts: 0,
          lockedUntil: null,
        },
      }),
      // Anyone signed in with the old password is signed out.
      this.prisma.staffSession.updateMany({
        where: { staffUserId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);

    return { message: 'Password updated. You can now sign in.' };
  }

  /**
   * Signed-in password change. A wrong current password is a 400, never a
   * 401, because the app signs the partner out on 401.
   */
  async changePassword(userId: string, sessionId: string | undefined, dto: ChangeStaffPasswordDto) {
    const user = await this.prisma.staffUser.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException();

    if (!(await this.verifyPassword(user, dto.currentPassword))) {
      throw new BadRequestException({
        message: 'Your current password is not correct',
        code: 'INVALID_CURRENT_PASSWORD',
      });
    }

    if (dto.currentPassword === dto.newPassword) {
      throw new BadRequestException({
        message: 'Choose a password different from your current one',
        code: 'SAME_PASSWORD',
      });
    }

    const passwordHash = await bcrypt.hash(dto.newPassword, 10);
    await this.prisma.$transaction([
      this.prisma.staffUser.update({ where: { id: userId }, data: { passwordHash } }),
      // Every other device is signed out; this one stays signed in.
      this.prisma.staffSession.updateMany({
        where: {
          staffUserId: userId,
          revokedAt: null,
          ...(sessionId ? { id: { not: sessionId } } : {}),
        },
        data: { revokedAt: new Date() },
      }),
    ]);

    return { message: 'Password changed' };
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

    return this.withoutSecrets(staffUser);
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

    return this.withoutSecrets(staffUser);
  }

  // Never send password, reset or lockout fields to a client.
  private withoutSecrets<T extends Record<string, any>>(user: T) {
    const {
      passwordHash,
      resetCodeHash,
      resetExpiresAt,
      resetAttempts,
      failedLoginAttempts,
      lockedUntil,
      ...safe
    } = user;
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
