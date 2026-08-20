/**
 * Matching what was published against what a market is about.
 *
 * Deliberately lexical and deterministic, for the same reason the duplicate
 * check is: this runs over every item from every source against every live
 * market, thousands of times an hour, and a model call per pair would cost
 * more than the whole platform earns in a day. An embedding pass is a seam
 * above this (`SimilarityModel`), not a replacement for it — the cheap filter
 * runs first and the expensive one only sees what survives.
 */

const STOPWORDS = new Set([
  'will',
  'the',
  'a',
  'an',
  'of',
  'in',
  'on',
  'at',
  'by',
  'to',
  'for',
  'be',
  'is',
  'are',
  'was',
  'were',
  'and',
  'or',
  'as',
  'it',
  'its',
  'this',
  'that',
  'with',
  'from',
  'has',
  'have',
  'says',
  'said',
  'after',
  'before',
  'over',
  'new',
  'more',
  'than',
]);

/** Meaningful words, lowercased, punctuation stripped, currency kept. */
export function terms(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9₦%$.\s]/g, ' ')
      .split(/\s+/)
      .map((word) => word.replace(/^\.+|\.+$/g, ''))
      .filter((word) => word.length > 1 && !STOPWORDS.has(word)),
  );
}

/**
 * Proper nouns and figures — the parts of a headline that actually identify
 * what it is about.
 *
 * A crude extractor on purpose. "CBN", "₦1,532" and "Osimhen" are what make an
 * item relevant to a market; "announced", "yesterday" and "reportedly" are
 * what every item has. Capitalisation is the signal available without a model,
 * and it is right often enough in headline case to be worth using — which is
 * why entities *raise* a score rather than gate it.
 */
export function entitiesOf(text: string): Set<string> {
  const found = new Set<string>();

  // Runs of capitalised words, and acronyms — plus each word on its own.
  //
  // The individual words are what makes this work at all. The regex is greedy,
  // so a criteria line beginning "The CBN official window closing rate…"
  // yields the phrase "The CBN", which never matches a headline's bare "CBN".
  // Every entity comparison against a sentence starting with a determiner was
  // silently scoring zero: a wire story about the CBN resuming dollar sales
  // failed to reach the naira market it was plainly about.
  for (const match of text.matchAll(/\b([A-Z][A-Za-z]{1,}(?:\s+[A-Z][A-Za-z]+)*)\b/g)) {
    const phrase = (match[1] ?? '').trim();
    if (phrase.length < 2) continue;

    if (!STOPWORDS.has(phrase.toLowerCase())) found.add(phrase.toLowerCase());
    for (const word of phrase.split(/\s+/)) {
      if (word.length > 1 && !STOPWORDS.has(word.toLowerCase())) found.add(word.toLowerCase());
    }
  }
  // Figures with a unit or currency, which is what a threshold market turns on.
  for (const match of text.matchAll(/(₦|\$)?\s?\d[\d,]*\.?\d*\s?(%|bn|m|k)?/gi)) {
    const figure = (match[0] ?? '').trim();
    if (/\d/.test(figure) && figure.length > 1) found.add(figure.replace(/\s+/g, '').toLowerCase());
  }
  return found;
}

export interface MarketSubject {
  readonly question: string;
  /** The settlement criteria, which name the metric and the source. */
  readonly criteria: readonly string[];
  readonly sourceName: string;
}

/**
 * How relevant one headline is to one market, in [0, 1].
 *
 * Three signals, weighted by how much each is worth: shared entities count
 * most, because two texts naming the CBN and ₦1,500 are about the same thing
 * whatever else they say; shared terms next; and a bonus when the item comes
 * from the market's own named source, which is the one case where relevance is
 * nearly a certainty rather than an estimate.
 */
export function relevanceOf(
  item: { headline: string; sourceName: string },
  market: MarketSubject,
): number {
  const subject = `${market.question} ${market.criteria.join(' ')}`;

  const sharedTerms = evidence(terms(item.headline), terms(subject), 4);
  const sharedEntities = evidence(entitiesOf(item.headline), entitiesOf(subject), 2);
  const fromNamedSource =
    item.sourceName.trim().toLowerCase() === market.sourceName.trim().toLowerCase();

  const score = 0.55 * sharedTerms + 0.3 * sharedEntities + (fromNamedSource ? 0.15 : 0);
  return Math.min(1, Number(score.toFixed(4)));
}

/**
 * How much evidence there is that the item is about the market, in [0, 1].
 *
 * Absolute count against a target, not a fraction — and the difference is the
 * whole scoring function. Two earlier versions got this wrong in opposite
 * directions and both were caught by printing scores across seven headlines
 * rather than by reasoning about them:
 *
 * Jaccard divides by the union, so a ten-word headline against a market's
 * question plus both criteria scored near zero however well it matched. "Naira
 * closes at ₦1,532/$ on the CBN official window" came out at 0.10, under its
 * own relevance floor.
 *
 * Containment then divided by the item's own size, which rewards *short*
 * headlines: "CBN announces new cash withdrawal limits" shares one term with a
 * market about the closing rate and outscored a story that shared three,
 * because one out of five beats three out of seven.
 *
 * A headline sharing three significant terms with a market is more likely
 * about it than one sharing a single acronym, whatever the lengths. So: how
 * many matched, against how many would be convincing.
 */
function evidence(item: Set<string>, subject: Set<string>, convincing: number): number {
  if (item.size === 0 || subject.size === 0) return 0;
  let shared = 0;
  for (const value of item) if (subject.has(value)) shared += 1;
  return Math.min(1, shared / convincing);
}

/** Symmetric overlap, for comparing two things of the same kind. */
function overlap(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const value of left) if (right.has(value)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/**
 * Below this an item is not worth storing against a market.
 *
 * Deliberately generous. Measured against the naira market, this scorer gives:
 *
 *   0.85  CBN official window closing rate ₦1,532.41/$ for the last business day
 *   0.55  Naira closes at ₦1,498/$ on the official window, traders say
 *   0.29  CBN resumes dollar sales to bureaux de change operators
 *   0.29  CBN announces new cash withdrawal limits
 *   0.14  Naira weakens against the dollar
 *   0.00  Super Eagles name squad for the next qualifier
 *   0.00  BBNaija eviction shocks viewers
 *
 * The floor's job is to keep the football out, and football scores zero. What
 * a reader actually sees is decided by *ranking*, not by this cut — which is
 * why it sits well below the weakest story anybody would want.
 *
 * The two 0.29s are honest rather than a defect: lexically those headlines are
 * equivalent evidence, and separating "resumes dollar sales" from "cash
 * withdrawal limits" needs the meaning of the words. That is the embedding
 * pass's job, and it runs above this filter rather than instead of it.
 */
export const RELEVANCE_FLOOR = 0.06;

/**
 * Above this, an item is significant enough to mark on the chart.
 *
 * One of two conditions, not the only one: the panel also marks anything a
 * staff member pinned. A chart annotation is an assertion that this is why the
 * line moved, and a lexical score alone is too thin a reason to make it.
 */
export const ANNOTATION_FLOOR = 0.4;

export interface Clusterable {
  readonly id: string;
  readonly headline: string;
  readonly publishedAt: Date;
}

export interface Cluster {
  readonly id: string;
  readonly headline: string;
  readonly members: readonly string[];
  /** How many outlets carried it. The number a reader actually wants. */
  readonly sourceCount: number;
  readonly firstPublishedAt: Date;
}

/** Two headlines above this are the same story from two newsrooms. */
export const CLUSTER_THRESHOLD = 0.5;

/**
 * Group the same story across outlets.
 *
 * Forty papers running the same wire copy is one thing that happened, and a
 * context panel that lists it forty times is worse than one that lists it
 * once — it buries everything else under the loudest story of the day. The
 * cluster keeps the earliest headline, because the first outlet to carry
 * something is the one worth citing.
 *
 * Greedy and single-pass. Proper agglomerative clustering would be better and
 * would also be O(n²) over a table that grows all day; this runs over one
 * market's recent items, where n is tens.
 */
export function cluster(items: readonly Clusterable[]): Cluster[] {
  const ordered = [...items].sort((a, b) => a.publishedAt.getTime() - b.publishedAt.getTime());
  const clusters: { seed: Clusterable; members: string[]; terms: Set<string> }[] = [];

  for (const item of ordered) {
    const itemTerms = terms(item.headline);
    const home = clusters.find(
      (candidate) => overlap(itemTerms, candidate.terms) >= CLUSTER_THRESHOLD,
    );
    if (home === undefined) {
      clusters.push({ seed: item, members: [item.id], terms: itemTerms });
    } else {
      home.members.push(item.id);
    }
  }

  return clusters.map((entry) => ({
    id: entry.seed.id,
    headline: entry.seed.headline,
    members: entry.members,
    sourceCount: entry.members.length,
    firstPublishedAt: entry.seed.publishedAt,
  }));
}

export interface FactClaim {
  readonly sourceName: string;
  readonly tier: 'resolution' | 'news' | 'signal';
  readonly value: string | number;
}

export interface Conflict {
  readonly factKey: string;
  readonly claims: readonly FactClaim[];
}

/**
 * Where sources disagree about the same fact.
 *
 * Flagged, never reconciled. The average of a published 1,532 and a published
 * 1,498 is 1,515, which is a number nobody published and which no market could
 * defensibly settle on. Two sources disagreeing is a fact about the world that
 * a person needs to see, and the cost of showing it is a line on a screen.
 *
 * Numbers compare with a tolerance because "23.4%" and "23.40%" are the same
 * claim typed differently, and a conflict raised on formatting would teach
 * everybody to ignore the conflict list.
 */
export function detectConflicts(
  claims: readonly (FactClaim & { factKey: string })[],
  tolerance = 0.001,
): Conflict[] {
  const byKey = new Map<string, (FactClaim & { factKey: string })[]>();
  for (const claim of claims) {
    const bucket = byKey.get(claim.factKey) ?? [];
    bucket.push(claim);
    byKey.set(claim.factKey, bucket);
  }

  const conflicts: Conflict[] = [];
  for (const [factKey, bucket] of byKey) {
    if (bucket.length < 2) continue;

    const disagrees = bucket.some((claim) =>
      bucket.some((other) => !same(claim.value, other.value, tolerance)),
    );
    if (disagrees) {
      conflicts.push({
        factKey,
        claims: bucket.map((claim) => ({
          sourceName: claim.sourceName,
          tier: claim.tier,
          value: claim.value,
        })),
      });
    }
  }
  return conflicts;
}

function same(left: string | number, right: string | number, tolerance: number): boolean {
  const a = numeric(left);
  const b = numeric(right);
  if (a !== null && b !== null) {
    return Math.abs(a - b) <= tolerance * Math.max(1, Math.abs(a));
  }
  return String(left).trim().toLowerCase() === String(right).trim().toLowerCase();
}

/**
 * The number in a claim, or null when there isn't one.
 *
 * The null matters more than the number. Stripping non-digits from "hold"
 * leaves an empty string, and `Number('')` is **0** rather than NaN — so the
 * first version of this compared "hold" against "cut" as 0 against 0 and
 * reported no conflict between a rate hold and a rate cut. Every conflict
 * between two *statements* was invisible.
 */
function numeric(value: string | number): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const digits = value.replace(/[^\d.-]/g, '');
  if (digits.trim().length === 0) return null;
  const parsed = Number(digits);
  return Number.isFinite(parsed) ? parsed : null;
}
