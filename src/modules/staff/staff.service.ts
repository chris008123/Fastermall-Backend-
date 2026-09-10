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
    return this.prisma.staffUser.findMany({
      select: { id: true, email: true, fullName: true, role: true, isVerified: true, createdAt: true },
    });
  }

  async getProfile(staffUserId: string) {
    const staffUser = await this.prisma.staffUser.findUnique({ where: { id: staffUserId } });
    if (!staffUser) throw new UnauthorizedException();
    const { passwordHash, ...safe } = staffUser;
    return safe;
  }

  private buildAuthResponse(staffUser: { id: string; email: string | null; fullName: string; role: string }) {
    const accessToken = this.jwt.sign({ sub: staffUser.id, email: staffUser.email, role: staffUser.role });
    return {
      accessToken,
      user: { id: staffUser.id, email: staffUser.email, fullName: staffUser.fullName, role: staffUser.role },
    };
  }
}
