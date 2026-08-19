import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { flagOn, type FlagState } from './rollout';

/**
 * §2.13's feature-flag gating, and §6.8's console behind it.
 *
 * The reason this exists is deployment safety rather than product
 * experimentation: the CI/CD gap in the matrix was "no canary or feature-flag
 * gating", meaning every change was all-or-nothing at deploy time and the only
 * way back was a revert. A flag turns a bad release into a checkbox.
 *
 * Reads are cached for a few seconds. A flag is checked on hot paths and the
 * table is tiny and rarely written, so a per-request query would be a
 * self-inflicted load problem; a few seconds of staleness on a rollout
 * percentage costs nothing, while a kill switch that takes five seconds is
 * still four minutes faster than a deploy.
 */
const CACHE_MS = 5_000;

@Injectable()
export class FlagsService {
  private cache: { at: number; flags: Map<string, FlagState> } | null = null;

  constructor(private readonly prisma: PrismaService) {}

  /** Whether a flag is on for one account. Unknown flags are off. */
  async on(key: string, subject: string | null): Promise<boolean> {
    const state = (await this.states()).get(key);
    // An unknown key is off, never on. A typo in a flag name must fail closed —
    // the alternative is a half-finished feature going live because somebody
    // wrote `newCheckout` where the row says `new-checkout`.
    return state === undefined ? false : flagOn(state, subject);
  }

  /** Every flag's answer for one account, for the client to read once. */
  async allFor(subject: string | null): Promise<Record<string, boolean>> {
    const states = await this.states();
    return Object.fromEntries([...states].map(([key, state]) => [key, flagOn(state, subject)]));
  }

  /** The console's view: the settings themselves, not one account's answers. */
  async list() {
    return this.prisma.featureFlag.findMany({ orderBy: { key: 'asc' } });
  }

  async upsert(input: {
    key: string;
    description: string;
    enabled: boolean;
    rolloutPct: number;
    allowList: string[];
    staffId: string;
  }) {
    const rolloutPct = Math.min(100, Math.max(0, Math.round(input.rolloutPct)));
    const data = {
      description: input.description,
      enabled: input.enabled,
      rolloutPct,
      allowList: input.allowList,
      updatedBy: input.staffId,
    };

    const flag = await this.prisma.featureFlag.upsert({
      where: { key: input.key },
      create: { key: input.key, ...data },
      update: data,
    });

    // The console's whole point is speed under pressure. Waiting five seconds
    // to see a kill switch take effect would make an operator press it twice.
    this.cache = null;
    return flag;
  }

  private async states(): Promise<Map<string, FlagState>> {
    const now = Date.now();
    if (this.cache !== null && now - this.cache.at < CACHE_MS) return this.cache.flags;

    const rows = await this.prisma.featureFlag.findMany();
    const flags = new Map(
      rows.map((row) => [
        row.key,
        {
          key: row.key,
          enabled: row.enabled,
          rolloutPct: row.rolloutPct,
          allowList: row.allowList,
        } satisfies FlagState,
      ]),
    );

    this.cache = { at: now, flags };
    return flags;
  }
}
