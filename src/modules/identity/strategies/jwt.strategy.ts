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
  // Staff only: the id of the StaffSession this token belongs to.
  sid?: string;
}

const isStaffRole = (role?: string) =>
  !!role && Object.values(StaffRole).includes(role as StaffRole);

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
    // Customer tokens carry role 'CUSTOMER' (see IdentityService) and have no
    // staff session, so they skip the staff checks below. Only real staff
    // roles are checked; otherwise every customer request would be refused.
    if (!isStaffRole(payload.role)) {
      return { userId: payload.sub, email: payload.email, role: payload.role };
    }

    // Staff tokens are only good while their session is alive and the account
    // is active, so logging out, a password reset or deactivation ends them at
    // once. Any failure is a 401, which the apps treat as "signed out".
    // Tokens issued before sessions existed have no sid and must sign in again.
    if (!payload.sid) throw new UnauthorizedException('Session ended');

    const session = await this.prisma.staffSession.findUnique({
      where: { id: payload.sid },
      select: {
        staffUserId: true,
        revokedAt: true,
        expiresAt: true,
        staffUser: { select: { isActive: true, role: true, email: true } },
      },
    });

    if (
      !session ||
      session.staffUserId !== payload.sub ||
      session.revokedAt ||
      session.expiresAt <= new Date()
    ) {
      throw new UnauthorizedException('Session ended');
    }
    if (!session.staffUser.isActive) {
      throw new UnauthorizedException('This staff account is not active');
    }

    // Role comes from the database, so a role change takes effect at once.
    return {
      userId: payload.sub,
      email: session.staffUser.email,
      role: session.staffUser.role,
      sessionId: payload.sid,
    };
  }
}
