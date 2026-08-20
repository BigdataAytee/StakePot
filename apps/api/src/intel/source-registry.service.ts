import { Injectable } from '@nestjs/common';
import { Prisma, type Source, type SourceKind, type SourceTier } from '@prisma/client';
import { maySettle, trustOf, TIERS } from '@stakeam/rules';

import { AdminAuditService } from '../audit/admin-audit.service';
import { PrismaService } from '../prisma/prisma.service';

export class SourceRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceRegistryError';
  }
}

export interface SourceInput {
  readonly tier: SourceTier;
  readonly kind: SourceKind;
  readonly name: string;
  readonly homeUrl: string;
  readonly feedUrl?: string;
  readonly categories?: readonly string[];
  readonly region?: string;
  readonly language?: string;
  readonly politenessMs?: number;
}

/**
 * The source registry: who we read, how often, and what they are allowed to say.
 *
 * Built to hold thousands of feeds, which is why almost nothing here is
 * per-source configuration. The tier decides what a source may do, the trust
 * score is recomputed from its record rather than edited, and the crawl cadence
 * comes from the markets rather than from a field somebody sets. What is left
 * to configure is the small part that genuinely varies: where to fetch from,
 * and how politely.
 *
 * The one rule this class exists to make unbreakable: a market may only name a
 * tier-1 source, and only a tier-1 source may be cited in a resolution
 * dossier. Everything else is a preference.
 */
@Injectable()
export class SourceRegistryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AdminAuditService,
  ) {}

  /**
   * Add sources in bulk.
   *
   * Bulk because tier 2 is meant to reach the thousands, and a registry you
   * populate through a form one row at a time never gets populated. Upserts on
   * `(tier, homeUrl)` so re-importing a list is safe — the second import of a
   * curated CSV should not double every outlet in it.
   */
  async importSources(params: {
    sources: readonly SourceInput[];
    staffId: string;
    ip: string;
  }): Promise<{ added: number; updated: number }> {
    let added = 0;
    let updated = 0;

    for (const input of params.sources) {
      const home = normaliseUrl(input.homeUrl);
      if (home === null) {
        throw new SourceRegistryError(`"${input.homeUrl}" is not an https address`);
      }

      const existing = await this.prisma.source.findUnique({
        where: { tier_homeUrl: { tier: input.tier, homeUrl: home } },
      });

      const data = {
        tier: input.tier,
        kind: input.kind,
        name: input.name.trim(),
        homeUrl: home,
        feedUrl: input.feedUrl === undefined ? null : normaliseUrl(input.feedUrl),
        categories: [...(input.categories ?? [])],
        region: input.region ?? null,
        language: input.language ?? 'en',
        politenessMs: input.politenessMs ?? 2000,
        // Trust starts at the tier's own figure rather than at zero: a source
        // somebody deliberately added to tier 1 is trusted from its first
        // fetch, and one starting at zero would be demoted before it had done
        // anything.
        trust: new Prisma.Decimal(TIERS[input.tier].initialTrust),
      };

      if (existing === null) {
        await this.prisma.source.create({ data });
        added += 1;
      } else {
        // Trust and the conflict record survive a re-import. Otherwise the fix
        // for a demoted source is to import the list again, which is not a fix.
        const { trust: _trust, ...rest } = data;
        await this.prisma.source.update({ where: { id: existing.id }, data: rest });
        updated += 1;
      }
    }

    await this.audit.record({
      staffId: params.staffId,
      action: 'sources.import',
      targetRef: 'sources',
      after: { added, updated, count: params.sources.length },
      ip: params.ip,
    });

    return { added, updated };
  }

  /**
   * The kill switch, at whatever scope is needed.
   *
   * One source when a feed starts returning nonsense, a tier when a class of
   * them does, everything when the pipeline itself is the problem. All three
   * are the same operation because in the moment somebody needs one they
   * should not be learning which of three screens has it.
   */
  async setEnabled(params: {
    scope: { sourceId: string } | { tier: SourceTier } | 'all';
    enabled: boolean;
    reason: string;
    staffId: string;
    ip: string;
  }): Promise<{ affected: number }> {
    if (!params.enabled && params.reason.trim().length < 5) {
      throw new SourceRegistryError(
        'say why — a source switched off at 3am has to be explicable at 9',
      );
    }

    const where =
      params.scope === 'all'
        ? {}
        : 'sourceId' in params.scope
          ? { id: params.scope.sourceId }
          : { tier: params.scope.tier };

    const result = await this.prisma.source.updateMany({
      where,
      data: params.enabled
        ? { enabled: true, disabledAt: null, disabledBy: null, disabledReason: null }
        : {
            enabled: false,
            disabledAt: new Date(),
            disabledBy: params.staffId,
            disabledReason: params.reason.trim(),
          },
    });

    await this.audit.record({
      staffId: params.staffId,
      action: params.enabled ? 'sources.enable' : 'sources.kill',
      targetRef: params.scope === 'all' ? 'sources:all' : JSON.stringify(params.scope),
      after: { affected: result.count, reason: params.reason },
      ip: params.ip,
    });

    return { affected: result.count };
  }

  /**
   * Record that a source contradicted a tier-1 fact, and recompute its trust.
   *
   * The recompute is a read of the whole record rather than a decrement, so
   * the score can be rebuilt from the row at any time — the first question
   * about an automatic demotion is "why", and a number that was mutated
   * twenty times cannot answer it.
   */
  async recordConflict(sourceId: string): Promise<void> {
    const source = await this.prisma.source.findUnique({ where: { id: sourceId } });
    if (source === null) return;

    const conflicts = source.conflicts + 1;
    const verdict = trustOf({
      tier: source.tier,
      trust: Number(source.trust.toString()),
      conflicts,
      // A conflict resets the run of agreements: three good weeks followed by a
      // contradiction is not the same as a contradiction three weeks ago.
      corroborations: 0,
    });

    await this.prisma.source.update({
      where: { id: sourceId },
      data: {
        conflicts,
        corroborations: 0,
        trust: new Prisma.Decimal(verdict.trust),
        ...(verdict.demoted
          ? {
              enabled: false,
              disabledAt: new Date(),
              disabledBy: 'system',
              disabledReason: verdict.reason,
            }
          : {}),
      },
    });
  }

  /** The other direction: this source agreed with a tier-1 fact. */
  async recordCorroboration(sourceId: string): Promise<void> {
    const source = await this.prisma.source.findUnique({ where: { id: sourceId } });
    if (source === null) return;

    const corroborations = source.corroborations + 1;
    const verdict = trustOf({
      tier: source.tier,
      trust: Number(source.trust.toString()),
      conflicts: source.conflicts,
      corroborations,
    });

    await this.prisma.source.update({
      where: { id: sourceId },
      data: { corroborations, trust: new Prisma.Decimal(verdict.trust) },
    });
  }

  /**
   * The sources a market may be settled against.
   *
   * The guard, expressed once. Callers that need "can this URL be named on a
   * market" ask here rather than checking a tier themselves, so a fourth tier
   * added later cannot be forgotten in one of three places.
   */
  async settlingSources(): Promise<Source[]> {
    return this.prisma.source.findMany({
      where: { enabled: true, tier: { in: TIER_NAMES.filter(maySettle) } },
      orderBy: { name: 'asc' },
    });
  }

  /** Whether a market may name this source. Used by the Studio's wizard. */
  async maySettleAgainst(sourceUrl: string): Promise<boolean> {
    const home = normaliseUrl(sourceUrl);
    if (home === null) return false;
    const host = hostOf(home);
    if (host === null) return false;

    const candidates = await this.prisma.source.findMany({
      where: { enabled: true },
      select: { tier: true, homeUrl: true },
    });
    return candidates.some((source) => maySettle(source.tier) && hostOf(source.homeUrl) === host);
  }
}

const TIER_NAMES: readonly SourceTier[] = ['resolution', 'news', 'signal'];

/** https only, trailing slash trimmed, so two spellings of one site are one row. */
function normaliseUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!/^https:\/\//i.test(trimmed)) return null;
  try {
    const url = new URL(trimmed);
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

function hostOf(raw: string): string | null {
  try {
    return new URL(raw).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return null;
  }
}
