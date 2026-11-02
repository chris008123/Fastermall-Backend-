import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { IdentityService } from './identity.service';
import { UpdateProfileDto } from './dto/update-profile.dto';

const user = {
  id: 'u1', email: 'a@b.c', phone: '0241234567', googleId: 'g1', fullName: 'Ama',
  passwordHash: 'hash', otpCodeHash: 'otp', resetCodeHash: 'reset', deletedAt: null,
};

function setup() {
  const prisma: any = {
    user: {
      findUnique: jest.fn().mockResolvedValue(user),
      update: jest.fn(async ({ data }) => ({ ...user, ...data })),
    },
    device: { deleteMany: jest.fn().mockReturnValue('devices') },
    notification: { deleteMany: jest.fn().mockReturnValue('notifications') },
    address: { deleteMany: jest.fn().mockReturnValue('addresses') },
    $transaction: jest.fn().mockResolvedValue([]),
  };
  const svc = new IdentityService(prisma, {} as any, {} as any);
  return { svc, prisma };
}

describe('GET /auth/me', () => {
  it('answers 401 for a deleted account, so an old token ends the session', async () => {
    const { svc, prisma } = setup();
    prisma.user.findUnique.mockResolvedValue({ ...user, deletedAt: new Date() });
    await expect(svc.getProfile('u1')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('never returns secrets', async () => {
    const result: any = await setup().svc.getProfile('u1');
    expect(result).not.toHaveProperty('passwordHash');
    expect(result).not.toHaveProperty('otpCodeHash');
    expect(result).not.toHaveProperty('resetCodeHash');
    expect(result).toMatchObject({ id: 'u1', fullName: 'Ama' });
  });
});

describe('PATCH /auth/me', () => {
  it('updates only the fields sent and returns the safe user', async () => {
    const { svc, prisma } = setup();
    const result: any = await svc.updateProfile('u1', { fullName: '  Kofi  ' });
    expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { fullName: 'Kofi' } });
    expect(result.fullName).toBe('Kofi');
    expect(result).not.toHaveProperty('passwordHash');
  });

  it('returns 409 when the phone number belongs to someone else', async () => {
    const { svc, prisma } = setup();
    prisma.user.update.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint', { code: 'P2002', clientVersion: 'x' }),
    );
    await expect(svc.updateProfile('u1', { phone: '0201111111' })).rejects.toThrow(
      new ConflictException('That number is already in use'),
    );
  });

  it('validates the phone as a local 10-digit number', () => {
    const errors = (body: object) => validateSync(plainToInstance(UpdateProfileDto, body));
    expect(errors({ phone: '0241234567' })).toHaveLength(0);
    expect(errors({ phone: '+233241234567' })).not.toHaveLength(0);
    expect(errors({ phone: '241234567' })).not.toHaveLength(0);
    expect(errors({ fullName: 'A' })).not.toHaveLength(0);
  });
});

describe('DELETE /auth/me', () => {
  it('clears every personal field, removes devices and notifications, keeps the row', async () => {
    const { svc, prisma } = setup();
    await expect(svc.deleteAccount('u1')).resolves.toEqual({ ok: true });

    const data = prisma.user.update.mock.calls[0][0].data;
    expect(data).toMatchObject({
      fullName: 'Deleted user', email: null, phone: null, googleId: null,
      passwordHash: null, otpCodeHash: null, resetCodeHash: null,
    });
    expect(data.deletedAt).toBeInstanceOf(Date);
    expect(prisma.device.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u1' } });
    expect(prisma.notification.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u1' } });
    expect(prisma.address.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u1' } });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('is a no-op the second time', async () => {
    const { svc, prisma } = setup();
    prisma.user.findUnique.mockResolvedValue({ id: 'u1', deletedAt: new Date() });
    await expect(svc.deleteAccount('u1')).resolves.toEqual({ ok: true });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
