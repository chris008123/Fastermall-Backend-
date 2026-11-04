import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { StaffRole } from '@prisma/client';
import { SettingsService } from './settings.service';
import { SettingsController } from './settings.controller';
import { ROLES_KEY } from '../../shared/decorators/roles.decorator';
import { RolesGuard } from '../../shared/guards/roles.guard';

function setup(rows: any[] = []) {
  const prisma: any = {
    platformSetting: { findMany: jest.fn().mockResolvedValue(rows), upsert: jest.fn().mockReturnValue('op') },
    $transaction: jest.fn().mockResolvedValue([]),
  };
  const config: any = { get: jest.fn((k: string) => (k === 'orders.marketplaceDeliveryFee' ? 7 : undefined)) };
  return { svc: new SettingsService(prisma, config), prisma };
}

describe('SettingsService', () => {
  it('uses env / previous hard-coded defaults when nothing is stored', async () => {
    const { svc } = setup();
    expect(await svc.getAll()).toEqual({
      marketplaceDeliveryFee: 7,
      laundryPickupFee: 5,
      partnerEarningPerDelivery: 15,
      maintenanceMode: false,
      maintenanceMessage: expect.any(String),
    });
  });

  it('stored values win; invalid or unknown stored rows are ignored', async () => {
    const { svc } = setup([
      { key: 'laundryPickupFee', value: 8.5 },
      { key: 'partnerEarningPerDelivery', value: -3 },
      { key: 'somethingElse', value: 1 },
    ]);
    const s = await svc.getAll();
    expect(s.laundryPickupFee).toBe(8.5);
    expect(s.partnerEarningPerDelivery).toBe(15);
    expect(s).not.toHaveProperty('somethingElse');
  });

  it('falls back to defaults if the table is unreadable, and retries next time', async () => {
    const { svc, prisma } = setup();
    prisma.platformSetting.findMany.mockRejectedValueOnce(new Error('relation does not exist'));
    expect((await svc.getAll()).marketplaceDeliveryFee).toBe(7);
    prisma.platformSetting.findMany.mockResolvedValueOnce([{ key: 'marketplaceDeliveryFee', value: 9 }]);
    expect((await svc.getAll()).marketplaceDeliveryFee).toBe(9);
  });

  it('caches reads, and an update clears the cache', async () => {
    const { svc, prisma } = setup();
    await svc.getAll();
    await svc.getAll();
    expect(prisma.platformSetting.findMany).toHaveBeenCalledTimes(1);
    await svc.update({ maintenanceMode: true }, 'a1');
    expect(prisma.platformSetting.findMany).toHaveBeenCalledTimes(2);
  });

  it('validates everything before saving anything', async () => {
    const { svc, prisma } = setup();
    await expect(svc.update({}, 'a1')).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.update({ laundryPickupFee: 5, nope: 1 }, 'a1')).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.update({ laundryPickupFee: 1.005 }, 'a1')).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.update({ maintenanceMode: 'yes' }, 'a1')).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();

    await svc.update({ laundryPickupFee: 6, maintenanceMode: false }, 'a1');
    expect(prisma.platformSetting.upsert).toHaveBeenCalledWith({
      where: { key: 'laundryPickupFee' },
      create: { key: 'laundryPickupFee', value: 6, updatedById: 'a1' },
      update: { value: 6, updatedById: 'a1' },
    });
  });

  it('maintenance mode blocks ordering with the admin message', async () => {
    const { svc } = setup([
      { key: 'maintenanceMode', value: true },
      { key: 'maintenanceMessage', value: 'Back at 6pm' },
    ]);
    await expect(svc.assertOrderingOpen()).rejects.toThrow(new ServiceUnavailableException('Back at 6pm'));
    await expect(setup().svc.assertOrderingOpen()).resolves.toBeUndefined();
  });
});

describe('SettingsController', () => {
  it('public settings hide the message unless maintenance is on, and never include partner pay', async () => {
    const { svc } = setup();
    const res = await new SettingsController(svc).publicSettings();
    expect(res).toEqual({ marketplaceDeliveryFee: 7, laundryPickupFee: 5, maintenanceMode: false, maintenanceMessage: null });
  });

  it.each(['getAll', 'update'])('%s is ADMIN only', (name) => {
    const handler = (SettingsController.prototype as any)[name];
    expect(new Reflector().get(ROLES_KEY, handler)).toEqual([StaffRole.ADMIN]);
    expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toContain(RolesGuard);
  });

  it('public settings need no login', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, SettingsController.prototype.publicSettings)).toBeUndefined();
  });
});
