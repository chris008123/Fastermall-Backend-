import { NotFoundException } from '@nestjs/common';
import { NotificationsService } from './notifications.service';

function setup() {
  const prisma: any = {
    notification: { updateMany: jest.fn(), findFirst: jest.fn() },
  };
  return { svc: new NotificationsService(prisma), prisma };
}

describe('NotificationsService.markRead', () => {
  it('marks only the caller\'s own notification', async () => {
    const { svc, prisma } = setup();
    prisma.notification.updateMany.mockResolvedValue({ count: 1 });
    prisma.notification.findFirst.mockResolvedValue({ id: 'n1', isRead: true });

    await svc.markRead('u1', 'n1');

    expect(prisma.notification.updateMany).toHaveBeenCalledWith({
      where: { id: 'n1', userId: 'u1' },
      data: { isRead: true },
    });
  });

  it("says 'not found' for someone else's notification and returns nothing from it", async () => {
    const { svc, prisma } = setup();
    prisma.notification.updateMany.mockResolvedValue({ count: 0 });

    await expect(svc.markRead('attacker', 'n1')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.notification.findFirst).not.toHaveBeenCalled();
  });
});
