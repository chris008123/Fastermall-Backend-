import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { StaffRole } from '@prisma/client';
import { CHANNELS, NotificationsService } from './notifications.service';
import { maskToken, PushService } from './push.service';
import { NotificationsController } from './notifications.controller';
import { AdminController } from '../admin/admin.controller';
import { ROLES_KEY } from '../../shared/decorators/roles.decorator';

// Step 2.4: the broadcast popup/ding fix, the test-push diagnostics, and the
// partner notification switches the backend now acts on.

const TOKEN_A = 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]';
const TOKEN_B = 'ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]';

function notifications(over: any = {}) {
  const prisma: any = {
    user: { findMany: jest.fn().mockResolvedValue([{ id: 'u1' }]), findFirst: jest.fn() },
    staffUser: { findMany: jest.fn().mockResolvedValue([{ id: 's1' }]), findUnique: jest.fn() },
    notification: { create: jest.fn().mockResolvedValue({}), createMany: jest.fn().mockResolvedValue({}) },
    deliveryPartnerProfile: { findUnique: jest.fn().mockResolvedValue(null) },
    ...over,
  };
  const push = {
    sendToOwners: jest.fn().mockResolvedValue(undefined),
    sendTest: jest.fn().mockResolvedValue({ devices: [], results: [] }),
  };
  return { svc: new NotificationsService(prisma, push as any), prisma, push };
}

describe('broadcast popup fix', () => {
  it('customers: sent on the orders channel (a channel the app has), skipping deleted accounts', async () => {
    const { svc, prisma, push } = notifications();
    await svc.broadcast('CUSTOMERS', 'Sale', 'Free delivery today');
    expect(prisma.user.findMany.mock.calls[0][0].where).toEqual({ deletedAt: null });
    expect(push.sendToOwners.mock.calls[0][1]).toMatchObject({ channelId: CHANNELS.orders, filterAs: 'offers' });
  });

  it('staff: sent on the deliveries channel', async () => {
    const { svc, push } = notifications();
    await svc.broadcast('DELIVERY_PARTNER', 'Rain', 'Ride safe');
    expect(push.sendToOwners.mock.calls[0][1]).toMatchObject({ channelId: CHANNELS.deliveries });
  });
});

describe('PushService.sendTest', () => {
  function pushService(tickets: any[] | Error) {
    const prisma: any = {
      device: {
        findMany: jest.fn().mockResolvedValue([
          { token: TOKEN_A, platform: 'android', lastSeenAt: new Date(), orderUpdates: false, announcements: true },
          { token: TOKEN_B, platform: 'ios', lastSeenAt: new Date(), orderUpdates: true, announcements: true },
        ]),
        deleteMany: jest.fn(),
      },
    };
    const svc = new PushService({ get: jest.fn() } as any, prisma);
    const expo = (svc as any).expo;
    expo.sendPushNotificationsAsync = jest.fn(() => (tickets instanceof Error ? Promise.reject(tickets) : Promise.resolve(tickets)));
    return { svc, prisma, expo };
  }

  it('ignores the category switches and reports what Expo said per device, tokens masked', async () => {
    const { svc, prisma, expo } = pushService([
      { status: 'ok', id: 'r1' },
      { status: 'error', message: 'not registered', details: { error: 'DeviceNotRegistered' } },
    ]);
    const out = await svc.sendTest({ userIds: ['u1'] }, { title: 't', body: 'b', channelId: 'orders' });

    expect(prisma.device.findMany.mock.calls[0][0].where).toEqual({ OR: [{ userId: { in: ['u1'] } }] });
    expect(out.results).toEqual([
      { token: maskToken(TOKEN_A), status: 'ok' },
      { token: maskToken(TOKEN_B), status: 'error', error: 'DeviceNotRegistered', message: 'not registered' },
    ]);
    expect(JSON.stringify(out)).not.toContain(TOKEN_A);
    // Messages ask for the popup and the sound.
    const sent = expo.sendPushNotificationsAsync.mock.calls[0][0];
    expect(sent[0]).toMatchObject({ sound: 'default', priority: 'high', channelId: 'orders' });
    // The dead token is removed, like a normal send.
    expect(prisma.device.deleteMany).toHaveBeenCalledWith({ where: { token: { in: [TOKEN_B] } } });
  });

  it('reports every device as failed when Expo cannot be reached, without throwing', async () => {
    const { svc } = pushService(new Error('ETIMEDOUT'));
    const out = await svc.sendTest({ staffUserIds: ['s1'] }, { title: 't', body: 'b' });
    expect(out.results.every((r) => r.status === 'error' && r.error === 'ExpoUnreachable')).toBe(true);
  });
});

describe('NotificationsService.sendTestPush', () => {
  it('a customer is tested on the orders channel, staff on the deliveries channel', async () => {
    const { svc, push } = notifications();
    await svc.sendTestPush({ userId: 'u1', role: 'CUSTOMER' });
    expect(push.sendTest).toHaveBeenLastCalledWith({ userIds: ['u1'] }, expect.objectContaining({ channelId: 'orders', data: { type: 'TEST' } }));
    await svc.sendTestPush({ userId: 's1', role: 'DELIVERY_PARTNER' });
    expect(push.sendTest).toHaveBeenLastCalledWith({ staffUserIds: ['s1'] }, expect.objectContaining({ channelId: 'deliveries' }));
  });

  it('explains the likely cause: no phone registered, app-side setup, or an Expo refusal', async () => {
    const { svc, push, prisma } = notifications();
    expect((await svc.sendTestPush({ userId: 'u1' })).hint).toMatch(/No phone is registered/);

    push.sendTest.mockResolvedValue({ devices: [{ token: 'x' }], results: [{ token: 'x', status: 'ok' }] });
    const ok = await svc.sendTestPush({ userId: 'u1' });
    expect(ok).toMatchObject({ sent: 1, failed: 0 });
    expect(ok.hint).toMatch(/setNotificationHandler/);

    push.sendTest.mockResolvedValue({ devices: [{ token: 'x' }], results: [{ token: 'x', status: 'error', error: 'DeviceNotRegistered' }] });
    expect((await svc.sendTestPush({ userId: 'u1' })).hint).toMatch(/Expo refused/);
    expect(prisma.notification.create).not.toHaveBeenCalled(); // never added to the in-app list
  });

  it('admin variant: exactly one target, 404 for unknown or deleted accounts', async () => {
    const { svc, prisma, push } = notifications();
    await expect(svc.sendTestPushTo({})).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.sendTestPushTo({ userId: 'u1', staffUserId: 's1' })).rejects.toBeInstanceOf(BadRequestException);
    prisma.user.findFirst.mockResolvedValue(null);
    await expect(svc.sendTestPushTo({ userId: 'gone' })).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.user.findFirst.mock.calls[0][0].where).toEqual({ id: 'gone', deletedAt: null });

    prisma.staffUser.findUnique.mockResolvedValue({ id: 's1', role: 'DELIVERY_PARTNER' });
    await svc.sendTestPushTo({ staffUserId: 's1' });
    expect(push.sendTest).toHaveBeenLastCalledWith({ staffUserIds: ['s1'] }, expect.anything());
  });

  it('routes: anyone signed in can test their own phone; testing another account is ADMIN only', () => {
    expect(new Reflector().get(ROLES_KEY, NotificationsController.prototype.sendTest)).toBeUndefined();
    expect(new Reflector().get(ROLES_KEY, AdminController)).toEqual([StaffRole.ADMIN]);
    expect(typeof (AdminController.prototype as any).testPush).toBe('function');
    expect(Reflect.getMetadata(GUARDS_METADATA, NotificationsController)).toBeDefined();
  });
});

describe('Delivery App notification switches', () => {
  const flush = () => new Promise((r) => setImmediate(r));
  const prefs = (notificationsPrefs: object) => ({ preferences: { notifications: notificationsPrefs } });

  it('jobUpdates: a cancelled delivery is pushed, unless the partner turned job updates off', async () => {
    const { svc, prisma, push } = notifications();
    prisma.deliveryPartnerProfile.findUnique.mockResolvedValue(prefs({}));
    await svc.onDeliveryCancelled({ deliveryId: 'd1', orderId: 'o1', staffUserId: 's1' });
    expect(prisma.notification.create.mock.calls[0][0].data).toMatchObject({ staffUserId: 's1', type: 'DELIVERY_CANCELLED' });
    expect(push.sendToOwners).toHaveBeenCalledWith(
      { staffUserIds: ['s1'] },
      expect.objectContaining({ channelId: 'deliveries', data: expect.objectContaining({ type: 'DELIVERY_CANCELLED', jobId: 'd1' }) }),
    );

    push.sendToOwners.mockClear();
    prisma.deliveryPartnerProfile.findUnique.mockResolvedValue(prefs({ jobUpdates: false }));
    await svc.onDeliveryCancelled({ deliveryId: 'd2', staffUserId: 's1' });
    await flush();
    expect(prisma.notification.create).toHaveBeenCalledTimes(2); // still in the in-app list
    expect(push.sendToOwners).not.toHaveBeenCalled();
  });

  it('payments: cash-out paid / failed and recorded payouts, honouring the payments switch', async () => {
    const { svc, prisma, push } = notifications();
    prisma.deliveryPartnerProfile.findUnique.mockResolvedValue(prefs({}));
    await svc.onCashOutUpdated({ staffUserId: 's1', payoutId: 'p1', status: 'PAID', amountPesewas: 2550 });
    expect(prisma.notification.create.mock.calls[0][0].data).toMatchObject({ type: 'CASHOUT_PAID', body: expect.stringContaining('GHS 25.50') });

    await svc.onCashOutUpdated({ staffUserId: 's1', payoutId: 'p2', status: 'FAILED', amountPesewas: 1000, reason: 'Wrong number' });
    expect(prisma.notification.create.mock.calls[1][0].data).toMatchObject({ type: 'CASHOUT_FAILED', body: expect.stringContaining('Wrong number') });

    await svc.onPayoutRecorded({ staffUserId: 's1', payoutId: 'pp1', amount: '40' });
    expect(prisma.notification.create.mock.calls[2][0].data).toMatchObject({ type: 'PAYOUT_RECORDED', body: expect.stringContaining('GHS 40.00') });
    expect(push.sendToOwners).toHaveBeenCalledTimes(3);

    push.sendToOwners.mockClear();
    prisma.deliveryPartnerProfile.findUnique.mockResolvedValue(prefs({ payments: false }));
    await svc.onPayoutRecorded({ staffUserId: 's1', payoutId: 'pp2', amount: '5' });
    expect(push.sendToOwners).not.toHaveBeenCalled();
  });

  it('sound off: partner pushes are silent; admins (no partner profile) get a normal push', async () => {
    const { svc, prisma, push } = notifications();
    prisma.deliveryPartnerProfile.findUnique.mockResolvedValue(prefs({ sound: false }));
    await svc.onPayoutRecorded({ staffUserId: 's1', payoutId: 'pp1', amount: '1' });
    expect(push.sendToOwners.mock.calls[0][1]).toMatchObject({ sound: false });

    prisma.deliveryPartnerProfile.findUnique.mockResolvedValue(null);
    await svc.onSupportReply({ ticketId: 't1', staffUserId: 'a1', subject: 'x' });
    expect(push.sendToOwners.mock.calls[1][1]).not.toHaveProperty('sound');
  });
});
