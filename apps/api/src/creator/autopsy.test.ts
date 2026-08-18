import { describe, expect, it } from 'vitest';

import { autopsyFor, DEFAULT_AUTOPSY_RULES, type AutopsyFacts } from './autopsy';

const RESOLVED: AutopsyFacts = {
  kind: 'resolved',
  question: 'Will petrol pass ₦1,000 before December?',
  volume: 500_000,
  distinctStakers: 60,
  views: 900,
  finalSplit: 0.55,
  disputed: false,
  activationPath: 'organic',
  voidReason: null,
  creatorFeeEarned: 9_000,
};

describe('market autopsy', () => {
  it('has nothing to fix about a balanced, well-staked, clean settle', () => {
    const autopsy = autopsyFor(RESOLVED, DEFAULT_AUTOPSY_RULES);
    expect(autopsy.tip).toBeNull();
    expect(autopsy.signals.balanced).toBe(true);
    expect(autopsy.worked.length).toBeGreaterThan(0);
    expect(autopsy.summary).toContain('cleanly');
  });

  it('names the creator fee among what worked', () => {
    expect(autopsyFor(RESOLVED, DEFAULT_AUTOPSY_RULES).worked.join(' ')).toContain('9,000');
  });

  it('tells a lopsided market to move the threshold', () => {
    const autopsy = autopsyFor({ ...RESOLVED, finalSplit: 0.93 }, DEFAULT_AUTOPSY_RULES);
    expect(autopsy.signals.lopsided).toBe(true);
    expect(autopsy.tip).toContain('threshold');
  });

  it('blames the criteria when a market was disputed', () => {
    const autopsy = autopsyFor({ ...RESOLVED, disputed: true }, DEFAULT_AUTOPSY_RULES);
    expect(autopsy.tip).toContain('criteria');
    expect(autopsy.summary).toContain('after a dispute');
    expect(autopsy.worked.join(' ')).not.toContain('clean resolution');
  });

  it('sends a failed organic market to the seed path', () => {
    const autopsy = autopsyFor(
      {
        ...RESOLVED,
        kind: 'voided',
        finalSplit: null,
        voidReason: 'the funding window closed under the floor',
        volume: 20_000,
        distinctStakers: 3,
      },
      DEFAULT_AUTOPSY_RULES,
    );
    expect(autopsy.tip).toContain('symmetric seed');
    expect(autopsy.summary).toContain('every naira went back');
  });

  it('reminds a failed seeded market that the floor counts people', () => {
    const autopsy = autopsyFor(
      {
        ...RESOLVED,
        kind: 'voided',
        finalSplit: null,
        activationPath: 'seeded',
        voidReason: 'the participation floor was not met',
        distinctStakers: 2,
      },
      DEFAULT_AUTOPSY_RULES,
    );
    expect(autopsy.tip).toContain('liquidity, not interest');
  });

  it('separates a reach problem from a criteria problem', () => {
    const thin = autopsyFor({ ...RESOLVED, distinctStakers: 4, views: 30 }, DEFAULT_AUTOPSY_RULES);
    expect(thin.signals.thin).toBe(true);
    expect(thin.tip).toContain('reach');

    const unclear = autopsyFor(
      { ...RESOLVED, distinctStakers: 12, views: 600 },
      DEFAULT_AUTOPSY_RULES,
    );
    expect(unclear.signals.poorConversion).toBe(true);
    expect(unclear.tip).toContain('criteria');
  });

  it('gives exactly one tip, never a list', () => {
    // Lopsided, thin and disputed all at once — a creator handed three things
    // to fix fixes none of them, so the worst one wins.
    const autopsy = autopsyFor(
      { ...RESOLVED, finalSplit: 0.97, distinctStakers: 2, disputed: true },
      DEFAULT_AUTOPSY_RULES,
    );
    expect(typeof autopsy.tip).toBe('string');
    expect(autopsy.tip).toContain('criteria');
  });
});
