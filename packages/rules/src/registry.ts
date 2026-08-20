/**
 * `docs/ticket-creation-checklist.md`, as a table code can index.
 *
 * The checklist is the law; this is the register of who enforces which part of
 * it. Every numbered rule in the document has exactly one entry here, and the
 * suite in `__tests__/checklist-sync.test.ts` fails the build if that stops
 * being true in either direction — a rule added to the document with nothing
 * enforcing it, or an entry here citing a rule that no longer exists.
 *
 * That gate is the point of the file. Without it the document and the code
 * drift within a release: somebody adds rule 44 to the checklist, nothing
 * validates it, and the wizard's review screen quietly reports a clean pass on
 * a market that breaks a rule the team believes is enforced. A green review is
 * a claim about the whole checklist, so it has to be one.
 */

/** Which part of the checklist a rule comes from. */
export type Part =
  'non-negotiable' | 'commercial' | 'forbidden' | 'craft' | 'after-publishing' | 'red-flag';

/**
 * What happens when a rule is not satisfied.
 *
 * - `block` — publish is refused. Reserved for what the checklist calls a
 *   non-negotiable, the forbidden list, and the structural facts a market
 *   cannot be settled without.
 * - `warn` — publishable, but the wizard asks for a confirmation and records
 *   the reason. These are commercial judgements: a market outside the balance
 *   band is a bad market, not an unpublishable one, and staff sometimes have a
 *   reason the software does not know.
 * - `confirm` — a question only a person can answer, put to them explicitly on
 *   the review screen. Software cannot run the stranger test.
 * - `monitor` — nothing to check at publish; a job watches it afterwards.
 * - `practice` — a working instruction for staff with no artefact to validate
 *   (have the source page open, resolve promptly). Listed so the register
 *   covers the document, and marked so the sync test does not demand a
 *   validator that could only ever return `pass`.
 */
export type Enforcement = 'block' | 'warn' | 'confirm' | 'monitor' | 'practice';

/** Where the rule is applied. A rule can bind in more than one place. */
export type Surface = 'ai' | 'wizard' | 'community' | 'monitor';

export interface Rule {
  /** The number as printed in the checklist. Red flags are numbered R1-R6. */
  readonly id: string;
  readonly part: Part;
  readonly enforcement: Enforcement;
  /** Short name, used as the review screen's line label. */
  readonly title: string;
  /** What a failure means, in the words the reviewer sees. */
  readonly detail: string;
  readonly surfaces: readonly Surface[];
}

/**
 * The register.
 *
 * Order follows the document rather than any grouping that would read better
 * here — the review screen prints it in this order, and a reviewer holding the
 * checklist should be able to follow along line by line.
 */
export const RULES: readonly Rule[] = [
  // PART 1 — THE FIVE NON-NEGOTIABLES
  {
    id: '1',
    part: 'non-negotiable',
    enforcement: 'block',
    title: 'One named official source',
    detail:
      'Name the exact body and page. "Widely reported", "the news" and "confirmed sources" are not sources.',
    surfaces: ['ai', 'wizard', 'community'],
  },
  {
    id: '2',
    part: 'non-negotiable',
    enforcement: 'block',
    title: 'An event date and a separate void date',
    detail:
      'The void date is when everyone is refunded if it has not happened. A market without one can trap money indefinitely.',
    surfaces: ['ai', 'wizard', 'community'],
  },
  {
    id: '3',
    part: 'non-negotiable',
    enforcement: 'block',
    title: 'Complete, mutually exclusive outcomes',
    detail:
      'Binary must be truly binary. A multi-outcome market needs an "Any other" bucket so no result falls outside the list, and no two outcomes may overlap.',
    surfaces: ['ai', 'wizard', 'community'],
  },
  {
    id: '4',
    part: 'non-negotiable',
    enforcement: 'block',
    title: 'Edge cases mapped in advance',
    detail:
      'Postponed, cancelled, abandoned, replayed, source publishes nothing, result disputed, methodology changed — each maps to an outcome or to VOID, on the page before trading opens.',
    surfaces: ['ai', 'wizard', 'community'],
  },
  {
    id: '5',
    part: 'non-negotiable',
    enforcement: 'block',
    title: 'Nobody trading can influence the outcome',
    detail: 'Public, national-scale events only.',
    surfaces: ['ai', 'wizard', 'community'],
  },

  // PART 2 — COMMERCIAL RULES
  {
    id: '6',
    part: 'commercial',
    enforcement: 'warn',
    title: 'Genuine disagreement — 35-65%',
    detail:
      'Would two friends actually stake against each other on this? An obvious answer produces a one-sided pool, pennies in fees, and often fails to activate.',
    surfaces: ['ai', 'wizard', 'community'],
  },
  {
    id: '7',
    part: 'commercial',
    enforcement: 'warn',
    title: 'Thresholds at consensus, not round numbers',
    detail:
      '"Inflation below 20%" when the trend is 30% is dead on arrival. Pitch against the published forecast.',
    surfaces: ['ai', 'wizard'],
  },
  {
    id: '8',
    part: 'commercial',
    enforcement: 'warn',
    title: 'Expect news flow before settlement',
    detail:
      'A question nobody hears about again until the result earns once; one in the news daily earns all week.',
    surfaces: ['ai', 'wizard'],
  },
  {
    id: '9',
    part: 'commercial',
    enforcement: 'warn',
    title: 'Emotional stakes',
    detail:
      'Football, elections, naira, fuel, entertainment — things people already argue about unprompted.',
    surfaces: ['ai', 'wizard'],
  },
  {
    id: '10',
    part: 'commercial',
    enforcement: 'warn',
    title: 'Deadline close enough to hold attention',
    detail: 'Days to weeks normally; months only for blockbusters like elections and tournaments.',
    surfaces: ['ai', 'wizard', 'community'],
  },
  {
    id: '11',
    part: 'commercial',
    enforcement: 'warn',
    title: 'Prefer multi-outcome where the story allows',
    detail:
      '"Who wins?" splits money across several outcomes — naturally more balanced, and every fanbase gets a reason to stake.',
    surfaces: ['ai', 'wizard'],
  },
  {
    id: '12',
    part: 'commercial',
    enforcement: 'warn',
    title: 'Round, memorable thresholds where they do not hurt balance',
    detail:
      '₦1,500/$ is easier to argue about than ₦1,487/$ — pick the memorable number near consensus.',
    surfaces: ['ai', 'wizard'],
  },

  // PART 3 — THE FORBIDDEN LIST
  {
    id: '13',
    part: 'forbidden',
    enforcement: 'block',
    title: 'No death, injury, illness or harm',
    detail: 'Markets on harm to a person are never published.',
    surfaces: ['ai', 'wizard', 'community'],
  },
  {
    id: '14',
    part: 'forbidden',
    enforcement: 'block',
    title: 'No crime, violence, terrorism or security incidents',
    detail: 'Markets on these are never published.',
    surfaces: ['ai', 'wizard', 'community'],
  },
  {
    id: '15',
    part: 'forbidden',
    enforcement: 'block',
    title: 'No private individuals or private matters',
    detail: 'Public events and public figures acting publicly only.',
    surfaces: ['ai', 'wizard', 'community'],
  },
  {
    id: '16',
    part: 'forbidden',
    enforcement: 'block',
    title: 'Nothing a participant can influence or has inside knowledge of',
    detail: 'The creator attests to this, and the attestation is recorded against the submission.',
    surfaces: ['ai', 'wizard', 'community'],
  },
  {
    id: '17',
    part: 'forbidden',
    enforcement: 'block',
    title: 'No outcome without a checkable official source',
    detail: 'If no public page settles it, it does not open.',
    surfaces: ['ai', 'wizard', 'community'],
  },
  {
    id: '18',
    part: 'forbidden',
    enforcement: 'confirm',
    title: 'The front-page test',
    detail:
      'Would this embarrass the platform if screenshotted? Legal but tasteless markets cost more in brand than they earn in fees.',
    surfaces: ['wizard', 'community'],
  },
  {
    id: '19',
    part: 'forbidden',
    enforcement: 'block',
    title: 'No markets on the platform itself',
    detail: 'Its operations, staff or finances — a conflict of interest.',
    surfaces: ['ai', 'wizard', 'community'],
  },
  {
    id: '20',
    part: 'forbidden',
    enforcement: 'block',
    title: 'Neutral wording on political events',
    detail:
      'The event may be political; the wording must be neutral. Never phrase a market so one side reads as an insult.',
    surfaces: ['ai', 'wizard', 'community'],
  },

  // PART 4 — CRAFT & OPERATIONS
  {
    id: '21',
    part: 'craft',
    enforcement: 'block',
    title: 'Duplicate check before publishing',
    detail: 'Two similar markets split liquidity and both die. Merge or differentiate clearly.',
    surfaces: ['ai', 'wizard', 'community'],
  },
  {
    id: '22',
    part: 'craft',
    enforcement: 'block',
    title: 'Freeze at event start',
    detail:
      'Trading stops at kickoff, poll close or publication time, so nobody trades on a known result.',
    surfaces: ['wizard', 'community'],
  },
  {
    id: '23',
    part: 'craft',
    enforcement: 'practice',
    title: 'Wording is final once open',
    detail:
      'Typos may be fixed; meaning never. Read it twice as the losing side hunting for a loophole.',
    surfaces: ['wizard'],
  },
  {
    id: '24',
    part: 'craft',
    enforcement: 'warn',
    title: 'Size L to expected volume',
    detail:
      'About 25x a typical stake. Too small and the price swings wildly; too large and the market looks frozen.',
    surfaces: ['wizard', 'community'],
  },
  {
    id: '25',
    part: 'craft',
    enforcement: 'confirm',
    title: 'The stranger test',
    detail:
      'Could someone with no context resolve this correctly using only this page and the named source? If two reasonable people could settle it differently, rewrite it.',
    surfaces: ['wizard', 'community'],
  },
  {
    id: '26',
    part: 'craft',
    enforcement: 'block',
    title: 'State the timezone and the hour',
    detail: '"By 30 September" means nothing without a zone and a time. Use WAT and give an hour.',
    surfaces: ['ai', 'wizard', 'community'],
  },
  {
    id: '27',
    part: 'craft',
    enforcement: 'block',
    title: 'First-published-figure rule',
    detail:
      'For a statistic that gets revised — inflation, GDP — say that the first published figure governs and revisions are ignored.',
    surfaces: ['ai', 'wizard', 'community'],
  },
  {
    id: '28',
    part: 'craft',
    enforcement: 'block',
    title: 'Name the exact metric',
    detail:
      '"Inflation" is ambiguous — say "year-on-year headline CPI as published by NBS". "Fuel price" — say "NNPC retail price in Lagos".',
    surfaces: ['ai', 'wizard', 'community'],
  },
  {
    id: '29',
    part: 'craft',
    enforcement: 'block',
    title: 'State currency, unit and rate window',
    detail: 'Which naira rate — official window, closing, or average? Say which.',
    surfaces: ['ai', 'wizard', 'community'],
  },
  {
    id: '30',
    part: 'craft',
    enforcement: 'warn',
    title: 'Icon, category and tags set',
    detail: 'So the market is findable and looks finished on the card.',
    surfaces: ['wizard', 'community'],
  },
  {
    id: '31',
    part: 'craft',
    enforcement: 'warn',
    title: 'Launch timing',
    detail:
      'Early enough to accumulate liquidity, late enough that interest exists. Fixtures 3-7 days ahead; elections weeks to months.',
    surfaces: ['ai', 'wizard'],
  },
  {
    id: '32',
    part: 'craft',
    enforcement: 'warn',
    title: 'Recurring markets: refresh thresholds each cycle',
    detail: "Last month's consensus is not this month's — retune or the series drifts lopsided.",
    surfaces: ['wizard'],
  },
  {
    id: '33',
    part: 'craft',
    enforcement: 'warn',
    title: 'Check the calendar for collisions',
    detail:
      'Do not launch five markets settling the same day; stagger settlements so the app always has something live.',
    surfaces: ['wizard'],
  },
  {
    id: '34',
    part: 'craft',
    enforcement: 'warn',
    title: 'Do not over-list',
    detail: 'A few busy markets beat many empty ones. Concentrate liquidity.',
    surfaces: ['wizard'],
  },

  // PART 5 — AFTER PUBLISHING
  {
    id: '35',
    part: 'after-publishing',
    enforcement: 'monitor',
    title: 'Watch the split for 48 hours',
    detail: 'Anything running past 75/25 was probably a bad question. Note it for the next retune.',
    surfaces: ['monitor'],
  },
  {
    id: '36',
    part: 'after-publishing',
    enforcement: 'monitor',
    title: 'Watch for one-sided whale entry',
    detail:
      'A single large early position on a thin market distorts the price. Consider seeding the other side or lowering L next time.',
    surfaces: ['monitor'],
  },
  {
    id: '37',
    part: 'after-publishing',
    enforcement: 'practice',
    title: 'Pin news as the story develops',
    detail:
      'It feeds the chart annotations and the context panel, and it keeps traders coming back.',
    surfaces: ['monitor'],
  },
  {
    id: '38',
    part: 'after-publishing',
    enforcement: 'monitor',
    title: 'Prepare the resolution before the event ends',
    detail: 'Have the source page open and know exactly which figure or statement you will cite.',
    surfaces: ['monitor'],
  },
  {
    id: '39',
    part: 'after-publishing',
    enforcement: 'monitor',
    title: 'Resolve promptly',
    detail:
      'Slow settlement is the fastest way to lose trust. Propose within hours of the result, not days.',
    surfaces: ['monitor'],
  },
  {
    id: '40',
    part: 'after-publishing',
    enforcement: 'practice',
    title: 'Never resolve alone',
    detail:
      'Four-eyes: one staff member proposes, a second confirms. This protects you as much as the users.',
    surfaces: ['monitor'],
  },
  {
    id: '41',
    part: 'after-publishing',
    enforcement: 'practice',
    title: 'Honour the dispute window even when the result is obvious',
    detail: 'Skipping process on easy cases teaches you to skip it on hard ones.',
    surfaces: ['monitor'],
  },
  {
    id: '42',
    part: 'after-publishing',
    enforcement: 'practice',
    title: 'Void cleanly and loudly',
    detail:
      'Refund immediately and explain why in-app. A well-handled void builds more trust than a smooth settlement.',
    surfaces: ['monitor'],
  },
  {
    id: '43',
    part: 'after-publishing',
    enforcement: 'monitor',
    title: 'Log the post-mortem',
    detail:
      'Volume, final split, disputes, what you would change. This is the data that trains the question engine.',
    surfaces: ['monitor'],
  },

  // PART 6 — RED FLAGS TO STOP AND RETHINK
  {
    id: 'R1',
    part: 'red-flag',
    enforcement: 'practice',
    title: 'You had to explain it twice',
    detail: 'If a friend needed it explained twice before they understood it, rewrite it.',
    surfaces: ['ai', 'wizard'],
  },
  {
    id: 'R2',
    part: 'red-flag',
    enforcement: 'block',
    title: 'You cannot name the exact webpage',
    detail: 'If you cannot name the page that will settle it, do not publish.',
    surfaces: ['ai', 'wizard', 'community'],
  },
  {
    id: 'R3',
    part: 'red-flag',
    enforcement: 'confirm',
    title: 'You are hoping a particular side wins',
    detail: 'That is a conflict. Hand it to someone else.',
    surfaces: ['wizard'],
  },
  {
    id: 'R4',
    part: 'red-flag',
    enforcement: 'practice',
    title: 'The interesting part is how, not whether',
    detail: 'Then the question is wrong.',
    surfaces: ['ai', 'wizard'],
  },
  {
    id: 'R5',
    part: 'red-flag',
    enforcement: 'practice',
    title: 'You are unsure whether it is on the forbidden list',
    detail: 'Treat that uncertainty as a no.',
    surfaces: ['ai', 'wizard', 'community'],
  },
  {
    id: 'R6',
    part: 'red-flag',
    enforcement: 'block',
    title: 'The appeal depends on a rumour',
    detail: 'If there is no scheduled event behind it, wait for a date.',
    surfaces: ['ai', 'wizard', 'community'],
  },
];

const BY_ID = new Map(RULES.map((rule) => [rule.id, rule]));

/**
 * Look a rule up, loudly.
 *
 * Throws rather than returning undefined: every call site is code that has just
 * decided a market fails rule N, and a lookup miss there means the register and
 * the validators disagree about what N is. Silently rendering "rule undefined"
 * on a review screen is worse than a crash in a test.
 */
export function rule(id: string): Rule {
  const found = BY_ID.get(id);
  if (found === undefined) throw new Error(`no such checklist rule: ${id}`);
  return found;
}

/** Rules that bind on one surface, in checklist order. */
export function rulesFor(surface: Surface): readonly Rule[] {
  return RULES.filter((entry) => entry.surfaces.includes(surface));
}
