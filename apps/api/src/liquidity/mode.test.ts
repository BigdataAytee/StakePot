import { describe, expect, it } from 'vitest';

import { LiquidityModeError, LiquidityModeService } from './mode.service';
import type { FlagsService } from '../flags/flags.service';
import type { PlatformConfigService } from '../platform-config/platform-config.service';

/**
 * LIVE mode is unreachable without both switches.
 *
 * The test worth having is not "LIVE works when it is on" — it is the truth
 * table, all four rows, because the failure that matters is one switch left on
 * being mistaken for permission. Three of the four rows must refuse.
 */
function service(configOn: boolean, flagOn: boolean): LiquidityModeService {
  return new LiquidityModeService(
    { get: async () => configOn } as unknown as PlatformConfigService,
    { on: async () => flagOn } as unknown as FlagsService,
  );
}

describe('the LIVE-mode guard', () => {
  const rows: readonly [boolean, boolean, boolean][] = [
    // config, flag, live available
    [false, false, false],
    [true, false, false],
    [false, true, false],
    [true, true, true],
  ];

  it('needs the config key and the feature flag, both', async () => {
    for (const [configOn, flagOn, expected] of rows) {
      const state = await service(configOn, flagOn).state('live');
      expect(
        state.liveAvailable,
        `config=${configOn} flag=${flagOn} should be ${expected ? 'available' : 'refused'}`,
      ).toBe(expected);
      expect(state.mode).toBe(expected ? 'live' : 'test');
    }
  });

  it('defaults to TEST when nothing is requested, even with both switches on', async () => {
    // Availability is not selection. A request with no mode field must not
    // arrive in LIVE because the platform happens to be licensed that week.
    const state = await service(true, true).state();
    expect(state.mode).toBe('test');
  });

  it('throws rather than quietly downgrading a LIVE request', async () => {
    // The dangerous alternative: the caller asked for real money, was given
    // points, and was told it worked.
    await expect(service(true, false).resolve('live')).rejects.toThrow(LiquidityModeError);
    await expect(service(false, true).resolve('live')).rejects.toThrow(LiquidityModeError);
    await expect(service(false, false).resolve('live')).rejects.toThrow(LiquidityModeError);
    await expect(service(true, true).resolve('live')).resolves.toBe('live');
  });

  it('names the switch that is off, so nobody has to read the code', async () => {
    const bothOff = await service(false, false).state();
    expect(bothOff.why).toContain('liquidity_live_enabled');
    expect(bothOff.why).toContain('liquidity-live');

    const flagOff = await service(true, false).state();
    expect(flagOff.why).toContain('liquidity-live');
    expect(flagOff.why).not.toContain('liquidity_live_enabled');
  });

  it('lets a TEST request through whatever the switches say', async () => {
    for (const [configOn, flagOn] of rows) {
      await expect(service(configOn, flagOn).resolve('test')).resolves.toBe('test');
      await expect(service(configOn, flagOn).resolve(undefined)).resolves.toBe('test');
    }
  });
});
