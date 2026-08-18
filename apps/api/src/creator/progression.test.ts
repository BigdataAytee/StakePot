import { describe, expect, it } from 'vitest';

import {
  cleanRate,
  earnedLevel,
  nextLevel,
  privilegesFor,
  progressToNext,
  settledCount,
  type CreatorRecord,
  type LadderRules,
} from './progression';

const RULES: LadderRules = {
  level2CleanResolutions: 5,
  level3CleanResolutions: 20,
  level3VolumeSpc: 5_000_000,
  level3CleanRate: 0.9,
  maxLiveMarkets: { 1: 2, 2: 10, 3: 25 },
  bondMultiplier: { 1: 1, 2: 0.5, 3: 0.25 },
  creatorBps: { 1: 400, 2: 400, 3: 450 },
  demotionEnabled: true,
};

const EMPTY: CreatorRecord = {
  cleanResolutions: 0,
  disputedResolutions: 0,
  voidedAfterActivation: 0,
  volumeHosted: 0,
};

describe('progression ladder', () => {
  it('starts everybody at level 1', () => {
    expect(earnedLevel(EMPTY, RULES)).toBe(1);
    expect(privilegesFor(1, RULES).maxLiveMarkets).toBe(2);
    expect(privilegesFor(1, RULES).badge).toBeNull();
  });

  it('has no clean rate before anything has settled', () => {
    // A brand-new account must not read as the cleanest record on the platform.
    expect(cleanRate(EMPTY)).toBeNull();
    expect(settledCount(EMPTY)).toBe(0);
  });

  it('promotes to level 2 on the fifth clean resolution', () => {
    expect(earnedLevel({ ...EMPTY, cleanResolutions: 4 }, RULES)).toBe(1);
    expect(earnedLevel({ ...EMPTY, cleanResolutions: 5 }, RULES)).toBe(2);
  });

  it('halves the bond and lifts the market cap at level 2', () => {
    const privileges = privilegesFor(2, RULES);
    expect(privileges.bondMultiplier).toBe(0.5);
    expect(privileges.maxLiveMarkets).toBe(10);
    expect(privileges.autoApproveTemplateStandard).toBe(true);
    expect(privileges.badge).toBe('Verified');
  });

  it('needs volume and a clean rate as well as count for level 3', () => {
    const counted: CreatorRecord = { ...EMPTY, cleanResolutions: 20, volumeHosted: 5_000_000 };
    expect(earnedLevel(counted, RULES)).toBe(3);

    // Same count, not enough volume.
    expect(earnedLevel({ ...counted, volumeHosted: 4_999_999 }, RULES)).toBe(2);

    // Same count and volume, but three disputes drop the rate to 0.87.
    expect(earnedLevel({ ...counted, disputedResolutions: 3 }, RULES)).toBe(2);
  });

  it('gives level 3 the fee bump §2.14c promises', () => {
    expect(privilegesFor(2, RULES).creatorBps).toBe(400);
    expect(privilegesFor(3, RULES).creatorBps).toBe(450);
    expect(privilegesFor(3, RULES).featuredPlacement).toBe(true);
    expect(privilegesFor(3, RULES).customSyndicateSplits).toBe(true);
  });

  it('counts a post-activation void against the record', () => {
    const record: CreatorRecord = { ...EMPTY, cleanResolutions: 9, voidedAfterActivation: 1 };
    expect(cleanRate(record)).toBe(0.9);
    expect(settledCount(record)).toBe(10);
  });

  it('drops a level when the record stops supporting it', () => {
    const fallen: CreatorRecord = {
      cleanResolutions: 20,
      disputedResolutions: 5,
      voidedAfterActivation: 0,
      volumeHosted: 9_000_000,
    };
    expect(nextLevel(3, fallen, RULES)).toBe(2);
  });

  it('keeps a level that was earned when demotion is switched off', () => {
    const fallen: CreatorRecord = {
      cleanResolutions: 20,
      disputedResolutions: 5,
      voidedAfterActivation: 0,
      volumeHosted: 9_000_000,
    };
    expect(nextLevel(3, fallen, { ...RULES, demotionEnabled: false })).toBe(3);
  });

  it('still promotes with demotion off', () => {
    expect(
      nextLevel(1, { ...EMPTY, cleanResolutions: 5 }, { ...RULES, demotionEnabled: false }),
    ).toBe(2);
  });

  it('says exactly what is missing before the next level', () => {
    const progress = progressToNext({ ...EMPTY, cleanResolutions: 2 }, RULES);
    expect(progress?.target).toBe(2);
    expect(progress?.requirements).toEqual([
      { label: 'clean resolutions', have: 2, need: 5, met: false },
    ]);
  });

  it('has nothing above Pro', () => {
    expect(
      progressToNext({ ...EMPTY, cleanResolutions: 20, volumeHosted: 5_000_000 }, RULES),
    ).toBeNull();
  });
});
