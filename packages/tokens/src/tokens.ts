/**
 * StakeAm design tokens.
 *
 * Authoritative reference: docs/design-reference.html. Every value below is
 * lifted from that file's `:root` block and its component rules — it is the
 * source of truth for how this product looks, and this module exists so that
 * the truth is stated once and Tailwind, the canvas share cards and the chart
 * all read the same numbers.
 *
 * This replaces the earlier "Naija Green" direction wholesale.
 *
 * The system is light-only, as the reference is. That is a deliberate position
 * rather than an omission: the palette leans on a white ground with a single
 * hairline (`line`) and one soft shadow doing all the elevation work, and none
 * of that survives a naive inversion. A dark palette is a design job, not a
 * transform, and until it is done the roles below resolve the same way in
 * both modes.
 */

/**
 * The palette, exactly as the reference states it.
 *
 * Three colours carry meaning and nothing else may borrow them: blue is the
 * primary action, green is Yes, red is No.
 */
export const palette = {
  /** Page ground. */
  paper: '#ffffff',
  /** Primary text. */
  ink: '#1d2b39',
  /** Secondary text. */
  muted: '#828a93',
  /** Hairlines and 1px borders — the only divider in the system. */
  line: '#e4e9ef',
  /** The quiet fill: search field, sort pills, trade panel, star hover. */
  chip: '#f2f5f8',

  /** Primary action. Buttons that are not a side of a market are this. */
  blue: '#2d5cf6',
  /** Pressed and emphatic blue. */
  blueDeep: '#1f47d4',

  /** Yes. */
  green: '#27ae5f',
  /** The wash a resting Yes button sits on before it is hovered. */
  greenBg: '#e9f7ef',
  /** Deep green, for pressed states. */
  greenDeep: '#1e8f4d',

  /** No. */
  red: '#e64800',
  /** The wash a resting No button sits on. */
  redBg: '#fdeee7',

  /** A watchlisted star, and nothing else. */
  star: '#f4b63f',
} as const;

/**
 * Kept so the export surface does not change under consumers. The reference
 * has no dark ground; see the note at the top of this file.
 */
export const darkBase = palette.paper;

/**
 * Semantic roles — what a colour is *for*, which is what components name.
 *
 * The role names are unchanged from the previous system on purpose. They are
 * used in roughly nine hundred places across the app, and re-pointing them is
 * what lets one edit here restyle every screen rather than sixty files each
 * needing a hand.
 */
const roles = {
  /** The page. */
  surface: palette.paper,
  /**
   * Cards and panels. The same white as the page: in this system a card is
   * separated by its hairline and its shadow, not by a change of ground.
   * Anything that needs to read as recessed uses `chip`.
   */
  surfaceRaised: palette.paper,
  /** The quiet fill — inputs, pills, the trade panel. */
  chip: palette.chip,
  text: palette.ink,
  textMuted: palette.muted,
  border: palette.line,

  /** Primary action. */
  brand: palette.blue,
  brandDeep: palette.blueDeep,

  /** Yes, and its resting wash. */
  rise: palette.green,
  riseBg: palette.greenBg,
  riseDeep: palette.greenDeep,
  /** No, and its resting wash. */
  fall: palette.red,
  fallBg: palette.redBg,

  /**
   * Money — balances, pots, payouts. Green, because the reference sets the
   * portfolio figure in green and a second money colour would be a third
   * meaning for a palette that only has room for three.
   */
  money: palette.green,

  /**
   * Caution — something needs attention but nothing is wrong yet.
   *
   * Added after a screenshot pass found the amber state missing across the
   * whole console. In the palette this replaced, `money` was gold, and every
   * "attention" mark in the admin screens was written as `text-money`: an SLA
   * about to breach, a dispute still open, a backup going stale, a funding
   * window inside its last day. The redesign re-pointed `money` to green and
   * every one of those quietly became a success colour — a breaching SLA
   * rendered as good news, which is worse than no colour at all.
   *
   * The reference's star gold is the only warm tone in the palette, and this
   * is what it is for. Red stays reserved for alarms, exactly as §6.10 asks.
   */
  caution: palette.star,
  cautionBg: '#fef6e6',
} as const;

export const semantic = {
  light: roles,
  /** Light-only system; see the note at the top of this file. */
  dark: roles,
} as const;

export type SemanticRole = keyof typeof roles;

/**
 * Type scale in px, read off the reference: 11.5 / 12.5 / 14 / 14.5 / 17 / 21 / 26.
 *
 * Tighter and smaller than what it replaces, which is most of why the new
 * screens read as denser at the same information count. 14 is body.
 */
export const typeScale = {
  xs: 11.5,
  sm: 12.5,
  base: 14,
  md: 14.5,
  lg: 17,
  xl: 21,
  '2xl': 26,
} as const;

export const typeScaleAliases = {
  caption: typeScale.xs,
  label: typeScale.sm,
  body: typeScale.base,
  /** Card titles and primary buttons. */
  bodyLg: typeScale.md,
  title: typeScale.lg,
  /** The big percentage, and a detail page's question. */
  headline: typeScale.xl,
  /** The chart's current price. */
  display: typeScale['2xl'],
} as const;

/** Line heights, tightening as the type gets larger. */
export const lineHeights: Record<keyof typeof typeScale, number> = {
  xs: 1.4,
  sm: 1.4,
  base: 1.4,
  md: 1.32,
  lg: 1.3,
  xl: 1.25,
  '2xl': 1.2,
};

export const fonts = {
  /** Open Sauce, four weights, served from our own origin. */
  display: 'OpenSauce',
  body: 'OpenSauce',
  /**
   * There is no second typeface. Figures are Open Sauce with tabular numerals
   * — see `cssVar.font.numeric` and the preset's `font-mono` mapping.
   */
  mono: 'OpenSauce',
} as const;

/**
 * Four weights, which is all the files carry.
 *
 * `black` is mapped to 700 rather than dropped: it is used in ~60 places to
 * mean "the heaviest thing on this screen", and 700 is now that weight.
 */
export const fontWeights = {
  regular: 400,
  medium: 500,
  semibold: 600,
  bold: 700,
  black: 700,
} as const;

/** Radii: cards 14, buttons and chips 6–10. */
export const radii = {
  /** Mini Yes/No chips, the star, sort pills. */
  sm: 6,
  /** Buttons, icons, the back button. */
  md: 8,
  /** Search field, the primary buy button, the amount input. */
  lg: 10,
  /** Cards, the chart box, the trade panel, the outcome list. */
  xl: 14,
} as const;

/** 4px spacing grid. */
export const spacingUnit = 4;

/** Borders are always 1px in `line`. */
export const borderWidth = 1;

/** One resting shadow and one hover shadow. Nothing stacks. */
export const shadows = {
  soft: '0 1px 3px rgba(29,43,57,.06)',
  lifted: '0 6px 18px rgba(29,43,57,.10)',
} as const;

/**
 * SPcoin — the points-mode currency.
 *
 * Restated in the new palette. The coin is the one object allowed to carry a
 * gold, because it is a coin; `money` as a text role is green.
 */
export const spcoin = {
  gradient: ['#f8d07a', palette.star, '#c8891f'],
  face: palette.ink,
  smallPx: 18,
  fullPx: 48,
} as const;

/**
 * Outcome series colours, for markets with more than two sides.
 *
 * Ranked, so the leader is green and the runner-up red — the same reading a
 * binary market's Yes/No pair gives, extended rather than replaced. Beyond
 * those two the ramp is the reference's own icon-fallback palette, which is
 * already tuned to sit together on a white ground.
 */
export const outcomeSeries = [
  palette.green,
  palette.red,
  palette.blue,
  '#8b5cf6',
  '#0ea5a4',
  '#d97706',
  palette.greenDeep,
  palette.blueDeep,
] as const;

/** The catch-all bucket reads as neutral: it is not a candidate. */
export const otherOutcomeColour = palette.muted;

/**
 * The colour for one outcome, everywhere it appears — chart line, legend
 * swatch, stacked bar segment, outcome row.
 */
export function outcomeColour(ordinal: number, isOther = false): string {
  if (isOther) return otherOutcomeColour;
  return outcomeSeries[ordinal % outcomeSeries.length] ?? outcomeSeries[0];
}

/** Motion, timed off the reference's transitions. */
export const motion = {
  /** `.pc{transition:color .3s}` — the tint a changed price wears. */
  priceTickMs: 300,
  /** How long that tint stays before it is cleared. */
  priceTintHoldMs: 600,
  /** The card's lift. */
  liftMs: 120,
  /** The chart line drawing in. */
  chartDrawMs: 600,
  /** The live switch, and the trade sheet. */
  toggleMs: 200,
  sheetMs: 250,
  /** Everything eases the same way unless it is a linear loop. */
  ease: 'cubic-bezier(.2,.8,.2,1)',
  /** `.quick.tapped{transform:scale(.93)}` */
  pressScale: 0.93,
} as const;

/** CSS custom property names, so the preset and any hand-written CSS agree. */
export const cssVar = {
  font: {
    /** Open Sauce. */
    display: '--font-sauce',
    /** The same face, asked for by the figures. */
    numeric: '--font-sauce',
  },
  role: (role: SemanticRole): string =>
    `--sa-${role.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`,
} as const;
