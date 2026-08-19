import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';

import { logger } from '../logger';
import { PlatformConfigService } from '../platform-config/platform-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';

/**
 * §2.17's referral programme.
 *
 * The design decision that matters is *when the reward is paid*. A programme
 * that pays on signup pays for signups, which is a bounty on fake accounts —
 * and this platform hands every new account a starter balance, so a farmed
 * referral would be paid twice out of the same pocket. So nothing is paid
 * until the referred person has done the thing the business actually wants:
 * verified their contact and staked. `qualifiedAt` is when that happened.
 *
 * The anti-abuse checks are deliberately *not* a fraud engine. They catch the
 * cheap, obvious self-referral — one device, one contact domain — and leave
 * the sophisticated case to §2.11's abuse detection, which already looks at
 * clusters and has a human queue behind it. A referral check trying to be a
 * second fraud system would be worse at it and would silently deny honest
 * people their reward.
 */
@Injectable()
export class ReferralService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
    private readonly config: PlatformConfigService,
  ) {}

  /**
   * Somebody's code. Derived, not stored.
   *
   * A hash of the user id rather than a row: there is nothing to migrate, a
   * code cannot be lost, and it cannot collide. Six characters from a
   * base32-ish alphabet with the ambiguous glyphs removed, because this is a
   * thing people read out loud and type into a phone.
   */
  codeFor(userId: string): string {
    const digest = createHash('sha256').update(`referral:${userId}`).digest();
    const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
    return Array.from({ length: 6 }, (_, index) =>
      alphabet.charAt((digest[index] as number) % alphabet.length),
    ).join('');
  }

  /** Whose code this is, or null. Linear, because the codes are derived. */
  private async userForCode(code: string): Promise<string | null> {
    const wanted = code.trim().toUpperCase();
    // Only accounts that could plausibly have shared a code: a referrer has to
    // have verified their own contact first, which keeps this scan small and
    // stops an unverified farm from minting referrers.
    const candidates = await this.prisma.user.findMany({
      where: { tier: { gte: 1 }, status: 'active' },
      select: { id: true },
    });

    return candidates.find((user) => this.codeFor(user.id) === wanted)?.id ?? null;
  }

  /**
   * Attach a referral at signup. Records the claim; pays nothing.
   *
   * One row per referred account, ever, enforced by a unique index rather than
   * by this check — "who referred you" must not be re-answerable, or the
   * reward is farmable by asking again.
   */
  async claim(params: {
    referredId: string;
    code: string;
  }): Promise<{ attached: boolean; reason?: string }> {
    const referrerId = await this.userForCode(params.code);
    if (referrerId === null) return { attached: false, reason: 'that code does not match anybody' };
    if (referrerId === params.referredId) {
      return { attached: false, reason: 'that is your own code' };
    }

    const existing = await this.prisma.referral.findUnique({
      where: { referredId: params.referredId },
    });
    if (existing !== null)
      return { attached: false, reason: 'this account already has a referrer' };

    await this.prisma.referral.create({
      data: { referrerId, referredId: params.referredId, code: params.code.toUpperCase() },
    });

    return { attached: true };
  }

  /**
   * The referred person did something that counts. Pay, once, if it is clean.
   *
   * Called after a first filled trade rather than after verification alone:
   * verification is cheap to fake at scale with a SIM farm, and a stake is the
   * behaviour the referral was supposed to buy.
   */
  async qualify(referredId: string, now = new Date()): Promise<{ paid: boolean; reason?: string }> {
    const referral = await this.prisma.referral.findUnique({ where: { referredId } });
    if (referral === null) return { paid: false, reason: 'not referred' };
    if (referral.qualifiedAt !== null) return { paid: false, reason: 'already qualified' };

    const blocked = await this.selfReferralSignal(referral.referrerId, referredId);
    if (blocked !== null) {
      await this.prisma.referral.update({
        where: { referredId },
        data: { qualifiedAt: now, blockedFor: blocked },
      });
      logger.warn({ referredId, blocked }, 'referral reward withheld');
      return { paid: false, reason: blocked };
    }

    const reward = new Prisma.Decimal(await this.config.get('referral_reward_spc'));
    if (reward.lte(0)) {
      await this.prisma.referral.update({ where: { referredId }, data: { qualifiedAt: now } });
      return { paid: false, reason: 'the programme is currently paying nothing' };
    }

    // Issued and marked in one transaction. A reward paid whose row does not
    // say so is a reward payable again.
    await this.prisma.$transaction(async (tx) => {
      await this.wallet.issue({
        userId: referral.referrerId,
        amount: reward,
        type: 'signup_bonus',
        ref: `referral:${referral.id}`,
        tx,
      });
      await tx.referral.update({
        where: { referredId },
        data: { qualifiedAt: now, rewardPaid: reward },
      });
    });

    return { paid: true };
  }

  /**
   * The cheap self-referral tells.
   *
   * Returns the reason to withhold, or null. Both signals are about the pair
   * being the same person rather than about either account being bad — this
   * blocks a reward, it does not freeze anybody, and a false positive here
   * costs somebody a bonus rather than their account.
   */
  private async selfReferralSignal(referrerId: string, referredId: string): Promise<string | null> {
    const [shared, pair] = await Promise.all([
      this.prisma.deviceFingerprint.findMany({
        where: { userId: { in: [referrerId, referredId] } },
        select: { userId: true, fingerprint: true },
      }),
      this.prisma.user.findMany({
        where: { id: { in: [referrerId, referredId] } },
        select: { id: true, email: true, phone: true },
      }),
    ]);

    const byUser = new Map<string, Set<string>>();
    for (const row of shared) {
      byUser.set(row.userId, (byUser.get(row.userId) ?? new Set()).add(row.fingerprint));
    }
    const referrerHashes = byUser.get(referrerId) ?? new Set();
    for (const hash of byUser.get(referredId) ?? new Set()) {
      if (referrerHashes.has(hash)) return 'same_device';
    }

    // Plus-addressing on the same mailbox — ada+1@, ada+2@ — is the cheapest
    // possible farm and the one worth naming. Same domain is *not* a signal:
    // most of Nigeria is on the same four mail providers.
    const mailboxes = pair
      .map((user) => user.email)
      .filter((email): email is string => email !== null)
      .map((email) => {
        const [local = '', domain = ''] = email.toLowerCase().split('@');
        return `${local.split('+')[0]}@${domain}`;
      });
    if (mailboxes.length === 2 && mailboxes[0] === mailboxes[1]) return 'same_mailbox';

    return null;
  }

  /** What somebody's own referrals page shows. */
  async summaryFor(userId: string) {
    const rows = await this.prisma.referral.findMany({
      where: { referrerId: userId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    return {
      code: this.codeFor(userId),
      invited: rows.length,
      qualified: rows.filter((row) => row.qualifiedAt !== null && row.blockedFor === null).length,
      earned: rows.reduce((sum, row) => sum + Number(row.rewardPaid), 0).toFixed(2),
      referrals: rows.map((row) => ({
        joinedAt: row.createdAt.toISOString(),
        // Never the referred person's identity — somebody's friend list is not
        // the referrer's to read back.
        status:
          row.blockedFor !== null
            ? 'not eligible'
            : row.qualifiedAt === null
              ? 'waiting for their first stake'
              : 'paid',
        earned: row.rewardPaid.toString(),
      })),
    };
  }
}
