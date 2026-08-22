import { Injectable } from '@nestjs/common';
import { isPublicTier } from '@stakeam/rules';

import { PrismaService } from '../prisma/prisma.service';
import {
  cluster,
  detectConflicts,
  relevanceOf,
  RELEVANCE_FLOOR,
  type FactClaim,
} from './relevance';

/**
 * How far back a briefing looks, and how much of it the model is shown.
 *
 * Fourteen days because a shelf slot is a fortnight's argument — anything older
 * is background rather than news, and a draft grounded in last month's story is
 * a draft about something that has already been settled by events.
 *
 * The two caps are separate on purpose. `READ` is how much the briefing scores;
 * `SHOWN` is how much reaches the prompt, and it is small because a model given
 * forty headlines writes about the loudest one rather than the most tradeable.
 */
const WINDOW_DAYS = 14;
const READ = 400;
const SHOWN = 8;

/** One story, as the evidence panel shows it. */
export interface EvidenceStory {
  readonly headline: string;
  readonly url: string;
  readonly sourceName: string;
  readonly tier: 'resolution' | 'news';
  readonly publishedAt: string;
  /** How many outlets carried it. One is a report; nine is a story. */
  readonly sourceCount: number;
  readonly relevance: number;
}

/** One figure pulled out of an item, with where it came from. */
export interface EvidenceFigure {
  readonly key: string;
  readonly value: string;
  readonly sourceName: string;
  readonly tier: 'resolution' | 'news';
  readonly publishedAt: string;
  readonly url: string;
}

/** What the engine read before it drafted, and what it found. */
export interface SlotBriefing {
  readonly brief: string;
  readonly windowDays: number;
  /** Items scored. Zero here is the honest answer, not an empty panel. */
  readonly itemsRead: number;
  readonly stories: readonly EvidenceStory[];
  readonly figures: readonly EvidenceFigure[];
  /** Where two sources published different numbers for the same thing. */
  readonly conflicts: readonly { factKey: string; claims: readonly FactClaim[] }[];
  readonly builtAt: string;
}

/**
 * What the research pipeline knows about a shelf slot, assembled for one draft.
 *
 * The intelligence brief's third section: "evidence-backed AI drafts". A draft
 * that arrives with a question and nothing else asks a reviewer to take the
 * engine's word for it, and the reviewer's only options are to believe it or to
 * go and do the reading themselves. Either way the checklist's judgement calls
 * — is this actually in the news, is the source going to publish a figure on
 * the day — are being made on no evidence.
 *
 * So the same briefing goes to two places: into the prompt, so the draft is
 * grounded in what was actually published, and onto the draft row, so the
 * reviewer sees the reading rather than the conclusion. It is deliberately the
 * *same object* — a panel showing evidence the model never saw would be a
 * decoration, and a worse one for looking like a citation.
 *
 * Tier 3 never appears. `isPublicTier` is the gate, in the rules package, so
 * "staff-only signals stay staff-only" is one decision rather than one per
 * screen — and this screen is staff-only anyway, which is exactly the sort of
 * reasoning that leaks a source list into a public API two refactors later.
 */
@Injectable()
export class BriefingService {
  constructor(private readonly prisma: PrismaService) {}

  async forSlot(params: { brief: string; now?: Date }): Promise<SlotBriefing> {
    const now = params.now ?? new Date();
    const since = new Date(now.getTime() - WINDOW_DAYS * 86_400_000);

    const items = await this.prisma.sourceItem.findMany({
      where: { publishedAt: { gte: since, lte: now } },
      orderBy: { publishedAt: 'desc' },
      take: READ,
      include: { source: { select: { name: true, tier: true } } },
    });

    const publishable = items.filter((item) => isPublicTier(item.source.tier));

    // The slot brief is the subject. It has no criteria and no named source, so
    // relevance here rests on shared terms and entities alone — which is why
    // the floor still applies: a slot with nothing published about it should
    // produce an empty panel, not the fortnight's four hundred loudest stories.
    const subject = { question: params.brief, criteria: [], sourceName: '' };
    const scored = publishable
      .map((item) => ({
        item,
        relevance: relevanceOf({ headline: item.headline, sourceName: item.source.name }, subject),
      }))
      .filter((row) => row.relevance >= RELEVANCE_FLOOR)
      .sort((a, b) => b.relevance - a.relevance);

    const relevanceById = new Map(scored.map((row) => [row.item.id, row.relevance]));
    const itemById = new Map(scored.map((row) => [row.item.id, row.item]));

    const clusters = cluster(
      scored.map((row) => ({
        id: row.item.id,
        headline: row.item.headline,
        publishedAt: row.item.publishedAt,
      })),
    );

    const stories: EvidenceStory[] = clusters
      .map((group) => {
        // The cluster's seed, not whichever row the query returned first: the
        // clusterer keeps the earliest member, and the first outlet to carry
        // something is the one worth citing.
        const seed = itemById.get(group.id);
        if (seed === undefined) return null;
        return {
          headline: seed.headline,
          url: seed.url,
          sourceName: seed.source.name,
          tier: seed.source.tier as 'resolution' | 'news',
          publishedAt: seed.publishedAt.toISOString(),
          sourceCount: group.sourceCount,
          // The cluster's relevance is its best member's. A wire story that one
          // outlet headlined precisely should not be buried because thirty
          // others ran a vaguer version of it.
          relevance: Math.max(
            ...group.members.map((id) => relevanceById.get(id) ?? 0),
            relevanceById.get(group.id) ?? 0,
          ),
        };
      })
      .filter((story): story is EvidenceStory => story !== null)
      .sort((a, b) => b.sourceCount - a.sourceCount || b.relevance - a.relevance)
      .slice(0, SHOWN);

    const figures: EvidenceFigure[] = [];
    const claims: (FactClaim & { factKey: string })[] = [];
    for (const { item } of scored) {
      for (const [key, value] of Object.entries(asRecord(item.factsJson))) {
        const tier = item.source.tier as 'resolution' | 'news';
        claims.push({ factKey: key, sourceName: item.source.name, tier, value: value as never });
        figures.push({
          key,
          value: String(value),
          sourceName: item.source.name,
          tier,
          publishedAt: item.publishedAt.toISOString(),
          url: item.url,
        });
      }
    }

    return {
      brief: params.brief,
      windowDays: WINDOW_DAYS,
      itemsRead: publishable.length,
      stories,
      // Newest first, and capped: the panel is a reading list, not a data dump.
      figures: figures
        .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
        .slice(0, SHOWN * 2),
      // Flagged, never reconciled — the same rule the live ticket follows. A
      // slot whose sources disagree about the number is a slot where the
      // settlement criteria have to name which source wins, and that is a thing
      // the reviewer needs to decide before publishing, not after.
      conflicts: detectConflicts(claims),
      builtAt: now.toISOString(),
    };
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
