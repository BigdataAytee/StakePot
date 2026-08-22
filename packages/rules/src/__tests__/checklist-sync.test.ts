import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { RULES, type Enforcement } from '../registry';
import { checkedRules } from '../validators';

/**
 * The document and the code, held together.
 *
 * The checklist is a file a person edits. Without this suite, adding rule 44 to
 * it is a one-line change that produces no failure anywhere — and from that
 * moment the wizard's review screen reports a clean pass against a checklist it
 * has never heard of. A green review is a claim about the whole document, so
 * the build has to break when the document grows past the code.
 *
 * It runs in both directions. A register entry citing a rule the document no
 * longer contains is the same defect wearing the other face: the review screen
 * would enforce a rule the team had deliberately dropped.
 */
const CHECKLIST = join(__dirname, '..', '..', '..', '..', 'docs', 'ticket-creation-checklist.md');

/**
 * Numbered rules read out of the document.
 *
 * Not `^\d+\. \*\*` — Part 3's forbidden list is written as plain sentences
 * with no bold lead, and a regex tuned to the bolded parts silently skipped all
 * eight of them. The suite reported a clean sync while the forbidden list was
 * outside the register's coverage, which is the exact failure it exists to
 * catch, one level up.
 */
function numberedRules(markdown: string): string[] {
  return [...markdown.matchAll(/^(\d+)\.\s+\S/gm)].map((match) => match[1] as string);
}

/** Part 6's red flags: bullets under the red-flag heading, in document order. */
function redFlags(markdown: string): string[] {
  const start = markdown.indexOf('## PART 6');
  if (start === -1) return [];
  const section = markdown.slice(start);
  const bullets = [...section.matchAll(/^- /gm)];
  return bullets.map((_, index) => `R${index + 1}`);
}

describe('the register covers the checklist', () => {
  const markdown = readFileSync(CHECKLIST, 'utf8');
  const documented = [...numberedRules(markdown), ...redFlags(markdown)];
  const registered = RULES.map((entry) => entry.id);

  it('reads a checklist that actually has rules in it', () => {
    // Guards the guard. A regex that silently matched nothing would make every
    // assertion below vacuously true, which is the one way this suite could
    // fail at its job while passing.
    expect(documented.length).toBeGreaterThan(40);
  });

  it('has an entry for every rule in the document', () => {
    const missing = documented.filter((id) => !registered.includes(id));
    expect(
      missing,
      `rules in the checklist with nothing enforcing them: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('has no entry for a rule the document dropped', () => {
    const extra = registered.filter((id) => !documented.includes(id));
    expect(
      extra,
      `rules enforced in code but absent from the checklist: ${extra.join(', ')}`,
    ).toEqual([]);
  });

  it('numbers them in the document’s order', () => {
    // Order is load-bearing: the review screen prints the register top to
    // bottom so a reviewer holding the checklist can follow along.
    expect(registered).toEqual(documented);
  });
});

describe('every enforceable rule has something enforcing it', () => {
  const ENFORCED: readonly Enforcement[] = ['block', 'warn', 'confirm'];
  const checked = checkedRules();

  it('has a validator for every block, warn and confirm rule', () => {
    const gaps = RULES.filter(
      (entry) => ENFORCED.includes(entry.enforcement) && !checked.includes(entry.id),
    ).map((entry) => `${entry.id} (${entry.enforcement})`);
    expect(gaps, `rules with an enforcement but no validator: ${gaps.join(', ')}`).toEqual([]);
  });

  it('has no validator for a rule marked as unenforceable', () => {
    // A rule marked `practice` or `monitor` but wired to a validator is
    // mislabelled — the register would be telling the review screen not to
    // block on something the screen is in fact blocking on.
    const mislabelled = RULES.filter(
      (entry) => !ENFORCED.includes(entry.enforcement) && checked.includes(entry.id),
    ).map((entry) => entry.id);
    expect(mislabelled).toEqual([]);
  });

  it('names a surface for every rule', () => {
    expect(RULES.filter((entry) => entry.surfaces.length === 0)).toEqual([]);
  });
});
