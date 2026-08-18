import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { CommentState } from '@prisma/client';

import { PlatformConfigService } from '../platform-config/platform-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { badgeFor, boldness, calledIt, NO_POSITION } from './badges';
import { explain, flagsFor, verdictFor, type Flag } from './moderation';

export class ThreadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ThreadError';
  }
}

/** States a market can still be argued about in. */
const ARGUABLE: readonly string[] = [
  'seeding',
  'funding',
  'active',
  'frozen',
  'pending_resolution',
  'dispute_window',
  'resolved',
];

export interface PostedComment {
  readonly id: string;
  readonly state: CommentState;
  readonly badge: string;
  /** What the commenter is told when the rules held or flagged it. */
  readonly notice: string | null;
}

/**
 * §2.15a's take threads.
 *
 * "Every market has a discussion feed. Each comment displays the commenter's
 * position badge — arguments become accountable; talking your book is visible."
 *
 * Three things make that work and all three live here. The badge is snapshotted
 * at post time, so it cannot be edited by trading. The gate is Tier 1 plus
 * eligibility to trade *this* market, which is what keeps drive-by spam out.
 * And the §2.15e rules run before anything is published, so a hard-ban comment
 * never appears in the thread at all — it waits for a person.
 */
@Injectable()
export class ThreadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: PlatformConfigService,
  ) {}

  /**
   * Post a take.
   *
   * The order matters: eligibility, then rate limit, then the content rules,
   * then the badge. Checking content before eligibility would tell somebody who
   * cannot comment at all exactly which words trip the filter.
   */
  async post(params: {
    marketId: string;
    userId: string;
    text: string;
    parentId?: string;
    /** §2.15a's reason prompt: this came from the trade ticket, not the thread. */
    fromTrade?: boolean;
    now?: Date;
  }): Promise<PostedComment> {
    const now = params.now ?? new Date();
    const text = params.text.trim();

    const maxLength = await this.config.get('comment_max_length');
    if (text.length === 0) throw new ThreadError('say something');
    if (text.length > maxLength) {
      throw new ThreadError(`keep it under ${maxLength} characters`);
    }

    const market = await this.prisma.market.findUnique({
      where: { id: params.marketId },
      include: { outcomes: { orderBy: { ordinal: 'asc' } } },
    });
    if (market === null) throw new ThreadError('no such market');
    if (!ARGUABLE.includes(market.state)) {
      throw new ThreadError('this market is not open for comment');
    }

    await this.assertMayComment(params.userId, now);

    if (params.parentId !== undefined) {
      const parent = await this.prisma.comment.findUnique({ where: { id: params.parentId } });
      if (parent === null || parent.marketId !== params.marketId) {
        throw new ThreadError('that comment is not on this market');
      }
      if (parent.state !== 'live') {
        throw new ThreadError('you cannot reply to a comment that is not live');
      }
    }

    const flags = flagsFor(text);
    const verdict = verdictFor(flags);
    const state: CommentState =
      verdict === 'publish' ? 'live' : verdict === 'hold' ? 'held' : 'flagged';

    const badge = await this.badgeFor(params.marketId, params.userId, market.outcomes);

    const comment = await this.prisma.comment.create({
      data: {
        marketId: params.marketId,
        userId: params.userId,
        text,
        positionSnapshot: badge,
        fromTrade: params.fromTrade ?? false,
        state,
        ...(params.parentId === undefined ? {} : { parentId: params.parentId }),
        ...(flags.length === 0 ? {} : { flagsJson: flags as unknown as Prisma.InputJsonValue }),
      },
    });

    return {
      id: comment.id,
      state,
      badge,
      notice: verdict === 'publish' ? null : explain(flags),
    };
  }

  /**
   * §2.15a's gate: Tier 1, and eligible to trade the market.
   *
   * Self-exclusion counts as ineligible. Somebody who has shut their own account
   * out of the markets should not be kept in the argument — §2.12's whole point
   * is that the exclusion is a door that closes, not a balance that freezes.
   */
  private async assertMayComment(userId: string, now: Date): Promise<void> {
    const [user, rg, minTier, gapSeconds, perHour] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { tier: true, status: true },
      }),
      this.prisma.rgSettings.findUnique({ where: { userId } }),
      this.config.get('comment_min_tier'),
      this.config.get('comment_min_seconds_between'),
      this.config.get('comment_rate_per_hour'),
    ]);

    if (user === null) throw new ThreadError('no such account');
    if (user.status !== 'active') throw new ThreadError('this account cannot comment');
    if (user.tier < minTier) {
      throw new ThreadError(
        'verify your phone or email first — the thread is for people who can take a position',
      );
    }
    if (rg?.selfExcluded === true) {
      throw new ThreadError('your account is self-excluded');
    }
    if (rg?.cooloffUntil != null && rg.cooloffUntil.getTime() > now.getTime()) {
      throw new ThreadError('you are in a cool-off period');
    }

    // §2.15e's rate limits, counted from the comments already written rather
    // than from a token bucket — the rows are the truth, and they survive a
    // restart that an in-memory limiter would not.
    const lastComment = await this.prisma.comment.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    if (
      lastComment !== null &&
      now.getTime() - lastComment.createdAt.getTime() < gapSeconds * 1_000
    ) {
      throw new ThreadError(`wait ${gapSeconds} seconds between comments`);
    }

    const lastHour = await this.prisma.comment.count({
      where: { userId, createdAt: { gte: new Date(now.getTime() - 3_600_000) } },
    });
    if (lastHour >= perHour) {
      throw new ThreadError(`that is ${perHour} comments in an hour — take a break`);
    }
  }

  /** The badge, from the position the commenter actually holds right now. */
  private async badgeFor(
    marketId: string,
    userId: string,
    outcomes: readonly { id: string; label: string; priceCurrent: Prisma.Decimal }[],
  ): Promise<string> {
    const positions = await this.prisma.position.findMany({
      where: { userId, marketId, shares: { gt: 0 } },
    });
    if (positions.length === 0) return NO_POSITION;

    // The largest holding is the position they are speaking from. Somebody
    // holding both sides is hedged, and a badge claiming one side would be the
    // opposite of the accountability §2.15a is after.
    const largest = positions.reduce((best, position) =>
      position.shares.gt(best.shares) ? position : best,
    );
    const outcome = outcomes.find((row) => row.id === largest.outcomeId);
    if (outcome === undefined) return NO_POSITION;

    return badgeFor({
      outcomeLabel: outcome.label,
      priceAtPost: Number(outcome.priceCurrent),
      shares: Number(largest.shares),
    });
  }

  /**
   * The thread, as a reader sees it.
   *
   * Held comments are absent entirely; flagged ones are present, because
   * §2.15e's soft outcome is "published but queued" and hiding them would make
   * the queue a silent censor. A removed comment leaves its shape behind — a
   * thread with holes in it reads as tampered with.
   */
  async thread(params: { marketId: string; viewerId?: string; take?: number }): Promise<
    readonly {
      id: string;
      text: string | null;
      badge: string;
      handle: string | null;
      displayName: string | null;
      fromTrade: boolean;
      parentId: string | null;
      state: CommentState;
      calledIt: boolean | null;
      boldness: number | null;
      removed: boolean;
      mine: boolean;
      reports: number;
      createdAt: Date;
    }[]
  > {
    const comments = await this.prisma.comment.findMany({
      where: {
        marketId: params.marketId,
        // A viewer always sees their own held comment, so somebody whose
        // comment was caught is not left wondering where it went.
        OR: [
          { state: { in: ['live', 'flagged', 'removed'] } },
          ...(params.viewerId === undefined ? [] : [{ userId: params.viewerId }]),
        ],
      },
      include: {
        user: { select: { handle: true, displayName: true } },
        _count: { select: { reports: true } },
      },
      orderBy: { createdAt: 'asc' },
      take: params.take ?? 200,
    });

    return comments.map((comment) => ({
      id: comment.id,
      text: comment.state === 'removed' ? null : comment.text,
      badge: comment.positionSnapshot,
      handle: comment.user.handle,
      displayName: comment.user.displayName,
      fromTrade: comment.fromTrade,
      parentId: comment.parentId,
      state: comment.state,
      calledIt: comment.calledIt,
      boldness: comment.boldness === null ? null : Number(comment.boldness),
      removed: comment.state === 'removed',
      mine: comment.userId === params.viewerId,
      reports: comment._count.reports,
      createdAt: comment.createdAt,
    }));
  }

  /**
   * §2.15e's report button.
   *
   * One report per person per comment, enforced by the unique index, so a queue
   * ordered by report count counts people rather than clicks. Enough distinct
   * reporters pulls a live comment into the queue without waiting for a
   * moderator to happen past it.
   */
  async report(params: {
    commentId: string;
    reporterId: string;
    reason: string;
  }): Promise<{ reports: number; flagged: boolean }> {
    const reason = params.reason.trim();
    if (reason.length < 3) throw new ThreadError('say what is wrong with it');

    const comment = await this.prisma.comment.findUnique({ where: { id: params.commentId } });
    if (comment === null) throw new ThreadError('no such comment');
    if (comment.userId === params.reporterId) {
      throw new ThreadError('you cannot report your own comment');
    }

    try {
      await this.prisma.commentReport.create({
        data: { commentId: params.commentId, reporterId: params.reporterId, reason },
      });
    } catch (caught) {
      if (caught instanceof Prisma.PrismaClientKnownRequestError && caught.code === 'P2002') {
        // Already reported by this person. Not an error — but not a second vote.
        const reports = await this.prisma.commentReport.count({
          where: { commentId: params.commentId },
        });
        return { reports, flagged: comment.state === 'flagged' };
      }
      throw caught;
    }

    const reports = await this.prisma.commentReport.count({
      where: { commentId: params.commentId },
    });
    const threshold = await this.config.get('comment_reports_to_flag');

    if (reports >= threshold && comment.state === 'live') {
      await this.prisma.comment.update({
        where: { id: params.commentId },
        data: { state: 'flagged' },
      });
      return { reports, flagged: true };
    }
    return { reports, flagged: comment.state === 'flagged' };
  }

  /**
   * §2.15a's prediction receipts, stamped when a market settles.
   *
   * "At resolution, every comment keeps its badge permanently." The badge was
   * already permanent; this adds the only thing that could not be known at the
   * time — whether the call landed, and how bold it was. Idempotent, because
   * the resolution path can and will run its notifications twice.
   */
  async stampReceipts(marketId: string): Promise<{ stamped: number }> {
    const market = await this.prisma.market.findUnique({
      where: { id: marketId },
      include: { resolvedOutcome: { select: { label: true } } },
    });
    if (market === null || market.resolvedOutcome === null) return { stamped: 0 };

    const winning = market.resolvedOutcome.label;
    const comments = await this.prisma.comment.findMany({
      where: { marketId, calledIt: null },
      select: { id: true, positionSnapshot: true },
    });

    let stamped = 0;
    for (const comment of comments) {
      const correct = calledIt(comment.positionSnapshot, winning);
      if (correct === null) continue;

      const bold = boldness(comment.positionSnapshot, winning);
      await this.prisma.comment.update({
        where: { id: comment.id },
        data: {
          calledIt: correct,
          ...(bold === null ? {} : { boldness: new Prisma.Decimal(bold) }),
        },
      });
      stamped += 1;
    }
    return { stamped };
  }

  // --------------------------------------------------------------- moderation

  /** The queue §2.15e routes to the Trust & Safety desk (§6.5). */
  async queue(take = 50) {
    const comments = await this.prisma.comment.findMany({
      where: { state: { in: ['held', 'flagged'] } },
      include: {
        user: { select: { id: true, handle: true, displayName: true } },
        market: { select: { id: true, question: true } },
        reports: {
          select: { reason: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
          take: 5,
        },
        _count: { select: { reports: true } },
      },
      // Held first: those are the ones nobody can see yet, so somebody's words
      // are waiting on this queue rather than merely being watched by it.
      orderBy: [{ state: 'asc' }, { createdAt: 'asc' }],
      take,
    });

    return comments.map((comment) => ({
      id: comment.id,
      text: comment.text,
      state: comment.state,
      badge: comment.positionSnapshot,
      author: {
        id: comment.user.id,
        handle: comment.user.handle,
        displayName: comment.user.displayName,
      },
      market: comment.market,
      flags: (comment.flagsJson as unknown as Flag[] | null) ?? [],
      reports: comment._count.reports,
      recentReasons: comment.reports.map((report) => report.reason),
      createdAt: comment.createdAt,
    }));
  }

  /** A moderator's decision. The only thing that can remove or restore words. */
  async moderate(params: {
    commentId: string;
    staffId: string;
    decision: 'publish' | 'remove';
  }): Promise<{ state: CommentState }> {
    const comment = await this.prisma.comment.findUnique({ where: { id: params.commentId } });
    if (comment === null) throw new ThreadError('no such comment');

    const state: CommentState = params.decision === 'publish' ? 'live' : 'removed';
    await this.prisma.comment.update({
      where: { id: params.commentId },
      data: { state, moderatedBy: params.staffId, moderatedAt: new Date() },
    });
    return { state };
  }
}
