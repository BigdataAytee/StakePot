import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { NotificationsService } from '../notifications/notifications.service';
import { PlatformConfigService } from '../platform-config/platform-config.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  cleanRate,
  earnedLevel,
  LEVEL_NAMES,
  nextLevel,
  privilegesFor,
  progressToNext,
  type CreatorLevel,
  type CreatorRecord,
  type LadderRules,
  type Privileges,
} from './progression';

export class CreatorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CreatorError';
  }
}

/** Handles are addresses. Short, lowercase, and not something else's word. */
const HANDLE_PATTERN = /^[a-z0-9_]{3,20}$/;
const RESERVED_HANDLES = new Set([
  'admin',
  'stakeam',
  'staff',
  'support',
  'official',
  'system',
  'help',
  'api',
  'me',
  'new',
  'create',
  'market',
  'markets',
  'status',
  'account',
]);

export interface PublicProfile {
  readonly userId: string;
  readonly handle: string;
  readonly displayName: string;
  readonly level: CreatorLevel;
  readonly badge: string | null;
  readonly cleanResolutions: number;
  readonly disputedResolutions: number;
  readonly voidedAfterActivation: number;
  readonly cleanRatePct: number | null;
  readonly volumeHosted: string;
  readonly followerCount: number;
  readonly since: Date;
  readonly liveMarkets: readonly {
    id: string;
    question: string;
    state: string;
    potTotal: string;
  }[];
}

/**
 * The creator platform's spine (§2.14).
 *
 * §2.14's loop is *creator posts good ticket → shares it → brings their
 * audience → market activates → clean resolution → status + earnings → posts
 * again, better.* This service owns the two halves of that loop the platform
 * has to keep honest: the public record a creator is judged by, and the level
 * that record earns them.
 *
 * The level is never set directly. It is recomputed from counters after every
 * settlement, so a privilege can only ever be as good as the record behind it —
 * there is no code path that hands somebody level 3.
 */
@Injectable()
export class CreatorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: PlatformConfigService,
    private readonly notifications: NotificationsService,
  ) {}

  /** §2.14c's ladder, read from config so §6.4b can move it without a deploy. */
  async rules(): Promise<LadderRules> {
    const [
      level2CleanResolutions,
      level3CleanResolutions,
      level3VolumeSpc,
      level3CleanRate,
      maxLive,
      bondMultiplier,
      creatorBps,
      demotionEnabled,
    ] = await Promise.all([
      this.config.get('creator_level2_clean_resolutions'),
      this.config.get('creator_level3_clean_resolutions'),
      this.config.get('creator_level3_volume_spc'),
      this.config.get('creator_level3_clean_rate'),
      this.config.get('creator_max_live_markets'),
      this.config.get('creator_bond_multiplier'),
      this.config.get('creator_bps_by_level'),
      this.config.get('creator_demotion_enabled'),
    ]);

    const byLevel = (
      source: Record<string, number>,
      fallback: Record<CreatorLevel, number>,
    ): Record<CreatorLevel, number> => ({
      1: source['1'] ?? fallback[1],
      2: source['2'] ?? fallback[2],
      3: source['3'] ?? fallback[3],
    });

    return {
      level2CleanResolutions,
      level3CleanResolutions,
      level3VolumeSpc,
      level3CleanRate,
      maxLiveMarkets: byLevel(maxLive, { 1: 2, 2: 10, 3: 25 }),
      bondMultiplier: byLevel(bondMultiplier, { 1: 1, 2: 0.5, 3: 0.25 }),
      creatorBps: byLevel(creatorBps, { 1: 400, 2: 400, 3: 450 }),
      demotionEnabled,
    };
  }

  /**
   * The profile row, created on first need.
   *
   * Every account can become a creator, so a profile is not something you sign
   * up for — it appears the first time somebody's record has anything in it.
   */
  async ensureProfile(userId: string, tx?: Prisma.TransactionClient): Promise<void> {
    const client = tx ?? this.prisma;
    await client.creatorProfile.upsert({
      where: { userId },
      update: {},
      create: { userId, badgeFlags: {} },
    });
  }

  /**
   * Claim a public handle (§2.14c, §2.14d).
   *
   * A creator's markets are shared under this name, so it is checked the way an
   * address is checked: shape, reserved words, and uniqueness enforced by the
   * database rather than by a lookup that can race.
   */
  async claimHandle(params: {
    userId: string;
    handle: string;
    displayName?: string;
  }): Promise<{ handle: string; displayName: string }> {
    const handle = params.handle.trim().toLowerCase();
    if (!HANDLE_PATTERN.test(handle)) {
      throw new CreatorError(
        'a handle is 3–20 characters, lowercase letters, numbers and underscores',
      );
    }
    if (RESERVED_HANDLES.has(handle)) {
      throw new CreatorError('that handle is reserved');
    }

    const displayName = (params.displayName ?? handle).trim();
    if (displayName.length === 0 || displayName.length > 40) {
      throw new CreatorError('a display name is 1–40 characters');
    }

    try {
      await this.prisma.user.update({
        where: { id: params.userId },
        data: { handle, displayName },
      });
    } catch (caught) {
      if (caught instanceof Prisma.PrismaClientKnownRequestError && caught.code === 'P2002') {
        throw new CreatorError('that handle is taken');
      }
      throw caught;
    }

    await this.ensureProfile(params.userId);
    return { handle, displayName };
  }

  /** A creator's record as the ladder reads it. */
  async recordOf(userId: string): Promise<CreatorRecord> {
    const profile = await this.prisma.creatorProfile.findUnique({ where: { userId } });
    return {
      cleanResolutions: profile?.cleanResolutions ?? 0,
      disputedResolutions: profile?.disputedResolutions ?? 0,
      voidedAfterActivation: profile?.voidedAfterActivation ?? 0,
      volumeHosted: Number(profile?.totalVolumeHosted ?? 0),
    };
  }

  /**
   * What a creator is currently allowed to do.
   *
   * Read from the stored level rather than recomputed, because the stored level
   * is what the creator was told they hold — a privilege that silently differs
   * from the badge on their profile is a bug they cannot see.
   */
  async privilegesOf(userId: string): Promise<Privileges> {
    const [profile, rules] = await Promise.all([
      this.prisma.creatorProfile.findUnique({ where: { userId } }),
      this.rules(),
    ]);
    const level = clampLevel(profile?.level ?? 1);
    return privilegesFor(level, rules);
  }

  /**
   * Recompute a creator's level from their record (§2.14c).
   *
   * Called after every settlement. Returns the movement when there was one, so
   * the caller can tell the creator — a level that changed silently is a
   * privilege that changed silently.
   */
  async recomputeLevel(userId: string): Promise<{ from: CreatorLevel; to: CreatorLevel } | null> {
    const [profile, rules, record] = await Promise.all([
      this.prisma.creatorProfile.findUnique({ where: { userId } }),
      this.rules(),
      this.recordOf(userId),
    ]);
    if (profile === null) return null;

    const from = clampLevel(profile.level);
    const to = nextLevel(from, record, rules);
    if (to === from) return null;

    await this.prisma.creatorProfile.update({
      where: { userId },
      data: { level: to, levelUpdatedAt: new Date() },
    });

    await this.notifications.notify({
      userId,
      type: 'creator_level',
      body:
        to > from
          ? `You are now a Level ${to} creator — ${LEVEL_NAMES[to]}. ${describeGain(
              privilegesFor(from, rules),
              privilegesFor(to, rules),
            )}`
          : `Your creator level moved to ${to} — ${LEVEL_NAMES[to]}. Levels follow the record, and yours has changed.`,
      data: { from: String(from), to: String(to) },
    });

    return { from, to };
  }

  /**
   * Record what a settled market did to its creator's standing.
   *
   * The counters are the ladder's only inputs, so this is the one place they
   * move. `volume` is added whether the market settled or voided — a voided
   * market still hosted the stakes, and §2.14c counts volume hosted, not volume
   * kept.
   */
  async recordSettlement(params: {
    creatorId: string;
    kind: 'clean' | 'disputed' | 'voided_after_activation' | 'voided_before_activation';
    volume: string;
  }): Promise<{ from: CreatorLevel; to: CreatorLevel } | null> {
    await this.ensureProfile(params.creatorId);

    const increment =
      params.kind === 'clean'
        ? { cleanResolutions: { increment: 1 } }
        : params.kind === 'disputed'
          ? { disputedResolutions: { increment: 1 } }
          : params.kind === 'voided_after_activation'
            ? { voidedAfterActivation: { increment: 1 } }
            : {};

    await this.prisma.creatorProfile.update({
      where: { userId: params.creatorId },
      data: {
        ...increment,
        totalVolumeHosted: { increment: new Prisma.Decimal(params.volume) },
      },
    });

    return this.recomputeLevel(params.creatorId);
  }

  // ------------------------------------------------------------------ follows

  /**
   * Follow a creator (§2.14c: "creators become distribution channels with
   * audiences").
   *
   * The follower count is maintained alongside the row rather than counted on
   * read, and both move in one transaction — a count that drifts from the rows
   * is a number nobody can trust on a public profile.
   */
  async follow(params: {
    followerId: string;
    creatorId: string;
    notify?: boolean;
  }): Promise<{ following: boolean; followerCount: number }> {
    if (params.followerId === params.creatorId) {
      throw new CreatorError('you cannot follow yourself');
    }

    const creator = await this.prisma.user.findUnique({
      where: { id: params.creatorId },
      select: { id: true },
    });
    if (creator === null) throw new CreatorError('no such creator');

    return this.prisma.$transaction(async (tx) => {
      await this.ensureProfile(params.creatorId, tx);

      const existing = await tx.follower.findUnique({
        where: {
          followerId_creatorId: {
            followerId: params.followerId,
            creatorId: params.creatorId,
          },
        },
      });

      if (existing !== null) {
        // Following twice is not an error, but it must not double the count.
        if (params.notify !== undefined && params.notify !== existing.notify) {
          await tx.follower.update({
            where: {
              followerId_creatorId: {
                followerId: params.followerId,
                creatorId: params.creatorId,
              },
            },
            data: { notify: params.notify },
          });
        }
        const profile = await tx.creatorProfile.findUniqueOrThrow({
          where: { userId: params.creatorId },
        });
        return { following: true, followerCount: profile.followerCount };
      }

      await tx.follower.create({
        data: {
          followerId: params.followerId,
          creatorId: params.creatorId,
          notify: params.notify ?? true,
        },
      });
      const profile = await tx.creatorProfile.update({
        where: { userId: params.creatorId },
        data: { followerCount: { increment: 1 } },
      });
      return { following: true, followerCount: profile.followerCount };
    });
  }

  async unfollow(params: {
    followerId: string;
    creatorId: string;
  }): Promise<{ following: boolean; followerCount: number }> {
    return this.prisma.$transaction(async (tx) => {
      const deleted = await tx.follower.deleteMany({
        where: { followerId: params.followerId, creatorId: params.creatorId },
      });

      const profile = await tx.creatorProfile.findUnique({
        where: { userId: params.creatorId },
      });
      if (profile === null) return { following: false, followerCount: 0 };

      if (deleted.count === 0) {
        return { following: false, followerCount: profile.followerCount };
      }

      // Floored at zero: a count that has drifted must not go negative on a
      // public profile, whatever put it out of step.
      const updated = await tx.creatorProfile.update({
        where: { userId: params.creatorId },
        data: { followerCount: Math.max(0, profile.followerCount - 1) },
      });
      return { following: false, followerCount: updated.followerCount };
    });
  }

  /**
   * Tell a creator's followers they have opened something (§2.14c).
   *
   * Only the followers who asked to be told. This is the mechanism that makes a
   * creator a distribution channel, which is exactly why it must not become a
   * channel the platform can spam through.
   */
  async announceMarket(marketId: string): Promise<number> {
    const market = await this.prisma.market.findUnique({
      where: { id: marketId },
      select: {
        id: true,
        question: true,
        creatorId: true,
        creator: { select: { handle: true, displayName: true } },
      },
    });
    if (market === null || market.creatorId === null) return 0;

    const followers = await this.prisma.follower.findMany({
      where: { creatorId: market.creatorId, notify: true },
      select: { followerId: true },
    });

    const name = market.creator?.displayName ?? market.creator?.handle ?? 'A creator you follow';

    for (const follower of followers) {
      await this.notifications.notify({
        userId: follower.followerId,
        type: 'creator_new_market',
        body: `${name} just opened: ${market.question}`,
        data: { marketId: market.id },
      });
    }
    return followers.length;
  }

  async isFollowing(followerId: string, creatorId: string): Promise<boolean> {
    const row = await this.prisma.follower.findUnique({
      where: { followerId_creatorId: { followerId, creatorId } },
    });
    return row !== null;
  }

  // ------------------------------------------------------------------ profile

  /** The public profile §2.14c describes, addressed by handle. */
  async profileByHandle(handle: string): Promise<PublicProfile | null> {
    const user = await this.prisma.user.findUnique({
      where: { handle: handle.trim().toLowerCase() },
      select: { id: true },
    });
    return user === null ? null : this.profile(user.id);
  }

  async profile(userId: string): Promise<PublicProfile | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, handle: true, displayName: true, createdAt: true },
    });
    if (user === null) return null;

    const profile = await this.prisma.creatorProfile.findUnique({ where: { userId } });
    const record = await this.recordOf(userId);

    const markets = await this.prisma.market.findMany({
      where: {
        creatorId: userId,
        state: { in: ['funding', 'active', 'frozen', 'dispute_window'] },
      },
      select: { id: true, question: true, state: true, potTotal: true },
      orderBy: { createdAt: 'desc' },
      take: 25,
    });

    const rate = cleanRate(record);

    return {
      userId,
      handle: user.handle ?? '',
      displayName: user.displayName ?? user.handle ?? 'Creator',
      level: clampLevel(profile?.level ?? 1),
      // Level 1 wears no badge, here as everywhere else: "New" is the absence
      // of a record, not an award for having one.
      badge: privilegesFor(clampLevel(profile?.level ?? 1), await this.rules()).badge,
      cleanResolutions: record.cleanResolutions,
      disputedResolutions: record.disputedResolutions,
      voidedAfterActivation: record.voidedAfterActivation,
      cleanRatePct: rate === null ? null : Math.round(rate * 1000) / 10,
      volumeHosted: (profile?.totalVolumeHosted ?? new Prisma.Decimal(0)).toString(),
      followerCount: profile?.followerCount ?? 0,
      since: profile?.createdAt ?? user.createdAt,
      liveMarkets: markets.map((market) => ({
        id: market.id,
        question: market.question,
        state: market.state,
        potTotal: market.potTotal.toString(),
      })),
    };
  }

  /** What the studio shows: the level, and exactly what is left before the next. */
  async standing(userId: string): Promise<{
    level: CreatorLevel;
    privileges: Privileges;
    record: CreatorRecord;
    progress: ReturnType<typeof progressToNext>;
    liveMarkets: number;
  }> {
    const [profile, rules, record] = await Promise.all([
      this.prisma.creatorProfile.findUnique({ where: { userId } }),
      this.rules(),
      this.recordOf(userId),
    ]);
    const level = clampLevel(profile?.level ?? 1);

    const liveMarkets = await this.prisma.market.count({
      where: {
        creatorId: userId,
        state: { in: ['draft', 'funding', 'active', 'frozen', 'dispute_window'] },
      },
    });

    return {
      level,
      privileges: privilegesFor(level, rules),
      record,
      progress: progressToNext(record, rules),
      liveMarkets,
    };
  }

  /** The badge a creator carries, for the market page and the share card. */
  async badgeOf(userId: string): Promise<{ handle: string | null; badge: string | null }> {
    const [user, profile] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { handle: true, displayName: true },
      }),
      this.prisma.creatorProfile.findUnique({ where: { userId } }),
    ]);
    const level = clampLevel(profile?.level ?? 1);
    return {
      handle: user?.handle ?? null,
      badge: level === 1 ? null : LEVEL_NAMES[level],
    };
  }

  /** The level a record would earn right now, ignoring what is stored. */
  async earnedLevelOf(userId: string): Promise<CreatorLevel> {
    const [rules, record] = await Promise.all([this.rules(), this.recordOf(userId)]);
    return earnedLevel(record, rules);
  }
}

function clampLevel(level: number): CreatorLevel {
  if (level >= 3) return 3;
  if (level <= 1) return 1;
  return 2;
}

function describeGain(before: Privileges, after: Privileges): string {
  const gains: string[] = [];
  if (after.maxLiveMarkets > before.maxLiveMarkets) {
    gains.push(`${after.maxLiveMarkets} live markets at once`);
  }
  if (after.bondMultiplier < before.bondMultiplier) {
    gains.push(`a bond ${Math.round((1 - after.bondMultiplier) * 100)}% lower`);
  }
  if (after.creatorBps > before.creatorBps) {
    gains.push(`a creator fee of ${(after.creatorBps / 100).toFixed(2)}%`);
  }
  if (after.featuredPlacement && !before.featuredPlacement) {
    gains.push('featured placement');
  }
  return gains.length === 0 ? '' : `That unlocks ${gains.join(', ')}.`;
}
