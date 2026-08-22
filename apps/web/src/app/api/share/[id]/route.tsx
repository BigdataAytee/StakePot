import { ImageResponse } from '@vercel/og';

import { palette } from '@stakeam/tokens';
import { API_URL } from '@/lib/api';

/**
 * §2.14d's share kit: "auto-generated market card (question + live percentages
 * + creator handle) sized for WhatsApp status and X; one-tap share."
 *
 * Rendered on the server, at request time, because the numbers on it are the
 * point — a card cached with yesterday's percentages is worse than no card,
 * since somebody will paste it into a group as though it were current.
 *
 * Two sizes, one layout. `?format=story` is the 9:16 WhatsApp status crop; the
 * default is the 1.91:1 link preview X and WhatsApp use in-line.
 */
export const runtime = 'nodejs';

const SIZES = {
  link: { width: 1200, height: 628 },
  story: { width: 1080, height: 1920 },
} as const;

/**
 * Archivo, fetched as TTF, because the renderer's default face has no ₦.
 *
 * A Nigerian market card that draws the naira sign as an empty box is not a
 * card anybody will paste into a group, and half the questions on this platform
 * have a naira threshold in them. Google serves WOFF2 to a modern
 * `User-Agent` and TTF to an old one; the renderer reads TTF, so the request
 * asks as an old browser deliberately.
 *
 * Fetched once per process and remembered. If it fails the card still renders
 * in the fallback face — a card with one wrong glyph beats a 500 — so the
 * failure is logged rather than thrown.
 */
const FONT_TEXT = encodeURIComponent(
  '₦%0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz .,:;!?()-—–’\'"/@#&+',
);

let fontCache: Promise<
  { name: string; data: ArrayBuffer; weight: 400 | 800; style: 'normal' }[]
> | null = null;

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
    const loaded = await Promise.all(
      urls.slice(0, 2).map(async (url, index) => ({
        name: 'Archivo',
        data: await fetch(url).then((response) => response.arrayBuffer()),
        weight: weights[index] ?? 400,
        style: 'normal' as const,
      })),
    );
    return loaded;
  })().catch((error: unknown) => {
    // Reset so a transient failure does not poison every later card.
    fontCache = null;
    console.error('share card: could not load Archivo', error);
    return [];
  });

  return fontCache;
}

interface OutcomeView {
  id: string;
  label: string;
  price: string;
}

interface MarketView {
  id: string;
  question: string;
  shelf: string;
  state: string;
  pot: string;
  outcomes: OutcomeView[];
  creator?: { handle: string | null; badge: string | null } | null;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  const url = new URL(request.url);
  const format = url.searchParams.get('format') === 'story' ? 'story' : 'link';
  const size = SIZES[format];

  const response = await fetch(`${API_URL}/markets/${id}`, { cache: 'no-store' });
  if (!response.ok) {
    return new Response('no such market', { status: 404 });
  }
  const market = (await response.json()) as MarketView;

  const outcomes = [...market.outcomes]
    .map((outcome) => ({ ...outcome, pct: Math.round(Number(outcome.price) * 100) }))
    .sort((left, right) => right.pct - left.pct)
    .slice(0, format === 'story' ? 5 : 4);

  const pot = Number(market.pot).toLocaleString('en-NG', { maximumFractionDigits: 0 });
  const handle = market.creator?.handle ?? null;
  const story = format === 'story';

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
        fontFamily: 'sans-serif',
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
          <span>{market.shelf === 'official' ? 'OFFICIAL' : 'COMMUNITY'}</span>
        </div>

        <div
          style={{
            display: 'flex',
            fontSize: story ? 76 : 58,
            lineHeight: 1.15,
            fontWeight: 800,
            color: palette.ink,
            marginTop: story ? 48 : 30,
          }}
        >
          {market.question}
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: story ? 26 : 18 }}>
        {outcomes.map((outcome, index) => (
          <div
            key={outcome.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 24,
              fontSize: story ? 46 : 36,
            }}
          >
            <div
              style={{
                display: 'flex',
                width: story ? 700 : 620,
                height: story ? 26 : 20,
                backgroundColor: palette.line,
                borderRadius: 999,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  // The leader is green, everything else is neutral: the card
                  // is a scoreboard, not an argument for one side.
                  width: `${Math.max(outcome.pct, 1)}%`,
                  backgroundColor: index === 0 ? palette.green : palette.muted,
                  borderRadius: 999,
                }}
              />
            </div>
            <div style={{ display: 'flex', fontWeight: 800, color: palette.ink }}>
              {outcome.pct}%
            </div>
            <div style={{ display: 'flex', color: palette.muted }}>{outcome.label}</div>
          </div>
        ))}
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
          <span style={{ color: palette.muted }}>Pot</span>
          {/* Money is green in this system — see docs/design-reference.html. */}
          <span style={{ color: palette.green, fontWeight: 800 }}>{pot} SPC</span>
        </div>
        {handle !== null && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <span style={{ color: palette.muted }}>@{handle}</span>
            {market.creator?.badge != null && (
              <span
                style={{
                  display: 'flex',
                  color: palette.paper,
                  backgroundColor: palette.green,
                  padding: '6px 18px',
                  borderRadius: 999,
                  fontSize: story ? 30 : 22,
                  fontWeight: 800,
                }}
              >
                {market.creator.badge}
              </span>
            )}
          </div>
        )}
      </div>
    </div>,
    { ...size, fonts: await brandFonts() },
  );
}
