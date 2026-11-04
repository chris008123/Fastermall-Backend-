import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Observable, tap } from 'rxjs';
import { PrismaService } from '../../database/prisma.service';

// Never stored, at any depth.
const SECRET_KEYS = /pass(word)?|secret|token|code|otp|hash/i;
const MAX_STRING = 500;

/** Copy of a request body with secrets removed and long strings cut. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[…]';
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEYS.test(k) ? '[redacted]' : redact(v, depth + 1);
    return out;
  }
  if (typeof value === 'string' && value.length > MAX_STRING) return `${value.slice(0, MAX_STRING)}…`;
  return value;
}

/** "PATCH /staff/users/:id/password" -> { targetType: 'staff-user', action: 'staff.users.password.patch' } */
export function describe(method: string, routePath: string) {
  const parts = routePath
    .replace(/^\/?api\/v\d+/, '')
    .split('/')
    .filter((p) => p && !p.startsWith(':'));
  const action = [...parts, method.toLowerCase()].join('.');
  return { action, targetType: parts[0] ?? null };
}

/**
 * Records every successful write (POST/PUT/PATCH/DELETE) made with an ADMIN
 * token: who, what route, which id, and the redacted body. Logging is
 * best-effort: a failure to write the log never fails the request.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger('Audit');

  constructor(private readonly prisma: PrismaService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest();
    const method: string = req.method;
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return next.handle();

    return next.handle().pipe(
      tap(() => {
        // req.user is set by JwtAuthGuard, which runs before interceptors.
        const user = req.user as { userId?: string; role?: string } | undefined;
        if (user?.role !== 'ADMIN' || !user.userId) return;
        void this.record(user.userId, method, req.route?.path ?? req.path, req.params ?? {}, req.body);
      }),
    );
  }

  private async record(staffId: string, method: string, routePath: string, params: Record<string, string>, body: unknown) {
    try {
      const { action, targetType } = describe(method, routePath);
      const staff = await this.prisma.staffUser.findUnique({ where: { id: staffId }, select: { fullName: true } });
      await this.prisma.adminAuditLog.create({
        data: {
          staffId,
          staffName: staff?.fullName ?? null,
          action,
          targetType,
          targetId: params.id ?? params.staffId ?? null,
          details: redact({ method, route: routePath, params, body }) as Prisma.InputJsonValue,
        },
      });
    } catch (e) {
      this.logger.error(`Audit write failed: ${(e as Error).message}`);
    }
  }
}
