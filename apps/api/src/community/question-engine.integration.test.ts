import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AdminAuditService } from '../audit/admin-audit.service';
import { LedgerService } from '../ledger/ledger.service';
import { OfficialMarketService } from '../market/official-market.service';
import { PlatformConfigService } from '../platform-config/platform-config.service';
import type { PrismaService } from '../prisma/prisma.service';
import { resetDatabase } from '../testing/reset';
import { WalletService } from '../wallet/wallet.service';
import { QuestionEngineService } from './question-engine.service';
import { SeedService } from './seed.service';
import { MarketVoidService } from './void.service';
import type { MarketTemplate } from './market-template';
import type { Assessment, GenerationRequest, Proposal, QuestionModel } from './question-model';

/**
 * §2.9's engine against a real database, with a stand-in for the model.
 *
 * The point of the seam is exactly this: the model's job is to propose, and
 * every decision — blocklist, structure, balance band, duplicates, catalogue,
 * rank — belongs to code that can be tested without an API key. So these tests
 * hand the engine proposals a model might plausibly return, including bad ones,
 * and check what the platform does with them.
 */
const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

const inDays = (days: number): string => new Date(Date.now() + days * 86_400_000).toISOString();

const goodProposal = (overrides: Partial<Proposal> = {}): Proposal => ({
  slot: 'economic_banker',
  question: 'Will headline inflation print below 24.5% for June?',
  outcomes: [
    { label: 'BELOW', criteria: 'The NBS CPI report for June prints under 24.5%.' },
    { label: 'AT OR ABOVE', criteria: 'The NBS CPI report for June prints 24.5% or higher.' },
  ],
  sourceName: 'NBS CPI report',
  sourceUrl: 'https://nigerianstat.gov.ng/',
  eventDate: inDays(20),
  voidDate: inDays(30),
  edgeCases: { delayed: 'Voids if NBS has not published by the void date.' },
  balanceEstimates: [0.52, 0.48],
  engagementScore: 0.85,
  rationale: 'Pitched at the analyst consensus of 24.5%, so the argument is real.',
  ...overrides,
});

/** A model that returns whatever the test tells it to. */
class StubModel implements QuestionModel {
  readonly requests: GenerationRequest[] = [];

  constructor(
    private readonly proposals: Proposal[],
    private readonly assessment?: Assessment,
  ) {}

  async assess(_template: MarketTemplate): Promise<Assessment> {
    if (this.assessment === undefined) throw new Error('no assessment configured');
    return this.assessment;
  }

  async propose(request: GenerationRequest): Promise<Proposal> {
    this.requests.push(request);
    const next = this.proposals.shift();
    if (next === undefined) throw new Error('no proposal configured');
    return { ...next, slot: request.slot };
  }

  async restructure(): Promise<Proposal> {
    const next = this.proposals.shift();
    if (next === undefined) throw new Error('no proposal configured');
    return next;
  }
}

describe.skipIf(!TEST_DATABASE_URL)('question engine (integration)', () => {
  let prisma: PrismaService;
  let config: PlatformConfigService;
  let official: OfficialMarketService;

  beforeAll(async () => {
    prisma = new PrismaClient({
      datasources: { db: { url: TEST_DATABASE_URL as string } },
    }) as unknown as PrismaService;
    await prisma.$connect();
    config = new PlatformConfigService(prisma);
    await config.refresh();

    const ledger = new LedgerService(prisma);
    const wallet = new WalletService(prisma, ledger);
    const notifications = new NotificationsService(
      prisma,
      new PushSender(prisma),
      new EmailSender(),
      new SmsSender(),
    );
    // §2.14c's follow system reaches into the seed path — a seeded market opens
    // the moment the seed lands, and that is when followers hear about it.
    const creators = new CreatorService(prisma, config, notifications);
    const seeds = new SeedService(prisma, config, wallet, new MarketVoidService(ledger), creators);
    official = new OfficialMarketService(prisma, config, seeds, new AdminAuditService(prisma));
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    await prisma.platformConfig.updateMany({
      where: { key: 'official_seed_per_outcome_spc' },
      data: { valueJson: 5_000 },
    });
    await config.refresh();
  });

  const engineWith = (model: QuestionModel | null) =>
    new QuestionEngineService(prisma, config, model);

  it('files a good proposal as a scored suggestion', async () => {
    const engine = engineWith(new StubModel([goodProposal()]));
    const drafted = await engine.generate({ slots: ['economic_banker'] });

    expect(drafted).toHaveLength(1);
    expect(drafted[0]?.state).toBe('suggested');
    expect(drafted[0]?.refusals).toHaveLength(0);
    // engagement 0.85 × a near-even split ≈ 0.85, not 0.5.
    expect(drafted[0]?.score).toBeGreaterThan(0.75);

    const queue = await engine.queue();
    expect(queue[0]?.question).toMatch(/inflation/);
    expect(queue[0]?.slot).toBe('economic_banker');
  });

  it('refuses its own lopsided draft, and keeps the refusal on the record', async () => {
    const engine = engineWith(
      new StubModel([
        goodProposal({
          question: 'Will the sun rise before the CBN meeting?',
          balanceEstimates: [0.95, 0.05],
        }),
      ]),
    );

    const drafted = await engine.generate({ slots: ['economic_banker'] });
    expect(drafted[0]?.state).toBe('rejected');
    expect(drafted[0]?.refusals.join(' ')).toMatch(/outside the band/);

    // Not in the working queue, but visible when an operator asks — §2.9's loop
    // is meant to be watched, and a queue of only good news says nothing.
    expect(await engine.queue()).toHaveLength(0);
    const withRefusals = await engine.queue({ includeRejected: true });
    expect(withRefusals).toHaveLength(1);
    expect(withRefusals[0]?.state).toBe('rejected');
  });

  it('refuses a banned topic outright, whatever the model estimated', async () => {
    const engine = engineWith(
      new StubModel([
        goodProposal({
          question: 'Will the accident on Third Mainland Bridge kill anyone this month?',
          outcomes: [
            { label: 'YES', criteria: 'Police confirm a fatality on the bridge.' },
            { label: 'NO', criteria: 'No fatality is confirmed.' },
          ],
          balanceEstimates: [0.5, 0.5],
        }),
      ]),
    );

    const drafted = await engine.generate({ slots: ['rotating_trending'] });
    expect(drafted[0]?.state).toBe('rejected');
    // The Rulebook's own prohibition, not a balance quibble.
    expect(drafted[0]?.refusals.join(' ')).toMatch(/death|harm|kill/i);
  });

  it('refuses a draft that restates a live market', async () => {
    const template = goodProposal();
    await prisma.market.create({
      data: {
        shelf: 'official',
        question: 'Will headline inflation print below 24.5% for June?',
        sourceName: 'NBS',
        sourceUrl: 'https://nigerianstat.gov.ng/',
        criteriaJson: {},
        edgeCasesJson: {},
        eventDate: new Date(inDays(20)),
        voidDate: new Date(inDays(30)),
        liquidityParam: '50000',
        feeBps: 300,
        state: 'active',
        outcomes: {
          create: [
            { label: 'BELOW', ordinal: 0, priceCurrent: '0.5' },
            { label: 'AT OR ABOVE', ordinal: 1, priceCurrent: '0.5' },
          ],
        },
      },
    });

    const engine = engineWith(new StubModel([template]));
    const drafted = await engine.generate({ slots: ['economic_banker'] });
    expect(drafted[0]?.state).toBe('rejected');
    expect(drafted[0]?.refusals.join(' ')).toMatch(/restates a live market/);
  });

  it('only drafts for slots the shelf has free (§2.9 rule 8)', async () => {
    await prisma.platformConfig.updateMany({
      where: { key: 'official_shelf_slots' },
      data: { valueJson: 2 },
    });
    await config.refresh();

    for (const question of ['Live market one?', 'Live market two?']) {
      await prisma.market.create({
        data: {
          shelf: 'official',
          question,
          sourceName: 'NBS',
          sourceUrl: 'https://nigerianstat.gov.ng/',
          criteriaJson: {},
          edgeCasesJson: {},
          eventDate: new Date(inDays(20)),
          voidDate: new Date(inDays(30)),
          liquidityParam: '50000',
          feeBps: 300,
          state: 'active',
          outcomes: {
            create: [
              { label: 'YES', ordinal: 0, priceCurrent: '0.5' },
              { label: 'NO', ordinal: 1, priceCurrent: '0.5' },
            ],
          },
        },
      });
    }

    const model = new StubModel([goodProposal()]);
    const drafted = await engineWith(model).generate();
    expect(drafted).toHaveLength(0);
    expect(model.requests).toHaveLength(0);
  });

  it('opens an official market from a draft, seeded flat by the platform', async () => {
    const engine = engineWith(new StubModel([goodProposal()]));
    const [drafted] = await engine.generate({ slots: ['economic_banker'] });
    if (drafted === undefined) throw new Error('expected a draft');

    const staff = await prisma.user.create({
      data: { email: 'ops-open@example.ng', pwHash: 'x', role: 'admin', tier: 1 },
    });

    const opened = await official.openFromDraft({
      draftId: drafted.draftId,
      staffId: staff.id,
      ip: '10.0.0.2',
    });

    const market = await prisma.market.findUniqueOrThrow({
      where: { id: opened.marketId },
      include: { outcomes: { orderBy: { ordinal: 'asc' } } },
    });
    expect(market.shelf).toBe('official');
    expect(market.state).toBe('active');
    // 5,000 into each of two pools, and the seed moves no price.
    expect(Number(market.potTotal)).toBe(10_000);
    for (const outcome of market.outcomes) {
      expect(Number(outcome.stakedTotal)).toBe(5_000);
      expect(Number(outcome.priceCurrent)).toBe(0.5);
    }

    // The platform holds every outcome equally: liquidity, not a position.
    const positions = await prisma.position.findMany({ where: { marketId: market.id } });
    expect(positions).toHaveLength(2);
    expect(new Set(positions.map((p) => p.userId))).toEqual(new Set(['sys_platform']));

    const draft = await prisma.marketDraft.findUniqueOrThrow({ where: { id: drafted.draftId } });
    expect(draft.state).toBe('approved');
    expect(draft.reviewedBy).toBe(staff.id);

    // Opening twice would be a second market on the same question.
    await expect(
      official.openFromDraft({ draftId: drafted.draftId, staffId: staff.id, ip: '10.0.0.2' }),
    ).rejects.toThrow(/already approved/);
  });

  it('re-runs the screen at the moment of opening, not just at drafting', async () => {
    const engine = engineWith(new StubModel([goodProposal()]));
    const [drafted] = await engine.generate({ slots: ['economic_banker'] });
    if (drafted === undefined) throw new Error('expected a draft');

    // The world moved: the void date has passed since this was drafted.
    const draft = await prisma.marketDraft.findUniqueOrThrow({ where: { id: drafted.draftId } });
    const stale = {
      ...(draft.templateJson as object),
      eventDate: inDays(-5),
      voidDate: inDays(-2),
    };
    await prisma.marketDraft.update({
      where: { id: draft.id },
      data: { templateJson: stale },
    });

    const staff = await prisma.user.create({
      data: { email: 'ops-stale@example.ng', pwHash: 'x', role: 'admin', tier: 1 },
    });
    await expect(
      official.openFromDraft({ draftId: draft.id, staffId: staff.id, ip: '10.0.0.2' }),
    ).rejects.toThrow(/no longer passes the screen/);
  });

  it('fails closed with no model configured', async () => {
    const engine = engineWith(null);
    await expect(engine.generate({ slots: ['economic_banker'] })).rejects.toThrow(
      /ANTHROPIC_API_KEY/,
    );
    await expect(engine.copilot({ text: 'who go win the election for my LGA' })).rejects.toThrow(
      /ANTHROPIC_API_KEY/,
    );
  });

  it('turns what a creator typed into a full template (§2.14a)', async () => {
    const engine = engineWith(
      new StubModel([
        goodProposal({
          question: 'Who wins the Surulere LGA chairmanship?',
          outcomes: [
            { label: 'ADEBAYO', criteria: 'INEC declares Adebayo the winner.' },
            { label: 'OKONKWO', criteria: 'INEC declares Okonkwo the winner.' },
          ],
          otherLabel: 'Any other candidate',
          sourceName: 'INEC declaration',
          sourceUrl: 'https://inecnigeria.org/',
          balanceEstimates: [0.45, 0.4, 0.15],
        }),
      ]),
    );

    const result = await engine.copilot({ text: 'who go win the Surulere LGA chairmanship' });
    expect(result.template.outcomes).toHaveLength(2);
    expect(result.template.otherLabel).toBe('Any other candidate');
    expect(result.balanced).toBe(true);
    expect(result.problems).toHaveLength(0);
    // Nothing is filed while somebody is still typing.
    expect(await prisma.marketDraft.count()).toBe(0);
  });

  describe('the feedback loop (§2.9)', () => {
    async function settledMarket(question: string, splits: [number, number]) {
      const market = await prisma.market.create({
        data: {
          shelf: 'official',
          question,
          sourceName: 'NBS',
          sourceUrl: 'https://nigerianstat.gov.ng/',
          criteriaJson: {},
          edgeCasesJson: {},
          eventDate: new Date(inDays(-2)),
          voidDate: new Date(inDays(-1)),
          liquidityParam: '50000',
          feeBps: 300,
          state: 'resolved',
          potTotal: String(splits[0] + splits[1]),
          outcomes: {
            create: [
              { label: 'YES', ordinal: 0, priceCurrent: '0.5', stakedTotal: String(splits[0]) },
              { label: 'NO', ordinal: 1, priceCurrent: '0.5', stakedTotal: String(splits[1]) },
            ],
          },
        },
      });
      return market;
    }

    it('records what the crowd actually did, and reads it back as examples', async () => {
      const engine = engineWith(new StubModel([]));

      const balanced = await settledMarket('Balanced question?', [52_000, 48_000]);
      const lopsided = await settledMarket('Obvious question?', [90_000, 10_000]);
      await engine.recordOutcome(balanced.id);
      await engine.recordOutcome(lopsided.id);

      const log = await prisma.marketOutcomeLog.findUniqueOrThrow({
        where: { marketId: balanced.id },
      });
      expect(Number(log.initialSplit)).toBe(0.5);
      expect(Number(log.finalSplit)).toBeCloseTo(0.52, 6);
      expect(log.disputeCount).toBe(0);

      const exemplars = await engine.exemplars();
      expect(exemplars.map((row) => row.question)).toEqual(['Balanced question?']);

      const retune = await engine.lopsided();
      expect(retune.map((row) => row.question)).toEqual(['Obvious question?']);
    });

    it('hands its own hits and misses to the next generation cycle', async () => {
      const engine = engineWith(new StubModel([goodProposal()]));
      const balanced = await settledMarket('Balanced question?', [52_000, 48_000]);
      const lopsided = await settledMarket('Obvious question?', [90_000, 10_000]);
      await engine.recordOutcome(balanced.id);
      await engine.recordOutcome(lopsided.id);

      const model = new StubModel([goodProposal()]);
      await engineWith(model).generate({ slots: ['economic_banker'] });

      const request = model.requests[0];
      expect(request?.exemplars?.[0]?.question).toBe('Balanced question?');
      expect(request?.retune?.[0]?.question).toBe('Obvious question?');
      // Both settled markets are resolved, so neither is on the "already live" list.
      expect(request?.avoid).not.toContain('Balanced question?');
    });
  });
});
import { CreatorService } from '../creator/creator.service';
import { EmailSender } from '../notifications/email.sender';
import { NotificationsService } from '../notifications/notifications.service';
import { PushSender } from '../notifications/push.sender';
import { SmsSender } from '../notifications/sms.sender';
