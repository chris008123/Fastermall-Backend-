import { of, throwError, lastValueFrom } from 'rxjs';
import { AuditInterceptor, describe as describeRoute, redact } from './audit.interceptor';

const flush = () => new Promise((r) => setImmediate(r));

function ctx(req: any) {
  return { getType: () => 'http', switchToHttp: () => ({ getRequest: () => req }) } as any;
}

function setup() {
  const prisma: any = {
    staffUser: { findUnique: jest.fn().mockResolvedValue({ fullName: 'Admin Ama' }) },
    adminAuditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  return { icpt: new AuditInterceptor(prisma), prisma };
}

describe('redact', () => {
  it('removes secrets at any depth and trims long text', () => {
    const out: any = redact({ password: 'x', nested: { newPassword: 'y', deliveryCode: '1234', name: 'ok' }, long: 'a'.repeat(600) });
    expect(out.password).toBe('[redacted]');
    expect(out.nested).toEqual({ newPassword: '[redacted]', deliveryCode: '[redacted]', name: 'ok' });
    expect(out.long.length).toBe(501);
  });
});

describe('describe', () => {
  it('names actions from the route pattern', () => {
    expect(describeRoute('PATCH', '/api/v1/staff/users/:id/password')).toEqual({ action: 'staff.users.password.patch', targetType: 'staff' });
    expect(describeRoute('POST', '/payments/:id/refund')).toEqual({ action: 'payments.refund.post', targetType: 'payments' });
  });
});

describe('AuditInterceptor', () => {
  const adminReq = {
    method: 'PATCH',
    route: { path: '/api/v1/staff/users/:id/password' },
    params: { id: 's9' },
    body: { password: 'new-secret-1' },
    user: { userId: 'a1', role: 'ADMIN' },
  };

  it('records a successful admin write, without the password', async () => {
    const { icpt, prisma } = setup();
    await lastValueFrom(icpt.intercept(ctx(adminReq), { handle: () => of({ ok: true }) }));
    await flush();
    const data = prisma.adminAuditLog.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ staffId: 'a1', staffName: 'Admin Ama', action: 'staff.users.password.patch', targetId: 's9' });
    expect(JSON.stringify(data.details)).not.toContain('new-secret-1');
  });

  it('skips reads, non-admins and failed requests', async () => {
    const { icpt, prisma } = setup();
    await lastValueFrom(icpt.intercept(ctx({ ...adminReq, method: 'GET' }), { handle: () => of(1) }));
    await lastValueFrom(icpt.intercept(ctx({ ...adminReq, user: { userId: 'c1' } }), { handle: () => of(1) }));
    await expect(
      lastValueFrom(icpt.intercept(ctx(adminReq), { handle: () => throwError(() => new Error('400')) })),
    ).rejects.toThrow('400');
    await flush();
    expect(prisma.adminAuditLog.create).not.toHaveBeenCalled();
  });

  it('a failed log write never fails the request', async () => {
    const { icpt, prisma } = setup();
    prisma.adminAuditLog.create.mockRejectedValue(new Error('table missing'));
    await expect(lastValueFrom(icpt.intercept(ctx(adminReq), { handle: () => of('done') }))).resolves.toBe('done');
    await flush();
  });
});
