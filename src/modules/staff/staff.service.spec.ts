import * as bcrypt from 'bcrypt';
import { StaffService } from './staff.service';

function setup() {
  const prisma: any = { staffUser: { findUnique: jest.fn(), update: jest.fn() } };
  const jwt = { sign: jest.fn().mockReturnValue('token') };
  const config = { get: jest.fn() };
  return { svc: new StaffService(prisma, jwt as any, config as any), prisma };
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
