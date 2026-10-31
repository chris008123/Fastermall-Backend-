import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../database/prisma.service';

export interface JwtPayload {
  sub: string;
  email: string;
  role?: string;
  // Staff only: the id of the StaffSession this token belongs to.
  sid?: string;
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
    // Customer tokens carry no role and are handled as before.
    if (!payload.role) {
      return { userId: payload.sub, email: payload.email, role: payload.role };
    }

    // Staff tokens are only good while their session is alive and the account
    // is active. Any failure is a 401, which the app treats as "signed out".
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
      session.expiresAt <= new Date() ||
      !session.staffUser.isActive
    ) {
      throw new UnauthorizedException('Session ended');
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
