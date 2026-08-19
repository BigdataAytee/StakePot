import { describe, expect, it } from 'vitest';

import { CURRENT_VERSIONS } from './consent.service';

/**
 * §2.18's versioning. The service itself needs a database; what is worth
 * asserting without one is that the version table cannot quietly go missing a
 * document, because a document with no current version is one nobody is ever
 * prompted to re-accept.
 */
describe('consent versions (§2.18)', () => {
  it('has a current version for every document', () => {
    for (const document of ['terms', 'privacy', 'rules', 'marketing'] as const) {
      expect(CURRENT_VERSIONS[document]).toMatch(/^\d{4}-\d{2}$/);
    }
  });

  it('keeps marketing separate from the required documents', () => {
    // NDPA: bundling marketing into "accept the terms" is not consent. This
    // asserts the shape that keeps them apart — marketing has its own entry
    // rather than sharing the terms version.
    expect(Object.keys(CURRENT_VERSIONS)).toContain('marketing');
  });
});
