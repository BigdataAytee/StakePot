/**
 * StakeAm design tokens — architecture §7.4.
 *
 * This file is the single source of truth. The Tailwind preset in `preset.ts`
 * derives everything it exposes from these objects, including the CSS custom
 * properties it injects, so there is no second copy of a hex value anywhere.
 */

/** The palette, exactly as specified. */
export const palette = {
  /** Page ground, light mode. */
  paper: '#FAFDF7',
  /** Primary text, light mode. */
  ink: '#10241B',
  /** Rise / YES. */
  green: '#0E7A3D',
  /** Deep green, for pressed and emphatic states. */
  greenDeep: '#0A5A2D',
  /** Fall / NO. */
  red: '#C93A2E',
  /** Money ONLY — pots, fees, payouts. Never decoration. */
  gold: '#E3A81C',
  /** Secondary text. */
  muted: '#5E7267',
  /** Hairlines and 1px borders. */
  line: '#DCE7DC',
} as const;

/** Page ground, dark mode. The one dark surface the spec pins down. */
export const darkBase = '#0B1A13';

/**
 * Semantic roles. Dark mode keeps the same roles against `darkBase`.
 *
 * Only `surface` is given by the spec for dark; the remaining dark values are
 * derived from the light palette to hold the same contrast relationships, and
 * are the ones to revisit first when the full §7.4 doc lands.
 */
export const semantic = {
  light: {
    surface: palette.paper,
    surfaceRaised: '#FFFFFF',
    text: palette.ink,
    textMuted: palette.muted,
    border: palette.line,
    rise: palette.green,
    riseDeep: palette.greenDeep,
    fall: palette.red,
    money: palette.gold,
  },
  dark: {
    surface: darkBase,
    /** The light-mode ink reads as a raised surface once the ground is dark. */
    surfaceRaised: palette.ink,
    text: '#EAF2EC',
    textMuted: '#8FA69A',
    border: '#1E3328',
    /** Lifted for legibility against a dark ground; same semantic role. */
    rise: '#22A85C',
    riseDeep: palette.green,
    fall: '#E4574A',
    money: '#F0BC3E',
  },
} as const;

export type SemanticRole = keyof (typeof semantic)['light'];

/**
 * Type scale in px: 12 / 13.5 / 15 / 17 / 21 / 28 / 34.
 *
 * Named twice on purpose — `xs…2xl` for laying out, and the aliases below for
 * saying what a thing is.
 */
export const typeScale = {
  xs: 12,
  sm: 13.5,
  base: 15,
  md: 17,
  lg: 21,
  xl: 28,
  '2xl': 34,
} as const;

export const typeScaleAliases = {
  caption: typeScale.xs,
  label: typeScale.sm,
  body: typeScale.base,
  bodyLg: typeScale.md,
  title: typeScale.lg,
  headline: typeScale.xl,
  display: typeScale['2xl'],
} as const;

/** Line heights, tightening as the type gets larger. */
export const lineHeights: Record<keyof typeof typeScale, number> = {
  xs: 1.4,
  sm: 1.4,
  base: 1.55,
  md: 1.5,
  lg: 1.3,
  xl: 1.15,
  '2xl': 1.05,
};

export const fonts = {
  /** Archivo, variable, 400–900. Display and body both. */
  display: 'Archivo',
  body: 'Archivo',
  /** Space Mono. Every live figure, tabular numerals. */
  mono: 'Space Mono',
} as const;

/** Weight 900 is reserved for headline numbers and market questions. */
export const fontWeights = {
  regular: 400,
  medium: 500,
  semibold: 600,
  bold: 700,
  black: 900,
} as const;

/** Radii live in an 8–14px band. Nothing rounder, nothing squarer. */
export const radii = {
  sm: 8,
  md: 10,
  lg: 12,
  xl: 14,
} as const;

/** 4px spacing grid. */
export const spacingUnit = 4;

/** Borders are always 1px in `line`. */
export const borderWidth = 1;

/** Single-layer soft shadows — no stacked elevation. */
export const shadows = {
  soft: '0 1px 2px 0 rgb(16 36 27 / 0.06)',
  lifted: '0 2px 8px 0 rgb(16 36 27 / 0.08)',
} as const;

/**
 * SPcoin — the points-mode currency, specified in §7.4 as an object rather than
 * a number with a label.
 *
 * Gold is money-only per the palette rule, and SPcoin is the only *object* ever
 * rendered in gold. The asset itself lives at apps/web/public/spcoin.svg.
 */
export const spcoin = {
  /** Radial gradient, light to dark. */
  gradient: ['#F6C453', '#E3A81C', '#B8860B'],
  /** The inner face the pot silhouette and SP monogram sit on. */
  face: palette.greenDeep,
  /** Inline balance size, e.g. `<coin> 12,400 SP`. */
  smallPx: 18,
  /** Wallet header and win moments. */
  fullPx: 48,
} as const;

/**
 * Outcome series colours, for markets with more than two sides.
 *
 * Ordered by rank, so the leader is always `green` and the runner-up `red` —
 * the same reading a binary market's argument bar gives, extended rather than
 * replaced. The chart legend, the stacked bar and the outcome rows all take
 * their colour from here, so one candidate is one colour everywhere on screen.
 *
 * Gold is absent on purpose. §7.4 reserves it for money — pots, fees, payouts —
 * and a candidate rendered in gold would quietly break the one rule the palette
 * has. The extra steps are tints of the existing greens and reds instead, which
 * keeps a six-candidate election inside the Naija Green identity.
 */
export const outcomeSeries = [
  palette.green,
  palette.red,
  // Ordered so adjacent ranks alternate hue family rather than shade. Ranks 1
  // and 3 are the pair a reader compares most, and two greens a shade apart is
  // not a comparison anyone can make on a line chart.
  '#2FA35F',
  '#E4574A',
  palette.greenDeep,
  '#8C2018',
  '#1B5E3A',
  '#F08A80',
] as const;

/** The catch-all bucket reads as neutral: it is not a candidate. */
export const otherOutcomeColour = palette.muted;

/**
 * The colour for one outcome, everywhere it appears — chart line, legend swatch,
 * stacked bar segment, outcome row.
 */
export function outcomeColour(ordinal: number, isOther = false): string {
  if (isOther) return otherOutcomeColour;
  return outcomeSeries[ordinal % outcomeSeries.length] ?? outcomeSeries[0];
}

/** Motion tokens. */
export const motion = {
  /** Count-up on a price tick, with a green/red tint over the same window. */
  priceTickMs: 250,
  /** The ticket-view chart line draws in once on open. */
  chartDrawMs: 600,
  /** The argument bar's easing. */
  barEase: 'cubic-bezier(.2,.8,.2,1)',
  /** Buttons depress on press — the only scale transform in the system. */
  pressScale: 0.97,
} as const;

/** CSS custom property names, so the preset and any hand-written CSS agree. */
export const cssVar = {
  font: {
    display: '--font-archivo',
    mono: '--font-space-mono',
  },
  role: (role: SemanticRole): string =>
    `--sa-${role.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`,
} as const;
