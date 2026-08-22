import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AdminAuditService } from '../audit/admin-audit.service';
import { BriefingService } from '../intel/briefing.service';
import { LedgerService } from '../ledger/ledger.service';
import { MarketHealthService } from '../market/health.service';
import { OfficialMarketService } from '../market/official-market.service';
import { PlatformConfigService } from '../platform-config/platform-config.service';
import type { PrismaService } from '../prisma/prisma.service';
import { resetDatabase } from '../testing/reset';
import { WalletService } from '../wallet/wallet.service';
import {
  QuestionEngineService,
  SubmissionOriginError,
  type SubmissionOrigin,
} from './question-engine.service';
import { SeedService } from './seed.service';
import { TemplateLibraryService } from './template-library';
import { MarketVoidService } from './void.service';
import type { MarketTemplate } from './market-template';
import { approvalAnswers, compliantTemplate } from '../testing/templates';
import type { Assessment, GenerationRequest, Proposal, QuestionModel } from './question-model';
import { CreatorService } from '../creator/creator.service';
import { EmailSender } from '../notifications/email.sender';
import { NotificationsService } from '../notifications/notifications.service';
import { PushSender } from '../notifications/push.sender';
import { SmsSender } from '../notifications/sms.sender';

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

/**
 * A proposal that satisfies the whole ticket-creation checklist.
 *
 * Longer than it was, and every added clause is a rule: the year-on-year
 * qualifier is 28, "first published" is 27, the WAT hours are 26, the silent
 * source is 4, and the exact report URL rather than the institution's homepage
 * is R2. Written out in full because a fixture that skips them is a fixture
 * that only ever exercises the refusal path.
 */
const goodProposal = (overrides: Partial<Proposal> = {}): Proposal => ({
  slot: 'economic_banker',
  question:
    'Will year-on-year headline CPI for June, as first published by the NBS, print below 24.5%?',
  outcomes: [
    {
      label: 'BELOW',
      criteria:
        'The NBS CPI report for June, first published figure, shows year-on-year headline inflation below 24.5%, read at 23:59 WAT. Revisions are ignored.',
    },
    {
      label: 'AT OR ABOVE',
      criteria:
        'That same first published year-on-year headline figure is 24.5% or higher, read at 23:59 WAT.',
    },
  ],
  sourceName: 'NBS CPI report',
  sourceUrl: 'https://nigerianstat.gov.ng/elibrary/read/1241',
  eventDate: inDays(20),
  voidDate: inDays(30),
  edgeCases: {
    delayed: 'Voids if the NBS has not published by the void date.',
    'no publication': 'If the NBS publishes no June CPI report at all, the market voids.',
  },
  balanceEstimates: [0.52, 0.48],
  engagementScore: 0.85,
  rationale: 'Pitched at the analyst consensus of 24.5%, so the argument is real.',
  influenceable: false,
  newsExpected: true,
  rejected: false,
  rejectedRules: [],
  rejectionReason: '',
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
    new QuestionEngineService(
      prisma,
      config,
      new MarketHealthService(prisma),
      new BriefingService(prisma),
      model,
    );

  /** A model that likes what it is shown — the screen path needs one. */
  const goodAssessment = (): Assessment => ({
    balanceEstimates: [0.55, 0.45],
    engagementScore: 0.7,
    influenceable: false,
    sourceSettles: true,
    duplicateOfLiveMarket: false,
    concerns: [],
    verdict: 'looks_good',
    reason: 'A published figure on a known date, with the argument still live.',
  });

  // ------------------------------------ checklist Part 4: the two doors in

  describe('community submissions come through a template or the co-pilot', () => {
    async function creator(email: string): Promise<string> {
      const user = await prisma.user.create({
        data: { email, pwHash: 'x', role: 'user', tier: 1 },
      });
      return user.id;
    }

    const submission = (creatorId: string, origin: SubmissionOrigin) => ({
      template: compliantTemplate(),
      creatorId,
      isFirstMarket: true,
      attestedNoInfluence: true,
      origin,
    });

    it('refuses a market hand-written straight at the endpoint', async () => {
      const engine = engineWith(new StubModel([], goodAssessment()));
      const id = await creator('handwritten@example.ng');

      // A client that skipped the template picker and posted the JSON itself.
      // This is the whole reason the rule lives in the service: a wizard-only
      // rule would wave it through, and the market would be one nobody shaped.
      await expect(
        engine.screen(submission(id, { kind: 'copilot', runId: 'made-up' })),
      ).rejects.toBeInstanceOf(SubmissionOriginError);
      await expect(
        engine.screen(submission(id, { kind: 'template', templateId: 'made-up' })),
      ).rejects.toBeInstanceOf(SubmissionOriginError);

      // And nothing was filed, so a refused origin cannot fill the queue.
      expect(await prisma.marketDraft.count()).toBe(0);
    });

    it('accepts a submission that started from a template in the library', async () => {
      await new TemplateLibraryService(prisma).sync();
      const engine = engineWith(new StubModel([], goodAssessment()));
      const id = await creator('templated@example.ng');

      const screened = await engine.screen(
        submission(id, { kind: 'template', templateId: 'fx-threshold' }),
      );
      expect(screened.state).toBe('suggested');

      // A template is a library, not a ticket: picking the same starting point
      // twice is normal and must not be rationed.
      const again = await engine.screen(
        submission(id, { kind: 'template', templateId: 'fx-threshold' }),
      );
      expect(again.state).toBe('suggested');
    });

    it("will not let one creator spend another creator's co-pilot run", async () => {
      const engine = engineWith(new StubModel([], goodAssessment()));
      const mine = await creator('mine@example.ng');
      const theirs = await creator('theirs@example.ng');
      const run = await prisma.copilotRun.create({
        data: { creatorId: theirs, inputText: 'who go win', proposalJson: {} },
      });

      await expect(
        engine.screen(submission(mine, { kind: 'copilot', runId: run.id })),
      ).rejects.toBeInstanceOf(SubmissionOriginError);
    });

    it('spends a co-pilot run once, even when the submission is refused', async () => {
      const engine = engineWith(new StubModel([], goodAssessment()));
      const id = await creator('spender@example.ng');
      const run = await prisma.copilotRun.create({
        data: { creatorId: id, inputText: 'who go win', proposalJson: {} },
      });

      // A market the checklist refuses. The run is still spent: the refusal is
      // about the question, and re-posting the same rejected market on the same
      // receipt is exactly what the one-use rule is for.
      const refused = await engine.screen({
        ...submission(id, { kind: 'copilot', runId: run.id }),
        template: compliantTemplate({ sourceName: 'widely reported' }),
      });
      expect(refused.state).toBe('rejected');

      const spent = await prisma.copilotRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(spent.usedAt).not.toBeNull();
      expect(spent.usedByDraft).toBe(refused.draftId);

      await expect(
        engine.screen(submission(id, { kind: 'copilot', runId: run.id })),
      ).rejects.toThrow(/already been submitted/);
    });

    it('fails rule 16 when the creator has not attested (and passes when they have)', async () => {
      await new TemplateLibraryService(prisma).sync();
      const engine = engineWith(new StubModel([], goodAssessment()));
      const id = await creator('attesting@example.ng');
      const origin = { kind: 'template', templateId: 'fx-threshold' } as const;

      // The create form collected this attestation and dropped it on the way to
      // the endpoint, so rule 16 failed every submission made through the real
      // UI while every service-level test passed by passing it directly.
      const without = await engine.screen({
        ...submission(id, origin),
        attestedNoInfluence: false,
      });
      expect(without.state).toBe('rejected');
      expect(without.report.findings.find((finding) => finding.rule === '16')?.status).toBe('fail');

      const with_ = await engine.screen(submission(id, origin));
      expect(with_.report.findings.find((finding) => finding.rule === '16')?.status).toBe('pass');
    });
  });

  it('files a good proposal as a scored suggestion', async () => {
    const engine = engineWith(new StubModel([goodProposal()]));
    const drafted = await engine.generate({ slots: ['economic_banker'] });

    expect(drafted).toHaveLength(1);
    expect(drafted[0]?.state).toBe('suggested');
    expect(drafted[0]?.refusals).toHaveLength(0);
    // engagement 0.85 × a near-even split ≈ 0.85, not 0.5.
    expect(drafted[0]?.score).toBeGreaterThan(0.75);

    const queue = await engine.queue();
    expect(queue[0]?.question).toMatch(/headline CPI/);
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
        // Deliberately the same question the stub proposes, so the duplicate
        // check has something to actually catch.
        question:
          'Will year-on-year headline CPI for June, as first published by the NBS, print below 24.5%?',
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
      ...approvalAnswers(),
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
      official.openFromDraft({
        draftId: draft.id,
        staffId: staff.id,
        ip: '10.0.0.2',
        ...approvalAnswers(),
      }),
    ).rejects.toThrow(/Rule 2: The void date has already passed/);
  });

  it('fails closed with no model configured', async () => {
    const engine = engineWith(null);
    await expect(engine.generate({ slots: ['economic_banker'] })).rejects.toThrow(
      /ANTHROPIC_API_KEY/,
    );
    await expect(
      engine.copilot({ text: 'who go win the election for my LGA', creatorId: 'nobody' }),
    ).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });

  it('turns what a creator typed into a full template (§2.14a)', async () => {
    const engine = engineWith(
      new StubModel([
        goodProposal({
          question: 'Who will INEC declare winner of the Surulere LGA chairmanship?',
          outcomes: [
            {
              label: 'ADEBAYO',
              criteria: 'INEC declares Adebayo the winner, per the declaration read at 23:59 WAT.',
            },
            {
              label: 'OKONKWO',
              criteria: 'INEC declares Okonkwo the winner, per the declaration read at 23:59 WAT.',
            },
          ],
          otherLabel: 'Any other candidate',
          sourceName: 'INEC declaration',
          sourceUrl: 'https://inecnigeria.org/elections/lga/surulere/',
          edgeCases: {
            rerun: 'If INEC orders a rerun, the market settles on the rerun declaration.',
            'no publication': 'If INEC declares no winner by the void date, the market voids.',
          },
          balanceEstimates: [0.45, 0.4, 0.15],
        }),
      ]),
    );

    const creator = await prisma.user.create({
      data: { email: `copilot-${Date.now()}@example.ng`, pwHash: 'x', role: 'user', tier: 1 },
    });
    const result = await engine.copilot({
      text: 'who go win the Surulere LGA chairmanship',
      creatorId: creator.id,
    });
    expect(result.template.outcomes).toHaveLength(2);

    // The receipt. Without it the co-pilot path would produce a template
    // nobody can prove came from the co-pilot, and Part 4's "templates or the
    // co-pilot, nothing hand-written" would be a claim the client makes about
    // itself.
    const run = await prisma.copilotRun.findUniqueOrThrow({ where: { id: result.runId } });
    expect(run.creatorId).toBe(creator.id);
    expect(run.inputText).toBe('who go win the Surulere LGA chairmanship');
    expect(run.usedAt).toBeNull();
    expect(result.template.otherLabel).toBe('Any other candidate');
    expect(result.balanced).toBe(true);
    // The co-pilot's output is held to the same checklist a staff draft is, so
    // the creator sees rule by rule what still needs doing rather than being
    // told "looks fine" and refused at approval.
    expect(result.report.failures).toEqual([]);
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

    it('drafts from what was published, and files the same reading with the draft', async () => {
      const cbn = await prisma.source.create({
        data: {
          tier: 'resolution',
          kind: 'rss',
          name: 'CBN',
          homeUrl: 'https://www.cbn.gov.ng/',
          trust: '1',
        },
      });
      const desk = await prisma.source.create({
        data: {
          tier: 'signal',
          kind: 'rss',
          name: 'Internal desk',
          homeUrl: 'https://desk.example',
          trust: '0.4',
        },
      });
      await prisma.sourceItem.create({
        data: {
          sourceId: cbn.id,
          headline: 'CBN holds interest rates as inflation eases to 23.4%',
          url: 'https://www.cbn.gov.ng/news/mpr-hold',
          publishedAt: new Date(Date.now() - 2 * 86_400_000),
          factsJson: { inflation_rate: '23.4%' },
        },
      });
      await prisma.sourceItem.create({
        data: {
          sourceId: desk.id,
          headline: 'CBN interest rates decision leaked to our desk',
          url: 'https://desk.example/leak',
          publishedAt: new Date(Date.now() - 1 * 86_400_000),
          factsJson: {},
        },
      });

      const model = new StubModel([goodProposal()]);
      const drafted = await engineWith(model).generate({ slots: ['economic_banker'] });

      // What the model was given...
      const shown = model.requests[0]?.evidence;
      expect(shown?.stories.map((story) => story.headline)).toEqual([
        'CBN holds interest rates as inflation eases to 23.4%',
      ]);
      expect(shown?.figures.map((figure) => figure.key)).toEqual(['inflation_rate']);
      // Tier 3 is staff-only, and this surface is staff-only — which is exactly
      // the reasoning that leaks a source list, so the gate holds here too.
      expect(JSON.stringify(shown)).not.toContain('Internal desk');

      // ...is what the reviewer sees. Not a fresh briefing built at review
      // time: that would put today's news beside a question written from last
      // week's, which reads as a citation and is not one.
      const row = await prisma.marketDraft.findUniqueOrThrow({
        where: { id: drafted[0]?.draftId ?? '' },
      });
      expect(row.evidenceJson).toEqual(JSON.parse(JSON.stringify(shown)));
    });

    it('will not hold up a flagged market as an example to copy (rule 43)', async () => {
      const engine = engineWith(new StubModel([]));

      const clean = await settledMarket('Balanced question?', [52_000, 48_000]);
      const wobbled = await settledMarket('Balanced in the end?', [51_000, 49_000]);
      // Same final split, same volume, no dispute. The only difference is that
      // the Part 5 sweep flagged this one at 48 hours — which is the whole
      // reason the flag is recorded rather than computed on read, because by
      // settlement there is nothing left in the numbers to see it in.
      await prisma.marketHealthFlag.create({
        data: {
          marketId: wobbled.id,
          rule: '35',
          severity: 'watch',
          message: 'Running 84/16 after 60h. Note it for the next retune.',
          clearedAt: new Date(),
        },
      });

      await engine.recordOutcome(clean.id);
      await engine.recordOutcome(wobbled.id);

      const flaggedLog = await prisma.marketOutcomeLog.findUniqueOrThrow({
        where: { marketId: wobbled.id },
      });
      expect(flaggedLog.warningsFired).toEqual(['35']);

      const exemplars = await engine.exemplars();
      expect(exemplars.map((row) => row.question)).toEqual(['Balanced question?']);
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
