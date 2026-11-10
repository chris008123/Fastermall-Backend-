import {
  BadRequestException,
  ConflictException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomInt } from 'crypto';
import * as bcrypt from 'bcrypt';
import { OAuth2Client, TokenPayload } from 'google-auth-library';
import { PrismaService } from '../../database/prisma.service';
import { EmailService } from '../../shared/email/email.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';
import { ResendOtpDto } from './dto/resend-otp.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { GoogleLoginDto } from './dto/google-login.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { Prisma, User } from '@prisma/client';
import {
  CODE_LOCK_MS,
  DUMMY_PASSWORD_HASH,
  LOGIN_LOCK_MS,
  MAX_LOGIN_FAILURES,
  MAX_TOTAL_CODE_FAILURES,
  isLocked,
  issuedRecently,
  tooManyAttempts,
} from '../../shared/utils/lockout';

const OTP_EXPIRY_MINUTES = 10;
const RESET_EXPIRY_MINUTES = 15;
// After this many wrong codes the code is thrown away and a new one must be requested.
const MAX_CODE_ATTEMPTS = 5;

// This module is for the CUSTOMER-facing app only. Vendors, delivery
// partners, laundry staff, and admins authenticate through the Staff
// module instead.
@Injectable()
export class IdentityService {
  private googleClient = new OAuth2Client();

  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private email: EmailService,
  ) {}

  async register(dto: RegisterDto) {
    const existing = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });

    // A verified account really belongs to someone. An UNverified one is just a
    // half-finished sign-up, so it must not lock the real owner out of their
    // own email — they simply start again and get a fresh code.
    if (existing?.isVerified) {
      throw new ConflictException('An account with this email already exists');
    }

    if (
      existing &&
      (isLocked(existing.codeLockedUntil) ||
        issuedRecently(existing.otpExpiresAt, OTP_EXPIRY_MINUTES * 60_000))
    ) {
      throw tooManyAttempts('Please wait a minute before requesting another code');
    }

    const passwordHash = await bcrypt.hash(dto.password, 10);
    const { code, codeHash, expiresAt } = await this.generateOtp();

    if (existing) {
      await this.prisma.user.update({
        where: { id: existing.id },
        data: {
          phone: dto.phone,
          fullName: dto.fullName,
          passwordHash,
          otpCodeHash: codeHash,
          otpExpiresAt: expiresAt,
          otpAttempts: 0,
        },
      });
    } else {
      await this.prisma.user.create({
        data: {
          email: dto.email,
          phone: dto.phone,
          fullName: dto.fullName,
          passwordHash,
          isVerified: false,
          otpCodeHash: codeHash,
          otpExpiresAt: expiresAt,
        },
      });
    }

    await this.email.sendOtpEmail(dto.email, code);

    return {
      message: 'Verification code sent to your email',
      email: dto.email,
    };
  }

  async verifyOtp(dto: VerifyOtpDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });

    if (!user) {
      throw new BadRequestException('No pending registration for this email');
    }

    if (user.isVerified) {
      throw new BadRequestException(
        'This account is already verified — try logging in instead',
      );
    }

    if (isLocked(user.codeLockedUntil)) {
      throw tooManyAttempts('Too many incorrect codes. Please try again later.');
    }

    if (
      !user.otpCodeHash ||
      !user.otpExpiresAt ||
      user.otpExpiresAt < new Date()
    ) {
      throw new BadRequestException('Code expired — request a new one');
    }

    const matches = await bcrypt.compare(dto.code, user.otpCodeHash);

    if (!matches) {
      const attempts = user.otpAttempts + 1;
      const burned = attempts >= MAX_CODE_ATTEMPTS;
      const after = await this.prisma.user.update({
        where: { id: user.id },
        data: {
          ...(burned
            ? { otpAttempts: 0, otpCodeHash: null, otpExpiresAt: null }
            : { otpAttempts: attempts }),
          codeFailures: { increment: 1 },
        },
        select: { codeFailures: true },
      });
      if ((after?.codeFailures ?? 0) >= MAX_TOTAL_CODE_FAILURES) {
        await this.lockCodeFlows(user.id);
        throw tooManyAttempts('Too many incorrect codes. Please try again later.');
      }
      throw new BadRequestException(
        burned
          ? 'Too many incorrect attempts — request a new code'
          : 'Incorrect code',
      );
    }

    const verifiedUser = await this.prisma.user.update({
      where: { id: user.id },
      data: {
        isVerified: true,
        otpCodeHash: null,
        otpExpiresAt: null,
        otpAttempts: 0,
        codeFailures: 0,
      },
    });

    return this.buildAuthResponse(verifiedUser);
  }

  async resendOtp(dto: ResendOtpDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });

    if (!user) {
      throw new BadRequestException('No pending registration for this email');
    }

    if (user.isVerified) {
      throw new BadRequestException(
        'This account is already verified — try logging in instead',
      );
    }

    if (
      isLocked(user.codeLockedUntil) ||
      issuedRecently(user.otpExpiresAt, OTP_EXPIRY_MINUTES * 60_000)
    ) {
      throw tooManyAttempts('Please wait a minute before requesting another code');
    }

    const { code, codeHash, expiresAt } = await this.generateOtp();

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        otpCodeHash: codeHash,
        otpExpiresAt: expiresAt,
        otpAttempts: 0,
      },
    });

    await this.email.sendOtpEmail(dto.email, code);

    return {
      message: 'A new code has been sent to your email',
    };
  }

  // Always answers the same way, so it can't be used to find out which emails
  // have accounts. Only verified accounts actually get a code.
  async forgotPassword(dto: ForgotPasswordDto) {
    const generic = {
      message: 'If an account exists for that email, a reset code has been sent.',
    };

    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });
    if (!user || !user.isVerified) return generic;

    // Too soon after the last code, or the account's code flows are locked:
    // answer the same way but send nothing (no inbox spam, no new guesses).
    if (
      isLocked(user.codeLockedUntil) ||
      issuedRecently(user.resetExpiresAt, RESET_EXPIRY_MINUTES * 60_000)
    ) {
      return generic;
    }

    const { code, codeHash } = await this.generateOtp();
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        resetCodeHash: codeHash,
        resetExpiresAt: new Date(Date.now() + RESET_EXPIRY_MINUTES * 60 * 1000),
        resetAttempts: 0,
      },
    });

    await this.email.sendPasswordResetEmail(dto.email, code);
    return generic;
  }

  async resetPassword(dto: ResetPasswordDto) {
    const invalid = new BadRequestException('Invalid or expired code');

    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });
    if (
      !user ||
      isLocked(user.codeLockedUntil) ||
      !user.resetCodeHash ||
      !user.resetExpiresAt ||
      user.resetExpiresAt < new Date()
    ) {
      throw invalid;
    }

    const matches = await bcrypt.compare(dto.code, user.resetCodeHash);
    if (!matches) {
      const attempts = user.resetAttempts + 1;
      const after = await this.prisma.user.update({
        where: { id: user.id },
        data: {
          ...(attempts >= MAX_CODE_ATTEMPTS
            ? { resetAttempts: 0, resetCodeHash: null, resetExpiresAt: null }
            : { resetAttempts: attempts }),
          codeFailures: { increment: 1 },
        },
        select: { codeFailures: true },
      });
      if ((after?.codeFailures ?? 0) >= MAX_TOTAL_CODE_FAILURES) {
        await this.lockCodeFlows(user.id);
      }
      throw invalid;
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: await bcrypt.hash(dto.newPassword, 10),
        resetCodeHash: null,
        resetExpiresAt: null,
        resetAttempts: 0,
        codeFailures: 0,
        loginFailures: 0,
        loginLockedUntil: null,
      },
    });

    return { message: 'Password updated. You can now log in.' };
  }

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });

    if (!user) {
      await bcrypt.compare(dto.password, DUMMY_PASSWORD_HASH);
      throw new UnauthorizedException('Invalid email or password');
    }

    // Google-only accounts have no password, so they can't log in this way.
    if (!user.passwordHash) {
      throw new UnauthorizedException('Invalid email or password');
    }

    if (isLocked(user.loginLockedUntil)) {
      throw tooManyAttempts(
        'Too many failed login attempts. Try again in 15 minutes, or reset your password.',
      );
    }

    const passwordMatches = await bcrypt.compare(
      dto.password,
      user.passwordHash,
    );

    if (!passwordMatches) {
      const after = await this.prisma.user.update({
        where: { id: user.id },
        data: { loginFailures: { increment: 1 } },
        select: { loginFailures: true },
      });
      if ((after?.loginFailures ?? 0) >= MAX_LOGIN_FAILURES) {
        await this.prisma.user.update({
          where: { id: user.id },
          data: {
            loginFailures: 0,
            loginLockedUntil: new Date(Date.now() + LOGIN_LOCK_MS),
          },
        });
      }
      throw new UnauthorizedException('Invalid email or password');
    }

    if (user.loginFailures > 0) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { loginFailures: 0, loginLockedUntil: null },
      });
    }

    if (!user.isVerified) {
      throw new UnauthorizedException(
        'Please verify your email before logging in',
      );
    }

    return this.buildAuthResponse(user);
  }

  async loginWithGoogle(dto: GoogleLoginDto) {
    const audience = [
      process.env.GOOGLE_WEB_CLIENT_ID,
      process.env.GOOGLE_IOS_CLIENT_ID,
    ].filter((id): id is string => !!id);

    if (audience.length === 0) {
      throw new ServiceUnavailableException('Google sign-in is not configured');
    }

    let payload: TokenPayload | undefined;
    try {
      const ticket = await this.googleClient.verifyIdToken({
        idToken: dto.idToken,
        audience,
      });
      payload = ticket.getPayload();
    } catch {
      throw new UnauthorizedException('Invalid Google token');
    }

    if (!payload?.sub || !payload.email || !payload.email_verified) {
      throw new UnauthorizedException('Google account email is not verified');
    }

    const email = payload.email.toLowerCase();

    let user = await this.prisma.user.findUnique({
      where: { googleId: payload.sub },
    });

    if (!user) {
      // register() stores emails as typed, so match without caring about case
      // to avoid creating a duplicate account for "Ama@x.com" vs "ama@x.com".
      user = await this.prisma.user.findFirst({
        where: { email: { equals: email, mode: 'insensitive' } },
      });
    }

    if (!user) {
      user = await this.prisma.user.create({
        data: {
          email,
          googleId: payload.sub,
          fullName: payload.name ?? email.split('@')[0],
          isVerified: true,
        },
      });
    } else if (!user.googleId) {
      user = await this.prisma.user.update({
        where: { id: user.id },
        data: {
          googleId: payload.sub,
          isVerified: true,
          // An unverified account may have been pre-registered by someone else
          // with their own password (or a pending code). Google has now proved
          // who owns the email, so wipe all of that.
          ...(user.isVerified
            ? {}
            : {
                passwordHash: null,
                otpCodeHash: null,
                otpExpiresAt: null,
                otpAttempts: 0,
              }),
        },
      });
    } else if (user.googleId !== payload.sub) {
      // Same email, but already linked to a different Google account.
      throw new UnauthorizedException('Invalid Google token');
    }

    return this.buildAuthResponse(user);
  }

  async getProfile(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    // A deleted account answers 401 so an old token ends the app's session.
    if (!user || user.deletedAt) {
      throw new UnauthorizedException();
    }

    return this.toSafeUser(user);
  }

  // PATCH /auth/me — name and phone. Returns the same shape as GET /auth/me.
  async updateProfile(userId: string, dto: UpdateProfileDto) {
    await this.getProfile(userId); // 401 for a missing or deleted account

    try {
      const user = await this.prisma.user.update({
        where: { id: userId },
        data: {
          ...(dto.fullName !== undefined ? { fullName: dto.fullName.trim() } : {}),
          ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
        },
      });
      return this.toSafeUser(user);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('That number is already in use');
      }
      throw error;
    }
  }

  /**
   * DELETE /auth/me — deletes the customer's account.
   *
   * The User row is kept because orders and payments reference it and must
   * stay for accounting, but every personal field is cleared, so the email
   * and phone can be used for a new account. Devices are removed so pushes
   * stop, and in-app notifications and saved addresses are deleted. Product
   * reviews stay, shown as "Deleted user". Calling it again is a no-op.
   */
  async deleteAccount(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, deletedAt: true },
    });

    if (!user) {
      throw new UnauthorizedException();
    }

    if (user.deletedAt) {
      return { ok: true };
    }

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: {
          fullName: 'Deleted user',
          email: null,
          phone: null,
          googleId: null,
          passwordHash: null,
          isVerified: false,
          otpCodeHash: null,
          otpExpiresAt: null,
          otpAttempts: 0,
          resetCodeHash: null,
          resetExpiresAt: null,
          resetAttempts: 0,
          loginFailures: 0,
          loginLockedUntil: null,
          codeFailures: 0,
          codeLockedUntil: null,
          deletedAt: new Date(),
        },
      }),
      this.prisma.device.deleteMany({ where: { userId } }),
      this.prisma.notification.deleteMany({ where: { userId } }),
      this.prisma.address.deleteMany({ where: { userId } }),
    ]);

    return { ok: true };
  }

  private toSafeUser(user: User) {
    const {
      passwordHash,
      otpCodeHash,
      resetCodeHash,
      deletedAt,
      loginFailures,
      loginLockedUntil,
      codeFailures,
      codeLockedUntil,
      ...safeUser
    } = user;
    return safeUser;
  }

  // Shuts verify-otp / forgot-password / reset-password for this account for a
  // while and throws away any live codes.
  private async lockCodeFlows(userId: string) {
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        codeFailures: 0,
        codeLockedUntil: new Date(Date.now() + CODE_LOCK_MS),
        otpCodeHash: null,
        otpExpiresAt: null,
        otpAttempts: 0,
        resetCodeHash: null,
        resetExpiresAt: null,
        resetAttempts: 0,
      },
    });
  }

  private async generateOtp() {
    const code = randomInt(100000, 1000000).toString();
    const codeHash = await bcrypt.hash(code, 10);
    const expiresAt = new Date(
      Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000,
    );

    return {
      code,
      codeHash,
      expiresAt,
    };
  }

  private buildAuthResponse(user: {
    id: string;
    email: string | null;
    fullName: string;
  }) {
    // Customers are always CUSTOMER.
    // Staff authentication is handled separately by the Staff module.
    const accessToken = this.jwt.sign({
      sub: user.id,
      email: user.email,
      role: 'CUSTOMER',
    });

    return {
      accessToken,
      user: {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        role: 'CUSTOMER',
      },
    };
  }
}
