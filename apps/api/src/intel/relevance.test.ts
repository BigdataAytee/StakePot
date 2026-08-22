import { describe, expect, it } from 'vitest';

import {
  ANNOTATION_FLOOR,
  CLUSTER_THRESHOLD,
  cluster,
  detectConflicts,
  entitiesOf,
  RELEVANCE_FLOOR,
  relevanceOf,
  terms,
} from './relevance';

/**
 * The cheap filter the whole pipeline stands on.
 *
 * Every item from every source is scored against every live market, so this
 * runs thousands of times an hour and has to be both fast and roughly right.
 * These tests are about "roughly right": the naira story reaches the naira
 * market, the football story does not, and forty papers running one wire story
 * arrive as one line.
 */
const nairaMarket = {
  question: 'Will the naira close below ₦1,500/$ on the official window this month?',
  criteria: [
    'The CBN official window closing rate on the last business day is below ₦1,500/$.',
    'That rate is ₦1,500/$ or above.',
  ],
  sourceName: 'CBN',
};

describe('relevance', () => {
  it('scores a story about the market above the floor', () => {
    const score = relevanceOf(
      { headline: 'Naira closes at ₦1,532/$ on the CBN official window', sourceName: 'A paper' },
      nairaMarket,
    );
    expect(score).toBeGreaterThan(RELEVANCE_FLOOR);
  });

  it('leaves an unrelated story below it', () => {
    const score = relevanceOf(
      { headline: 'Super Eagles name squad for the next qualifier', sourceName: 'A paper' },
      nairaMarket,
    );
    expect(score).toBeLessThan(RELEVANCE_FLOOR);
  });

  it('ranks a story sharing several terms above one sharing a single acronym', () => {
    // The ordering an earlier scorer got backwards. Dividing by the item's own
    // length rewards short headlines: "CBN announces new cash withdrawal
    // limits" shares one term with this market and outscored a story that
    // shared three, because one out of five beats three out of seven.
    const direct = relevanceOf(
      {
        headline: 'Naira closes at ₦1,498/$ on the official window, traders say',
        sourceName: 'A paper',
      },
      nairaMarket,
    );
    const glancing = relevanceOf(
      { headline: 'CBN announces new cash withdrawal limits', sourceName: 'A paper' },
      nairaMarket,
    );
    expect(direct).toBeGreaterThan(glancing);
  });

  it('finds an acronym in a sentence that starts with a determiner', () => {
    // The entity regex is greedy, so a criteria line beginning "The CBN
    // official window…" yields the phrase "The CBN" — which never matched a
    // headline's bare "CBN". Every entity comparison against a sentence
    // starting with a determiner scored zero, silently.
    const score = relevanceOf(
      {
        headline: 'CBN resumes dollar sales to bureaux de change operators',
        sourceName: 'A paper',
      },
      nairaMarket,
    );
    expect(score).toBeGreaterThan(RELEVANCE_FLOOR);
  });

  it('ranks the market’s own named source above a newspaper saying the same thing', () => {
    const headline = 'Official window closes at ₦1,532/$';
    const fromCbn = relevanceOf({ headline, sourceName: 'CBN' }, nairaMarket);
    const fromPaper = relevanceOf({ headline, sourceName: 'A paper' }, nairaMarket);
    expect(fromCbn).toBeGreaterThan(fromPaper);
  });

  it('treats a direct hit as significant enough to mark on the chart', () => {
    const score = relevanceOf(
      {
        headline: 'CBN official window closing rate ₦1,532/$ for the last business day',
        sourceName: 'CBN',
      },
      nairaMarket,
    );
    expect(score).toBeGreaterThan(ANNOTATION_FLOOR);
  });
});

describe('what counts as a term and an entity', () => {
  it('keeps figures and currency, drops the words every headline has', () => {
    const found = terms('The CBN said the naira will be at ₦1,500 after the announcement');
    expect(found.has('cbn')).toBe(true);
    expect(found.has('₦1,500'.toLowerCase()) || found.has('1500') || found.has('₦1')).toBe(true);
    expect(found.has('the')).toBe(false);
    expect(found.has('will')).toBe(false);
  });

  it('picks out names and figures rather than verbs', () => {
    const found = entitiesOf('Osimhen scores as Nigeria beat Ghana 2-1');
    expect(found.has('osimhen')).toBe(true);
    expect(found.has('scores')).toBe(false);
  });
});

describe('clustering', () => {
  const at = (minutes: number): Date => new Date(Date.UTC(2026, 7, 20, 9, minutes));

  it('folds the same story from forty newsrooms into one line', () => {
    // A context panel that lists one wire story forty times buries everything
    // else under the loudest story of the day.
    const wire = Array.from({ length: 40 }, (_, index) => ({
      id: `item-${index}`,
      headline: 'CBN resumes dollar sales to bureaux de change operators',
      publishedAt: at(index),
    }));

    const clusters = cluster(wire);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.sourceCount).toBe(40);
  });

  it('keeps the earliest headline as the cluster’s own', () => {
    const clusters = cluster([
      { id: 'late', headline: 'CBN resumes dollar sales to BDCs', publishedAt: at(30) },
      { id: 'first', headline: 'CBN resumes dollar sales to BDCs today', publishedAt: at(1) },
    ]);
    expect(clusters[0]?.id).toBe('first');
  });

  it('leaves two different stories apart', () => {
    const clusters = cluster([
      { id: 'a', headline: 'CBN resumes dollar sales to bureaux de change', publishedAt: at(1) },
      { id: 'b', headline: 'Super Eagles name squad for the qualifier', publishedAt: at(2) },
    ]);
    expect(clusters).toHaveLength(2);
  });

  it('has a threshold somewhere sane', () => {
    expect(CLUSTER_THRESHOLD).toBeGreaterThan(0.3);
    expect(CLUSTER_THRESHOLD).toBeLessThan(0.8);
  });
});

describe('conflicts', () => {
  it('flags two sources publishing different figures', () => {
    const conflicts = detectConflicts([
      { factKey: 'naira.official.close', sourceName: 'CBN', tier: 'resolution', value: 1532 },
      { factKey: 'naira.official.close', sourceName: 'A paper', tier: 'news', value: 1498 },
    ]);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.claims).toHaveLength(2);
  });

  it('never reconciles them', () => {
    // The average of a published 1,532 and a published 1,498 is a number
    // nobody published, and no market could defensibly settle on it.
    const conflicts = detectConflicts([
      { factKey: 'naira.official.close', sourceName: 'CBN', tier: 'resolution', value: 1532 },
      { factKey: 'naira.official.close', sourceName: 'A paper', tier: 'news', value: 1498 },
    ]);
    const values = conflicts[0]?.claims.map((claim) => claim.value);
    expect(values).toEqual([1532, 1498]);
  });

  it('does not raise one over formatting', () => {
    // "23.4%" and "23.40%" are the same claim typed differently, and a
    // conflict raised on that would teach everybody to skip the list.
    const conflicts = detectConflicts([
      { factKey: 'cpi.yoy', sourceName: 'NBS', tier: 'resolution', value: '23.4%' },
      { factKey: 'cpi.yoy', sourceName: 'A paper', tier: 'news', value: '23.40%' },
    ]);
    expect(conflicts).toEqual([]);
  });

  it('says nothing when only one source has spoken', () => {
    const conflicts = detectConflicts([
      { factKey: 'cpi.yoy', sourceName: 'NBS', tier: 'resolution', value: 23.4 },
    ]);
    expect(conflicts).toEqual([]);
  });

  it('compares statements as well as numbers', () => {
    const conflicts = detectConflicts([
      { factKey: 'mpc.decision', sourceName: 'CBN', tier: 'resolution', value: 'hold' },
      { factKey: 'mpc.decision', sourceName: 'A paper', tier: 'news', value: 'cut' },
    ]);
    expect(conflicts).toHaveLength(1);
  });
});
