import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';

/**
 * §2.18's consent versioning.
 *
 * "ToS/privacy/rulebook acceptance recorded per version per user (`consents`
 * table); re-acceptance prompted on material changes; marketing consent
 * separate (NDPA)."
 *
 * "They agreed to the terms" is worthless without saying which terms. The
 * version is the whole record — a signup in March agreed to the March
 * document, and if June's document changes what happens to somebody's money,
 * their March acceptance does not cover it.
 *
 * A new version does not invalidate the old row. It needs a *new* row, and the
 * absence of one is what triggers the prompt. Consents are append-only at the
 * database level for the same reason the ledger is: this is evidence, and a
 * withdrawn consent is a new fact rather than an erased one.
 */
export type ConsentDocument = 'terms' | 'privacy' | 'rules' | 'marketing';

/**
 * The versions currently in force.
 *
 * Deliberately in code and not in `platform_config`. A document version is not
 * a tunable — it changes when counsel changes the document, in the same deploy
 * that ships the new text, and the two must not be able to drift apart. A
 * config console that could bump the version without the wording changing
 * would let somebody mark the whole userbase as having agreed to something
 * they never saw.
 */
export const CURRENT_VERSIONS: Record<ConsentDocument, string> = {
  terms: '2026-01',
  privacy: '2026-01',
  rules: '2026-01',
  // NDPA: marketing is a separate, freely-withdrawable consent and is never
  // bundled into "accept the terms". It has no "current version" to chase —
  // the absence of a row means no, which is the only safe default.
  marketing: '2026-01',
};

/** The documents somebody must have accepted to keep using the platform. */
const REQUIRED: ConsentDocument[] = ['terms', 'privacy', 'rules'];

@Injectable()
export class ConsentService {
  constructor(private readonly prisma: PrismaService) {}

  async record(params: {
    userId: string;
    document: ConsentDocument;
    version?: string;
    ip: string;
  }): Promise<void> {
    const version = params.version ?? CURRENT_VERSIONS[params.document];

    // Accepting twice is not an error and must not overwrite the first
    // acceptance's timestamp — when they first agreed is the fact worth
    // keeping.
    //
    // An insert that skips duplicates rather than an upsert with an empty
    // update. Both work today: Prisma compiles `update: {}` to DO NOTHING, so
    // the previous form survives the append-only trigger this table now
    // carries — checked against a live database rather than assumed. But it
    // survives by an implementation detail. An upsert *means* "update if it
    // exists", and a Prisma release that starts emitting a literal `DO UPDATE`
    // would turn a second acceptance into a rejected write on a table that
    // rejects updates by design. This says what is actually wanted.
    await this.prisma.consent.createMany({
      data: [{ userId: params.userId, document: params.document, version, ip: params.ip }],
      skipDuplicates: true,
    });
  }

  /** Accept everything currently required, in one go, at signup. */
  async acceptAllRequired(userId: string, ip: string): Promise<void> {
    for (const document of REQUIRED) {
      await this.record({ userId, document, ip });
    }
  }

  /**
   * What still needs agreeing to.
   *
   * Marketing is never in this list. A prompt somebody cannot dismiss without
   * agreeing is not consent, and under the NDPA marketing has to be a genuine
   * choice — so it is offered, never demanded.
   */
  async outstanding(userId: string): Promise<ConsentDocument[]> {
    const held = await this.prisma.consent.findMany({
      where: { userId },
      select: { document: true, version: true },
    });

    return REQUIRED.filter(
      (document) =>
        !held.some(
          (row) => row.document === document && row.version === CURRENT_VERSIONS[document],
        ),
    );
  }

  /** Everything somebody has agreed to, for their own account screen. */
  async historyFor(userId: string) {
    const rows = await this.prisma.consent.findMany({
      where: { userId },
      orderBy: { acceptedAt: 'desc' },
    });

    return rows.map((row) => ({
      document: row.document,
      version: row.version,
      acceptedAt: row.acceptedAt.toISOString(),
      current: CURRENT_VERSIONS[row.document as ConsentDocument] === row.version,
    }));
  }

  /** NDPA: withdrawable, and withdrawal is recorded rather than deleted. */
  async withdrawMarketing(userId: string, ip: string): Promise<void> {
    await this.prisma.consent.create({
      data: { userId, document: 'marketing_withdrawn', version: CURRENT_VERSIONS.marketing, ip },
    });
  }

  async marketingAllowed(userId: string): Promise<boolean> {
    const rows = await this.prisma.consent.findMany({
      where: { userId, document: { in: ['marketing', 'marketing_withdrawn'] } },
      orderBy: { acceptedAt: 'desc' },
      take: 1,
    });
    // No row at all means no. Silence is not consent.
    return rows[0]?.document === 'marketing';
  }
}
