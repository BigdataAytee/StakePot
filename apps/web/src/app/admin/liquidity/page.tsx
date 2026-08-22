'use client';

import { AlertTriangle, Lock, Octagon, Play, Square } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import {
  admin,
  type LiquidityMarketRow,
  type LiquidityMode,
  type MakerRow,
  type SeedPreview,
} from '@/lib/admin-api';
import { money } from '@/lib/format';
import { SkeletonRows } from '@/components/skeleton';

/**
 * The liquidity section: two tools, and the switch that decides whose money
 * they spend.
 *
 * The mode is the first thing on the screen and stays visible while anything
 * else is used, because it is the only fact here that changes what a number
 * means. "Seed 5,000" is a rehearsal in TEST and a wire transfer in LIVE, and
 * the difference cannot live in a setting somebody checked when they arrived.
 *
 * Nothing on this page enforces anything. Every rule — the budget ceiling, the
 * depth stop, the inventory cap, the freeze, LIVE mode itself — is a branch in
 * `apps/api/src/liquidity`, and this screen would be refused by the server if
 * it tried to go round one. What it does is make the state legible: what is
 * running, what it has spent, and where the switches are.
 */
export default function LiquiditySection() {
  const [mode, setMode] = useState<LiquidityMode | null>(null);
  const [markets, setMarkets] = useState<LiquidityMarketRow[] | null>(null);
  const [makers, setMakers] = useState<MakerRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(() => {
    void admin.liquidityMode().then(setMode).catch(fail);
    void admin.liquidityMarkets().then(setMarkets).catch(fail);
    void admin.makers().then(setMakers).catch(fail);
    function fail(caught: Error): void {
      setError(caught.message);
    }
  }, []);

  useEffect(load, [load]);

  async function act(run: () => Promise<unknown>, done: string): Promise<void> {
    setError(null);
    try {
      await run();
      setNote(done);
      load();
    } catch (caught) {
      setError((caught as Error).message);
    }
  }

  function killEverything(): void {
    const reason = window.prompt(
      'Stop every market maker now, on every market. Why? This is recorded.',
      '',
    );
    if (reason === null || reason.trim().length < 3) return;
    void act(() => admin.killAllMakers(reason), 'Every maker stopped and its quotes withdrawn.');
  }

  const quoting = makers.filter((maker) => maker.status === 'quoting').length;

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="text-lg font-black">Liquidity</h1>
        {mode !== null && <ModeChip mode={mode} />}
        <p className="w-full text-sm text-text-muted sm:w-auto">
          Platform money into a market: as a one-off seed, or as a maker quoting both sides.
        </p>
        {quoting > 0 && (
          <button
            type="button"
            onClick={killEverything}
            className="ml-auto flex items-center gap-1.5 rounded-md border border-fall px-3 py-1.5 text-sm font-bold text-fall"
          >
            <Octagon size={14} /> Stop everything
          </button>
        )}
      </header>

      {mode !== null && !mode.liveAvailable && (
        <p className="flex items-start gap-2 rounded-xl border border-caution bg-caution-bg/40 p-3.5 text-sm">
          <Lock size={15} className="mt-0.5 shrink-0 text-caution" />
          <span>{mode.why}</span>
        </p>
      )}

      {error !== null && (
        <p role="alert" className="text-sm text-fall">
          {error}
        </p>
      )}
      {note !== null && <p className="text-sm text-rise">{note}</p>}

      <SeedTool markets={markets} mode={mode} onDone={load} />
      <BotTool markets={markets ?? []} makers={makers} onAct={act} />
    </div>
  );
}

/** The mode, in the header, at all times. */
function ModeChip({ mode }: { mode: LiquidityMode }) {
  const live = mode.mode === 'live';
  return (
    <span
      title={mode.why}
      className={`rounded-sm px-2 py-0.5 font-mono text-fine font-bold uppercase tracking-widest ${
        live ? 'bg-fall text-paper' : 'bg-chip text-text-muted'
      }`}
    >
      {live ? 'live · naira' : 'test · points'}
    </span>
  );
}

/**
 * Seed: pick a market, see what it would do, then do it.
 *
 * The preview is not decoration. The claim it makes — that money can go into a
 * running market without moving a price — is one nobody should take on trust,
 * so both prices are printed and the operator can check rather than believe.
 */
function SeedTool({
  markets,
  mode,
  onDone,
}: {
  markets: LiquidityMarketRow[] | null;
  mode: LiquidityMode | null;
  onDone: () => void;
}) {
  const [chosen, setChosen] = useState<string>('');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [preview, setPreview] = useState<SeedPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());

  const seedable = (markets ?? []).filter((row) => row.seedable);
  const perOutcome = Number(amount);
  const ready = chosen !== '' && Number.isFinite(perOutcome) && perOutcome > 0;

  useEffect(() => {
    if (!ready) {
      setPreview(null);
      return;
    }
    const timer = setTimeout(() => {
      void admin
        .seedPreview(chosen, String(perOutcome))
        .then((result) => {
          setPreview(result);
          setError(null);
        })
        .catch((caught: Error) => setError(caught.message));
    }, 400);
    return () => clearTimeout(timer);
  }, [chosen, perOutcome, ready]);

  async function execute(): Promise<void> {
    if (!ready || reason.trim().length < 3) return;
    setBusy(true);
    setError(null);
    try {
      const result = await admin.seedExecute(chosen, {
        perOutcome: String(perOutcome),
        reason: reason.trim(),
        requestId,
      });
      setAmount('');
      setReason('');
      setPreview(null);
      setRequestId(crypto.randomUUID());
      onDone();
      setError(null);
      window.alert(`Added ${result.added}. Pot is now ${result.potAfter}.`);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-xl border border-border bg-surface-raised">
      <header className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide">Seed</h2>
        <p className="mt-0.5 text-xs text-text-muted">
          The same amount on every outcome, executed as real trades through the engine. It deepens
          the pot and takes no side.
        </p>
      </header>

      <div className="space-y-3 p-4">
        <div className="grid gap-3 sm:grid-cols-[2fr_1fr]">
          <label className="block">
            <span className="text-xs font-semibold">Market</span>
            <select
              value={chosen}
              onChange={(event) => setChosen(event.target.value)}
              className="mt-1 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm"
            >
              <option value="">Choose a market…</option>
              {seedable.map((row) => (
                <option key={row.marketId} value={row.marketId}>
                  {row.question}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-xs font-semibold">Per outcome (₦)</span>
            <input
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(event.target.value.replace(/[^\d.]/g, ''))}
              placeholder="5000"
              className="mt-1 w-full rounded-md border border-border bg-surface px-3 py-2 font-mono text-sm"
            />
          </label>
        </div>

        {preview !== null && <SeedPreviewPanel preview={preview} />}

        <div className="flex flex-wrap items-end gap-2">
          <label className="min-w-[12rem] flex-1">
            <span className="text-xs font-semibold">Why</span>
            <input
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={300}
              placeholder="Thin pot before kickoff"
              className="mt-1 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm"
            />
          </label>
          <button
            type="button"
            disabled={!ready || reason.trim().length < 3 || busy}
            onClick={() => void execute()}
            className="rounded-md bg-brand px-4 py-2 text-sm font-bold text-paper disabled:opacity-35"
          >
            {busy ? 'Seeding…' : `Seed in ${mode?.mode === 'live' ? 'naira' : 'points'}`}
          </button>
        </div>

        {error !== null && <p className="text-xs text-fall">{error}</p>}
      </div>

      <MarketTable markets={markets} />
    </section>
  );
}

function SeedPreviewPanel({ preview }: { preview: SeedPreview }) {
  return (
    <div className="rounded-md border border-border bg-surface p-3 text-xs">
      <dl className="flex flex-wrap gap-x-5 gap-y-1.5">
        <span>
          Total in <b className="font-mono text-text">{money(preview.total)}</b>
        </span>
        <span>
          Pot{' '}
          <b className="font-mono text-text">
            {money(preview.potBefore)} → {money(preview.potAfter)}
          </b>
        </span>
        <span>
          Largest single stake <b className="font-mono text-text">{money(preview.maxStakeAfter)}</b>
        </span>
      </dl>

      {/* Both price rows, so the claim can be checked rather than believed. */}
      <div className="mt-2 flex flex-wrap items-center gap-2 font-mono">
        <span className="text-text-muted">before</span>
        <span>{preview.pricesBefore.map(asPercent).join(' / ')}</span>
        <span className="text-text-muted">after</span>
        <span>{preview.pricesAfter.map(asPercent).join(' / ')}</span>
        {preview.priceMoved ? (
          <span className="flex items-center gap-1 font-sans font-semibold text-fall">
            <AlertTriangle size={12} /> a price moved — this should not happen
          </span>
        ) : (
          <span className="font-sans text-rise">unchanged</span>
        )}
      </div>

      {/*
        The thing an operator will assume and be wrong about. Seeding makes the
        pot bigger to win; it does not make the market steadier. That dial is L,
        set when the market is written.
      */}
      {!preview.absorbsMore && (
        <p className="mt-2 text-text-muted">
          This does <b className="text-text">not</b> make the market absorb bigger stakes — the
          largest single trade is {money(preview.maxStakeBefore)} either way. Seeding changes the
          pot, not the price sensitivity; that is the liquidity constant L, set when the market is
          written.
        </p>
      )}
    </div>
  );
}

function MarketTable({ markets }: { markets: LiquidityMarketRow[] | null }) {
  if (markets === null) return <SkeletonRows rows={3} height="h-12" label="Loading markets" />;

  return (
    <div className="overflow-x-auto border-t border-border">
      <table className="w-full min-w-[46rem] text-left text-xs">
        <thead className="bg-chip font-mono text-fine uppercase tracking-widest text-text-muted">
          <tr>
            <th className="px-4 py-2 font-normal">Market</th>
            <th className="px-3 py-2 font-normal">Pot</th>
            <th className="px-3 py-2 font-normal">Seeded</th>
            <th className="px-3 py-2 font-normal">Split</th>
            <th className="px-3 py-2 font-normal">Max stake</th>
            <th className="px-3 py-2 font-normal">Maker</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {markets.map((row) => (
            <tr key={row.marketId}>
              <td className="max-w-[18rem] truncate px-4 py-2">
                <a href={`/market/${row.marketId}`} className="hover:underline">
                  {row.question}
                </a>
                <span className="ml-1.5 font-mono text-fine uppercase text-text-muted">
                  {row.shelf} · {row.state}
                </span>
              </td>
              <td className="px-3 py-2 font-mono">{money(row.pot)}</td>
              <td className="px-3 py-2 font-mono">
                {row.seedPlaced === '0' ? '—' : money(row.seedPlaced)}
              </td>
              <td className="px-3 py-2 font-mono">
                {row.split.map((part) => asPercent(part.price)).join(' / ')}
              </td>
              <td className="px-3 py-2 font-mono">{money(row.maxStake)}</td>
              <td className="px-3 py-2">{row.hasMaker ? 'configured' : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The maker: configure it, run it, watch it, stop it.
 *
 * The dashboard leads with budget and status because those are the two
 * questions an operator has at three in the morning — how much of our money is
 * out there, and is it still trading.
 */
function BotTool({
  markets,
  makers,
  onAct,
}: {
  markets: LiquidityMarketRow[];
  makers: MakerRow[];
  onAct: (run: () => Promise<unknown>, done: string) => Promise<void>;
}) {
  const [chosen, setChosen] = useState('');
  const [budget, setBudget] = useState('10000');
  const [quoteSize, setQuoteSize] = useState('1000');
  const [spread, setSpread] = useState('3');

  const configurable = markets.filter((row) => row.state === 'active');

  function kill(maker: MakerRow): void {
    const reason = window.prompt(`Stop the maker on "${maker.question}" now. Why?`, '');
    if (reason === null || reason.trim().length < 3) return;
    void onAct(
      () => admin.killMaker(maker.marketId, reason),
      'Stopped. Its quotes are off the book and the escrow is back.',
    );
  }

  function start(maker: MakerRow): void {
    // §E: a maker on a freshly seeded market stacks platform exposure. The
    // server refuses without a confirm; this is where the confirm happens.
    const stacked = maker.seededAt !== null && !maker.stackConfirmed;
    if (stacked) {
      const ok = window.confirm(
        'This market was seeded from this section. Running the maker on top of a fresh seed ' +
          'stacks platform exposure. Go ahead?',
      );
      if (!ok) return;
    }
    void onAct(() => admin.startMaker(maker.marketId, stacked), 'Quoting.');
  }

  return (
    <section className="rounded-xl border border-border bg-surface-raised">
      <header className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide">Market maker</h2>
        <p className="mt-0.5 text-xs text-text-muted">
          Quotes both sides at a spread, off by default, one budget per market that it can never
          exceed. It sees its own inventory, the price and the depth — nothing else.
        </p>
      </header>

      <div className="grid gap-3 border-b border-border p-4 sm:grid-cols-[2fr_1fr_1fr_1fr_auto]">
        <label className="block">
          <span className="text-xs font-semibold">Market</span>
          <select
            value={chosen}
            onChange={(event) => setChosen(event.target.value)}
            className="mt-1 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm"
          >
            <option value="">Choose…</option>
            {configurable.map((row) => (
              <option key={row.marketId} value={row.marketId}>
                {row.question}
              </option>
            ))}
          </select>
        </label>
        <Field label="Budget (₦)" value={budget} onChange={setBudget} />
        <Field label="Quote size" value={quoteSize} onChange={setQuoteSize} />
        <Field label="Spread (k)" value={spread} onChange={setSpread} />
        <button
          type="button"
          disabled={chosen === ''}
          onClick={() =>
            void onAct(
              () =>
                admin.configureMaker(chosen, {
                  budget,
                  quoteSize,
                  spreadKobo: Number(spread),
                }),
              'Configured. It is off until you start it.',
            )
          }
          className="self-end rounded-md border border-border px-3 py-2 text-sm font-semibold disabled:opacity-35"
        >
          Save
        </button>
      </div>

      {makers.length === 0 ? (
        <p className="p-4 text-sm text-text-muted">
          No maker configured on any market. Nothing is quoting.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {makers.map((maker) => (
            <MakerCard
              key={maker.marketId}
              maker={maker}
              onKill={kill}
              onStart={start}
              onAct={onAct}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function MakerCard({
  maker,
  onKill,
  onStart,
  onAct,
}: {
  maker: MakerRow;
  onKill: (maker: MakerRow) => void;
  onStart: (maker: MakerRow) => void;
  onAct: (run: () => Promise<unknown>, done: string) => Promise<void>;
}) {
  const spent = Number(maker.spent);
  const budget = Number(maker.budget);
  const used = budget > 0 ? Math.min(spent / budget, 1) : 0;

  return (
    <li className="p-4">
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <StatusChip status={maker.status} />
        <a
          href={`/market/${maker.marketId}`}
          className="flex-1 text-sm font-semibold hover:underline"
        >
          {maker.question}
        </a>
        <span className="font-mono text-fine uppercase tracking-widest text-text-muted">
          {maker.mode}
        </span>
      </div>

      {maker.statusNote !== null && (
        <p className="mt-1 text-xs text-text-muted">{maker.statusNote}</p>
      )}

      {/* Budget first: the number somebody wants at three in the morning. */}
      <div className="mt-2.5">
        <div className="h-1.5 overflow-hidden rounded-full bg-chip">
          <div
            className={`h-full ${used >= 1 ? 'bg-fall' : 'bg-brand'}`}
            style={{ width: `${Math.round(used * 100)}%` }}
          />
        </div>
        <p className="mt-1 font-mono text-xs text-text-muted">
          {money(maker.spent)} of {money(maker.budget)} committed ·{' '}
          <b className="text-text">{money(maker.remaining)}</b> left
        </p>
      </div>

      <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-muted">
        <span>
          Holding <b className="font-mono text-text">{money(maker.inventory.long)}</b> long ·{' '}
          <b className="font-mono text-text">{money(maker.inventory.short)}</b> short
        </span>
        <span>
          Quotes up <b className="font-mono text-text">{maker.openQuotes}</b>
        </span>
        <span>
          Fills <b className="font-mono text-text">{maker.trades}</b>
        </span>
        <span title="A mark, not a result: a matched share pays ₦1 or nothing at settlement.">
          Unrealised{' '}
          <b className={`font-mono ${Number(maker.unrealisedPnl) < 0 ? 'text-fall' : 'text-rise'}`}>
            {money(maker.unrealisedPnl)}
          </b>
        </span>
        <span>
          Last quote{' '}
          <b className="font-mono text-text">
            {maker.lastQuoteAt === null
              ? 'never'
              : new Date(maker.lastQuoteAt).toLocaleTimeString('en-NG')}
          </b>
        </span>
      </dl>

      <div className="mt-2.5 flex flex-wrap gap-2 text-xs">
        {maker.enabled ? (
          <button
            type="button"
            onClick={() => void onAct(() => admin.stopMaker(maker.marketId), 'Stopped.')}
            className="flex items-center gap-1 rounded-sm border border-border px-2.5 py-1 font-semibold"
          >
            <Square size={11} /> Stop
          </button>
        ) : (
          <button
            type="button"
            onClick={() => onStart(maker)}
            className="flex items-center gap-1 rounded-sm border border-rise px-2.5 py-1 font-semibold text-rise"
          >
            <Play size={11} /> Start
          </button>
        )}
        <button
          type="button"
          onClick={() =>
            void onAct(() => admin.cycleMaker(maker.marketId), 'Cycled — quotes refreshed.')
          }
          className="rounded-sm border border-border px-2.5 py-1"
        >
          Cycle now
        </button>
        <button
          type="button"
          onClick={() => onKill(maker)}
          className="ml-auto flex items-center gap-1 rounded-sm border border-fall px-2.5 py-1 font-bold text-fall"
        >
          <Octagon size={11} /> Kill
        </button>
      </div>

      {maker.killedAt !== null && (
        <p className="mt-1.5 text-xs text-fall">
          Killed {new Date(maker.killedAt).toLocaleString('en-NG')} — {maker.killReason}. Starting
          it again clears this.
        </p>
      )}
    </li>
  );
}

const STATUS_LOOK: Record<MakerRow['status'], { label: string; chip: string }> = {
  quoting: { label: 'QUOTING', chip: 'bg-rise text-paper' },
  idle: { label: 'OFF', chip: 'bg-chip text-text-muted' },
  budget_spent: { label: 'BUDGET SPENT', chip: 'bg-caution-bg text-caution' },
  depth_reached: { label: 'STOOD DOWN', chip: 'bg-chip text-text-muted' },
  inventory_capped: { label: 'INVENTORY CAP', chip: 'bg-caution-bg text-caution' },
  market_closing: { label: 'CLOSING', chip: 'bg-caution-bg text-caution' },
  killed: { label: 'KILLED', chip: 'bg-fall text-paper' },
};

function StatusChip({ status }: { status: MakerRow['status'] }) {
  const look = STATUS_LOOK[status];
  return (
    <span className={`rounded-sm px-1.5 py-0.5 font-mono text-fine font-bold ${look.chip}`}>
      {look.label}
    </span>
  );
}

function Field({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      <span className="text-xs font-semibold">{label}</span>
      <input
        inputMode="decimal"
        value={value}
        onChange={(event) => onChange(event.target.value.replace(/[^\d.]/g, ''))}
        className="mt-1 w-full rounded-md border border-border bg-surface px-3 py-2 font-mono text-sm"
      />
    </label>
  );
}

/** A price string in (0,1) as the percentage a trader reads. */
function asPercent(price: string): string {
  return `${Math.round(Number(price) * 100)}%`;
}
