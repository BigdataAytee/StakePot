import { describe, expect, it } from 'vitest';

import {
  CATALOGUE_SLOT_NAMES,
  OFFICIAL_SHELF_SIZE,
  balanceQuality,
  draftScore,
  duplicateOf,
  isCatalogueSlot,
  questionSimilarity,
  withinBalanceBand,
} from './draft-ranking';

/**
 * §2.9's rules, tested without an API key — which is the point of having them
 * as code rather than as prose in a system prompt.
 */
describe('balance', () => {
  it('scores an even split highest and a certainty lowest', () => {
    expect(balanceQuality([0.5, 0.5])).toBe(1);
    expect(balanceQuality([1, 0])).toBe(0);
    expect(balanceQuality([0.25, 0.25, 0.25, 0.25])).toBe(1);
  });

  it('treats the edge of the acceptable band as a real but modest penalty', () => {
    // 65/35 is the edge of §2.9's band. It should score clearly below an even
    // split without being scored as if it were a dead market.
    const edge = balanceQuality([0.65, 0.35]);
    expect(edge).toBeGreaterThan(0.65);
    expect(edge).toBeLessThan(0.75);
    expect(balanceQuality([0.9, 0.1])).toBeLessThan(edge);
  });

  it('normalises estimates that do not sum to 1', () => {
    expect(balanceQuality([50, 50])).toBe(1);
    expect(balanceQuality([2, 1, 1])).toBeCloseTo(balanceQuality([0.5, 0.25, 0.25]), 10);
  });

  const bounds = { binaryLow: 0.35, binaryHigh: 0.65, multiMax: 0.6 };

  it('gates binary questions on the band and multi-outcome on the leader', () => {
    expect(withinBalanceBand([0.5, 0.5], bounds)).toBe(true);
    expect(withinBalanceBand([0.35, 0.65], bounds)).toBe(true);
    expect(withinBalanceBand([0.34, 0.66], bounds)).toBe(false);
    expect(withinBalanceBand([0.8, 0.2], bounds)).toBe(false);

    expect(withinBalanceBand([0.4, 0.3, 0.3], bounds)).toBe(true);
    // A 4-way race with a 70% favourite is not an argument.
    expect(withinBalanceBand([0.7, 0.1, 0.1, 0.1], bounds)).toBe(false);
  });

  it('ranks a balanced question on a big topic above a lopsided one', () => {
    const balancedBigTopic = draftScore({ engagement: 0.8, estimates: [0.52, 0.48] });
    const lopsidedBigTopic = draftScore({ engagement: 0.95, estimates: [0.9, 0.1] });
    const balancedNiche = draftScore({ engagement: 0.3, estimates: [0.5, 0.5] });

    expect(balancedBigTopic).toBeGreaterThan(lopsidedBigTopic);
    expect(balancedBigTopic).toBeGreaterThan(balancedNiche);
    // A certainty earns nothing however big the topic.
    expect(draftScore({ engagement: 1, estimates: [1, 0] })).toBe(0);
  });
});

describe('catalogue discipline (§2.9 rule 8)', () => {
  it('has six slots, and knows which names are real', () => {
    expect(OFFICIAL_SHELF_SIZE).toBe(6);
    expect(CATALOGUE_SLOT_NAMES).toContain('economic_banker');
    expect(isCatalogueSlot('cost_of_living')).toBe(true);
    expect(isCatalogueSlot('crypto_moonshot')).toBe(false);
  });
});

describe('duplicate detection', () => {
  it('catches a restatement of a live market', () => {
    const live = [
      { id: 'm1', question: 'Will the naira close below ₦1,500 to the dollar on 30 June?' },
      { id: 'm2', question: 'Who wins the BBNaija final?' },
    ];

    const found = duplicateOf(
      'Will the naira close below ₦1,500 to the dollar by 30 June?',
      live,
      0.6,
    );
    expect(found?.id).toBe('m1');
    expect(found?.similarity).toBeGreaterThan(0.8);
  });

  it('lets a genuinely different question through', () => {
    const live = [{ id: 'm1', question: 'Will the naira close below ₦1,500 on 30 June?' }];
    expect(duplicateOf('Will Nigeria qualify from their AFCON group?', live, 0.6)).toBeNull();
    // Same subject, different threshold — a market people can hold both sides of.
    expect(duplicateOf('Will petrol sell below ₦900 a litre in Lagos?', live, 0.6)).toBeNull();
  });

  it('ignores the words every market question shares', () => {
    // Identical apart from stopwords would score 1; these share only "will/the".
    expect(
      questionSimilarity(
        'Will the Super Eagles win the AFCON final?',
        'Will the CBN hold the rate at the next meeting?',
      ),
    ).toBeLessThan(0.2);
  });
});
