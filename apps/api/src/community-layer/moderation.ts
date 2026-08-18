/**
 * §2.15e's moderation rules.
 *
 * "Hard bans: tips-for-sale, external betting links, 'DM me for sure odds' —
 * parasite-tipster patterns auto-flagged."
 *
 * These are the patterns that turn a prediction market's comment section into
 * somebody else's customer acquisition channel, so they are matched here rather
 * than left to a model: the rule has to be the same on every comment, at 3am,
 * with no API key, and it has to be explainable to the person whose comment was
 * held. §2.15e's "AI-assisted moderation queue" sits *after* this — a human
 * reviews what the rules flag, and the rules never delete anything themselves.
 *
 * Pure, and deliberately conservative in one direction only: a false flag costs
 * a reviewer thirty seconds, while a missed tipster costs the platform its
 * comment section.
 */

export type FlagKind =
  'external_betting' | 'tips_for_sale' | 'contact_harvesting' | 'guaranteed_odds' | 'banned_topic';

export interface Flag {
  readonly kind: FlagKind;
  /** What matched, shown to the reviewer so the decision is checkable. */
  readonly evidence: string;
}

/** Sportsbooks and tipster shops whose links turn the thread into their funnel. */
const BETTING_DOMAINS = [
  'bet9ja',
  'sportybet',
  'betking',
  '1xbet',
  'nairabet',
  'betway',
  'msport',
  'parimatch',
  'melbet',
  'stake.com',
  'bangbet',
  'betano',
];

/** "DM me", "WhatsApp me", a bare number — the handover to a private channel. */
const CONTACT_PATTERNS: readonly { pattern: RegExp; label: string }[] = [
  { pattern: /\bd\.?m\b\s*(me|for|us)?/i, label: 'DM' },
  { pattern: /\bwh?ats?\s?app\b/i, label: 'WhatsApp' },
  { pattern: /\btele(gram)?\b\s*(me|@|link)/i, label: 'Telegram' },
  { pattern: /\binbox\s*(me|us)\b/i, label: 'inbox me' },
  // A Nigerian mobile number, spaced or run together.
  { pattern: /(?:\+?234|0)[\s-]?[789][01][\s-]?\d[\s-]?\d{3}[\s-]?\d{4}/, label: 'phone number' },
];

/** Money changing hands for a prediction — the tipster's actual offer. */
const SALE_PATTERNS: readonly { pattern: RegExp; label: string }[] = [
  {
    pattern: /\b(subscribe|subscription|vip)\b.{0,30}\b(odds|tips?|slips?|picks?)\b/i,
    label: 'VIP tips',
  },
  {
    pattern:
      /\b(odds|tips?|slips?|picks?)\b.{0,30}\b(for|₦|ngn|naira|\d{3,})\b.{0,15}\b(sale|only|per)\b/i,
    label: 'tips for sale',
  },
  {
    pattern: /\bpay\b.{0,20}\b(for|to get)\b.{0,20}\b(odds|tips?|slips?|picks?)\b/i,
    label: 'pay for tips',
  },
  { pattern: /\bbooking\s?code\b/i, label: 'booking code' },
];

/** The promise no honest forecaster makes. */
const GUARANTEE_PATTERNS: readonly { pattern: RegExp; label: string }[] = [
  {
    pattern: /\b(sure|guaranteed?|fixed|100%)\b.{0,25}\b(odds|game|match|tips?|win|banker)\b/i,
    label: 'sure odds',
  },
  {
    pattern: /\b(odds|game|match|tips?|win)\b.{0,25}\b(sure|guaranteed?|fixed|100%)\b/i,
    label: 'guaranteed win',
  },
  { pattern: /\bno\s?(lose|loss|losing)\b/i, label: 'no-loss claim' },
];

/**
 * The same banned topics markets have (§2.9's blocklist), because §2.15e says
 * "banned-topic rules identical to markets".
 */
const BANNED_TOPICS: readonly { pattern: RegExp; label: string }[] = [
  // Inflected deliberately: "dies", "dying" and "killed" are the forms people
  // actually write, and a pattern that only matches the infinitive catches none
  // of them.
  {
    pattern:
      /\b(die|dies|died|dying|death|deaths|dead|kill|kills|killed|killing|killer|murder(ed|s)?)\b/i,
    label: 'death',
  },
  { pattern: /\b(kidnap(ped|ping|s)?|abduct(ed|ion|s)?|ransom)\b/i, label: 'kidnapping' },
  { pattern: /\b(terror(ism|ist)?|bomb(ed|ing|s)?|attack(ed|s)?)\b/i, label: 'violence' },
];

function urlsIn(text: string): string[] {
  return [
    ...text.matchAll(/\b(?:https?:\/\/|www\.)[^\s]+|\b[a-z0-9-]+\.(?:com|ng|net|bet|io|co)\b/gi),
  ].map((match) => match[0]);
}

/**
 * Every rule a comment trips. Empty means nothing matched.
 *
 * Returns all of them rather than the first: a reviewer deciding whether to
 * remove somebody's comment should see the whole case, and a comment that trips
 * three rules is a different decision from one that trips a borderline one.
 */
export function flagsFor(text: string): readonly Flag[] {
  const found: Flag[] = [];
  const lowered = text.toLowerCase();

  for (const url of urlsIn(text)) {
    const domain = url.toLowerCase();
    const matched = BETTING_DOMAINS.find((known) => domain.includes(known));
    if (matched !== undefined) {
      found.push({ kind: 'external_betting', evidence: url });
    }
  }
  for (const known of BETTING_DOMAINS) {
    if (
      lowered.includes(known) &&
      !found.some((flag) => flag.evidence.toLowerCase().includes(known))
    ) {
      found.push({ kind: 'external_betting', evidence: known });
    }
  }

  for (const { pattern, label } of SALE_PATTERNS) {
    if (pattern.test(text)) found.push({ kind: 'tips_for_sale', evidence: label });
  }
  for (const { pattern, label } of GUARANTEE_PATTERNS) {
    if (pattern.test(text)) found.push({ kind: 'guaranteed_odds', evidence: label });
  }
  for (const { pattern, label } of BANNED_TOPICS) {
    if (pattern.test(text)) found.push({ kind: 'banned_topic', evidence: label });
  }

  // Contact harvesting only counts alongside a pitch. "DM me" on its own is how
  // people talk; "DM me for sure odds" is the thing §2.15e names.
  const pitching = found.some(
    (flag) => flag.kind === 'tips_for_sale' || flag.kind === 'guaranteed_odds',
  );
  for (const { pattern, label } of CONTACT_PATTERNS) {
    if (!pattern.test(text)) continue;
    if (pitching || label === 'phone number') {
      found.push({ kind: 'contact_harvesting', evidence: label });
    }
  }

  return dedupe(found);
}

function dedupe(flags: readonly Flag[]): Flag[] {
  const seen = new Set<string>();
  return flags.filter((flag) => {
    const key = `${flag.kind}:${flag.evidence}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * What to do with a comment that tripped rules.
 *
 * `hold` keeps it out of the thread until a human looks; `flag` publishes it but
 * puts it in the queue. Nothing here removes anything — §2.15e routes to the
 * Trust & Safety desk (§6.5), and a rule that can delete somebody's words with
 * no person in the loop is a rule that will eventually delete the wrong ones.
 */
export function verdictFor(flags: readonly Flag[]): 'publish' | 'flag' | 'hold' {
  if (flags.length === 0) return 'publish';

  // The parasite-tipster patterns §2.15e calls hard bans: held, not published.
  const hard = flags.some(
    (flag) =>
      flag.kind === 'external_betting' ||
      flag.kind === 'tips_for_sale' ||
      flag.kind === 'guaranteed_odds',
  );
  return hard ? 'hold' : 'flag';
}

/** What the commenter is told. Specific, so it is arguable rather than mysterious. */
export function explain(flags: readonly Flag[]): string {
  if (flags.length === 0) return '';
  const kinds = new Set(flags.map((flag) => flag.kind));

  if (kinds.has('external_betting')) {
    return 'Links to betting sites are not allowed here. The argument stays on StakeAm.';
  }
  if (kinds.has('tips_for_sale')) {
    return 'Selling tips or slips is not allowed. Take a position and let the receipt speak.';
  }
  if (kinds.has('guaranteed_odds')) {
    return 'Nothing is a sure thing, and claiming it is gets held for review.';
  }
  if (kinds.has('banned_topic')) {
    return 'This touches a topic the platform does not host, the same rule markets follow.';
  }
  return 'This is waiting on a moderator.';
}
