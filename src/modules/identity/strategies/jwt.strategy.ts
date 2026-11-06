import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { StaffRole } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';

export interface JwtPayload {
  sub: string;
  email: string;
  role?: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('jwt.secret'),
    });
  }

  async validate(payload: JwtPayload) {
    // Staff tokens carry a StaffRole; customer tokens carry role 'CUSTOMER'
    // (see IdentityService.buildAuthResponse). A staff token stops working as
    // soon as the account is deactivated or deleted, without waiting for it
    // to expire. Customers must not go through this check: they have no
    // staff_users row, so it would reject every customer request.
    if (payload.role && Object.values(StaffRole).includes(payload.role as StaffRole)) {
      const staff = await this.prisma.staffUser.findUnique({
        where: { id: payload.sub },
        select: { isActive: true },
      });
      if (!staff?.isActive) throw new UnauthorizedException('This staff account is not active');
    }
    // Whatever is returned here becomes request.user
    return { userId: payload.sub, email: payload.email, role: payload.role };
  }
}
