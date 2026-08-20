import { ExternalLink } from 'lucide-react';

import type { MarketDetail } from '@/lib/api';

/**
 * §7.2f — the rules card.
 *
 * Rulebook §4 makes this the golden rule: every market settles against one
 * named source. Showing the source, the criteria and both dates up front is
 * what makes a resolution arguable in advance rather than disputable after.
 */
export function RulesCard({ market, bare = false }: { market: MarketDetail; bare?: boolean }) {
  const criteria =
    market.criteria !== null && typeof market.criteria === 'object'
      ? (market.criteria as Record<string, string>)
      : {};

  const labels = new Set(market.outcomes.map((outcome) => outcome.label));
  const unmatched = Object.entries(criteria).filter(
    ([key, value]) => !labels.has(key) && typeof value === 'string',
  );

  return (
    // `bare` when the card sits inside the context panel, which already has a
    // frame and a tab saying "Rules" — a second border and a second heading
    // repeating the tab is chrome describing chrome.
    <section className={bare ? '' : 'rounded-md border border-border bg-surface-raised p-4'}>
      {!bare && (
        <h2 className="text-sm font-semibold uppercase tracking-wide text-text-muted">
          How this settles
        </h2>
      )}

      <dl className={`space-y-3 text-sm ${bare ? '' : 'mt-3'}`}>
        {/*
          Ordered by the market's own outcomes, not by the criteria object.
          Postgres jsonb does not preserve key order, so reading the object
          directly listed NO before YES — the rules should read in the same
          order as the buttons above them.
        */}
        {market.outcomes.map((outcome) => {
          const rule = criteria[outcome.label];
          if (rule === undefined) return null;
          return (
            <div key={outcome.id}>
              <dt className="font-semibold">{outcome.label}</dt>
              <dd className="text-text-muted">{rule}</dd>
            </div>
          );
        })}

        {/*
          Anything the loop above could not match to an outcome.

          It used to be dropped. Both creation paths key criteria by outcome
          label, so the match normally holds — but "normally" is doing real
          work there: a market whose labels were edited after the criteria were
          written, or one restored from a template with a differently-shaped
          object, rendered a settlement card with no settlement rules on it and
          no sign that anything was missing. On the one card whose entire
          purpose is to make a resolution arguable in advance, silence is the
          worst available failure.
        */}
        {unmatched.map(([key, rule]) => (
          <div key={key}>
            <dt className="font-semibold">{sentence(key)}</dt>
            <dd className="text-text-muted">{rule}</dd>
          </div>
        ))}

        {/* The context panel puts the source in its own Source Watch block,
            which says more about it than a link does. Two of them on one tab
            is the same fact twice. */}
        {!bare && (
          <div>
            <dt className="font-semibold">Official source</dt>
            <dd>
              <a
                href={market.sourceUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-center gap-1 text-rise underline underline-offset-2"
              >
                {market.sourceName}
                <ExternalLink size={12} />
              </a>
            </dd>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <div>
            <dt className="font-semibold">Trading freezes</dt>
            <dd className="font-mono text-text-muted">
              {new Date(market.eventDate).toLocaleString('en-NG', {
                dateStyle: 'medium',
                timeStyle: 'short',
              })}
            </dd>
          </div>
          <div>
            <dt className="font-semibold">Voids if unsettled by</dt>
            <dd className="font-mono text-text-muted">
              {new Date(market.voidDate).toLocaleDateString('en-NG', { dateStyle: 'medium' })}
            </dd>
          </div>
        </div>
      </dl>
    </section>
  );
}

/** `noPublication` → "No publication". Enough to label a key a human wrote. */
function sentence(key: string): string {
  const spaced = key.replace(/[_-]+/g, ' ').replace(/([a-z\d])([A-Z])/g, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}
