'use client';

import {
  AreaSeries,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type Time,
} from 'lightweight-charts';
import { useEffect, useRef } from 'react';

import type { Annotation, PricePoint } from '@/lib/api';
import { palette, semantic } from '@stakeam/tokens';

const TIMEFRAMES = ['1H', '6H', '1D', '1W', 'ALL'] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

/** The marks §7.2a pins on the chart, so the line doubles as the market's timeline. */
const ANNOTATION_MARK: Record<Annotation['type'], { text: string; colour: string }> = {
  open: { text: 'Open', colour: palette.muted },
  activation: { text: 'Live', colour: palette.green },
  big_trade: { text: 'Big trade', colour: palette.gold },
  news: { text: 'News', colour: palette.ink },
  freeze: { text: 'Frozen', colour: palette.muted },
  resolution: { text: 'Result', colour: palette.greenDeep },
};

/**
 * §7.2a — the hero.
 *
 * "Smooth area chart of probability over time (0–100%) for the selected
 * outcome... Event annotations pinned on the chart: market opened, activation
 * reached, large trades, admin news pins, freeze, resolution. The chart doubles
 * as the market's timeline — a newcomer reads the whole drama at a glance."
 *
 * Which is why the annotations are not decoration: they are the answer to
 * "what moved it", the third of the three questions §7.3 says this display
 * exists to answer in one glance.
 */
export function PriceChart({
  points,
  annotations,
  timeframe,
  onTimeframeChange,
}: {
  points: PricePoint[];
  annotations: Annotation[];
  timeframe: Timeframe;
  onTimeframeChange: (tf: Timeframe) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<'Area'> | null>(null);
  const markers = useRef<ISeriesMarkersPluginApi<Time> | null>(null);

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
      grid: {
        horzLines: { color: theme.border },
        vertLines: { visible: false },
      },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.12, bottom: 0.08 } },
      timeScale: { borderVisible: false, timeVisible: true },
      crosshair: { horzLine: { labelVisible: false } },
      handleScale: false,
      handleScroll: false,
    });

    const area = created.addSeries(AreaSeries, {
      lineColor: theme.rise,
      topColor: `${theme.rise}33`,
      bottomColor: `${theme.rise}00`,
      lineWidth: 2,
      // A market can spend all day inside a three-point band, where whole
      // percentages repeat down the axis and read as a rendering fault.
      priceFormat: { type: 'custom', minMove: 0.1, formatter: (p: number) => `${p.toFixed(1)}%` },
      lastValueVisible: false,
      priceLineVisible: false,
    });

    chart.current = created;
    series.current = area;
    markers.current = createSeriesMarkers(area, []);

    return () => {
      created.remove();
      chart.current = null;
      series.current = null;
      markers.current = null;
    };
  }, []);

  useEffect(() => {
    const area = series.current;
    if (area === null) return;

    // lightweight-charts wants one point per timestamp, ascending.
    const seen = new Set<number>();
    const data = points
      .map((p) => ({
        time: Math.floor(new Date(p.ts).getTime() / 1000),
        value: Number.parseFloat(p.price) * 100,
      }))
      .filter((p) => {
        if (seen.has(p.time)) return false;
        seen.add(p.time);
        return true;
      })
      .sort((a, b) => a.time - b.time);

    area.setData(data as Parameters<typeof area.setData>[0]);

    if (data.length > 0) {
      const first = data[0]!.time;
      const last = data[data.length - 1]!.time;
      // Snap each annotation to the nearest point on the line. An event rarely
      // lands exactly on a trade, and a chart whose job is "what moved it"
      // (§7.3) must not silently drop the pin that explains a move. Events
      // before the window belong to an earlier timeframe and are left out.
      const times = data.map((point) => point.time);
      const nearest = (target: number): number =>
        times.reduce(
          (best, t) => (Math.abs(t - target) < Math.abs(best - target) ? t : best),
          times[0]!,
        );

      markers.current?.setMarkers(
        annotations
          .map((annotation) => ({
            annotation,
            time: Math.floor(new Date(annotation.ts).getTime() / 1000),
            mark: ANNOTATION_MARK[annotation.type],
          }))
          .filter(({ time }) => time >= first)
          .map(({ annotation, time, mark }) => ({
            time: nearest(Math.min(time, last)) as Time,
            position: 'aboveBar' as const,
            color: mark.colour,
            shape: 'circle' as const,
            // The open mark sits on the first point, where a centred label
            // clips off the left edge — and where it says nothing the start of
            // the line does not already say. The dot alone is enough.
            text: annotation.type === 'open' ? '' : annotation.label || mark.text,
          }))
          .sort((a, b) => (a.time as number) - (b.time as number)),
      );
      chart.current?.timeScale().fitContent();
    }
  }, [points, annotations]);

  return (
    <div>
      <div ref={container} className="h-64 w-full sm:h-80" />

      <div className="mt-3 flex gap-1" role="group" aria-label="Chart timeframe">
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

      {points.length === 0 && (
        <p className="mt-3 text-sm text-text-muted">No trades yet. The first one draws the line.</p>
      )}
    </div>
  );
}
