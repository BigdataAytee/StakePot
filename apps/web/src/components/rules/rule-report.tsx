'use client';

import type { Finding, RuleReport, Status } from '@stakeam/rules';

/**
 * The ticket-creation checklist, rendered as a pass/warn/fail line per rule.
 *
 * One component for three screens — the admin wizard's review step, the
 * community wizard, and the drafts queue where staff open somebody else's
 * submission. They are looking at the same document and have to be looking at
 * the same verdict; a review screen that renders the report differently from
 * the queue is a review screen that can disagree with itself.
 *
 * Every line is printed, including the ones nothing checked. A report that
 * quietly dropped its notes would show a clean list of twenty-two green ticks
 * and read as "the checklist passed" — a claim about forty-nine rules made on
 * evidence about twenty-two.
 */
const LOOK: Record<Status, { chip: string; label: string; row: string }> = {
  pass: { chip: 'bg-rise/15 text-rise', label: 'PASS', row: '' },
  warn: { chip: 'bg-caution-bg text-caution', label: 'WARN', row: 'bg-caution-bg/30' },
  fail: { chip: 'bg-fall/15 text-fall', label: 'FAIL', row: 'bg-fall/[.06]' },
  ask: { chip: 'bg-brand/15 text-brand', label: 'ASK', row: 'bg-brand/[.05]' },
  note: { chip: 'bg-chip text-text-muted', label: '—', row: '' },
};

export function RuleReportPanel({
  report,
  /** Collapsed to what needs attention until somebody asks for the rest. */
  defaultExpanded = false,
  onAnswer,
  answers,
}: {
  report: RuleReport;
  defaultExpanded?: boolean;
  /**
   * Supplied by the review screen, absent everywhere else. Where it is absent
   * the questions still print — a reviewer needs to see what is outstanding
   * even on a screen that cannot answer it.
   */
  onAnswer?: (rule: string, answer: boolean) => void;
  answers?: Record<string, boolean>;
}) {
  const attention = report.findings.filter(
    (finding) => finding.status !== 'pass' && finding.status !== 'note',
  );
  const shown = defaultExpanded ? report.findings : attention;

  return (
    <section className="rounded-xl border border-border bg-surface-raised">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide">Ticket-creation checklist</h2>
        <p className="text-xs text-text-muted">
          {report.failures.length} failing · {report.warnings.length} warning ·{' '}
          {report.unanswered.length} to answer · {report.findings.length} rules
        </p>
        {report.blocked ? (
          <span className="ml-auto rounded-sm bg-fall/15 px-2 py-0.5 text-[11px] font-bold text-fall">
            CANNOT PUBLISH
          </span>
        ) : (
          <span className="ml-auto rounded-sm bg-rise/15 px-2 py-0.5 text-[11px] font-bold text-rise">
            CLEAR TO PUBLISH
          </span>
        )}
      </header>

      {shown.length === 0 ? (
        <p className="px-4 py-3 text-sm text-text-muted">
          Nothing failing, nothing outstanding. Expand to read every rule that was checked.
        </p>
      ) : (
        <ol>
          {shown.map((finding) => (
            <Line key={finding.rule} finding={finding} onAnswer={onAnswer} answers={answers} />
          ))}
        </ol>
      )}
    </section>
  );
}

function Line({
  finding,
  onAnswer,
  answers,
}: {
  finding: Finding;
  onAnswer?: ((rule: string, answer: boolean) => void) | undefined;
  answers?: Record<string, boolean> | undefined;
}) {
  const look = LOOK[finding.status];
  const answered = answers?.[finding.rule];

  return (
    <li className={`border-b border-border px-4 py-2.5 text-sm last:border-b-0 ${look.row}`}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span
          className={`rounded-sm px-1.5 py-0.5 font-mono text-[10px] font-bold ${look.chip}`}
          aria-label={`${finding.status} on rule ${finding.rule}`}
        >
          {look.label}
        </span>
        {/* The number, always. A reviewer is signing off against a document
            they can go and read, and a message with no rule number tells them
            they are wrong without telling them against what. */}
        <span className="font-mono text-xs text-text-muted">Rule {finding.rule}</span>
        <span className="font-semibold">{finding.title}</span>
      </div>
      <p className="mt-0.5 text-text-muted">{finding.message}</p>

      {finding.status === 'ask' && onAnswer !== undefined && (
        <div className="mt-2 flex gap-2">
          <Answer
            label="Yes"
            active={answered === true}
            onClick={() => onAnswer(finding.rule, true)}
          />
          <Answer
            label="No"
            active={answered === false}
            onClick={() => onAnswer(finding.rule, false)}
          />
        </div>
      )}
    </li>
  );
}

function Answer({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-md border px-3 py-1 text-sm font-semibold ${
        active ? 'border-brand bg-brand text-paper' : 'border-border hover:bg-chip'
      }`}
    >
      {label}
    </button>
  );
}
