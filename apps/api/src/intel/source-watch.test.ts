import { describe, expect, it } from 'vitest';

import { sourceWatchOf, thresholdOf } from './source-watch';

/**
 * The threshold parse, and the cases where it should give up.
 *
 * Giving up is most of the value here: a wrong level drawn as a dashed line on
 * a price chart is a claim about where the market settles, made confidently, on
 * a screen people trade from.
 */
describe('recovering the threshold from a question', () => {
  it('reads a currency level and which way the market asks', () => {
    expect(thresholdOf('Will the naira close below ₦1,500/$ this month?')).toEqual({
      label: '₦1,500',
      value: 1500,
      direction: 'below',
    });
  });

  it('reads a percentage', () => {
    expect(thresholdOf('Will year-on-year headline CPI print below 24.0% for August?')).toEqual({
      label: '24.0%',
      value: 24,
      direction: 'below',
    });
  });

  it('reads the other direction', () => {
    expect(thresholdOf('Will reserves close above $40bn?')?.direction).toBe('above');
  });

  it('gives up on a question with no level', () => {
    expect(thresholdOf('Will the naira strengthen this month?')).toBeNull();
  });

  it('gives up on a level with no direction', () => {
    // "₦1,500" appearing in a question is not a threshold: "Will the CBN
    // publish the ₦1,500 note this year" has a number and no line to draw.
    expect(thresholdOf('Will the CBN issue a ₦1,500 note this year?')).toBeNull();
  });

  it('gives up on a market that is not about a number at all', () => {
    expect(thresholdOf('Who will INEC declare winner of the Surulere chairmanship?')).toBeNull();
  });
});

describe('the source watch strip', () => {
  const published = (value: string | number) => ({
    value,
    publishedAt: new Date('2026-08-20T14:02:00.000Z'),
  });

  it('puts the latest figure beside the level', () => {
    const watch = sourceWatchOf({
      sourceName: 'CBN',
      question: 'Will the naira close below ₦1,500/$ this month?',
      latest: published('₦1,532'),
    });

    expect(watch.latest).toBe('₦1,532');
  });

  it('gives a bare published number the same unit as the level', () => {
    // A source publishes 1532.41 and the market says "below ₦1,500". Shown as
    // "Latest 1532.41 · Settles below ₦1,500" it is the same quantity written
    // two ways, on a strip whose whole job is the comparison.
    const watch = sourceWatchOf({
      sourceName: 'CBN',
      question: 'Will the naira close below ₦1,500/$ this month?',
      latest: published(1532.41),
    });
    expect(watch.latest).toBe('₦1,532.41');
  });

  it('leaves a percentage as a percentage', () => {
    const watch = sourceWatchOf({
      sourceName: 'NBS',
      question: 'Will year-on-year headline CPI print below 24.0%?',
      latest: published(23.4),
    });
    expect(watch.latest).toBe('23.4%');
  });

  it('does not restyle a figure the source formatted itself', () => {
    // It knows what it published better than this does.
    const watch = sourceWatchOf({
      sourceName: 'CBN',
      question: 'Will the naira close below ₦1,500/$ this month?',
      latest: published('₦1,532.41 (official window)'),
    });
    expect(watch.latest).toBe('₦1,532.41 (official window)');
    expect(watch.threshold?.label).toBe('₦1,500');
    expect(watch.checkedAt).toBe('2026-08-20T14:02:00.000Z');
    // 1,532 is not below 1,500 — as of this reading, the market settles No.
    expect(watch.meetsThreshold).toBe(false);
  });

  it('says so when the source has published nothing', () => {
    const watch = sourceWatchOf({
      sourceName: 'CBN',
      question: 'Will the naira close below ₦1,500/$ this month?',
      latest: null,
    });
    expect(watch.latest).toBeNull();
    expect(watch.meetsThreshold).toBeNull();
    // The threshold still renders: the reader is owed the level even before
    // anybody has published a figure to compare it against.
    expect(watch.threshold?.value).toBe(1500);
  });

  it('draws no line when the question has no level in it', () => {
    const watch = sourceWatchOf({
      sourceName: 'CAF',
      question: 'Will the Super Eagles beat Ghana in the next qualifier?',
      latest: null,
    });
    expect(watch.threshold).toBeNull();
    expect(watch.meetsThreshold).toBeNull();
  });
});
