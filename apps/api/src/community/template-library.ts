import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Prisma, type TemplateCategory } from '@prisma/client';

import { logger } from '../logger';
import { PrismaService } from '../prisma/prisma.service';

export interface LibraryTemplate {
  readonly id: string;
  readonly category: TemplateCategory;
  readonly name: string;
  readonly question: string;
  readonly outcomes: readonly { readonly label: string; readonly criteria: string }[];
  readonly otherLabel?: string;
  readonly sourceName: string;
  readonly sourceUrl: string;
}

/**
 * The starter templates (§2.14a), owned by the server.
 *
 * A blank form is the reason most people never create a market: they do not
 * know what a settleable question looks like. Each one is a worked example with
 * the source already named — the part creators get wrong most often, and the
 * part the Rulebook's golden rule turns on.
 *
 * These lived in the web bundle until checklist Part 4 made "you started from a
 * template" something the server has to verify. A list only the client holds
 * cannot be checked against, so a submission could name any template id it
 * liked and the rule would be decoration.
 *
 * The bracketed placeholders stay. A template is a shape to fill in, and one
 * submitted with `[team]` still in the question fails rule 1 at the checklist
 * like anything else — the wizard is not the thing stopping it.
 */
export const TEMPLATE_LIBRARY: readonly LibraryTemplate[] = [
  {
    id: 'match-result',
    category: 'football',
    name: 'Match result',
    question: 'Will [team] beat [opponent] on [day]?',
    outcomes: [
      { label: 'YES', criteria: '[team] wins in regulation or extra time.' },
      { label: 'NO', criteria: 'Draw, loss, or the match is decided on penalties.' },
    ],
    sourceName: 'CAF official match report',
    sourceUrl: 'https://www.cafonline.com/',
  },
  {
    id: 'fx-threshold',
    category: 'economic',
    name: 'Naira threshold',
    question: 'Will the naira close under ₦[rate]/$ on [date]?',
    outcomes: [
      { label: 'YES', criteria: 'The CBN closing rate is below ₦[rate] to the dollar.' },
      { label: 'NO', criteria: 'The rate is ₦[rate] or above.' },
    ],
    sourceName: 'CBN official rate',
    sourceUrl: 'https://www.cbn.gov.ng/rates/',
  },
  {
    id: 'who-wins',
    category: 'election',
    name: 'Who wins',
    question: 'Who wins the [race]?',
    outcomes: [
      { label: '[Candidate A]', criteria: 'Declared winner by INEC.' },
      { label: '[Candidate B]', criteria: 'Declared winner by INEC.' },
    ],
    otherLabel: 'Any other',
    sourceName: 'INEC declared result',
    sourceUrl: 'https://inecnigeria.org/',
  },
  {
    id: 'eviction',
    category: 'bbnaija',
    name: 'Eviction night',
    question: 'Will [housemate] be evicted on [date]?',
    outcomes: [
      { label: 'YES', criteria: '[housemate] is announced as evicted in that live show.' },
      { label: 'NO', criteria: 'They are not evicted in that show.' },
    ],
    sourceName: 'Africa Magic live show',
    sourceUrl: 'https://africamagic.dstv.com/',
  },
];

/**
 * Keeps `ticket_templates` in step with the library above.
 *
 * The table already existed and was already read in three places — the
 * creator's opportunity feed, the admin template screen, the AI's
 * template-backed drafts — and nothing had ever written a row to it. All three
 * were quietly rendering an empty list.
 *
 * Synced on boot rather than by a migration because the library is content:
 * changing a template's wording should not need a schema change, and a
 * deployment should never be running against templates from two releases ago.
 * `active` is left alone on an existing row — an operator who retired a
 * template through the admin screen meant it, and a redeploy must not quietly
 * bring it back.
 */
@Injectable()
export class TemplateLibraryService implements OnModuleInit {
  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    try {
      const synced = await this.sync();
      logger.info({ synced }, 'ticket templates synced');
    } catch (error) {
      // Not fatal. A missing template library means the create page offers no
      // starting points, which is bad; refusing to boot the whole API over it
      // would be worse.
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        'could not sync ticket templates — the create page will have no starting points',
      );
    }
  }

  async sync(): Promise<number> {
    for (const template of TEMPLATE_LIBRARY) {
      const json = JSON.parse(JSON.stringify(template)) as Prisma.InputJsonValue;
      await this.prisma.ticketTemplate.upsert({
        where: { id: template.id },
        create: {
          id: template.id,
          category: template.category,
          templateJson: json,
          localisableFields: ['question', 'outcomes'] as Prisma.InputJsonValue,
        },
        update: { category: template.category, templateJson: json },
      });
    }
    return TEMPLATE_LIBRARY.length;
  }

  /**
   * The library as the create page shows it: active rows only.
   *
   * Re-syncs when the table is *entirely* empty, which is the one state that
   * cannot be anybody's intention. Syncing only at boot turned out to be too
   * fragile: anything that clears the table — a restored backup taken before
   * the library existed, a test suite's reset, a fresh environment whose API
   * happened to start before its migration — leaves the create page blank until
   * somebody redeploys, and a blank create page looks like a broken product
   * rather than a missing row.
   *
   * Empty *and* the table has rows is a different thing entirely: an operator
   * retired every template through the admin screen, and they meant it. That is
   * why the check counts rows rather than reading `list()`'s own result.
   */
  async list(): Promise<LibraryTemplate[]> {
    if ((await this.prisma.ticketTemplate.count()) === 0) {
      await this.sync();
    }
    const rows = await this.prisma.ticketTemplate.findMany({
      where: { active: true },
      orderBy: { id: 'asc' },
    });
    return rows.map((row) => row.templateJson as unknown as LibraryTemplate);
  }
}
