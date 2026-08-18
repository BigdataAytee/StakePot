import { Controller, Get } from '@nestjs/common';

import { PlatformConfigService } from '../platform-config/platform-config.service';

/**
 * The handful of config values the logged-out front door has to state out loud.
 *
 * §7.6's landing page and §2.1's signup screen both quote the starter balance
 * and the verification bonus as the reason to sign up. §6.7 is emphatic that
 * "every tunable value in this document lives here as an editable setting —
 * never in code", and marketing copy is exactly where a hardcoded 5,000 would
 * survive the day finance changes the number. So the front door reads them the
 * same way every other screen does.
 *
 * Deliberately a whitelist rather than a dump of the config table: most of what
 * is in there (limits, thresholds, fee splits, abuse-rule parameters) is
 * operational detail an anonymous caller has no business enumerating.
 */
@Controller('config')
export class PublicConfigController {
  constructor(private readonly config: PlatformConfigService) {}

  @Get('public')
  async publicConfig() {
    const [starterBalance, signupBonus, exitFeeRate] = await Promise.all([
      this.config.get('starter_balance_spc'),
      this.config.get('signup_bonus_spc'),
      this.config.get('exit_fee_rate'),
    ]);

    return {
      starterBalanceSpc: String(starterBalance),
      signupBonusSpc: String(signupBonus),
      /** As a rate (0.01), because §2.3 states it as a percentage of proceeds. */
      exitFeeRate,
    };
  }
}
