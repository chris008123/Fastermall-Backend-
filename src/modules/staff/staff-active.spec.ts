import { BadRequestException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { StaffRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { StaffService } from './staff.service';
import { StaffController } from './staff.controller';
import { JwtStrategy } from '../identity/strategies/jwt.strategy';
import { ROLES_KEY } from '../../shared/decorators/roles.decorator';
import { RolesGuard } from '../../shared/guards/roles.guard';

function setup() {
  const prisma: any = {
    staffUser: { findUnique: jest.fn(), update: jest.fn().mockResolvedValue({ id: 's2' }), count: jest.fn() },
  };
  const jwt: any = { sign: jest.fn().mockReturnValue('token') };
  return { svc: new StaffService(prisma, jwt, {} as any), prisma };
}

describe('StaffService.setActive', () => {
  it('deactivates another account and stamps the time; reactivating clears it', async () => {
    const { svc, prisma } = setup();
    prisma.staffUser.findUnique.mockResolvedValue({ id: 's2', role: 'VENDOR', isActive: true });
    await svc.setActive('s2', false, 'a1');
    expect(prisma.staffUser.update.mock.calls[0][0].data).toEqual({ isActive: false, deactivatedAt: expect.any(Date) });
    expect(prisma.staffUser.update.mock.calls[0][0].select.passwordHash).toBeUndefined();

    await svc.setActive('s2', true, 'a1');
    expect(prisma.staffUser.update.mock.calls[1][0].data).toEqual({ isActive: true, deactivatedAt: null });
  });

  it("won't let an admin deactivate themselves or the last active admin", async () => {
    const { svc, prisma } = setup();
    await expect(svc.setActive('a1', false, 'a1')).rejects.toBeInstanceOf(BadRequestException);

    prisma.staffUser.findUnique.mockResolvedValue({ id: 'a2', role: 'ADMIN', isActive: true });
    prisma.staffUser.count.mockResolvedValue(1);
    await expect(svc.setActive('a2', false, 'a1')).rejects.toBeInstanceOf(BadRequestException);

    prisma.staffUser.count.mockResolvedValue(2);
    await svc.setActive('a2', false, 'a1');
    expect(prisma.staffUser.update).toHaveBeenCalledTimes(1);
  });

  it('404s on a missing account', async () => {
    const { svc, prisma } = setup();
    prisma.staffUser.findUnique.mockResolvedValue(null);
    await expect(svc.setActive('x', false, 'a1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('is ADMIN only', () => {
    const handler = StaffController.prototype.setActive;
    expect(new Reflector().get(ROLES_KEY, handler)).toEqual([StaffRole.ADMIN]);
    expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toContain(RolesGuard);
  });
});

describe('deactivated staff are locked out', () => {
  it('login refuses a deactivated account even with the right password', async () => {
    const { svc, prisma } = setup();
    const passwordHash = await bcrypt.hash('right-password', 4);
    prisma.staffUser.findUnique.mockResolvedValue({ id: 's1', email: 'a@x.com', fullName: 'A', role: 'ADMIN', passwordHash, isActive: false });
    await expect(svc.login({ email: 'a@x.com', password: 'right-password' } as any)).rejects.toBeInstanceOf(UnauthorizedException);

    prisma.staffUser.findUnique.mockResolvedValue({ id: 's1', email: 'a@x.com', fullName: 'A', role: 'ADMIN', passwordHash, isActive: true });
    await expect(svc.login({ email: 'a@x.com', password: 'right-password' } as any)).resolves.toMatchObject({ accessToken: 'token' });
  });

  it('GET /staff/me refuses a deactivated account', async () => {
    const { svc, prisma } = setup();
    prisma.staffUser.findUnique.mockResolvedValue({ id: 's1', isActive: false, passwordHash: 'x' });
    await expect(svc.getProfile('s1')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('JWT check: staff tokens need an active account; customer tokens skip the lookup', async () => {
    const prisma: any = { staffUser: { findUnique: jest.fn() } };
    const strategy = new JwtStrategy({ get: () => 'secret' } as any, prisma);

    prisma.staffUser.findUnique.mockResolvedValueOnce({ isActive: false });
    await expect(strategy.validate({ sub: 's1', email: 'a', role: 'ADMIN' })).rejects.toBeInstanceOf(UnauthorizedException);

    prisma.staffUser.findUnique.mockResolvedValueOnce(null);
    await expect(strategy.validate({ sub: 'gone', email: 'a', role: 'ADMIN' })).rejects.toBeInstanceOf(UnauthorizedException);

    prisma.staffUser.findUnique.mockResolvedValueOnce({ isActive: true });
    await expect(strategy.validate({ sub: 's1', email: 'a', role: 'ADMIN' })).resolves.toEqual({ userId: 's1', email: 'a', role: 'ADMIN' });

    prisma.staffUser.findUnique.mockClear();
    await expect(strategy.validate({ sub: 'c1', email: 'c' })).resolves.toEqual({ userId: 'c1', email: 'c', role: undefined });
    expect(prisma.staffUser.findUnique).not.toHaveBeenCalled();
  });
});
