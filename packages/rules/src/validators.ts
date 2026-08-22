import {
  AMBIGUOUS_METRICS,
  ATTENTION_WINDOW_DAYS,
  BALANCE_BAND,
  BLOCKBUSTER_WINDOW_DAYS,
  COLLISION_THRESHOLD,
  CURRENCY_TERMS,
  LIQUIDITY_MULTIPLE,
  LIQUIDITY_TOLERANCE,
  MULTI_FAVOURITE_MAX,
  TIMEZONE,
} from './constants';
import type { ReviewContext, TicketDraft } from './draft';
import { RULES, rule, type Rule, type Surface } from './registry';

/**
 * The checklist, run against one draft.
 *
 * Five statuses rather than three, because "we did not check" and "it passed"
 * are different claims and collapsing them is how a review screen comes to lie.
 *
 * - `pass`  — checked, satisfied.
 * - `warn`  — checked, not satisfied, publishable with a reason recorded.
 * - `fail`  — checked, not satisfied, publish refused.
 * - `ask`   — only a person can answer this; unanswered blocks, and a "no"
 *             on the conflict question blocks too.
 * - `note`  — nothing to check at publish time: a working practice, or a rule a
 *             job watches afterwards, or a fact the caller did not supply.
 *             Printed anyway, so the reviewer sees the whole checklist and can
 *             tell what the software did *not* decide for them.
 */
export type Status = 'pass' | 'warn' | 'fail' | 'ask' | 'note';

export interface Finding {
  readonly rule: string;
  readonly title: string;
  readonly status: Status;
  readonly message: string;
}

export interface RuleReport {
  readonly findings: readonly Finding[];
  /** True when nothing may publish: a `fail`, or an unanswered `ask`. */
  readonly blocked: boolean;
  readonly failures: readonly Finding[];
  readonly warnings: readonly Finding[];
  /** The questions still owed an answer. */
  readonly unanswered: readonly Finding[];
}

type Check = (draft: TicketDraft, context: ReviewContext) => Omit<Finding, 'rule' | 'title'>;

const pass = (message: string) => ({ status: 'pass' as const, message });
const fail = (message: string) => ({ status: 'fail' as const, message });
const warn = (message: string) => ({ status: 'warn' as const, message });
const note = (message: string) => ({ status: 'note' as const, message });

/** Every word the market puts in front of a trader, as one haystack. */
function surfaceText(draft: TicketDraft): string {
  return [
    draft.question,
    ...draft.outcomes.map((outcome) => `${outcome.label} ${outcome.criteria}`),
    draft.otherLabel ?? '',
    ...Object.values(draft.edgeCases),
  ].join(' \n ');
}

/** The settlement wording specifically — where rules 26-29 want their detail. */
function settlementText(draft: TicketDraft): string {
  return [
    draft.question,
    ...draft.outcomes.map((outcome) => outcome.criteria),
    ...Object.values(draft.edgeCases),
  ].join(' \n ');
}

/** A pair that already covers the space, so a catch-all beside it is dead. */
const BINARY_PAIR = /^(yes\|no|no\|yes|true\|false|false\|true)$/i;

/** ISO instants only. A date with no time is rule 26's whole complaint. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

const VAGUE_SOURCE =
  /\b(widely reported|the news|news reports?|confirmed sources?|social media|twitter|various sources?|media|the internet|public knowledge)\b/i;

/**
 * The forbidden list, as patterns, attributed to the rule each one enforces.
 *
 * Deliberately blunt. Anything caught here goes to a human with the reason
 * attached, so a false positive costs a review; the opposite trade — a market
 * about somebody's death going live because the phrasing dodged a regex — is
 * not one worth making.
 */
const FORBIDDEN: readonly {
  readonly rule: string;
  readonly pattern: RegExp;
  readonly why: string;
}[] = [
  {
    rule: '13',
    pattern:
      /\b(die|dies|died|death|dead|kill(ed|ing|s)?|murder\w*|assassinat\w*|suicide|injur\w*|illness|hospitali[sz]\w*|coma|terminally? ill)\b/i,
    why: 'Markets on death, injury or illness are never published.',
  },
  {
    rule: '14',
    pattern:
      /\b(arrest\w*|convict\w*|jail\w*|imprison\w*|charged with|indict\w*|crime|robbery|kidnap\w*|attack|bomb\w*|terror\w*|shooting|riot|coup|insurgen\w*|abduct\w*)\b/i,
    why: 'Markets on crime, violence or security incidents are never published.',
  },
  {
    rule: '15',
    pattern: /\b(marriage|marry|married|divorce|pregnan\w*|affair|girlfriend|boyfriend|dating)\b/i,
    why: 'This reads as a private matter. Public events and public figures acting publicly only.',
  },
  {
    rule: '19',
    pattern: /\b(stakeam|this platform|our own (staff|revenue|markets))\b/i,
    why: 'A market on the platform, its staff or its finances is a conflict of interest.',
  },
  {
    rule: '20',
    pattern:
      /\b(thief|thieves|criminal|corrupt|fraudster|illiterate|clueless|useless|stupid|idiot|disgrace)\b/i,
    why: 'Reword neutrally. The event may be political; the wording may not read as an insult.',
  },
  {
    rule: 'R6',
    pattern: /\b(rumour|rumor|allegedly|reportedly|speculation|it is said)\b/i,
    why: 'The appeal rests on a rumour rather than a scheduled event. Wait for a date.',
  },
];

/** Qualifiers that turn an ambiguous statistic into a figure (rule 28). */
const METRIC_QUALIFIERS: readonly { readonly term: RegExp; readonly qualifier: RegExp }[] = [
  {
    term: /\b(inflation|cpi)\b/i,
    qualifier: /\b(year[- ]on[- ]year|y-?o-?y|headline|month[- ]on[- ]month|core)\b/i,
  },
  { term: /\bgdp\b/i, qualifier: /\b(real|nominal|quarter\w*|annual)\b/i },
  { term: /\bunemployment\b/i, qualifier: /\b(labour force|labor force|quarter\w*|nbs)\b/i },
  { term: /\breserves?\b/i, qualifier: /\b(gross|net|external|foreign)\b/i },
  { term: /\b(fuel|petrol) price\b/i, qualifier: /\b(retail|pump|nnpc|depot|lagos|abuja)\b/i },
  {
    term: /\b(exchange rate|naira|₦)\b/i,
    qualifier:
      /\b(official window|closing|average|nafem|nfem|parallel|interbank|per (dollar|\$)|\/\$)\b/i,
  },
];

/**
 * One checker per rule the software can actually decide.
 *
 * Keyed by rule id, and the sync suite asserts that this map covers every
 * `block`, `warn` and `confirm` rule in the register. A rule with no entry
 * here would print as a note on the review screen — visible, but not enforced —
 * and the suite is what stops that happening silently.
 */
const CHECKS: Readonly<Record<string, Check>> = {
  '1': (draft) => {
    const name = draft.sourceName.trim();
    if (name.length === 0) return fail('Name the official source that settles this.');
    if (VAGUE_SOURCE.test(name)) {
      return fail(`"${name}" is not a source. Name the body and the page.`);
    }
    return pass(`Settles against ${name}.`);
  },

  '2': (draft, context) => {
    const event = new Date(draft.eventDate);
    const voided = new Date(draft.voidDate);
    if (!Number.isFinite(event.getTime())) return fail('The event date is not a real date.');
    if (!Number.isFinite(voided.getTime())) return fail('Give a void date.');
    if (voided <= context.now) return fail('The void date has already passed.');
    if (voided <= event) {
      return fail('The void date has to fall after the event, or it can never refund anybody.');
    }
    return pass('Event and void dates are set, in that order.');
  },

  '3': (draft) => {
    if (draft.outcomes.length < 2) return fail('List every outcome — at least two.');

    const labels = draft.outcomes.map((outcome) => outcome.label.trim().toLowerCase());
    if (draft.otherLabel !== undefined) labels.push(draft.otherLabel.trim().toLowerCase());
    const repeated = labels.find((label, index) => labels.indexOf(label) !== index);
    if (repeated !== undefined)
      return fail(`"${repeated}" is listed twice — outcomes must not overlap.`);

    const thin = draft.outcomes.find((outcome) => outcome.criteria.trim().length < 10);
    if (thin !== undefined) return fail(`Say what makes "${thin.label}" the result.`);

    // A field with more than two runners is a field somebody can finish outside
    // of, and the market has to have somewhere to put them.
    if (draft.outcomes.length > 2 && draft.otherLabel === undefined) {
      return fail(
        'A multi-outcome market needs an "Any other" bucket so no result falls outside the list.',
      );
    }
    // Only a *complementary* pair. Two named contenders plus a catch-all —
    // "Okafor, Okonkwo, any other candidate" — is a three-way race and exactly
    // what rule 3 asks for; the first version of this check refused it, and the
    // co-pilot's own worked example was the thing that failed.
    //
    // Yes plus No plus a catch-all is the incoherent case: the pair already
    // covers the space, so the third bucket can never be the result.
    if (
      draft.outcomes.length === 2 &&
      draft.otherLabel !== undefined &&
      BINARY_PAIR.test(labels.slice(0, 2).join('|'))
    ) {
      return fail(
        'Yes and No already cover every result — an "Any other" bucket on top of them can never settle.',
      );
    }
    return pass(`${draft.outcomes.length} outcomes, complete and distinct.`);
  },

  '4': (draft) => {
    const cases = Object.keys(draft.edgeCases);
    if (cases.length === 0) return fail('Map the edge cases before trading opens.');
    // Every market has a source, so every market can meet a source that says
    // nothing. It is the one edge case that always applies, and the one most
    // often left out — which is how a market ends up unsettleable and unvoided.
    const silence = cases.some((key) =>
      /(no publication|not published|nothing published|no result|no data|source (does not|doesn't) publish|unpublished|no figure)/i.test(
        `${key} ${draft.edgeCases[key] ?? ''}`,
      ),
    );
    if (!silence) {
      return fail('Say what happens if the source publishes nothing. It applies to every market.');
    }
    if (cases.length < 2) return warn('Only one edge case is mapped. Walk through the others.');
    return pass(`${cases.length} edge cases mapped.`);
  },

  '5': (_draft, context) => {
    if (context.attestedNoInfluence !== true) {
      return fail('Nobody involved may be able to affect the result — this has to be attested.');
    }
    return pass('Attested: a public event nobody trading can influence.');
  },

  '6': (draft) => {
    const estimates = draft.balanceEstimates;
    if (estimates === undefined || estimates.length === 0) {
      return note('No balance estimate supplied, so nothing was checked against the 35-65% band.');
    }
    const total = estimates.reduce((a, b) => a + b, 0);
    if (Math.abs(total - 1) > 0.02) {
      return fail(`The outcome probabilities add up to ${(total * 100).toFixed(0)}%, not 100%.`);
    }
    if (estimates.length === 2) {
      const [yes = 0] = estimates;
      if (yes < BALANCE_BAND.low || yes > BALANCE_BAND.high) {
        return warn(
          `At ${(yes * 100).toFixed(0)}% this is outside 35-65%. Would two friends really stake against each other on it?`,
        );
      }
      return pass(`${(yes * 100).toFixed(0)}% — a market with an argument in it.`);
    }
    const favourite = Math.max(...estimates);
    if (favourite > MULTI_FAVOURITE_MAX) {
      return warn(
        `The favourite is at ${(favourite * 100).toFixed(0)}%. Above ${(MULTI_FAVOURITE_MAX * 100).toFixed(0)}% the rest of the field is decoration.`,
      );
    }
    return pass(`Favourite at ${(favourite * 100).toFixed(0)}% — the field is live.`);
  },

  '7': (draft) => {
    // Consensus is a fact about the world, not about the draft. What can be
    // checked is that a numeric market states the level it is pitched against.
    if (!/\d/.test(draft.question)) return note('No threshold in the question — nothing to pitch.');
    return note('Check the threshold against the current consensus or published forecast.');
  },

  '8': (_draft, context) => {
    if (context.expectedNewsFlow === undefined) {
      return note('Nobody has said whether news is expected before this settles.');
    }
    return context.expectedNewsFlow
      ? pass('News expected between opening and settlement.')
      : warn('No news expected before settlement — this earns once instead of all week.');
  },

  '9': () =>
    note('Emotional stakes are a judgement: naira, football, elections, fuel, entertainment.'),

  '10': (draft, context) => {
    const event = new Date(draft.eventDate);
    if (!Number.isFinite(event.getTime())) return note('No usable event date to measure.');
    const days = (event.getTime() - context.now.getTime()) / 86_400_000;
    const limit = draft.blockbuster === true ? BLOCKBUSTER_WINDOW_DAYS : ATTENTION_WINDOW_DAYS;
    if (days > limit) {
      return warn(
        `${Math.round(days)} days out. Past ${limit} the market is asking for attention it will not hold.`,
      );
    }
    if (days < 0) return fail('The event date is in the past.');
    return pass(`Settles in ${Math.round(days)} days.`);
  },

  '11': (draft) =>
    draft.outcomes.length > 2
      ? pass('Multi-outcome — naturally closer to balanced.')
      : note(
          'Binary. Where the story allows, "who wins?" splits money better and pulls in more fanbases.',
        ),

  '12': () => note('Prefer a memorable threshold near consensus over an exact one nobody repeats.'),

  '13': forbidden('13'),
  '14': forbidden('14'),
  '15': forbidden('15'),

  '16': (_draft, context) => {
    if (context.attestedNoInfluence !== true) {
      return fail(
        'The creator has to attest they cannot influence this and hold no inside knowledge.',
      );
    }
    return pass('Attested: no influence, no inside knowledge.');
  },

  '17': (draft) => {
    const url = draft.sourceUrl.trim();
    if (!/^https:\/\/[^\s/$.?#][^\s]*$/i.test(url)) {
      return fail('Link the source over https so anyone can check it.');
    }
    return pass('The source is a link anybody can open.');
  },

  '18': asks('18', 'Would this embarrass us if it were screenshotted onto the front page?'),

  '19': forbidden('19'),
  '20': forbidden('20'),

  '21': (_draft, context) => {
    if (context.duplicates === undefined) {
      return note('No duplicate search was run against the live shelf.');
    }
    const [first] = context.duplicates;
    if (first !== undefined) {
      return fail(
        `Too close to a live market: "${first.question}". Merge it or differentiate clearly.`,
      );
    }
    return pass('Nothing live is close enough to split the liquidity.');
  },

  '22': (draft) => {
    const freeze = new Date(draft.freezesAt ?? draft.eventDate);
    const event = new Date(draft.eventDate);
    if (!Number.isFinite(freeze.getTime())) return fail('The freeze time is not a real date.');
    if (freeze > event) {
      return fail(
        'Trading has to stop when the event starts, or somebody trades on a known result.',
      );
    }
    return pass('Trading freezes at the event.');
  },

  '24': (draft) => {
    const liquidity = Number(draft.liquidityParam ?? Number.NaN);
    const stake = Number(draft.expectedStake ?? Number.NaN);
    if (!Number.isFinite(liquidity) || !Number.isFinite(stake) || stake <= 0) {
      return note(
        `No expected stake supplied, so L was not checked against ${LIQUIDITY_MULTIPLE}x.`,
      );
    }
    const ratio = liquidity / (stake * LIQUIDITY_MULTIPLE);
    if (ratio > LIQUIDITY_TOLERANCE)
      return warn('L is large for the volume expected — the market will look frozen.');
    if (ratio < 1 / LIQUIDITY_TOLERANCE)
      return warn('L is small for the volume expected — the price will swing wildly.');
    return pass(`L is about ${LIQUIDITY_MULTIPLE}x a typical stake.`);
  },

  '25': asks(
    '25',
    'Could somebody with no context resolve this using only this page and the named source?',
  ),

  '26': (draft) => {
    if (DATE_ONLY.test(draft.eventDate.trim())) {
      return fail(
        'Give the hour, not just the day. "By 30 September" means nothing without a time.',
      );
    }
    if (!new RegExp(`\\b${TIMEZONE}\\b`, 'i').test(settlementText(draft))) {
      return fail(`State the timezone in the wording — "23:59 ${TIMEZONE}", not "23:59".`);
    }
    return pass(`Timezone and hour are stated in ${TIMEZONE}.`);
  },

  '27': (draft) => {
    const text = settlementText(draft);
    const revised = AMBIGUOUS_METRICS.filter((metric) => metric.revised && metric.term.test(text));
    if (revised.length === 0) return pass('No revisable statistic in play.');
    if (
      /\b(first[- ](published|release[d]?)|as first published|revisions? (are )?ignored|initial (print|release))\b/i.test(
        text,
      )
    ) {
      return pass('States that the first published figure governs.');
    }
    return fail(
      'This settles on a statistic that gets revised. Say that the first published figure governs.',
    );
  },

  '28': (draft) => {
    const text = settlementText(draft);
    const vague = METRIC_QUALIFIERS.filter(
      (metric) => metric.term.test(text) && !metric.qualifier.test(text),
    );
    if (vague.length === 0) return pass('The metric is named precisely enough to settle on.');
    return fail('Name the exact metric — which series, whose publication, which basis.');
  },

  '29': (draft) => {
    const text = settlementText(draft);
    if (!CURRENCY_TERMS.test(text)) return pass('No currency figure to qualify.');
    if (
      /\b(official window|closing|average|nafem|nfem|parallel|interbank|per (dollar|\$)|\/\$|per litre|per barrel)\b/i.test(
        text,
      )
    ) {
      return pass('Currency, unit and rate window are stated.');
    }
    return fail('Say which rate — official window, closing, or average — and in what unit.');
  },

  '30': (draft) => {
    const missing = [
      draft.category === undefined || draft.category.trim().length === 0 ? 'category' : null,
      (draft.tags ?? []).length === 0 ? 'tags' : null,
      draft.icon === undefined || draft.icon.trim().length === 0 ? 'icon' : null,
    ].filter((item): item is string => item !== null);
    if (missing.length > 0)
      return warn(`No ${missing.join(', ')} — the card will look unfinished.`);
    return pass('Category, tags and icon are set.');
  },

  '31': (draft, context) => {
    const event = new Date(draft.eventDate);
    if (!Number.isFinite(event.getTime()))
      return note('No usable event date to time the launch against.');
    const days = (event.getTime() - context.now.getTime()) / 86_400_000;
    if (days < 1)
      return warn('Opening less than a day before the event leaves no time to build a pot.');
    return note(`Opening ${Math.round(days)} days ahead. Fixtures want 3-7; elections want weeks.`);
  },

  '32': (draft, context) => {
    if (context.previousCycle === undefined)
      return note('Not a recurring market, or the last cycle was not supplied.');
    if (context.previousCycle.question.trim() === draft.question.trim()) {
      return warn(
        "Identical to last cycle. Last month's consensus is not this month's — retune the threshold.",
      );
    }
    return pass('Retuned since the last cycle.');
  },

  '33': (_draft, context) => {
    if (context.settlingSameDay === undefined)
      return note('The settlement calendar was not checked.');
    if (context.settlingSameDay >= COLLISION_THRESHOLD) {
      return warn(
        `${context.settlingSameDay} markets already settle that day. Stagger it so the app always has something live.`,
      );
    }
    return pass('No settlement pile-up on that day.');
  },

  '34': (_draft, context) => {
    if (context.liveCount === undefined || context.catalogueSlots === undefined) {
      return note('Shelf size was not supplied, so nothing was checked against over-listing.');
    }
    if (context.liveCount >= context.catalogueSlots) {
      return warn(
        `${context.liveCount} markets are already live against ${context.catalogueSlots} slots. A few busy markets beat many empty ones.`,
      );
    }
    return pass('There is room on the shelf.');
  },

  R2: (draft) => {
    const url = draft.sourceUrl.trim();
    const path = (() => {
      try {
        return new URL(url).pathname;
      } catch {
        return '';
      }
    })();
    if (path === '' || path === '/') {
      return fail('Link the exact page that will settle it, not the site it lives on.');
    }
    return pass('The exact settling page is linked.');
  },

  R3: asks('R3', 'Do you want a particular side to win?'),

  R6: forbidden('R6'),
};

/** A checker that fails when the rule's forbidden pattern is anywhere in the market. */
function forbidden(id: string): Check {
  return (draft) => {
    const entry = FORBIDDEN.find((item) => item.rule === id);
    if (entry === undefined) return note('No pattern registered.');
    return entry.pattern.test(surfaceText(draft)) ? fail(entry.why) : pass('Clear.');
  };
}

/**
 * A checker for a question only a person can answer.
 *
 * Unanswered is `ask`, which blocks. That is the whole design: a review screen
 * that let somebody publish without answering the stranger test would be
 * printing the question decoratively.
 */
function asks(id: string, question: string): Check {
  return (_draft, context) => {
    const answer = context.confirmations?.[id];
    if (answer === undefined) return { status: 'ask' as const, message: question };
    // R3 is the one whose "yes" is the bad answer: wanting a side to win is the
    // conflict, and the checklist's remedy is to hand the market to somebody else.
    const bad = id === 'R3' ? answer : !answer;
    if (id === 'R3' && bad) {
      return fail('You want a side to win. Hand this market to another staff member.');
    }
    if (bad) return fail(question);
    return pass('Confirmed by the reviewer.');
  };
}

/**
 * Run the checklist.
 *
 * Every rule in the register produces a line, including the ones nothing here
 * decides — the reviewer is being asked to sign off against a document, and a
 * report that quietly omits the rules it cannot check is not a report on that
 * document.
 */
export function review(draft: TicketDraft, context: ReviewContext, surface?: Surface): RuleReport {
  const applicable =
    surface === undefined ? RULES : RULES.filter((entry) => entry.surfaces.includes(surface));

  const findings: Finding[] = applicable.map((entry) => {
    const check = CHECKS[entry.id];
    if (check === undefined) {
      return {
        rule: entry.id,
        title: entry.title,
        status: entry.enforcement === 'monitor' ? ('note' as const) : ('note' as const),
        message:
          entry.enforcement === 'monitor'
            ? `Watched after publishing: ${entry.detail}`
            : entry.detail,
      };
    }
    return { rule: entry.id, title: entry.title, ...check(draft, context) };
  });

  const failures = findings.filter((finding) => finding.status === 'fail');
  const warnings = findings.filter((finding) => finding.status === 'warn');
  const unanswered = findings.filter((finding) => finding.status === 'ask');

  return {
    findings,
    blocked: failures.length > 0 || unanswered.length > 0,
    failures,
    warnings,
    unanswered,
  };
}

/** The rules with a checker behind them — what the sync suite asserts against. */
export function checkedRules(): readonly string[] {
  return Object.keys(CHECKS);
}

/** Convenience for a caller that wants the register entry beside a finding. */
export function ruleOf(finding: Finding): Rule {
  return rule(finding.rule);
}
