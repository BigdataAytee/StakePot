import { Injectable } from '@nestjs/common';
import type { LiquidityMode } from '@prisma/client';

import { FlagsService } from '../flags/flags.service';
import { PlatformConfigService } from '../platform-config/platform-config.service';

/**
 * The flag name guarding real money.
 *
 * Exported so the console, the tests and the service all name the same string.
 * A flag checked by a literal in three places is a flag that is on in two of
 * them after somebody renames it.
 */
export const LIQUIDITY_LIVE_FLAG = 'liquidity-live';

export class LiquidityModeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LiquidityModeError';
  }
}

export interface ModeState {
  readonly mode: LiquidityMode;
  /** Whether LIVE could be selected at all, and if not, exactly what is missing. */
  readonly liveAvailable: boolean;
  readonly flagOn: boolean;
  readonly configOn: boolean;
  /** The sentence the banner shows. Written here so every surface says the same one. */
  readonly why: string;
}

/**
 * TEST or LIVE, and why LIVE is not available.
 *
 * **Two independent switches, both required.** The `liquidity-live` feature
 * flag and the `liquidity_live_enabled` config key must *both* be true before
 * anything may run in LIVE mode. This is not belt and braces for its own sake:
 * they are operated by different mechanisms with different audiences — a flag is
 * a deploy-time control an engineer flips, a config key is a four-eyes change
 * with a 24-hour delay (§6.8). Requiring both means neither an engineer nor an
 * operator can put real money at risk alone, and a flag left on after a test
 * does nothing on its own.
 *
 * **It fails loudly.** `assertLive` throws with the specific missing switch
 * named. A guard that silently downgrades to TEST would be worse than no guard
 * at all: the operator would believe they had moved real money and the market
 * would believe they had not.
 *
 * The current mode is a *read* of these two switches, never a stored session
 * value. There is no "set the mode" that persists — a mode you can set is a
 * mode that can be left set.
 */
@Injectable()
export class LiquidityModeService {
  constructor(
    private readonly config: PlatformConfigService,
    private readonly flags: FlagsService,
  ) {}

  /** What the section header shows, and what the banner explains. */
  async state(requested?: LiquidityMode): Promise<ModeState> {
    const [configOn, flagOn] = await Promise.all([
      this.config.get('liquidity_live_enabled').then((value) => value === true),
      this.flags.on(LIQUIDITY_LIVE_FLAG, null),
    ]);

    const liveAvailable = configOn && flagOn;
    // TEST unless LIVE was asked for *and* is genuinely available. Defaulting
    // the other way is how a tool ends up spending naira because a request
    // arrived without the field.
    const mode: LiquidityMode = requested === 'live' && liveAvailable ? 'live' : 'test';

    return { mode, liveAvailable, flagOn, configOn, why: explain(configOn, flagOn) };
  }

  /**
   * Refuse unless LIVE is genuinely available.
   *
   * Called before anything that would move real money. The message names the
   * switch that is off, because "not available" sends somebody to read code.
   */
  async assertLive(): Promise<void> {
    const state = await this.state('live');
    if (state.mode !== 'live') throw new LiquidityModeError(state.why);
  }

  /**
   * Resolve the mode an action will run in, refusing an impossible request.
   *
   * Asking for LIVE when LIVE is off throws rather than quietly running in
   * TEST — the caller asked for real money and must not be told "done".
   */
  async resolve(requested: LiquidityMode | undefined): Promise<LiquidityMode> {
    if (requested !== 'live') return 'test';
    await this.assertLive();
    return 'live';
  }
}

function explain(configOn: boolean, flagOn: boolean): string {
  if (configOn && flagOn) return 'Live mode is available. Actions here move real money.';
  const missing = [
    configOn ? null : 'the `liquidity_live_enabled` config key is off',
    flagOn ? null : 'the `liquidity-live` feature flag is off',
  ].filter((item): item is string => item !== null);
  return (
    'Live mode is off until licensing — ' +
    missing.join(' and ') +
    '. Both have to be on, and the config key is a four-eyes change with a delay. ' +
    'Everything below runs in points and has no real value.'
  );
}
