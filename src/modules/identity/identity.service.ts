import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../database/prisma.service';
import { EmailService } from '../../shared/email/email.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';
import { ResendOtpDto } from './dto/resend-otp.dto';

const OTP_EXPIRY_MINUTES = 10;

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

    if (existing) {
      throw new ConflictException('An account with this email already exists');
    }

    const passwordHash = await bcrypt.hash(dto.password, 10);
    const { code, codeHash, expiresAt } = await this.generateOtp();

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

    if (
      !user.otpCodeHash ||
      !user.otpExpiresAt ||
      user.otpExpiresAt < new Date()
    ) {
      throw new BadRequestException('Code expired — request a new one');
    }

    const matches = await bcrypt.compare(dto.code, user.otpCodeHash);

    if (!matches) {
      throw new BadRequestException('Incorrect code');
    }

    const verifiedUser = await this.prisma.user.update({
      where: { id: user.id },
      data: {
        isVerified: true,
        otpCodeHash: null,
        otpExpiresAt: null,
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

    const { code, codeHash, expiresAt } = await this.generateOtp();

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        otpCodeHash: codeHash,
        otpExpiresAt: expiresAt,
      },
    });

    await this.email.sendOtpEmail(dto.email, code);

    return {
      message: 'A new code has been sent to your email',
    };
  }

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });

    if (!user) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const passwordMatches = await bcrypt.compare(
      dto.password,
      user.passwordHash,
    );

    if (!passwordMatches) {
      throw new UnauthorizedException('Invalid email or password');
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

    const { passwordHash, otpCodeHash, ...safeUser } = user;

    return safeUser;
  }

  private async generateOtp() {
    const code = Math.floor(100000 + Math.random() * 900000).toString();
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
