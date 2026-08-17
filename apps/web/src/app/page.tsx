/**
 * Phase 0 placeholder.
 *
 * Deliberately not a design: it exists to prove the token preset, both fonts
 * and the Tailwind pipeline are wired end to end. The real Ticket View arrives
 * with §7.2.
 */
export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-6 px-6">
      <p className="font-mono text-xs uppercase tracking-widest text-text-muted">Phase 0</p>

      <h1 className="text-2xl font-black leading-none">StakeAm</h1>

      <p className="text-md text-text-muted">
        Scaffold is up: pricing engine, design tokens, data model and CI. No market UI yet.
      </p>

      <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-4">
        {[
          { label: 'Engine', value: 'v1.1' },
          { label: 'Money math', value: 'decimal.js' },
          { label: 'Pot floor', value: '≥ 0' },
          { label: 'House edge', value: 'none' },
        ].map((item) => (
          <div key={item.label} className="bg-surface-raised px-4 py-3">
            <dt className="text-xs text-text-muted">{item.label}</dt>
            <dd className="font-mono text-base tabular-nums">{item.value}</dd>
          </div>
        ))}
      </dl>
    </main>
  );
}
