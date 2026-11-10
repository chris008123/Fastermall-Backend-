import {
  allowedWindows,
  assignWindow,
  nextWindow,
  nextWindows,
  presentWindow,
  windowLabel,
  windowStartingAt,
} from './delivery-windows';

// Ghana time is UTC (no offset, no daylight saving), so 'Z' times below are
// Ghana times.
const at = (iso: string) => new Date(iso);
const iso = (w: { start: Date; end: Date }) => [w.start.toISOString(), w.end.toISOString()];

describe('assignWindow (order time -> delivery window)', () => {
  it.each([
    ['00:00', '2026-11-08T10:00:00.000Z', '2026-11-08T12:00:00.000Z'],
    ['08:59', '2026-11-08T10:00:00.000Z', '2026-11-08T12:00:00.000Z'],
    ['09:00', '2026-11-08T16:00:00.000Z', '2026-11-08T18:00:00.000Z'],
    ['12:30', '2026-11-08T16:00:00.000Z', '2026-11-08T18:00:00.000Z'],
    ['14:59', '2026-11-08T16:00:00.000Z', '2026-11-08T18:00:00.000Z'],
    ['15:00', '2026-11-09T10:00:00.000Z', '2026-11-09T12:00:00.000Z'],
    ['23:59', '2026-11-09T10:00:00.000Z', '2026-11-09T12:00:00.000Z'],
  ])('an order at %s on 8 Nov is delivered %s – %s', (time, start, end) => {
    expect(iso(assignWindow(at(`2026-11-08T${time}:00Z`)))).toEqual([start, end]);
  });

  it('seconds do not move an order across a cut-off', () => {
    expect(assignWindow(at('2026-11-08T08:59:59.999Z')).slot).toBe('MORNING');
    expect(assignWindow(at('2026-11-08T14:59:59.999Z')).slot).toBe('AFTERNOON');
  });

  it('after 15:00 on the last day of a month or year goes to the 1st', () => {
    expect(iso(assignWindow(at('2026-11-30T16:00:00Z')))[0]).toBe('2026-12-01T10:00:00.000Z');
    expect(iso(assignWindow(at('2026-12-31T20:00:00Z')))[0]).toBe('2027-01-01T10:00:00.000Z');
  });
});

describe('next windows (rescheduling)', () => {
  it('the requirement example: 8 Nov morning -> 8 Nov afternoon -> 9 Nov morning', () => {
    const original = assignWindow(at('2026-11-08T07:30:00Z'));
    expect(allowedWindows(original).map(iso)).toEqual([
      ['2026-11-08T10:00:00.000Z', '2026-11-08T12:00:00.000Z'],
      ['2026-11-08T16:00:00.000Z', '2026-11-08T18:00:00.000Z'],
      ['2026-11-09T10:00:00.000Z', '2026-11-09T12:00:00.000Z'],
    ]);
  });

  it('from an afternoon: next morning, then next afternoon', () => {
    const original = assignWindow(at('2026-11-08T10:00:00Z'));
    expect(nextWindows(original, 2).map((w) => [w.slot, w.start.toISOString()])).toEqual([
      ['MORNING', '2026-11-09T10:00:00.000Z'],
      ['AFTERNOON', '2026-11-09T16:00:00.000Z'],
    ]);
  });

  it('crosses month ends', () => {
    expect(nextWindow(assignWindow(at('2026-11-30T12:00:00Z'))).start.toISOString()).toBe('2026-12-01T10:00:00.000Z');
  });
});

describe('windowStartingAt', () => {
  it('rebuilds a stored window from its start, and rejects anything else', () => {
    expect(windowStartingAt(at('2026-11-08T16:00:00Z'))).toMatchObject({ slot: 'AFTERNOON' });
    expect(windowStartingAt(at('2026-11-08T10:00:00Z'))?.end.toISOString()).toBe('2026-11-08T12:00:00.000Z');
    expect(windowStartingAt(at('2026-11-08T11:00:00Z'))).toBeNull();
    expect(windowStartingAt(at('2026-11-08T10:00:01Z'))).toBeNull();
    expect(windowStartingAt(new Date('garbage'))).toBeNull();
  });
});

describe('labels', () => {
  it('reads in Ghana time', () => {
    const w = assignWindow(at('2026-11-08T07:00:00Z'));
    expect(windowLabel(w)).toBe('Sun 8 Nov, 10:00 AM – 12:00 PM');
    expect(presentWindow(nextWindow(w))).toEqual({
      slot: 'AFTERNOON',
      start: '2026-11-08T16:00:00.000Z',
      end: '2026-11-08T18:00:00.000Z',
      label: 'Sun 8 Nov, 4:00 PM – 6:00 PM',
    });
  });
});
