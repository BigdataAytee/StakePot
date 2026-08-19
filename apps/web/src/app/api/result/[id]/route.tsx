import { ImageResponse } from '@vercel/og';

import { palette } from '@stakeam/tokens';
import { API_URL } from '@/lib/api';

/**
 * §2.15d's resolution-day recap card.
 *
 * "Resolution-day recap cards ('The 18% longshot landed — here's who called
 * it') market the next market."
 *
 * The market card (`/api/share/[id]`) sells an argument that is still open;
 * this one sells the *receipt*. It leads with what the crowd got wrong, because
 * that is the interesting half — a card saying the 91% favourite won is not
 * something anybody forwards.
 */
export const runtime = 'nodejs';

const SIZES = {
  link: { width: 1200, height: 628 },
  story: { width: 1080, height: 1920 },
} as const;

const FONT_TEXT = encodeURIComponent(
  '₦%0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz .,:;!?()-—–’\'"/@#&+',
);

let fontCache: Promise<
  { name: string; data: ArrayBuffer; weight: 400 | 800; style: 'normal' }[]
> | null = null;

/** Archivo as TTF — the default face has no ₦, and half these questions carry one. */
async function brandFonts() {
  fontCache ??= (async () => {
    const css = await fetch(
      `https://fonts.googleapis.com/css2?family=Archivo:wght@400;800&text=${FONT_TEXT}`,
      { headers: { 'User-Agent': 'Mozilla/4.0' } },
    ).then((response) => response.text());

    const urls = [...css.matchAll(/src: url\((?<url>[^)]+)\) format\('truetype'\)/g)].map(
      (match) => match.groups?.['url'] ?? '',
    );
    const weights: (400 | 800)[] = [400, 800];
    return Promise.all(
      urls.slice(0, 2).map(async (url, index) => ({
        name: 'Archivo',
        data: await fetch(url).then((response) => response.arrayBuffer()),
        weight: weights[index] ?? 400,
        style: 'normal' as const,
      })),
    );
  })().catch((error: unknown) => {
    fontCache = null;
    console.error('result card: could not load Archivo', error);
    return [];
  });

  return fontCache;
}

interface MarketView {
  id: string;
  question: string;
  state: string;
  pot: string;
  distributed: string | null;
  resolvedOutcomeId: string | null;
  outcomes: { id: string; label: string; price: string }[];
  creator?: { handle: string | null } | null;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  const format = new URL(request.url).searchParams.get('format') === 'story' ? 'story' : 'link';
  const size = SIZES[format];
  const story = format === 'story';

  const response = await fetch(`${API_URL}/markets/${id}`, { cache: 'no-store' });
  if (!response.ok) return new Response('no such market', { status: 404 });

  const market = (await response.json()) as MarketView;
  if (market.state !== 'resolved' || market.resolvedOutcomeId === null) {
    // A recap of a market that has not settled would be a claim about a result
    // that does not exist yet.
    return new Response('this market has not settled', { status: 409 });
  }

  const winner = market.outcomes.find((outcome) => outcome.id === market.resolvedOutcomeId);
  // The pot is drained at settlement, so the figure worth showing is what the
  // winners actually split.
  const pot = Number(market.distributed ?? market.pot).toLocaleString('en-NG', {
    maximumFractionDigits: 0,
  });

  // The price the winner was trading at *before* settlement is the story: the
  // lower it was, the fewer people saw it coming.
  const closingPct = Math.round(Number(winner?.price ?? 0) * 100);
  const longshot = closingPct <= 35;

  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        backgroundColor: palette.paper,
        padding: story ? 90 : 64,
        fontFamily: 'Archivo, sans-serif',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 16,
            fontSize: story ? 34 : 26,
            color: palette.muted,
            letterSpacing: 2,
          }}
        >
          <span style={{ color: palette.green, fontWeight: 800 }}>STAKEAM</span>
          <span>·</span>
          <span>SETTLED</span>
        </div>

        <div
          style={{
            display: 'flex',
            fontSize: story ? 64 : 48,
            lineHeight: 1.15,
            fontWeight: 800,
            color: palette.ink,
            marginTop: story ? 44 : 28,
          }}
        >
          {market.question}
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: story ? 20 : 14 }}>
        {longshot && (
          <div
            style={{
              display: 'flex',
              fontSize: story ? 42 : 32,
              color: palette.green,
              fontWeight: 800,
            }}
          >
            The {closingPct}% call landed.
          </div>
        )}
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: 20,
            fontSize: story ? 96 : 76,
            fontWeight: 800,
            color: palette.green,
          }}
        >
          {winner?.label ?? 'Settled'}
          <span style={{ fontSize: story ? 44 : 34, color: palette.muted, fontWeight: 400 }}>
            closed at {closingPct}%
          </span>
        </div>
      </div>

      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-end',
          fontSize: story ? 40 : 30,
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span style={{ color: palette.muted }}>Pot split between the winners</span>
          {/* Money is green in this system — see docs/design-reference.html. */}
          <span style={{ color: palette.green, fontWeight: 800 }}>{pot} SPC</span>
        </div>
        {market.creator?.handle != null && (
          <span style={{ color: palette.muted }}>@{market.creator.handle}</span>
        )}
      </div>
    </div>,
    { ...size, fonts: await brandFonts() },
  );
}
