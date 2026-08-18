import { palette } from '@stakeam/tokens';

/**
 * The market card's 24h mini sparkline (§7.1) — "sparklines on cards create the
 * pull into detail views" (§7.3).
 *
 * Inline SVG rather than a chart library: it is decoration-free data at 96×24,
 * and a second charting runtime on a list of fifty cards would cost more than
 * it renders.
 */
export function Sparkline({
  points,
  width = 96,
  height = 24,
}: {
  points: string[];
  width?: number;
  height?: number;
}) {
  if (points.length < 2) {
    return <div style={{ width, height }} aria-hidden />;
  }

  const values = points.map((p) => Number.parseFloat(p) * 100);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const rising = values[values.length - 1]! >= values[0]!;

  const d = values
    .map((value, index) => {
      const x = (index / (values.length - 1)) * width;
      const y = height - ((value - min) / span) * (height - 2) - 1;
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden
      focusable="false"
    >
      <path
        d={d}
        fill="none"
        stroke={rising ? palette.green : palette.red}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
