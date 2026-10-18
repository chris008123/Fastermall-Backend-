import * as bcrypt from 'bcrypt';
import { StaffService } from './staff.service';

function setup() {
  const prisma: any = { staffUser: { findUnique: jest.fn(), update: jest.fn(), findFirst: jest.fn(), create: jest.fn() } };
  const jwt = { sign: jest.fn().mockReturnValue('token') };
  const config = { get: jest.fn((k: string) => (k === 'adminBootstrapSecret' ? 'a-long-random-bootstrap-secret-123' : undefined)) };
  return { svc: new StaffService(prisma, jwt as any, config as any), prisma, jwt };
}

describe('StaffService.login lockout', () => {
  it('locks after 5 wrong passwords', async () => {
    const { svc, prisma } = setup();
    const passwordHash = await bcrypt.hash('rightpass1', 4);
    prisma.staffUser.findUnique.mockResolvedValue({ id: 's1', passwordHash, loginFailures: 4, loginLockedUntil: null });
    prisma.staffUser.update.mockResolvedValue({ loginFailures: 5 });

    await expect(svc.login({ email: 'a@b.c', password: 'nope' })).rejects.toThrow('Invalid email or password');
    const lock = prisma.staffUser.update.mock.calls[1][0].data;
    expect(lock.loginLockedUntil).toBeInstanceOf(Date);
  });

  it('refuses a locked account even with the right password', async () => {
    const { svc, prisma } = setup();
    const passwordHash = await bcrypt.hash('rightpass1', 4);
    prisma.staffUser.findUnique.mockResolvedValue({ id: 's1', passwordHash, loginFailures: 0, loginLockedUntil: new Date(Date.now() + 60_000) });
    await expect(svc.login({ email: 'a@b.c', password: 'rightpass1' })).rejects.toMatchObject({ status: 429 });
  });

  it('says the same thing for an unknown email', async () => {
    const { svc, prisma } = setup();
    prisma.staffUser.findUnique.mockResolvedValue(null);
    await expect(svc.login({ email: 'x@b.c', password: 'whatever1' })).rejects.toThrow('Invalid email or password');
  });
});

describe('StaffService.bootstrapAdmin secret', () => {
  it('rejects a wrong secret, including one of a different length', async () => {
    const { svc } = setup();
    await expect(svc.bootstrapAdmin({ secret: 'nope', email: 'a@b.c', password: 'password123', fullName: 'A' } as any)).rejects.toThrow('Invalid bootstrap secret');
    await expect(svc.bootstrapAdmin({ secret: 'a-long-random-bootstrap-secret-124', email: 'a@b.c', password: 'password123', fullName: 'A' } as any)).rejects.toThrow('Invalid bootstrap secret');
  });

  it('accepts the right secret and then checks for an existing admin', async () => {
    const { svc, prisma } = setup();
    prisma.staffUser.findFirst.mockResolvedValue({ id: 'admin' });
    await expect(svc.bootstrapAdmin({ secret: 'a-long-random-bootstrap-secret-123', email: 'a@b.c', password: 'password123', fullName: 'A' } as any)).rejects.toThrow(/admin already exists/);
  });
});

describe('StaffService token lifetime', () => {
  it('signs staff tokens with the staff expiry (12h by default)', async () => {
    const { svc, prisma, jwt } = setup();
    const passwordHash = await bcrypt.hash('rightpass1', 4);
    prisma.staffUser.findUnique.mockResolvedValue({ id: 's1', email: 'a@b.c', fullName: 'A', role: 'ADMIN', passwordHash, loginFailures: 0, loginLockedUntil: null });
    await svc.login({ email: 'a@b.c', password: 'rightpass1' });
    expect(jwt.sign).toHaveBeenCalledWith(expect.objectContaining({ role: 'ADMIN' }), { expiresIn: '12h' });
  });
});
