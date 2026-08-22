import { iconColour, monogram } from '@/lib/home';

/**
 * The square beside a question.
 *
 * The reference hangs an artwork here and falls back to a coloured tile with
 * the title's initial when there is none. We are always in the fallback case —
 * markets on this platform carry no image — so the tile is the design rather
 * than a hole where one failed to load, and it is built to be recognisable:
 * the colour is derived from the market id, so the same question wears the
 * same square on every screen and on every visit.
 */
export function MarketIcon({
  id,
  question,
  size = 40,
  radius = 8,
}: {
  id: string;
  question: string;
  size?: number;
  radius?: number;
}) {
  return (
    <span
      aria-hidden
      className="flex shrink-0 items-center justify-center font-bold leading-none text-paper"
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        fontSize: Math.round(size * 0.4),
        background: iconColour(id),
      }}
    >
      {monogram(question).slice(0, 1)}
    </span>
  );
}
