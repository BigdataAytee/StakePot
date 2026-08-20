import { BALANCE_BAND, MULTI_FAVOURITE_MAX, TIMEZONE } from './constants';
import { RULES, type Part } from './registry';

/**
 * The checklist, addressed to the model.
 *
 * Built from the register rather than retyped, and deliberately: a prompt
 * written by hand beside a rule table is a second copy of the law that nobody
 * updates. When rule 29 is reworded in the document, the sync suite forces the
 * register entry to follow, and the prompt changes with it in the same commit.
 *
 * Parts 1, 3 and 6 go in as hard constraints — things the model must refuse
 * rather than weigh. Part 2 goes in as scoring, because a market that scores
 * badly on engagement is a bad market rather than a forbidden one, and telling
 * a model to refuse on a judgement it is bad at produces refusals, not quality.
 *
 * None of this replaces the validators. §2.9's own note applies: a prohibition
 * that exists only in a prompt is a preference — a model can be argued out of
 * one, and `review()` cannot.
 */

function section(part: Part): string {
  return RULES.filter((entry) => entry.part === part && entry.surfaces.includes('ai'))
    .map((entry) => `${entry.id}. ${entry.title} — ${entry.detail}`)
    .join('\n');
}

/** Parts 1, 3 and 6: refuse, do not weigh. */
export const HARD_CONSTRAINTS = `NON-NEGOTIABLE — a draft breaking any of these must not be emitted:
${section('non-negotiable')}

FORBIDDEN — never draft any of these, whatever the framing:
${section('forbidden')}

RED FLAGS — stop and rethink rather than proceeding:
${section('red-flag')}`;

/** Part 2: what separates a market that hums from one that sits empty. */
export const SCORING_CRITERIA = `SCORE EVERY DRAFT ON THESE, and say what you scored:
${section('commercial')}

A binary market outside ${Math.round(BALANCE_BAND.low * 100)}-${Math.round(BALANCE_BAND.high * 100)}% is a failure, not a quibble: reject your own draft and propose a different threshold or a different question. On a multi-outcome market the same failure is a favourite above ${Math.round(MULTI_FAVOURITE_MAX * 100)}%.`;

/** Part 4, for the fields the draft has to arrive carrying. */
export const CRAFT_REQUIREMENTS = `EVERY DRAFT MUST ARRIVE COMPLETE:
${section('craft')}

Concretely, that means: a named source with the exact page URL; an event date and a separate void date, both as full ISO timestamps with an hour, stated in ${TIMEZONE} in the wording; every outcome with its settlement criteria, plus an "Any other" bucket wherever the field is open; the edge cases mapped, including what happens if the source publishes nothing; the exact metric named where a statistic is involved; the first-published-figure clause wherever that statistic gets revised; and your honest probability for each outcome.`;

/**
 * The refusal contract.
 *
 * The brief asks for self-rejection with a logged reason, and the reason is the
 * valuable half: a draft the engine threw away is the cheapest possible signal
 * about what the shelf is short of, and it is invisible unless the model is
 * required to say why. So refusing is a first-class output, not an error.
 */
export const SELF_REJECTION = `If you cannot draft something that satisfies all of the above, do not lower the bar. Emit a rejection instead: set "rejected" true, name the rule numbers you could not satisfy, and say in one sentence what stopped you. A logged rejection is a useful result. A draft that breaks a rule is not.`;

/** Everything above, in the order a reader of the checklist would meet it. */
export const CHECKLIST_PROMPT = [
  HARD_CONSTRAINTS,
  SCORING_CRITERIA,
  CRAFT_REQUIREMENTS,
  SELF_REJECTION,
].join('\n\n');
