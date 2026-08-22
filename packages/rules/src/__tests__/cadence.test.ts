import { describe, expect, it } from 'vitest';

import { CADENCE_MS, IDLE_MS, cadenceLabel, crawlIntervalMs, inPublishWindow } from '../sources';

/**
 * The polling tiers.
 *
 * The behaviour worth pinning is not the numbers — those are constants and a
 * test that restates them proves nothing. It is that **the markets decide**:
 * a source becomes urgent because something it feeds settles today, and stops
 * being urgent afterwards, with nobody touching a setting either way.
 */
describe('crawl cadence', () => {
  it('escalates a source when a market it feeds enters its last day', () => {
    const quiet = crawlIntervalMs({ cadence: 'auto', hoursToNearestSettlement: 200 });
    const soon = crawlIntervalMs({ cadence: 'auto', hoursToNearestSettlement: 20 });

    expect(quiet).toBe(CADENCE_MS.background);
    expect(soon).toBeLessThan(quiet);
    expect(soon).toBe(CADENCE_MS.urgent);
    expect(cadenceLabel({ cadence: 'auto', hoursToNearestSettlement: 20 })).toBe('urgent');
  });

  it('falls back on its own once the market has settled', () => {
    // No settlement ahead of it any more. Nothing had to remember to undo the
    // escalation, which is the point of asking the question every pass rather
    // than storing the answer.
    // Idle, not background: "nothing is listening" should cost less than
    // "nothing is happening soon", which the older suite already insisted on.
    expect(crawlIntervalMs({ cadence: 'auto', hoursToNearestSettlement: null })).toBe(IDLE_MS);
    expect(IDLE_MS).toBeGreaterThan(CADENCE_MS.background);
  });

  it('lets an operator pin a source against what its markets say', () => {
    expect(crawlIntervalMs({ cadence: 'background', hoursToNearestSettlement: 1 })).toBe(
      CADENCE_MS.background,
    );
    expect(crawlIntervalMs({ cadence: 'urgent', hoursToNearestSettlement: 5000 })).toBe(
      CADENCE_MS.urgent,
    );
  });

  it('keeps a calendar source on background until its window opens', () => {
    // The NBS posts CPI monthly. Polling every five minutes for thirty days to
    // catch one publication is 8,600 requests for one item.
    const closed = crawlIntervalMs({
      cadence: 'auto',
      hoursToNearestSettlement: 10,
      inPublishWindow: false,
    });
    const open = crawlIntervalMs({
      cadence: 'auto',
      hoursToNearestSettlement: 10,
      inPublishWindow: true,
    });

    expect(closed).toBe(CADENCE_MS.background);
    expect(open).toBe(CADENCE_MS.urgent);
  });

  it('backs off a failing source instead of hammering it', () => {
    const healthy = crawlIntervalMs({ cadence: 'urgent', hoursToNearestSettlement: 1 });
    const struggling = crawlIntervalMs({
      cadence: 'urgent',
      hoursToNearestSettlement: 1,
      failureCount: 4,
    });

    expect(struggling).toBe(healthy * 16);
    // Capped, so a source that has been down for a week still gets retried
    // rather than effectively never.
    expect(
      crawlIntervalMs({ cadence: 'urgent', hoursToNearestSettlement: 1, failureCount: 40 }),
    ).toBe(healthy * 32);
  });

  it('still answers the old bare-hours call', () => {
    expect(crawlIntervalMs(20)).toBe(CADENCE_MS.urgent);
    expect(crawlIntervalMs(null)).toBe(IDLE_MS);
  });
});

/**
 * Publish windows, the part of the cadence policy that keeps a monthly release
 * from costing 40,000 requests a month.
 */
describe('publish windows', () => {
  // 09:30 WAT on Wednesday 15 April 2026 is 08:30 UTC.
  const inside = new Date('2026-04-15T08:30:00Z');
  const night = new Date('2026-04-15T22:30:00Z');

  it('has no opinion when a source carries no window', () => {
    expect(inPublishWindow(null, inside)).toBeUndefined();
    expect(inPublishWindow('  ', inside)).toBeUndefined();
  });

  it('reads a plain time range in Lagos time', () => {
    expect(inPublishWindow('08:00-11:00', inside)).toBe(true);
    expect(inPublishWindow('08:00-11:00', night)).toBe(false);
  });

  it('honours weekdays', () => {
    expect(inPublishWindow('mon-fri 08:00-11:00', inside)).toBe(true);
    // Sunday 19 April, same clock time.
    expect(inPublishWindow('mon-fri 08:00-11:00', new Date('2026-04-19T08:30:00Z'))).toBe(false);
    expect(inPublishWindow('wed,sat 08:00-11:00', inside)).toBe(true);
  });

  it('honours a day-of-month range, which is how a monthly release is written', () => {
    expect(inPublishWindow('d14-18 08:00-15:00', inside)).toBe(true);
    expect(inPublishWindow('d1-5 08:00-15:00', inside)).toBe(false);
    expect(inPublishWindow('d15 08:00-15:00', inside)).toBe(true);
  });

  it('handles a window that wraps midnight', () => {
    expect(inPublishWindow('22:00-02:00', night)).toBe(true);
    expect(inPublishWindow('22:00-02:00', inside)).toBe(false);
  });

  it('treats a typo as no window rather than as a source that never polls', () => {
    expect(inPublishWindow('evenings', inside)).toBeUndefined();
    expect(inPublishWindow('mon-fri', inside)).toBeUndefined();
    expect(inPublishWindow('nonsense 08:00-11:00', inside)).toBeUndefined();
  });
});
