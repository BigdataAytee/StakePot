import { ExternalLink } from 'lucide-react';

import type { MarketDetail } from '@/lib/api';

/**
 * §7.2f — the rules card.
 *
 * Rulebook §4 makes this the golden rule: every market settles against one
 * named source. Showing the source, the criteria and both dates up front is
 * what makes a resolution arguable in advance rather than disputable after.
 */
export function RulesCard({ market }: { market: MarketDetail }) {
  const criteria =
    market.criteria !== null && typeof market.criteria === 'object'
      ? (market.criteria as Record<string, string>)
      : {};

  return (
    <section className="rounded-md border border-border bg-surface-raised p-4">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-text-muted">
        How this settles
      </h2>

      <dl className="mt-3 space-y-3 text-sm">
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
