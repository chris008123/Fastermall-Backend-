import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Prisma, StaffRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { StaffService } from './staff.service';
import { StaffController } from './staff.controller';
import { ROLES_KEY } from '../../shared/decorators/roles.decorator';
import { RolesGuard } from '../../shared/guards/roles.guard';

function setup() {
  const prisma: any = { staffUser: { update: jest.fn(), findMany: jest.fn() } };
  return { svc: new StaffService(prisma, {} as any, {} as any), prisma };
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

describe('StaffService.resetPassword', () => {
  it('stores a bcrypt hash of the new password, not the password', async () => {
    const { svc, prisma } = setup();
    prisma.staffUser.update.mockResolvedValue({ id: 's1' });
    expect(await svc.resetPassword('s1', 'new-password-1')).toEqual({ id: 's1', passwordReset: true });
    const { passwordHash } = prisma.staffUser.update.mock.calls[0][0].data;
    expect(passwordHash).not.toBe('new-password-1');
    expect(await bcrypt.compare('new-password-1', passwordHash)).toBe(true);
  });

  it('maps a missing account to 404', async () => {
    const { svc, prisma } = setup();
    prisma.staffUser.update.mockRejectedValueOnce(known('P2025'));
    await expect(svc.resetPassword('x', 'new-password-1')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('StaffController guards', () => {
  it.each(['updateStaff', 'resetPassword', 'createStaff', 'findAll'])('%s is ADMIN only', (name) => {
    const handler = (StaffController.prototype as any)[name];
    expect(new Reflector().get(ROLES_KEY, handler)).toEqual([StaffRole.ADMIN]);
    expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toContain(RolesGuard);
  });
});
