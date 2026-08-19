import { monogram, tileHue } from '@/lib/home';

/**
 * The square next to a question.
 *
 * Every market on the front page wears one, at three sizes: 30px in a carousel
 * outcome row, 38px on a grid card, 56px on a featured slide. It carries the
 * question's initials over a hue derived from the market id, so a market looks
 * the same everywhere it appears and nothing ever renders as a broken image.
 */
export function MarketTile({
  id,
  question,
  size = 38,
  className = '',
}: {
  id: string;
  question: string;
  size?: number;
  className?: string;
}) {
  const hue = tileHue(id);

  return (
    <span
      aria-hidden
      className={`grid shrink-0 place-items-center rounded-sm font-black leading-none text-paper ${className}`}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.36),
        background: `linear-gradient(140deg, hsl(${hue} 52% 38%), hsl(${(hue + 38) % 360} 46% 24%))`,
      }}
    >
      {monogram(question)}
    </span>
  );
}
