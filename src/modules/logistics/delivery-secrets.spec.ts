import { EventEmitter2 } from '@nestjs/event-emitter';
import { LogisticsService } from './logistics.service';
import { stripDeliverySecrets } from '../../shared/utils/delivery-secrets';

// The handover code's hash/ciphertext must never reach a partner or admin
// app. A 6-digit bcrypt hash can be brute-forced offline.
const SECRETS = {
  deliveryCodeHash: '$2b$10$abcdefghijklmnopqrstuv',
  deliveryCodeEncrypted: 'iv:cipher:tag',
  deliveryCodeAttempts: 2,
  deliveryCodeLockedUntil: null,
};

const row = (over: Record<string, unknown> = {}) => ({
  id: 'd1',
  orderId: 'o1',
  laundryOrderId: null,
  partnerId: null,
  claimedByStaffId: null,
  status: 'ASSIGNED',
  order: { type: 'FOOD', customer: { id: 'c1', fullName: 'Ama' } },
  laundryOrder: null,
  ...SECRETS,
  ...over,
});

function expectNoSecrets(value: unknown) {
  const json = JSON.stringify(value);
  for (const key of Object.keys(SECRETS)) expect(json).not.toContain(key);
}

describe('stripDeliverySecrets', () => {
  it('removes only the secret fields', () => {
    const out = stripDeliverySecrets(row());
    expectNoSecrets(out);
    expect(out).toMatchObject({ id: 'd1', status: 'ASSIGNED', order: { type: 'FOOD' } });
  });
});

describe('LogisticsService responses carry no handover-code secrets', () => {
  let svc: LogisticsService;
  let prisma: any;

  beforeEach(() => {
    prisma = {
      delivery: {
        findMany: jest.fn().mockResolvedValue([row(), row({ id: 'd2' })]),
        findUnique: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn(),
      },
      deliveryPartnerProfile: {
        findUnique: jest.fn().mockResolvedValue({ id: 'p1', staffUserId: 's1' }),
      },
      deliveryStatusEvent: { create: jest.fn() },
      order: { update: jest.fn() },
      $transaction: jest.fn((fn: any) => fn(prisma)),
    };
    svc = new LogisticsService(prisma, new EventEmitter2());
  });

  it('findUnassigned', async () => {
    const res = await svc.findUnassigned('DELIVERY_PARTNER');
    expect(res).toHaveLength(2);
    expectNoSecrets(res);
  });

  it('myDeliveries', async () => {
    expectNoSecrets(await svc.myDeliveries('s1', 'DELIVERY_PARTNER'));
    expectNoSecrets(await svc.myDeliveries('admin1', 'ADMIN'));
  });

  it('claim', async () => {
    prisma.delivery.findUnique.mockResolvedValue(row());
    prisma.$queryRaw = jest.fn();
    prisma.delivery.count = jest.fn().mockResolvedValue(0);
    prisma.delivery.findUniqueOrThrow.mockResolvedValue(row({ partnerId: 'p1', status: 'EN_ROUTE_TO_PICKUP' }));
    expectNoSecrets(await svc.claim('d1', 's1', 'DELIVERY_PARTNER'));
  });

  it('updateStatus, including the repeated-tap shortcut', async () => {
    prisma.delivery.findUnique.mockResolvedValue(row({ partnerId: 'p1', status: 'EN_ROUTE_TO_PICKUP' }));
    expectNoSecrets(await svc.updateStatus('d1', { status: 'EN_ROUTE_TO_PICKUP' } as any, 's1', 'DELIVERY_PARTNER'));

    prisma.delivery.findUniqueOrThrow.mockResolvedValue(row({ partnerId: 'p1', status: 'PICKED_UP' }));
    expectNoSecrets(await svc.updateStatus('d1', { status: 'PICKED_UP' } as any, 's1', 'DELIVERY_PARTNER'));
  });
});
