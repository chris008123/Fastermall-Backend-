import { BadRequestException } from '@nestjs/common';
import { NotificationsService } from './notifications.service';

function setup(users = 3, staff = 2) {
  const prisma: any = {
    user: { findMany: jest.fn().mockResolvedValue(Array.from({ length: users }, (_, i) => ({ id: `u${i}` }))) },
    staffUser: { findMany: jest.fn().mockResolvedValue(Array.from({ length: staff }, (_, i) => ({ id: `s${i}` }))) },
    notification: { createMany: jest.fn().mockResolvedValue({}) },
  };
  const push = { sendToOwners: jest.fn().mockResolvedValue(undefined) };
  return { svc: new NotificationsService(prisma, push as any), prisma, push };
}

describe('NotificationsService.broadcast', () => {
  it('reaches every customer in the app and by push, honouring the announcements switch', async () => {
    const { svc, prisma, push } = setup(3);
    expect(await svc.broadcast('CUSTOMERS', ' Hello ', ' Free delivery today ')).toEqual({ audience: 'CUSTOMERS', recipients: 3 });
    const rows = prisma.notification.createMany.mock.calls[0][0].data;
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({ userId: 'u0', title: 'Hello', body: 'Free delivery today', type: 'ANNOUNCEMENT' });
    expect(push.sendToOwners).toHaveBeenCalledWith({ userIds: ['u0', 'u1', 'u2'] }, expect.objectContaining({ filterAs: 'offers', title: 'Hello' }));
  });

  it('targets active staff of one role, or all active staff', async () => {
    const { svc, prisma, push } = setup(0, 2);
    await svc.broadcast('DELIVERY_PARTNER', 'Shift', 'Rain tonight');
    expect(prisma.staffUser.findMany.mock.calls[0][0].where).toEqual({ isActive: true, role: 'DELIVERY_PARTNER' });
    expect(prisma.notification.createMany.mock.calls[0][0].data[0]).toMatchObject({ staffUserId: 's0' });
    expect(push.sendToOwners.mock.calls[0][0]).toEqual({ staffUserIds: ['s0', 's1'] });

    await svc.broadcast('ALL_STAFF', 'Hi', 'Team meeting');
    expect(prisma.staffUser.findMany.mock.calls[1][0].where).toEqual({ isActive: true });
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  it('sends in batches of 500', async () => {
    const { svc, prisma, push } = setup(1201);
    await svc.broadcast('CUSTOMERS', 'Hi', 'There');
    expect(prisma.notification.createMany).toHaveBeenCalledTimes(3);
    expect(push.sendToOwners).toHaveBeenCalledTimes(3);
  });

  it('refuses a blank title or message', async () => {
    const { svc, prisma } = setup();
    await expect(svc.broadcast('CUSTOMERS', '  ', 'x')).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.notification.createMany).not.toHaveBeenCalled();
  });
});
