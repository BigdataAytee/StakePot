'use client';

import {
  AreaSeries,
  LineSeries,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type Time,
} from 'lightweight-charts';
import { useEffect, useMemo, useRef, useState } from 'react';

import { outcomeColour, semantic, type SemanticRole } from '@stakeam/tokens';

import type { Annotation, OutcomeView, PricePoint } from '@/lib/api';
import { percent } from '@/lib/format';

const TIMEFRAMES = ['1H', '6H', '1D', '1W', 'ALL'] as const;
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
}: {
  points: PricePoint[];
  outcomes: OutcomeView[];
  annotations: Annotation[];
  timeframe: Timeframe;
  onTimeframeChange: (tf: Timeframe) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const seriesByOutcome = useRef(new Map<string, ISeriesApi<'Area'> | ISeriesApi<'Line'>>());
  const markers = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const [isolated, setIsolated] = useState<string | null>(null);

  const binary = outcomes.length === 2;
  // Binary charts tell the story of the first outcome; the second is its mirror.
  const plotted = useMemo(() => (binary ? outcomes.slice(0, 1) : outcomes), [binary, outcomes]);

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

    const map = new Map<string, ISeriesApi<'Area'> | ISeriesApi<'Line'>>();
    for (const outcome of plotted) {
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

    return () => {
      created.remove();
      chart.current = null;
      seriesByOutcome.current = new Map();
      markers.current = null;
    };
    // Rebuilt when the market's outcome set changes — that is a different chart.
  }, [plotted, binary]);

  useEffect(() => {
    const map = seriesByOutcome.current;
    if (map.size === 0) return;

    let earliest: number | null = null;
    let latest: number | null = null;

    for (const outcome of plotted) {
      const series = map.get(outcome.id);
      if (series === undefined) continue;

      const seen = new Set<number>();
      const data = points
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
        .sort((a, b) => a.time - b.time);

      series.setData(data as Parameters<typeof series.setData>[0]);
      series.applyOptions({
        visible: isolated === null || isolated === outcome.id,
      });

      if (data.length > 0) {
        earliest = earliest === null ? data[0]!.time : Math.min(earliest, data[0]!.time);
        latest =
          latest === null
            ? data[data.length - 1]!.time
            : Math.max(latest, data[data.length - 1]!.time);
      }
    }

    if (earliest !== null && latest !== null) {
      const times = points
        .map((p) => Math.floor(new Date(p.ts).getTime() / 1000))
        .sort((a, b) => a - b);
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
        .filter(({ time }) => time >= earliest!)
        .map(({ annotation, time }) => ({
          time: nearest(Math.min(time, latest!)),
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
      chart.current?.timeScale().fitContent();
    }
  }, [points, annotations, plotted, isolated]);

  return (
    <div>
      {/* An empty canvas is a hole in the page. A market that has not traded —
          every seeding and funding ticket — says so in one line instead. */}
      <div ref={container} className={points.length === 0 ? 'hidden' : 'h-64 w-full sm:h-80'} />
      {points.length === 0 && (
        <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-text-muted">
          No trades yet. The first one draws the line.
        </p>
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

        {!binary && (
          <button
            type="button"
            onClick={() => setIsolated(null)}
            disabled={isolated === null}
            className="font-mono text-xs text-text-muted underline-offset-2 hover:underline disabled:opacity-0"
          >
            Show all
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
