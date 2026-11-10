import { Prisma } from '@prisma/client';

// The customer's handover code is stored as a bcrypt hash plus an encrypted
// copy. Neither may leave the server: a 6-digit code's hash can be cracked
// offline in minutes, and whoever learns the code can mark a delivery as
// handed over without meeting the customer.
const SECRET_KEYS = [
  'deliveryCodeHash',
  'deliveryCodeEncrypted',
  'deliveryCodeAttempts',
  'deliveryCodeLockedUntil',
] as const;

// Live maps and location tracking were removed from the apps (Nov 2026).
// The columns are kept so the feature can return later, but no delivery
// response carries coordinates or the rider's position any more.
export const DELIVERY_LOCATION_KEYS = [
  'pickupLat',
  'pickupLng',
  'dropoffLat',
  'dropoffLng',
  'riderLat',
  'riderLng',
  'riderLocationAt',
] as const;

const HIDDEN_KEYS = [...SECRET_KEYS, ...DELIVERY_LOCATION_KEYS] as const;

type HiddenKey = (typeof HIDDEN_KEYS)[number];

/**
 * Copy of a delivery row without the handover-code secrets and without
 * location fields (see DELIVERY_LOCATION_KEYS).
 */
export function stripDeliverySecrets<T extends object>(delivery: T): Omit<T, HiddenKey & keyof T> {
  const out = { ...delivery } as Record<string, unknown>;
  for (const key of HIDDEN_KEYS) delete out[key];
  return out as Omit<T, HiddenKey & keyof T>;
}

/** Same, for a list. */
export function stripDeliveriesSecrets<T extends object>(rows: T[]): Omit<T, HiddenKey & keyof T>[] {
  return rows.map(stripDeliverySecrets);
}

/**
 * Prisma select for a delivery's own columns, minus the secrets and the
 * location fields. Use this when a delivery is nested inside another record
 * (order, laundry order).
 */
export const SAFE_DELIVERY_SELECT = {
  id: true,
  orderId: true,
  laundryOrderId: true,
  partnerId: true,
  claimedByStaffId: true,
  status: true,
  distanceKm: true,
  deliveryCodeUsed: true,
  verifiedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.DeliverySelect;
