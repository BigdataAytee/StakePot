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

/** Motion tokens. */
export const motion = {
  /** Count-up on a price tick, with a green/red tint over the same window. */
  priceTickMs: 250,
  /** The argument bar's easing. */
  barEase: 'cubic-bezier(.2,.8,.2,1)',
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
