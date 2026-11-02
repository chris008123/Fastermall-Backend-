import { PushService } from './push.service';

describe('PushService category switches', () => {
  let prisma: any;
  let push: PushService;

  beforeEach(() => {
    prisma = { device: { findMany: jest.fn().mockResolvedValue([]), deleteMany: jest.fn() } };
    push = new PushService({ get: jest.fn() } as any, prisma);
  });

  const whereFor = async (channelId?: string) => {
    await push.sendToOwners({ userIds: ['u1'] }, { title: 't', body: 'b', channelId });
    return prisma.device.findMany.mock.calls[0][0].where;
  };

  it.each(['orders', 'deliveries'])('skips devices with order updates off (%s channel)', async (channel) => {
    expect(await whereFor(channel)).toEqual({ OR: [{ userId: { in: ['u1'] } }], orderUpdates: true });
  });

  it('skips devices with announcements off (offers channel)', async () => {
    expect(await whereFor('offers')).toEqual({ OR: [{ userId: { in: ['u1'] } }], announcements: true });
  });

  it('sends anything else to every device', async () => {
    expect(await whereFor(undefined)).toEqual({ OR: [{ userId: { in: ['u1'] } }] });
  });
});
