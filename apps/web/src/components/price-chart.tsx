'use client';

import {
  AreaSeries,
  CandlestickSeries,
  LineSeries,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type Time,
} from 'lightweight-charts';
import { useEffect, useMemo, useRef, useState } from 'react';

import { outcomeColour, palette, semantic, type SemanticRole } from '@stakeam/tokens';

import type { Annotation, OutcomeView, PricePoint } from '@/lib/api';
import { countdown, dateTime, money, percent, settlesOn } from '@/lib/format';
import { bucketFor, toCandles, type Candle } from '@/lib/candles';
import { EDGE_STEP_MS, carryCandles, carryForward, edgeAt, elapsed } from '@/lib/liveness';

export const TIMEFRAMES = ['1H', '6H', '1D', '1W', 'ALL'] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

/** The marks §7.2a pins on the chart, so the line doubles as the market's timeline. */
const ANNOTATION_MARK: Record<Annotation['type'], string> = {
  open: 'Open',
  activation: 'Live',
  big_trade: 'Big trade',
  news: 'News',
  freeze: 'Frozen',
  resolution: 'Result',
};

/**
 * §7.2a — the hero.
 *
 * "Binary markets: one line (YES). Multi-outcome: multi-line overlay with the
 * outcome legend; tapping a candidate isolates their line."
 *
 * Binary gets a filled area because there is one story and the fill carries it.
 * A six-candidate election does not: six overlapping fills is mud, so multi
 * draws lines and lets the legend do the naming. Isolating a candidate is how
 * you read one line out of a crowded field, which is exactly the moment a
 * multi-outcome chart stops being legible without it.
 */
export function PriceChart({
  points,
  outcomes,
  annotations,
  timeframe,
  onTimeframeChange,
  live = false,
  volume,
  settlesAt,
  targetLine,
  lastTradeAt,
}: {
  points: PricePoint[];
  outcomes: OutcomeView[];
  annotations: Annotation[];
  timeframe: Timeframe;
  onTimeframeChange: (tf: Timeframe) => void;
  /** Streaming, so the end dot pulses and the badge shows. */
  live?: boolean;
  /** 24h volume, for the footer inside the card. */
  volume?: string;
  /** When the market settles — the footer's date and its countdown. */
  settlesAt?: string;
  /**
   * A threshold this market is measured against, drawn as a dashed line.
   *
   * "Will the naira close below ₦1,500" is not really a question about a
   * probability, it is a question about a number crossing a level — and a chart
   * that shows the probability without the level leaves the reader holding
   * half the picture. Optional because most markets have no such number, and
   * inventing one from the question text would be worse than omitting it.
   */
  targetLine?: { value: number; label: string } | undefined;
  /**
   * When this market last traded, for the age beside the live edge.
   *
   * Separate from the last point on the chart: the chart is windowed, so a
   * market that last traded ninety minutes ago has no points at all on a 1H
   * view and the honest label there is "last trade 1h ago", not silence.
   */
  lastTradeAt?: string | null;
}) {
  const container = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const seriesByOutcome = useRef(
    new Map<string, ISeriesApi<'Area'> | ISeriesApi<'Line'> | ISeriesApi<'Candlestick'>>(),
  );
  const markers = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const [isolated, setIsolated] = useState<string | null>(null);

  const binary = outcomes.length === 2;

  /**
   * §7.2a's power-user toggle. Candles need one series to be about — a
   * multi-line overlay of candlesticks is unreadable — so they are offered on
   * binary markets and on an isolated candidate, and nowhere else.
   */
  const [style, setStyle] = useState<'area' | 'candles'>('area');
  const candleable = binary || isolated !== null;
  const candles = style === 'candles' && candleable;
  // Binary charts tell the story of the first outcome; the second is its mirror.
  /**
   * How many lines go on the chart.
   *
   * Binary draws one — the Yes side is the whole story and a No line is its
   * mirror image, which adds a second line carrying no second fact. A field of
   * candidates draws the leading five: past that the lines are within a
   * point of each other at the bottom of the axis, and the sixth through
   * twentieth are a grey smear that makes the five that matter harder to read.
   * `showAll` is the way to the rest, because "the tail is hidden" is a
   * decision the reader is entitled to overrule.
   */
  const [showAll, setShowAll] = useState(false);
  const ranked = useMemo(
    () =>
      [...outcomes].sort((left, right) => {
        if (left.isOther !== right.isOther) return left.isOther ? 1 : -1;
        return Number.parseFloat(right.price) - Number.parseFloat(left.price);
      }),
    [outcomes],
  );
  const plotted = useMemo(
    () => (binary ? outcomes.slice(0, 1) : showAll ? ranked : ranked.slice(0, 5)),
    [binary, outcomes, ranked, showAll],
  );

  /** What the crosshair is over, or null when the pointer has left the chart. */
  const [scrub, setScrub] = useState<{
    ts: number;
    values: { id: string; value: number }[];
  } | null>(null);

  const colourFor = (outcome: OutcomeView, theme: Record<SemanticRole, string>): string =>
    binary ? theme.rise : outcomeColour(outcome.ordinal, outcome.isOther);

  useEffect(() => {
    const element = container.current;
    if (element === null) return;

    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const theme = dark ? semantic.dark : semantic.light;

    const created = createChart(element, {
      autoSize: true,
      layout: {
        attributionLogo: false,
        background: { color: 'transparent' },
        textColor: theme.textMuted,
        fontFamily: 'var(--font-space-mono), monospace',
        fontSize: 12,
      },
      grid: { horzLines: { color: theme.border }, vertLines: { visible: false } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.12, bottom: 0.08 } },
      timeScale: { borderVisible: false, timeVisible: true },
      crosshair: { horzLine: { labelVisible: false } },
      handleScale: false,
      handleScroll: false,
    });

    const priceFormat = {
      type: 'custom' as const,
      minMove: 0.1,
      // A market can spend all day inside a three-point band, where whole
      // percentages repeat down the axis and read as a rendering fault.
      formatter: (p: number) => `${p.toFixed(1)}%`,
    };

    const map = new Map<
      string,
      ISeriesApi<'Area'> | ISeriesApi<'Line'> | ISeriesApi<'Candlestick'>
    >();

    // Candles are about one outcome, so there is one series rather than a map
    // of them — the target is the isolated candidate, or the binary market's
    // headline side.
    const target = isolated ?? plotted[0]?.id;
    if (candles && target !== undefined) {
      map.set(
        target,
        created.addSeries(CandlestickSeries, {
          upColor: palette.green,
          downColor: palette.red,
          borderVisible: false,
          wickUpColor: palette.green,
          wickDownColor: palette.red,
          priceFormat,
        }),
      );
    }

    for (const outcome of candles ? [] : plotted) {
      const colour = colourFor(outcome, theme);
      map.set(
        outcome.id,
        binary
          ? created.addSeries(AreaSeries, {
              lineColor: colour,
              topColor: `${colour}33`,
              bottomColor: `${colour}00`,
              lineWidth: 2,
              priceFormat,
              lastValueVisible: false,
              priceLineVisible: false,
            })
          : created.addSeries(LineSeries, {
              color: colour,
              lineWidth: 2,
              priceFormat,
              lastValueVisible: false,
              priceLineVisible: false,
            }),
      );
    }

    chart.current = created;
    seriesByOutcome.current = map;

    const first = map.values().next().value;
    markers.current = first === undefined ? null : createSeriesMarkers(first, []);

    /*
     * The threshold, as a dashed line the eye can sit on.
     *
     * Hung off the first series rather than the chart, because lightweight
     * charts anchors price lines to a series' scale — and the axis here is
     * probability, so the target is expressed as one too.
     */
    if (targetLine !== undefined && first !== undefined) {
      first.createPriceLine({
        price: targetLine.value,
        color: theme.textMuted,
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: targetLine.label,
      });
    }

    /*
     * The scrub.
     *
     * A chart that only shows the latest value answers "where is it now",
     * which the header already says. Dragging along it answers "when did it
     * move, and what was everything else doing at that moment" — which is the
     * question a multi-line market exists to pose, and it cannot be answered by
     * reading five lines by eye.
     *
     * Every visible outcome is read at the crosshair, not just the one under
     * the pointer: the comparison is the point.
     */
    created.subscribeCrosshairMove((param) => {
      if (param.time === undefined || param.point === undefined) {
        setScrub(null);
        return;
      }
      const values: { id: string; value: number }[] = [];
      for (const [id, series] of map) {
        const data = param.seriesData.get(series) as { value?: number; close?: number } | undefined;
        const value = data?.value ?? data?.close;
        if (value !== undefined) values.push({ id, value });
      }
      setScrub({ ts: (param.time as number) * 1000, values });
    });

    /*
     * The end dot follows the canvas.
     *
     * Its position is computed from the time scale and the price scale, both
     * of which move when the chart is resized or its range changes — and a
     * live dot sitting where the line used to be is worse than no dot. Both
     * are cheap: the callback reads two coordinates and bails if neither
     * moved.
     */
    const follow = (): void => place.current();
    created.timeScale().subscribeVisibleTimeRangeChange(follow);
    const observer = new ResizeObserver(follow);
    observer.observe(element);

    return () => {
      observer.disconnect();
      created.timeScale().unsubscribeVisibleTimeRangeChange(follow);
      created.remove();
      chart.current = null;
      seriesByOutcome.current = new Map();
      markers.current = null;
    };
    // Rebuilt when the outcome set or the series style changes — either one is
    // a different chart, not a redraw of this one.
  }, [plotted, binary, candles, isolated, targetLine]);

  /**
   * The clock, so the chart advances along the time axis while nothing is
   * happening on the price axis.
   *
   * Null until mounted. This component is server-rendered, and reading the
   * clock during render is how you get markup that disagrees with the first
   * paint on the largest element of the page. Quantised to `EDGE_STEP_MS`, so
   * a ticking second hand costs a redraw only when the redraw would move the
   * line by a pixel.
   */
  const [edge, setEdge] = useState<number | null>(null);
  useEffect(() => {
    if (!live) {
      setEdge(null);
      return undefined;
    }
    const tick = (): void => setEdge(edgeAt(Date.now()));
    tick();
    const timer = window.setInterval(tick, EDGE_STEP_MS);
    return () => window.clearInterval(timer);
  }, [live]);

  /**
   * The real series, one entry per plotted outcome.
   *
   * Memoised away from the clock on purpose: this is the traded data and it
   * changes only when somebody trades. The live edge is added on top of it
   * below, every few seconds, and it must not be possible for that to reshape
   * what the trades actually were.
   */
  const lines = useMemo(() => {
    const built = new Map<string, { time: number; value: number }[]>();
    for (const outcome of plotted) {
      const seen = new Set<number>();
      built.set(
        outcome.id,
        points
          .filter((p) => p.outcomeId === outcome.id)
          .map((p) => ({
            time: Math.floor(new Date(p.ts).getTime() / 1000),
            value: percent(p.price),
          }))
          .filter((p) => {
            if (seen.has(p.time)) return false;
            seen.add(p.time);
            return true;
          })
          .sort((a, b) => a.time - b.time),
      );
    }
    return built;
  }, [points, plotted]);

  const candleTarget = isolated ?? plotted[0]?.id;
  const candleData = useMemo<Candle[]>(
    () =>
      candles && candleTarget !== undefined
        ? toCandles(
            points.filter((p) => p.outcomeId === candleTarget),
            bucketFor(timeframe),
          )
        : [],
    [candles, candleTarget, points, timeframe],
  );

  /** Where the live end dot sits, in pixels inside the canvas. */
  const [dot, setDot] = useState<{ x: number; y: number } | null>(null);
  const place = useRef<() => void>(() => undefined);

  useEffect(() => {
    const map = seriesByOutcome.current;
    if (map.size === 0) return;

    const nowSeconds = edge === null ? null : Math.floor(edge / 1000);
    // Which line the end dot belongs to. One dot, not one per outcome: five
    // pulsing dots down the right edge is five things asking for attention
    // when the fact being reported is a single one — the market is live, and
    // this is where it is now.
    const leadId = isolated ?? plotted[0]?.id;
    let leadTime: number | null = null;
    let leadValue: number | null = null;

    if (candles && candleTarget !== undefined) {
      const series = map.get(candleTarget);
      if (series !== undefined) {
        const data =
          nowSeconds === null
            ? candleData
            : carryCandles(candleData, nowSeconds, bucketFor(timeframe));
        series.setData(data as Parameters<typeof series.setData>[0]);
        const last = data[data.length - 1];
        if (last !== undefined) {
          leadTime = last.time;
          leadValue = last.close;
        }
      }
    }

    for (const outcome of candles ? [] : plotted) {
      const series = map.get(outcome.id);
      if (series === undefined) continue;

      const real = lines.get(outcome.id) ?? [];
      // The flat segment. Same value as the last trade, carried to now — see
      // lib/liveness.ts for why this is the only extension of the line that is
      // a true statement about what happened.
      const data = nowSeconds === null ? real : carryForward(real, nowSeconds);
      series.setData(data as Parameters<typeof series.setData>[0]);
      series.applyOptions({ visible: isolated === null || isolated === outcome.id });

      const last = data[data.length - 1];
      if (outcome.id === leadId && last !== undefined) {
        leadTime = last.time;
        leadValue = last.value;
      }
    }

    chart.current?.timeScale().fitContent();

    /*
     * The end dot, positioned against the canvas rather than drawn into it.
     *
     * lightweight-charts has no pulsing marker, and a static circle is not the
     * thing being said — "this is streaming" is a claim that has to keep
     * proving itself. So it is a DOM element over the canvas, which also means
     * it can be transitioned: when a trade lands the dot glides to the new
     * price instead of teleporting to it.
     *
     * Note what does *not* animate. The line itself jumps, because the price
     * jumped: a tweened price line would draw, for a few hundred milliseconds,
     * a sequence of prices at which nothing ever traded. That is exactly the
     * synthetic movement this whole block exists to avoid, and a smooth
     * animation is not worth a lie on the axis.
     */
    const target = leadId === undefined ? undefined : map.get(leadId);
    place.current = (): void => {
      if (target === undefined || leadTime === null || leadValue === null) {
        setDot(null);
        return;
      }
      const x = chart.current?.timeScale().timeToCoordinate(leadTime as Time) ?? null;
      const y = target.priceToCoordinate(leadValue);
      setDot((current) => {
        if (x === null || y === null) return null;
        // Guarded, because this also runs from the chart's own range-change
        // callback: setting an identical object would render on every pan.
        if (current !== null && current.x === x && current.y === y) return current;
        return { x, y };
      });
    };
    place.current();
  }, [lines, candleData, plotted, isolated, candles, candleTarget, timeframe, edge]);

  /**
   * The annotation marks.
   *
   * Split out from the data effect once the data effect started running every
   * few seconds. Marks are pinned to real trades and change only when the
   * market's history does — recomputing the snapping and the collision pass on
   * a clock tick would be work done five times a minute to produce the same
   * answer, and it would re-pin marks to the moving edge.
   */
  useEffect(() => {
    const times = points
      .map((p) => Math.floor(new Date(p.ts).getTime() / 1000))
      .sort((a, b) => a - b);
    const earliest = times[0];
    const latest = times[times.length - 1];
    if (earliest === undefined || latest === undefined) return;

    // Snap each annotation to the nearest point on the line. An event rarely
    // lands exactly on a trade, and a chart whose job is "what moved it"
    // (§7.3) must not silently drop the pin that explains a move.
    const nearest = (target: number): number =>
      times.reduce(
        (best, t) => (Math.abs(t - target) < Math.abs(best - target) ? t : best),
        times[0]!,
      );

    const snapped = annotations
      .map((annotation) => ({
        annotation,
        time: Math.floor(new Date(annotation.ts).getTime() / 1000),
      }))
      .filter(({ time }) => time >= earliest)
      .map(({ annotation, time }) => ({
        time: nearest(Math.min(time, latest)),
        // The open mark sits on the first point, where a centred label clips
        // off the left edge — and says nothing the start of the line does not.
        text:
          annotation.type === 'open' ? '' : annotation.label || ANNOTATION_MARK[annotation.type],
      }));

    // Two events on one point draw two dots stacked on top of each other, which
    // reads as a rendering fault rather than as history. A seeded market always
    // hits this — it opens and activates in the same instant — so the later
    // annotation wins the point, and a labelled one beats a bare mark.
    const byTime = new Map<number, { time: number; text: string }>();
    for (const mark of snapped) {
      const existing = byTime.get(mark.time);
      if (existing === undefined || mark.text !== '') byTime.set(mark.time, mark);
    }

    markers.current?.setMarkers(
      [...byTime.values()]
        .sort((a, b) => a.time - b.time)
        .map((mark) => ({
          time: mark.time as Time,
          position: 'aboveBar' as const,
          color: semantic.light.textMuted,
          shape: 'circle' as const,
          text: mark.text,
        })),
    );
  }, [points, annotations, plotted, isolated, candles, timeframe]);

  /**
   * The moment a trade lands, as a ring off the end dot.
   *
   * Keyed on the newest real point rather than on a render, so it fires when
   * the market moved and not when the clock did.
   */
  const newest = points.reduce((best, p) => Math.max(best, new Date(p.ts).getTime()), 0);
  const [landed, setLanded] = useState(0);
  const previous = useRef(newest);
  useEffect(() => {
    if (newest > previous.current) {
      previous.current = newest;
      setLanded((count) => count + 1);
    }
  }, [newest]);

  return (
    <div>
      {/* An empty canvas is a hole in the page. A market that has not traded —
          every seeding and funding ticket — says so in one line instead. */}
      <div className="relative">
        {/*
          What the crosshair is over, or the LIVE badge when it is not.
          
          One slot, because they are the same slot's worth of attention: while
          you are reading a moment in the past, "this is streaming" is not the
          thing you want the corner of the chart to be telling you.
        */}
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-end px-1 pt-1">
          {scrub !== null ? (
            <div className="rounded-md border border-border bg-surface/95 px-2.5 py-1.5 text-xs shadow-soft backdrop-blur">
              <p className="font-mono text-fine text-text-muted">
                {dateTime(new Date(scrub.ts).toISOString())}
              </p>
              <ul className="mt-0.5 space-y-0.5">
                {scrub.values.map((row) => {
                  const outcome = plotted.find((candidate) => candidate.id === row.id);
                  if (outcome === undefined) return null;
                  return (
                    <li key={row.id} className="flex items-center gap-1.5 whitespace-nowrap">
                      <span
                        className="inline-block size-2 rounded-sm"
                        style={{
                          backgroundColor: binary
                            ? semantic.light.rise
                            : outcomeColour(outcome.ordinal, outcome.isOther),
                        }}
                      />
                      <span>{outcome.label}</span>
                      <span className="ml-auto font-mono font-bold tabular-nums">
                        {row.value.toFixed(1)}%
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : (
            live &&
            points.length > 0 && (
              <span className="flex items-center gap-2 rounded-md bg-surface/90 px-2 py-1 backdrop-blur">
                <span className="flex items-center gap-1.5 font-mono text-fine font-bold uppercase tracking-widest text-rise">
                  <span className="size-1.5 animate-pulse rounded-full bg-rise" aria-hidden />
                  Live
                </span>
                {/*
                  The age, beside the badge that would otherwise be claiming
                  more than it can prove. "Live" on a chart that has not moved
                  in twenty minutes reads as broken; "Live · last trade 20m
                  ago" reads as a quiet market, which is what it is.
                */}
                {lastTradeAt != null && <LastTradeAge at={lastTradeAt} />}
              </span>
            )
          )}
        </div>

        <div ref={container} className={points.length === 0 ? 'hidden' : 'h-64 w-full sm:h-80'} />

        {/*
          The live edge.

          Sits at the end of the flat segment, which is at the present rather
          than at the last trade — that is the whole point of carrying the line
          forward. It pulses to say the market is open, and glides rather than
          jumps when a trade moves the price under it.
        */}
        {live && dot !== null && points.length > 0 && (
          <span
            aria-hidden
            className="pointer-events-none absolute z-[5] motion-safe:transition-[left,top] motion-safe:duration-500 motion-safe:ease-out"
            style={{ left: dot.x, top: dot.y }}
          >
            <span
              key={landed}
              className="absolute -left-2 -top-2 block size-4 rounded-full bg-rise/40 motion-safe:animate-ping"
            />
            <span className="absolute -left-[3px] -top-[3px] block size-1.5 rounded-full bg-rise ring-2 ring-surface" />
          </span>
        )}
      </div>
      {points.length === 0 && (
        <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-text-muted">
          No trades yet. The first one draws the line.
        </p>
      )}

      {/*
        The card's own footer, so the chart is not a picture with its facts
        somewhere else on the page. Volume says whether the line means anything;
        the settlement date says how long it has left to mean it; the countdown
        appears only inside a day, because a clock that ticks for three weeks
        teaches people to ignore the one ticking for three hours.
      */}
      {(volume !== undefined || settlesAt !== undefined) && (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-muted">
          {volume !== undefined && (
            <span>
              <b className="font-mono text-text">{money(volume)}</b> volume
            </span>
          )}
          {settlesAt !== undefined && (
            <>
              <span aria-hidden>·</span>
              <span>Settles {settlesOn(settlesAt)}</span>
              {countdown(settlesAt) !== null && (
                <span className="rounded-sm bg-caution-bg px-1.5 py-0.5 font-mono font-bold text-caution">
                  Ends in {countdown(settlesAt)}
                </span>
              )}
            </>
          )}
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-1" role="group" aria-label="Chart timeframe">
          {TIMEFRAMES.map((tf) => (
            <button
              key={tf}
              type="button"
              onClick={() => onTimeframeChange(tf)}
              aria-pressed={tf === timeframe}
              className={`rounded-sm px-2.5 py-1 font-mono text-xs transition-colors ${
                tf === timeframe ? 'bg-surface-raised text-text' : 'text-text-muted hover:text-text'
              }`}
            >
              {tf}
            </button>
          ))}
        </div>

        {/* §7.2a: "candlestick toggle for power users". Offered only where a
            candle has one series to be about — a binary market, or a candidate
            somebody has isolated. */}
        {candleable && (
          <button
            type="button"
            onClick={() => setStyle(style === 'area' ? 'candles' : 'area')}
            aria-pressed={candles}
            className={`rounded-sm px-2.5 py-1 font-mono text-xs transition-colors ${
              candles ? 'bg-surface-raised text-text' : 'text-text-muted hover:text-text'
            }`}
          >
            {candles ? 'Line' : 'Candles'}
          </button>
        )}

        {!binary && ranked.length > 5 && (
          <button
            type="button"
            onClick={() => setShowAll(!showAll)}
            aria-pressed={showAll}
            className="rounded-sm px-2.5 py-1 font-mono text-xs text-text-muted transition-colors hover:text-text"
          >
            {showAll ? 'Top 5' : `+${ranked.length - 5} others`}
          </button>
        )}

        {!binary && (
          <button
            type="button"
            onClick={() => setIsolated(null)}
            disabled={isolated === null}
            className="font-mono text-xs text-text-muted underline-offset-2 hover:underline disabled:opacity-0"
          >
            Show all lines
          </button>
        )}
      </div>

      {/* The legend, which is also how you isolate a candidate. */}
      {!binary && (
        <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-2">
          {plotted.map((outcome) => {
            const colour = outcomeColour(outcome.ordinal, outcome.isOther);
            const dimmed = isolated !== null && isolated !== outcome.id;
            return (
              <li key={outcome.id}>
                <button
                  type="button"
                  onClick={() => setIsolated(isolated === outcome.id ? null : outcome.id)}
                  aria-pressed={isolated === outcome.id}
                  className={`flex items-center gap-1.5 text-sm transition-opacity ${
                    dimmed ? 'opacity-35' : ''
                  }`}
                >
                  <span
                    className="inline-block h-2 w-2 rounded-sm"
                    style={{ backgroundColor: colour }}
                  />
                  <span>{outcome.label}</span>
                  <span className="font-mono tabular-nums text-text-muted">
                    {Math.round(percent(outcome.price))}%
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * "last trade 12s ago", ticking.
 *
 * Its own component so the seconds do not re-render the chart around it. The
 * parent redraws on a five-second step, which is the right cadence for a line
 * and much too coarse for a number counting seconds — separating them lets
 * each have the cadence it needs.
 *
 * Null until mounted, like every other clock in this app: the server has no
 * business rendering a duration it computed at build time.
 */
function LastTradeAge({ at }: { at: string }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = (): void => setNow(Date.now());
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, []);

  if (now === null) return null;
  return (
    <span className="whitespace-nowrap font-mono text-fine text-text-muted">
      last trade {elapsed(now - new Date(at).getTime())} ago
    </span>
  );
}
