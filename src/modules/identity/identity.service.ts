import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomInt } from 'crypto';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../database/prisma.service';
import { EmailService } from '../../shared/email/email.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';
import { ResendOtpDto } from './dto/resend-otp.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
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

  async getProfile(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new UnauthorizedException();
    }

    const {
      passwordHash,
      otpCodeHash,
      resetCodeHash,
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
