/**
 * The community market template (§2.5) and the screen every submission passes
 * before a human ever sees it.
 *
 * Kept free of Prisma, the network and the LLM so the rules that decide whether
 * a market may exist can be tested directly. §2.9 puts the blocklist in the
 * model's system prompt; this is the other half of it. A prohibition that only
 * exists in a prompt is a preference, not a control — a model can be argued
 * out of one, and the Rulebook's §8 list is not negotiable.
 */

export interface TemplateOutcome {
  readonly label: string;
  readonly criteria: string;
}

export interface MarketTemplate {
  readonly question: string;
  /** Complete list. §2.5 requires it, plus an "Any other" bucket where the field is open. */
  readonly outcomes: readonly TemplateOutcome[];
  readonly otherLabel?: string;
  readonly sourceName: string;
  readonly sourceUrl: string;
  readonly eventDate: string;
  readonly voidDate: string;
  readonly edgeCases: Readonly<Record<string, string>>;
}

export type RejectionCode =
  | 'blocklist'
  | 'incomplete_outcomes'
  | 'missing_source'
  | 'bad_source_url'
  | 'void_date_not_future'
  | 'void_date_before_event'
  | 'missing_criteria'
  | 'duplicate_outcome'
  | 'question_too_short'
  | 'question_not_a_question';

export interface TemplateProblem {
  readonly code: RejectionCode;
  /** Shown to the creator verbatim (§2.9: "approve/reject with reason shown"). */
  readonly message: string;
}

/**
 * Rulebook Part 1 §8, as patterns rather than prose.
 *
 * Deliberately blunt: this screen rejects, it does not decide. Anything it
 * catches goes to a human with the reason attached, so a false positive costs a
 * review rather than a market. The opposite trade — letting a market about
 * someone's death go live because the phrasing dodged a regex — is not one
 * worth making.
 */
const BLOCKED_PATTERNS: readonly { readonly pattern: RegExp; readonly reason: string }[] = [
  {
    pattern: /\b(die|dies|died|death|dead|kill(ed|ing)?|murder|assassinat\w*|suicide)\b/i,
    reason: 'markets about death or harm to a person are not allowed',
  },
  {
    pattern: /\b(injur\w*|illness|sick|hospitali[sz]\w*|coma|terminal)\b/i,
    reason: 'markets about injury or illness are not allowed',
  },
  {
    pattern:
      /\b(arrest\w*|convict\w*|jail\w*|imprison\w*|charged with|indict\w*|crime|robbery|kidnap\w*)\b/i,
    reason: 'markets about crimes or prosecutions are not allowed',
  },
  {
    pattern: /\b(attack|bomb\w*|terror\w*|shooting|riot|coup|insurgen\w*|abduct\w*)\b/i,
    reason: 'markets about violence or security incidents are not allowed',
  },
];

const HTTPS_URL = /^https:\/\/[^\s/$.?#][^\s]*$/i;

export interface ScreenOptions {
  /** Injected rather than read from a clock, so the screen stays a pure function. */
  readonly now: Date;
}

/**
 * Structural and blocklist screen. Everything here is decidable without a model.
 *
 * Returns every problem it finds rather than the first — a creator fixing a
 * template one rejection at a time gives up, and §2.9 promises them a reason.
 */
export function screenTemplate(
  template: MarketTemplate,
  options: ScreenOptions,
): TemplateProblem[] {
  const problems: TemplateProblem[] = [];
  const question = template.question.trim();

  if (question.length < 15) {
    problems.push({
      code: 'question_too_short',
      message: 'Give the question enough detail that a stranger could settle it.',
    });
  }
  if (!question.endsWith('?')) {
    problems.push({
      code: 'question_not_a_question',
      message: 'Write the market as a question, ending in a question mark.',
    });
  }

  // The blocklist reads the question and every outcome — a clean question with a
  // prohibited outcome is still a prohibited market.
  const surface = [question, ...template.outcomes.map((o) => `${o.label} ${o.criteria}`)].join(' ');
  for (const blocked of BLOCKED_PATTERNS) {
    if (blocked.pattern.test(surface)) {
      problems.push({ code: 'blocklist', message: blocked.reason });
    }
  }

  if (template.outcomes.length < 2) {
    problems.push({
      code: 'incomplete_outcomes',
      message: 'List every outcome the market can settle to — at least two.',
    });
  }

  const labels = template.outcomes.map((o) => o.label.trim().toLowerCase());
  if (template.otherLabel !== undefined) labels.push(template.otherLabel.trim().toLowerCase());
  const duplicate = labels.find((label, i) => labels.indexOf(label) !== i);
  if (duplicate !== undefined) {
    problems.push({ code: 'duplicate_outcome', message: `"${duplicate}" is listed twice.` });
  }

  for (const outcome of template.outcomes) {
    if (outcome.criteria.trim().length < 10) {
      problems.push({
        code: 'missing_criteria',
        message: `Say what makes "${outcome.label}" the result.`,
      });
    }
  }

  if (template.sourceName.trim().length === 0) {
    problems.push({
      code: 'missing_source',
      message: 'Name the official source that settles this.',
    });
  }
  if (!HTTPS_URL.test(template.sourceUrl.trim())) {
    problems.push({
      code: 'bad_source_url',
      message: 'Link the source over https so anyone can check it.',
    });
  }

  const eventDate = new Date(template.eventDate);
  const voidDate = new Date(template.voidDate);
  if (!Number.isFinite(voidDate.getTime()) || voidDate <= options.now) {
    problems.push({
      code: 'void_date_not_future',
      message: 'The void date has to be in the future.',
    });
  } else if (Number.isFinite(eventDate.getTime()) && voidDate <= eventDate) {
    problems.push({
      code: 'void_date_before_event',
      message: 'The void date has to fall after the event.',
    });
  }

  return problems;
}

/**
 * §2.9 rule 3: the engine rejects its own draft outside [35%–65%], and no single
 * outcome above [60%] on a multi-outcome market.
 *
 * The bounds are config, not constants — this takes them as arguments so the
 * §6.4b console owns them.
 */
export function isBalanced(
  estimates: readonly number[],
  bounds: { readonly binaryLow: number; readonly binaryHigh: number; readonly multiMax: number },
): boolean {
  if (estimates.length === 0) return false;
  const total = estimates.reduce((a, b) => a + b, 0);
  if (Math.abs(total - 1) > 0.02) return false;

  if (estimates.length === 2) {
    const [yes] = estimates as [number, number];
    return yes >= bounds.binaryLow && yes <= bounds.binaryHigh;
  }
  return Math.max(...estimates) <= bounds.multiMax;
}
