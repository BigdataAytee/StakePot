import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AdminAuditService } from '../audit/admin-audit.service';
import type { PrismaService } from '../prisma/prisma.service';
import { resetDatabase } from '../testing/reset';
import { DossierService } from './dossier.service';
import type { Reading, ResolutionAnalyst } from './resolution-analyst';

/**
 * The core principle of the intelligence layer, asserted rather than promised:
 * **the AI researches, analyses and proposes. Humans decide.**
 *
 * Every test here is a different way somebody could accidentally build the
 * path that must not exist. They are deliberately blunt and slightly
 * paranoid — a settlement is money leaving people's accounts, and the failure
 * this suite guards against is not a bug that throws, it is a convenience
 * method somebody adds in six months because the dossier "already knows the
 * answer".
 */
const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

/** An analyst that is certain, so the tests exercise the *confident* case. */
class ConfidentAnalyst implements ResolutionAnalyst {
  constructor(private readonly label: string) {}
  async read(): Promise<Reading> {
    return {
      outcomeLabel: this.label,
      confidence: 0.99,
      reasoning: 'The NBS published the figure and it is unambiguous.',
      conflicts: [],
      recommendVoid: false,
      voidReason: '',
    };
  }
}

describe.skipIf(!TEST_DATABASE_URL)('no automated path settles a market', () => {
  let prisma: PrismaService;
  let dossiers: DossierService;
  let marketId: string;
  let yesId: string;

  beforeAll(async () => {
    prisma = new PrismaClient({
      datasources: { db: { url: TEST_DATABASE_URL as string } },
    }) as unknown as PrismaService;
    await prisma.$connect();
    dossiers = new DossierService(
      prisma,
      new AdminAuditService(prisma),
      new ConfidentAnalyst('Yes'),
    );
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    const market = await prisma.market.create({
      data: {
        shelf: 'official',
        question: 'Will the figure print below 24%?',
        sourceName: 'NBS',
        sourceUrl: 'https://nigerianstat.gov.ng/elibrary/read/1241',
        criteriaJson: { Yes: 'below 24%', No: '24% or above' },
        edgeCasesJson: { 'no publication': 'voids' },
        eventDate: new Date(Date.now() - 3_600_000),
        voidDate: new Date(Date.now() + 7 * 86_400_000),
        liquidityParam: '50000',
        feeBps: 700,
        state: 'frozen',
        outcomes: {
          create: [
            { label: 'Yes', ordinal: 0, priceCurrent: '0.5' },
            { label: 'No', ordinal: 1, priceCurrent: '0.5' },
          ],
        },
      },
      include: { outcomes: true },
    });
    marketId = market.id;
    yesId = market.outcomes.find((outcome) => outcome.label === 'Yes')?.id ?? '';

    // Evidence from the market's own resolution source, so the analyst has
    // every reason to be confident and the dossier every reason to name Yes.
    const source = await prisma.source.create({
      data: {
        tier: 'resolution',
        kind: 'api',
        name: 'NBS',
        homeUrl: 'https://nigerianstat.gov.ng',
        trust: '1',
      },
    });
    const item = await prisma.sourceItem.create({
      data: {
        sourceId: source.id,
        headline: 'CPI prints at 23.4%',
        url: 'https://nigerianstat.gov.ng/elibrary/read/1241#aug',
        publishedAt: new Date(),
        factsJson: { 'cpi.yoy.headline': 23.4 },
      },
    });
    await prisma.marketSourceItem.create({
      data: { marketId, itemId: item.id, relevance: '0.98' },
    });
  });

  it('builds a confident dossier and still settles nothing', async () => {
    const dossier = await dossiers.build({ marketId });

    // The dossier is as certain as it will ever be…
    expect(dossier.proposedOutcomeId).toBe(yesId);
    expect(dossier.recommendVoid).toBe(false);
    expect(Number(dossier.confidence)).toBeGreaterThan(0.9);

    // …and nothing has happened to the market.
    const market = await prisma.market.findUniqueOrThrow({ where: { id: marketId } });
    expect(market.state).toBe('frozen');
    expect(market.resolvedOutcomeId).toBeNull();
    expect(await prisma.resolution.count()).toBe(0);
    expect(await prisma.ledgerEntry.count()).toBe(0);
  });

  it('leaves the dispute window untouched', async () => {
    await dossiers.build({ marketId });
    const market = await prisma.market.findUniqueOrThrow({ where: { id: marketId } });
    expect(market.disputeClosesAt).toBeNull();
  });

  it('records a human’s decision without acting on it', async () => {
    await dossiers.build({ marketId });
    const staff = await prisma.user.create({
      data: { email: 'resolver@example.ng', pwHash: 'x', role: 'resolver' },
    });

    await dossiers.recordDecision({ marketId, staffId: staff.id, accepted: true, ip: '10.0.0.1' });

    const dossier = await prisma.resolutionDossier.findUniqueOrThrow({ where: { marketId } });
    expect(dossier.accepted).toBe(true);
    expect(dossier.reviewedBy).toBe(staff.id);
    // Accepting a dossier is a note about a reading, not a resolution.
    expect(await prisma.resolution.count()).toBe(0);
    expect(
      (await prisma.market.findUniqueOrThrow({ where: { id: marketId } })).resolvedOutcomeId,
    ).toBeNull();
  });

  it('rebuilding clears a previous review rather than inheriting it', async () => {
    // Otherwise a market re-analysed after new evidence lands still carries
    // yesterday's sign-off, on a reading nobody has looked at.
    await dossiers.build({ marketId });
    const staff = await prisma.user.create({
      data: { email: 'resolver2@example.ng', pwHash: 'x', role: 'resolver' },
    });
    await dossiers.recordDecision({ marketId, staffId: staff.id, accepted: true, ip: '10.0.0.1' });

    await dossiers.build({ marketId });
    const rebuilt = await prisma.resolutionDossier.findUniqueOrThrow({ where: { marketId } });
    expect(rebuilt.accepted).toBeNull();
    expect(rebuilt.reviewedBy).toBeNull();
  });

  it('says so when nobody looked, rather than writing a confident blank', async () => {
    // A staff member has to be able to tell "nothing to report" from "the
    // analyst never ran". The second is the one that gets a market resolved
    // off an empty screen.
    const unconfigured = new DossierService(prisma, new AdminAuditService(prisma), null);
    const dossier = await unconfigured.build({ marketId });

    expect(dossier.proposedOutcomeId).toBeNull();
    expect(dossier.reasoning).toMatch(/No analysis was run/);
  });

  /**
   * The structural assertion, and the one that survives a refactor.
   *
   * Reading the source rather than calling the service: a test that only calls
   * `build()` and checks the tables passes just as happily on the day somebody
   * adds `settleIfConfident()` and does not call it from `build()`. This fails
   * the moment the import appears.
   */
  it('the dossier service cannot reach the resolution flow at all', () => {
    const source = readFileSync(join(__dirname, 'dossier.service.ts'), 'utf8');

    expect(source).not.toMatch(/ResolutionFlowService/);
    expect(source).not.toMatch(/from '\.\.\/resolution\//);
    expect(source).not.toMatch(/\bLedgerService\b/);
    expect(source).not.toMatch(/\bWalletService\b/);

    // And it writes to exactly one table plus the audit log.
    //
    // The verbs are listed rather than matched with `\w*Many`, which also
    // catches `findMany` — the first version of this assertion reported the
    // service writing to `marketSourceItem`, a table it only reads.
    const writes = [
      ...source.matchAll(
        /prisma\.(\w+)\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\b/g,
      ),
    ]
      .map((match) => match[1])
      .filter((model, index, all) => all.indexOf(model) === index);
    expect(writes.sort()).toEqual(['resolutionDossier']);
  });

  /**
   * And the flow itself still needs two different people.
   *
   * Asserted here as well as in the resolution suite, because this is the
   * property the whole intelligence layer leans on: however good a dossier
   * gets, the thing that settles a market takes two staff ids.
   */
  it('the resolution flow still requires a staff proposal and a second confirmation', () => {
    const flow = readFileSync(
      join(__dirname, '..', 'resolution', 'resolution-flow.service.ts'),
      'utf8',
    );

    // Proposing is gated on a role.
    expect(flow).toMatch(/isStaff\(/);
    // Finalising refuses the proposer.
    expect(flow).toMatch(/proposal\.proposedBy === params\.actor\.userId/);
    expect(flow).toMatch(/someone else confirms it/);
  });
});
