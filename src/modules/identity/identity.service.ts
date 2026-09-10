import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../database/prisma.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';

// This module is for the CUSTOMER-facing app only. Vendors, delivery
// partners, laundry staff, and admins authenticate through the Staff
// module instead — see src/modules/staff.
@Injectable()
export class IdentityService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
  ) {}

  async register(dto: RegisterDto) {
    const existing = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (existing) {
      throw new ConflictException('An account with this email already exists');
    }

    const passwordHash = await bcrypt.hash(dto.password, 10);

    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        phone: dto.phone,
        fullName: dto.fullName,
        passwordHash,
      },
    });

    return this.buildAuthResponse(user);
  }

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (!user) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const passwordMatches = await bcrypt.compare(dto.password, user.passwordHash);
    if (!passwordMatches) {
      throw new UnauthorizedException('Invalid email or password');
    }

    return this.buildAuthResponse(user);
  }

  async getProfile(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException();
    const { passwordHash, ...safeUser } = user;
    return safeUser;
  }

  private buildAuthResponse(user: { id: string; email: string | null; fullName: string }) {
    // role is hardcoded, not stored — customers are always CUSTOMER.
    // This keeps RolesGuard working unchanged: any @Roles(StaffRole.X) check
    // simply never matches 'CUSTOMER', so customers can't reach staff routes.
    const accessToken = this.jwt.sign({ sub: user.id, email: user.email, role: 'CUSTOMER' });
    return {
      accessToken,
      user: { id: user.id, email: user.email, fullName: user.fullName, role: 'CUSTOMER' },
    };
  }
}
