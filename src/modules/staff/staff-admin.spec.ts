import { BadRequestException, ConflictException, ForbiddenException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Prisma, StaffRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { StaffService } from './staff.service';
import { StaffController } from './staff.controller';
import { ROLES_KEY } from '../../shared/decorators/roles.decorator';
import { RolesGuard } from '../../shared/guards/roles.guard';

// Admin console tools for staff accounts: edit, set a password, deactivate.

function setup() {
  const prisma: any = {
    staffUser: {
      findUnique: jest.fn(),
      update: jest.fn().mockResolvedValue({ id: 's2' }),
      findMany: jest.fn(),
      count: jest.fn(),
    },
    staffSession: { create: jest.fn().mockResolvedValue({ id: 'sess' }), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    device: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    deliveryPartnerProfile: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    $transaction: jest.fn().mockImplementation((ops: any[]) => Promise.all(ops)),
  };
  const jwt: any = { sign: jest.fn().mockReturnValue('token'), decode: jest.fn().mockReturnValue(null) };
  const config: any = { get: jest.fn() };
  return { svc: new StaffService(prisma, jwt, config, {} as any), prisma };
}

const known = (code: string) => new Prisma.PrismaClientKnownRequestError('x', { code, clientVersion: 'test' });

describe('StaffService.updateStaff', () => {
  it('updates contact details and never returns the password hash', async () => {
    const { svc, prisma } = setup();
    prisma.staffUser.update.mockResolvedValue({ id: 's1', fullName: 'Kojo' });
    await svc.updateStaff('s1', { fullName: ' Kojo ', phone: '' });
    const arg = prisma.staffUser.update.mock.calls[0][0];
    expect(arg.data).toEqual({ fullName: 'Kojo', phone: null });
    expect(arg.select.passwordHash).toBeUndefined();
    expect(arg.select.id).toBe(true);
  });

  it('rejects empty edits and blank names; maps missing and duplicate accounts', async () => {
    const { svc, prisma } = setup();
    await expect(svc.updateStaff('s1', {})).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.updateStaff('s1', { fullName: '   ' })).rejects.toBeInstanceOf(BadRequestException);
    prisma.staffUser.update.mockRejectedValueOnce(known('P2025'));
    await expect(svc.updateStaff('x', { fullName: 'A' })).rejects.toBeInstanceOf(NotFoundException);
    prisma.staffUser.update.mockRejectedValueOnce(known('P2002'));
    await expect(svc.updateStaff('s1', { email: 'dup@x.com' })).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('StaffService.adminSetPassword', () => {
  it('stores a bcrypt hash, clears the lockout, and ends every session and push token', async () => {
    const { svc, prisma } = setup();
    prisma.staffUser.findUnique.mockResolvedValue({ id: 's1' });
    expect(await svc.adminSetPassword('s1', 'new-password-1')).toEqual({ id: 's1', passwordReset: true });

    const { data } = prisma.staffUser.update.mock.calls[0][0];
    expect(data.passwordHash).not.toBe('new-password-1');
    expect(await bcrypt.compare('new-password-1', data.passwordHash)).toBe(true);
    expect(data).toMatchObject({ failedLoginAttempts: 0, lockedUntil: null, resetCodeHash: null });
    expect(prisma.staffSession.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { staffUserId: 's1', revokedAt: null } }));
    expect(prisma.device.deleteMany).toHaveBeenCalledWith({ where: { staffUserId: 's1' } });
  });

  it('404s on a missing account without writing', async () => {
    const { svc, prisma } = setup();
    prisma.staffUser.findUnique.mockResolvedValue(null);
    await expect(svc.adminSetPassword('x', 'new-password-1')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.staffUser.update).not.toHaveBeenCalled();
  });
});

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
});

describe('deactivated staff are locked out', () => {
  it('login refuses a deactivated account even with the right password (403 ACCOUNT_DISABLED)', async () => {
    const { svc, prisma } = setup();
    const passwordHash = await bcrypt.hash('right-password', 4);
    const account = { id: 's1', email: 'a@x.com', fullName: 'A', role: 'ADMIN', passwordHash, failedLoginAttempts: 0, lockedUntil: null };
    prisma.staffUser.findUnique.mockResolvedValue({ ...account, isActive: false });
    const err: any = await svc.login({ email: 'a@x.com', password: 'right-password' } as any).catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.getResponse().code).toBe('ACCOUNT_DISABLED');
    expect(prisma.staffSession.create).not.toHaveBeenCalled();

    prisma.staffUser.findUnique.mockResolvedValue({ ...account, isActive: true });
    await expect(svc.login({ email: 'a@x.com', password: 'right-password' } as any)).resolves.toMatchObject({ accessToken: 'token' });
  });

  it('GET /staff/me refuses a deactivated account', async () => {
    const { svc, prisma } = setup();
    prisma.staffUser.findUnique.mockResolvedValue({ id: 's1', isActive: false, passwordHash: 'x' });
    await expect(svc.getProfile('s1')).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('StaffController guards', () => {
  it.each(['updateStaff', 'adminSetPassword', 'setActive', 'createStaff', 'findAll'])('%s is ADMIN only', (name) => {
    const handler = (StaffController.prototype as any)[name];
    expect(new Reflector().get(ROLES_KEY, handler)).toEqual([StaffRole.ADMIN]);
    expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toContain(RolesGuard);
  });

  it.each(['login', 'refresh', 'forgotPassword', 'resetPassword', 'bootstrapAdmin'])('%s needs no login', (name) => {
    expect(Reflect.getMetadata(GUARDS_METADATA, (StaffController.prototype as any)[name])).toBeUndefined();
  });
});
