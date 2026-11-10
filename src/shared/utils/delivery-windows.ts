/**
 * Marketplace delivery windows (requirement 2.8).
 *
 * Every day has two windows, in Ghana time (Africa/Accra, UTC+0 all year, no
 * daylight saving, so Ghana time and UTC are the same clock):
 *   MORNING    10:00 – 12:00
 *   AFTERNOON  16:00 – 18:00
 *
 * The window is assigned from the time the order is placed:
 *   before 09:00            -> same day, MORNING
 *   09:00 up to 15:00       -> same day, AFTERNOON
 *   15:00 or later          -> next day, MORNING
 *
 * A customer may move the delivery only to one of the two windows that come
 * straight after the ORIGINAL window (or back to the original). Any other
 * date or time is refused.
 */

export type WindowSlot = 'MORNING' | 'AFTERNOON';

export interface DeliveryWindow {
  slot: WindowSlot;
  start: Date;
  end: Date;
}

// Hours in Ghana time (= UTC).
const SLOTS: Record<WindowSlot, { start: number; end: number }> = {
  MORNING: { start: 10, end: 12 },
  AFTERNOON: { start: 16, end: 18 },
};
const MORNING_CUTOFF_HOUR = 9; // before 09:00 -> same-day morning
const AFTERNOON_CUTOFF_HOUR = 15; // before 15:00 -> same-day afternoon

/** Ghana is UTC+0 with no daylight saving, so UTC midnight is Ghana midnight. */
function ghanaMidnight(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

function addDays(day: Date, days: number): Date {
  return new Date(day.getTime() + days * 24 * 60 * 60 * 1000);
}

export function makeWindow(day: Date, slot: WindowSlot): DeliveryWindow {
  const midnight = ghanaMidnight(day);
  const { start, end } = SLOTS[slot];
  return {
    slot,
    start: new Date(midnight.getTime() + start * 60 * 60 * 1000),
    end: new Date(midnight.getTime() + end * 60 * 60 * 1000),
  };
}

/** The window an order placed at `placedAt` is delivered in. */
export function assignWindow(placedAt: Date): DeliveryWindow {
  const minutes = placedAt.getUTCHours() * 60 + placedAt.getUTCMinutes();
  if (minutes < MORNING_CUTOFF_HOUR * 60) return makeWindow(placedAt, 'MORNING');
  if (minutes < AFTERNOON_CUTOFF_HOUR * 60) return makeWindow(placedAt, 'AFTERNOON');
  return makeWindow(addDays(ghanaMidnight(placedAt), 1), 'MORNING');
}

/** The window straight after this one (morning -> afternoon -> next morning). */
export function nextWindow(window: DeliveryWindow): DeliveryWindow {
  return window.slot === 'MORNING'
    ? makeWindow(window.start, 'AFTERNOON')
    : makeWindow(addDays(ghanaMidnight(window.start), 1), 'MORNING');
}

/** The `count` consecutive windows after `window`. */
export function nextWindows(window: DeliveryWindow, count: number): DeliveryWindow[] {
  const out: DeliveryWindow[] = [];
  let current = window;
  for (let i = 0; i < count; i++) {
    current = nextWindow(current);
    out.push(current);
  }
  return out;
}

/** Rebuilds a window from its stored start time, or null if it isn't one. */
export function windowStartingAt(start: Date): DeliveryWindow | null {
  if (Number.isNaN(start.getTime())) return null;
  for (const slot of Object.keys(SLOTS) as WindowSlot[]) {
    const candidate = makeWindow(start, slot);
    if (candidate.start.getTime() === start.getTime()) return candidate;
  }
  return null;
}

/** Number of alternatives a customer may pick from, after the original. */
export const RESCHEDULE_ALTERNATIVES = 2;

/** The original window plus the only windows it may be moved to, in order. */
export function allowedWindows(original: DeliveryWindow): DeliveryWindow[] {
  return [original, ...nextWindows(original, RESCHEDULE_ALTERNATIVES)];
}

const DAY = new Intl.DateTimeFormat('en-GB', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  timeZone: 'Africa/Accra',
});
const TIME = new Intl.DateTimeFormat('en-US', {
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'Africa/Accra',
});

/** e.g. "Sat 8 Nov, 10:00 AM – 12:00 PM" (Ghana time). */
export function windowLabel(window: { start: Date; end: Date }): string {
  return `${DAY.format(window.start)}, ${TIME.format(window.start)} – ${TIME.format(window.end)}`;
}

/** The JSON shape the apps get for a window. */
export function presentWindow(window: DeliveryWindow) {
  return {
    slot: window.slot,
    start: window.start.toISOString(),
    end: window.end.toISOString(),
    label: windowLabel(window),
  };
}
