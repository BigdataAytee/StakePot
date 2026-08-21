import { RULES, checkedRules } from '@stakeam/rules';

/**
 * Where each checklist rule lives in the creation flow.
 *
 * The wizard used to answer "is rule 26 enforced?" by printing rule 26 on the
 * screen. Shortening the screen took the printing away, so the answer has to
 * come from somewhere that survives a redesign — and this is it: every rule the
 * wizard is responsible for names the step and the field it binds to, and
 * `__tests__/wizard-anchors.test.ts` fails the build if any rule with a
 * validator has no home here.
 *
 * That is the whole safety of the shorter form. A field quietly dropped in a
 * later tidy-up leaves a rule anchored to nothing, and the suite says so, in
 * the same release rather than three months later when a market opens with no
 * void date.
 *
 * Two things it deliberately does not do. It does not restate the rules —
 * every word a reviewer reads about a failing rule comes from the validator
 * that failed, so the screen cannot disagree with the enforcement. And it does
 * not enforce anything itself: the server runs `packages/rules` over the draft
 * on review and again on publish, whatever this file says.
 */
export const STEPS = ['question', 'settles', 'unusual', 'review'] as const;
export type StepKey = (typeof STEPS)[number];

/** The heading a step carries, in the words the operator sees. */
export const STEP_TITLE: Record<StepKey, string> = {
  question: 'What’s the question?',
  settles: 'How does it settle?',
  unusual: 'Anything unusual?',
  review: 'Review',
};

export interface Anchor {
  readonly step: StepKey;
  /**
   * The `id` of the control to scroll to and focus. A failing rule on the
   * review screen is a link back to this, because "rule 2 failed" and "the
   * void date is empty, here it is" are the same information and only one of
   * them can be acted on.
   */
  readonly field: string;
}

/**
 * Rule → the control that satisfies it.
 *
 * Several rules share a field, which is the point: rules 13-15, 19, 20 and R6
 * are all things about the *wording*, so all six surface under the question
 * box rather than as six lines in a compliance list. A reviewer fixing the
 * wording fixes all of them in one edit and never learns their numbers.
 */
export const ANCHORS: Readonly<Record<string, Anchor>> = {
  // The wording. Everything that can only be answered by rewriting the sentence.
  '7': { step: 'question', field: 'question' },
  '9': { step: 'question', field: 'question' },
  '12': { step: 'question', field: 'question' },
  '13': { step: 'question', field: 'question' },
  '14': { step: 'question', field: 'question' },
  '15': { step: 'question', field: 'question' },
  '19': { step: 'question', field: 'question' },
  '20': { step: 'question', field: 'question' },
  '26': { step: 'question', field: 'question' },
  '27': { step: 'question', field: 'question' },
  '28': { step: 'question', field: 'question' },
  '29': { step: 'question', field: 'question' },
  R6: { step: 'question', field: 'question' },
  // A duplicate is fixed by rewriting the question — merge it or differentiate
  // it — so it belongs on the wording, not on a review line that only reports.
  '21': { step: 'question', field: 'question' },

  // The answers. Binary is the default and needs no screen; the builder opens
  // when somebody says there are more than two.
  '3': { step: 'question', field: 'outcomes' },
  '6': { step: 'question', field: 'outcomes' },
  '11': { step: 'question', field: 'outcomes' },

  // Settlement.
  '1': { step: 'settles', field: 'source' },
  '17': { step: 'settles', field: 'source' },
  R2: { step: 'settles', field: 'sourceUrl' },
  '2': { step: 'settles', field: 'voidDate' },
  '10': { step: 'settles', field: 'eventDate' },
  '22': { step: 'settles', field: 'eventDate' },
  '31': { step: 'settles', field: 'eventDate' },

  // The unusual step.
  '4': { step: 'unusual', field: 'edgeCases' },
  '5': { step: 'unusual', field: 'attestation' },
  '16': { step: 'unusual', field: 'attestation' },
  '24': { step: 'unusual', field: 'liquidityParam' },
  '30': { step: 'unusual', field: 'category' },
  '8': { step: 'unusual', field: 'newsFlow' },
  '32': { step: 'unusual', field: 'liquidityParam' },

  // Judgements, and the two facts about the shelf rather than the draft:
  // nothing here is edited, so they belong where the decision is made.
  '18': { step: 'review', field: 'judgement-18' },
  '25': { step: 'review', field: 'judgement-25' },
  R3: { step: 'review', field: 'judgement-R3' },
  '33': { step: 'review', field: 'verdict' },
  '34': { step: 'review', field: 'verdict' },
};

/**
 * The rules this flow has to find a home for.
 *
 * A rule counts when the register says the wizard is a surface for it *and*
 * something actually checks it. `practice` rules — "have the source page open",
 * "resolve promptly" — have no artefact in a draft and nothing to anchor.
 */
export function anchorableRules(): readonly string[] {
  const checked = new Set(checkedRules());
  return RULES.filter(
    (rule) =>
      rule.surfaces.includes('wizard') && rule.enforcement !== 'practice' && checked.has(rule.id),
  ).map((rule) => rule.id);
}

/** Every rule that surfaces on a given step, for the inline notes. */
export function rulesOn(step: StepKey, field: string): readonly string[] {
  return Object.entries(ANCHORS)
    .filter(([, anchor]) => anchor.step === step && anchor.field === field)
    .map(([id]) => id);
}
