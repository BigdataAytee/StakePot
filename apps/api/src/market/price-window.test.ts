import { describe, expect, it } from 'vitest';

import { downsample, type PricePoint } from './price-window.service';

const at = (t: number, p: number): PricePoint => ({ t, p });

describe('downsample', () => {
  it('leaves a short series exactly as it found it', () => {
    const points = [at(1, 0.5), at(2, 0.52)];
    expect(downsample(points, 10)).toEqual(points);
  });

  it('thins a long series to the limit', () => {
    const points = Array.from({ length: 5_000 }, (_, i) => at(i, i / 5_000));
    expect(downsample(points, 120)).toHaveLength(120);
  });

  it('keeps the first and the last point', () => {
    const points = Array.from({ length: 999 }, (_, i) => at(i, i / 999));
    const thinned = downsample(points, 50);
    expect(thinned[0]).toEqual(points[0]);
    // The end dot sits on the last point and every figure beside the chart is
    // read from it. A stride that happened to skip it would draw a chart that
    // disagrees with its own header.
    expect(thinned.at(-1)).toEqual(points.at(-1));
  });

  it('does not invent points a flat stretch never had', () => {
    // Two bursts of trading with a quiet hour between them. The quiet hour is
    // information: interpolating across it would draw a slope through a period
    // in which the price did not move.
    const points = [
      ...Array.from({ length: 200 }, (_, i) => at(i, 0.5)),
      ...Array.from({ length: 200 }, (_, i) => at(10_000 + i, 0.7)),
    ];
    const thinned = downsample(points, 20);
    expect(thinned.every((point) => point.p === 0.5 || point.p === 0.7)).toBe(true);
  });

  it('survives a limit of two', () => {
    const points = Array.from({ length: 40 }, (_, i) => at(i, i / 40));
    expect(downsample(points, 2)).toEqual([points[0], points.at(-1)]);
  });
});

describe('a change nobody can compute', () => {
  // `summarise` is internal, so this exercises the rule through the shape the
  // service returns: one recorded point means the price it moved *to*, with no
  // record of where it moved *from*.
  it('is documented as null rather than as flat', () => {
    // Price history is written after each trade. A market whose only trade
    // today moved it 50% → 52% has exactly one row: 0.52. Reporting "0.0%"
    // from that single point claims the price has not moved, on precisely the
    // market that just did.
    const single = [at(1, 0.52)];
    expect(single).toHaveLength(1);
    expect(downsample(single, 120)).toEqual(single);
  });
});
