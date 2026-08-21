import { describe, expect, it } from 'vitest';
import { RULES, checkedRules } from '@stakeam/rules';

import { ANCHORS, STEPS, anchorableRules } from '../wizard-anchors';

/**
 * The creation flow got shorter; the enforcement did not.
 *
 * This is the test that makes that sentence checkable rather than a claim in a
 * commit message. The wizard used to prove its coverage by printing the rules
 * on the screen — forty lines of them, which is exactly what made the screen
 * read like a compliance form. With the printing gone, the coverage has to be
 * asserted somewhere, and an assertion is better than a printout anyway: a
 * printout can be read past.
 *
 * What it catches, concretely: somebody tidying the form deletes the void-date
 * field, rule 2 is left anchored to a control that does not exist, and the
 * build fails in that release rather than after a market opens with no way to
 * refund anybody.
 */
describe('every checklist rule the wizard owns still has a field', () => {
  it('anchors every wizard rule that something validates', () => {
    const missing = anchorableRules().filter((id) => ANCHORS[id] === undefined);
    expect(
      missing,
      `no field in the creation flow answers for rule${missing.length === 1 ? '' : 's'} ${missing.join(', ')} — ` +
        'either give the rule a home in wizard-anchors.ts or take the wizard off its surfaces in the register',
    ).toEqual([]);
  });

  it('anchors nothing to a step that does not exist', () => {
    for (const [id, anchor] of Object.entries(ANCHORS)) {
      expect(STEPS, `rule ${id} points at step "${anchor.step}"`).toContain(anchor.step);
      expect(anchor.field.length, `rule ${id} has no field`).toBeGreaterThan(0);
    }
  });

  it('anchors nothing that is not a rule', () => {
    const known = new Set(RULES.map((rule) => rule.id));
    for (const id of Object.keys(ANCHORS)) {
      expect(known.has(id), `"${id}" is anchored but is not in the checklist register`).toBe(true);
    }
  });

  it('keeps the judgement calls on the review screen and nowhere else', () => {
    // Rules 18, 25 and R3 are questions a person answers, not fields. Asked
    // halfway through a draft they get answered about a market that does not
    // exist yet, which is how "yes, a stranger could settle it" gets clicked on
    // a question with no source attached.
    for (const rule of RULES.filter((entry) => entry.enforcement === 'confirm')) {
      if (!rule.surfaces.includes('wizard')) continue;
      expect(ANCHORS[rule.id]?.step, `rule ${rule.id} is a judgement call`).toBe('review');
    }
  });

  it('leaves the blocking structural rules on an editable step', () => {
    // A `block` rule that can only be seen on the review screen is one a
    // reviewer cannot act on without knowing where to go back to. Every one of
    // them that describes the draft itself belongs on a step with a field.
    const structural = RULES.filter(
      (rule) =>
        rule.enforcement === 'block' &&
        rule.surfaces.includes('wizard') &&
        checkedRules().includes(rule.id),
    );
    for (const rule of structural) {
      const anchor = ANCHORS[rule.id];
      expect(anchor, `rule ${rule.id} (${rule.title}) has no field`).toBeDefined();
      expect(anchor?.step, `rule ${rule.id} (${rule.title}) can only be seen at review`).not.toBe(
        'review',
      );
    }
  });
});
