import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';

import { PrismaService } from '../prisma/prisma.service';
import { badgeFor, NO_POSITION, parseBadge } from './badges';

export class ChallengeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChallengeError';
  }
}

/**
 * §2.15d's challenge links.
 *
 * "Personal link from any market — 'I'm YES at 60%. Prove me wrong.' —
 * recipient lands on the market with the challenger's position shown.
 * Registering-to-disagree is the strongest signup motivator."
 *
 * The link carries a *snapshot*, for the same reason a comment badge does: the
 * challenge is a claim somebody made at a moment, and a link whose position
 * drifted as its author traded would be an invitation to argue with something
 * they never said.
 *
 * A challenge is not a wager. Nothing here escrows, matches or settles money —
 * §2.15d is an acquisition mechanism, and the recipient's stake is an ordinary
 * trade through the ordinary path with all of §2.12's limits on it.
 */
@Injectable()
export class ChallengeService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Mint a link from the challenger's current position.
   *
   * Refuses when they hold nothing: "prove me wrong" from somebody with no
   * position is not a challenge, and it is exactly the pump-talk §2.15e says
   * position badges exist to expose.
   */
  async create(params: { marketId: string; userId: string }): Promise<{
    token: string;
    badge: string;
    marketId: string;
  }> {
    const market = await this.prisma.market.findUnique({
      where: { id: params.marketId },
      include: { outcomes: { orderBy: { ordinal: 'asc' } } },
    });
    if (market === null) throw new ChallengeError('no such market');

    const positions = await this.prisma.position.findMany({
      where: { userId: params.userId, marketId: params.marketId, shares: { gt: 0 } },
    });
    if (positions.length === 0) {
      throw new ChallengeError('take a position first — that is what there is to argue with');
    }

    const largest = positions.reduce((best, position) =>
      position.shares.gt(best.shares) ? position : best,
    );
    const outcome = market.outcomes.find((row) => row.id === largest.outcomeId);
    if (outcome === undefined) throw new ChallengeError('that position is not on this market');

    const badge = badgeFor({
      outcomeLabel: outcome.label,
      priceAtPost: Number(outcome.priceCurrent),
      shares: Number(largest.shares),
    });

    // 16 bytes base64url. Guessable tokens would let somebody accept a
    // challenge that was never sent to them.
    const token = randomBytes(16).toString('base64url');

    await this.prisma.challenge.create({
      data: {
        marketId: params.marketId,
        challengerId: params.userId,
        positionSnapshot: badge,
        linkToken: token,
      },
    });

    return { token, badge, marketId: params.marketId };
  }

  /**
   * What a recipient sees when they land.
   *
   * Counts the open, because §2.15d claims challenge links are the strongest
   * signup motivator on the platform and a claim like that needs a denominator.
   * Deliberately readable with no account: the whole point is that the person
   * arriving does not have one yet.
   */
  async open(
    token: string,
    viewerId?: string,
  ): Promise<{
    marketId: string;
    question: string;
    state: string;
    challenger: { handle: string | null; displayName: string | null };
    badge: string;
    outcomeLabel: string | null;
    pricePct: number | null;
    accepted: boolean;
    /** True when the viewer is the person who made the challenge. */
    isChallenger: boolean;
  } | null> {
    const challenge = await this.prisma.challenge.findUnique({
      where: { linkToken: token },
      include: {
        market: { select: { id: true, question: true, state: true } },
        challenger: { select: { handle: true, displayName: true } },
      },
    });
    if (challenge === null) return null;

    await this.prisma.challenge.update({
      where: { linkToken: token },
      data: { opens: { increment: 1 } },
    });

    const parsed = parseBadge(challenge.positionSnapshot);
    return {
      marketId: challenge.market.id,
      question: challenge.market.question,
      state: challenge.market.state,
      challenger: {
        handle: challenge.challenger.handle,
        displayName: challenge.challenger.displayName,
      },
      badge: challenge.positionSnapshot,
      outcomeLabel: parsed.outcomeLabel,
      pricePct: parsed.pricePct,
      accepted: challenge.acceptedBy !== null,
      isChallenger: viewerId !== undefined && viewerId === challenge.challengerId,
    };
  }

  /**
   * Record that somebody took the other side.
   *
   * Conditional on it being unaccepted, in one statement, so two people
   * clicking at once cannot both be recorded as the one who answered it. The
   * challenger cannot accept their own, and accepting requires actually holding
   * a position — a claim to have disagreed is worth nothing without one.
   */
  async accept(params: { token: string; userId: string }): Promise<{ accepted: boolean }> {
    const challenge = await this.prisma.challenge.findUnique({
      where: { linkToken: params.token },
      include: { market: { include: { outcomes: true } } },
    });
    if (challenge === null) throw new ChallengeError('no such challenge');
    if (challenge.challengerId === params.userId) {
      throw new ChallengeError('you cannot answer your own challenge');
    }

    const positions = await this.prisma.position.findMany({
      where: { userId: params.userId, marketId: challenge.marketId, shares: { gt: 0 } },
    });
    if (positions.length === 0) {
      throw new ChallengeError('take a position on this market first');
    }

    const largest = positions.reduce((best, position) =>
      position.shares.gt(best.shares) ? position : best,
    );
    const theirOutcome = challenge.market.outcomes.find((row) => row.id === largest.outcomeId);
    const challengerLabel = parseBadge(challenge.positionSnapshot).outcomeLabel;

    if (
      theirOutcome !== undefined &&
      challengerLabel !== null &&
      theirOutcome.label.toUpperCase() === challengerLabel
    ) {
      throw new ChallengeError('you are on the same side — that is agreement, not a challenge');
    }

    const claimed = await this.prisma.challenge.updateMany({
      where: { linkToken: params.token, acceptedBy: null },
      data: { acceptedBy: params.userId, acceptedAt: new Date() },
    });

    if (claimed.count === 0) {
      throw new ChallengeError('somebody already answered this one');
    }
    return { accepted: true };
  }

  /** A creator's or trader's own challenges, with how they travelled. */
  async mine(userId: string) {
    const challenges = await this.prisma.challenge.findMany({
      where: { challengerId: userId },
      include: {
        market: { select: { id: true, question: true, state: true } },
        accepter: { select: { handle: true, displayName: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 25,
    });

    return challenges.map((challenge) => ({
      token: challenge.linkToken,
      market: challenge.market,
      badge: challenge.positionSnapshot,
      opens: challenge.opens,
      accepted: challenge.acceptedBy !== null,
      accepter: challenge.accepter,
      createdAt: challenge.createdAt,
    }));
  }
}

export { NO_POSITION };
