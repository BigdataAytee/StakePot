import type { Config } from 'tailwindcss';
import plugin from 'tailwindcss/plugin';
import {
  borderWidth,
  cssVar,
  fontWeights,
  lineHeights,
  motion,
  palette,
  radii,
  semantic,
  shadows,
  spacingUnit,
  spcoin,
  typeScale,
  typeScaleAliases,
  type SemanticRole,
} from './tokens';

/**
 * `#RRGGBB` → `"r g b"`, the space-separated form Tailwind needs to compose
 * opacity modifiers (`bg-chip/60`) on top of a CSS custom property.
 */
function toRgbTriplet(hex: string): string {
  const match = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (match === null) {
    throw new Error(`expected a #RRGGBB colour, received "${hex}"`);
  }
  const value = Number.parseInt(match[1] as string, 16);
  return `${(value >> 16) & 255} ${(value >> 8) & 255} ${value & 255}`;
}

const ROLES = Object.keys(semantic.light) as SemanticRole[];

function varsFor(mode: 'light' | 'dark'): Record<string, string> {
  return Object.fromEntries(
    ROLES.map((role) => [cssVar.role(role), toRgbTriplet(semantic[mode][role])]),
  );
}

/** A themeable colour, resolved through its custom property. */
function themed(role: SemanticRole): string {
  return `rgb(var(${cssVar.role(role)}) / <alpha-value>)`;
}

const fontSizes = Object.fromEntries([
  ...Object.entries(typeScale).map(([name, px]) => [
    name,
    [`${px}px`, { lineHeight: String(lineHeights[name as keyof typeof typeScale]) }],
  ]),
  ...Object.entries(typeScaleAliases).map(([name, px]) => [name, [`${px}px`, {}]]),
]);

/**
 * The design tokens as a Tailwind preset.
 *
 * Authoritative reference: docs/design-reference.html.
 *
 * Consumers extend it and supply their own `content`. The preset also injects
 * the custom properties as base styles, so nothing outside this package needs
 * to restate a hex value.
 */
export const tailwindPreset: Partial<Config> = {
  theme: {
    extend: {
      colors: {
        // The literal palette first, for the rare mark that must not be
        // re-pointed — `text-paper` on a coloured button, the star's gold.
        ...palette,
        // Then the semantic roles, which win where the names meet (`chip` is
        // both a palette entry and a role, and the role is the one to use).
        surface: themed('surface'),
        'surface-raised': themed('surfaceRaised'),
        chip: themed('chip'),
        text: themed('text'),
        'text-muted': themed('textMuted'),
        border: themed('border'),
        brand: themed('brand'),
        'brand-deep': themed('brandDeep'),
        rise: themed('rise'),
        'rise-bg': themed('riseBg'),
        'rise-deep': themed('riseDeep'),
        fall: themed('fall'),
        'fall-bg': themed('fallBg'),
        money: themed('money'),
        caution: themed('caution'),
        'caution-bg': themed('cautionBg'),
      },
      fontFamily: {
        sans: [`var(${cssVar.font.display})`, 'Open Sauce', 'Inter', 'system-ui', 'sans-serif'],
        display: [`var(${cssVar.font.display})`, 'Open Sauce', 'Inter', 'system-ui', 'sans-serif'],
        // There is no second typeface. `font-mono` still means "this is a live
        // figure" — the ~180 places that say so keep working, and the numerals
        // are held in their columns by `font-variant-numeric` below rather
        // than by switching face.
        mono: [`var(${cssVar.font.numeric})`, 'Open Sauce', 'Inter', 'system-ui', 'sans-serif'],
      },
      fontSize: fontSizes,
      fontWeight: Object.fromEntries(
        Object.entries(fontWeights).map(([name, weight]) => [name, String(weight)]),
      ),
      borderRadius: Object.fromEntries(
        Object.entries(radii).map(([name, px]) => [name, `${px}px`]),
      ),
      borderWidth: { DEFAULT: `${borderWidth}px` },
      boxShadow: shadows,
      // The 4px grid. Tailwind's default scale is already in 4px steps; these
      // are the named rungs the layouts refer to.
      spacing: Object.fromEntries(
        [1, 2, 3, 4, 6, 8, 12, 16, 24].map((step) => [`grid-${step}`, `${step * spacingUnit}px`]),
      ),
      transitionTimingFunction: { bar: motion.ease },
      transitionDuration: {
        tick: `${motion.priceTickMs}ms`,
        lift: `${motion.liftMs}ms`,
        chart: `${motion.chartDrawMs}ms`,
        toggle: `${motion.toggleMs}ms`,
        sheet: `${motion.sheetMs}ms`,
      },
      scale: { press: String(motion.pressScale) },
      backgroundImage: {
        spcoin: `radial-gradient(circle at 30% 25%, ${spcoin.gradient.join(', ')})`,
      },
      keyframes: {
        // The live dot beside the Trending tab.
        pulse: { '50%': { opacity: '.35' } },
        'tick-up': {
          '0%': { color: themed('rise').replace('<alpha-value>', '1') },
          '100%': { color: 'inherit' },
        },
        'tick-down': {
          '0%': { color: themed('fall').replace('<alpha-value>', '1') },
          '100%': { color: 'inherit' },
        },
        // The trade sheet's amount field, acknowledging a quick-add chip.
        // A chip adds to what is already there, so the only evidence a tap
        // landed is that the digits changed — and digits changing by the same
        // step twice looks a lot like nothing happening. This is the receipt.
        'chip-tick': {
          '0%': { transform: 'scale(1)' },
          '35%': { transform: 'scale(1.018)' },
          '100%': { transform: 'scale(1)' },
        },
      },
      animation: {
        pulse: 'pulse 1.4s infinite',
        'tick-up': `tick-up ${motion.priceTickMs}ms ${motion.ease}`,
        'tick-down': `tick-down ${motion.priceTickMs}ms ${motion.ease}`,
        'chip-tick': `chip-tick ${motion.priceTickMs}ms ${motion.ease}`,
      },
    },
  },
  plugins: [
    plugin(({ addBase, addUtilities }) => {
      addBase({
        // Light-only, as the reference is — see the note in tokens.ts. Both
        // selectors are emitted so that a `.dark` class left on an element
        // resolves to the same roles instead of to nothing.
        ':root': varsFor('light'),
        ':root.dark, .dark': varsFor('dark'),

        html: { scrollbarGutter: 'stable' },

        body: {
          backgroundColor: `rgb(var(${cssVar.role('surface')}))`,
          color: `rgb(var(${cssVar.role('text')}))`,
          fontFamily: `var(${cssVar.font.display}), Open Sauce, Inter, system-ui, sans-serif`,
          fontSize: `${typeScale.base}px`,
          lineHeight: String(lineHeights.base),
          textRendering: 'optimizeLegibility',
          WebkitFontSmoothing: 'antialiased',
        },

        /*
         * One focus ring, everywhere, for keyboard users only.
         *
         * Twenty-two controls were setting `outline-none` and signalling focus
         * with a border colour instead. That is weak on two counts: a 1px
         * border tint is easy to miss and fails WCAG 2.4.11's focus-appearance
         * bar, and `:focus` fires on mouse clicks too, so the cue appears when
         * it is not wanted and is then suppressed by the very people who need
         * it with a keyboard.
         *
         * `:focus-visible` is the browser telling us the user is navigating by
         * keyboard. Answering it once here means a new control is accessible by
         * default rather than by remembering.
         */
        ':focus-visible': {
          outline: `2px solid rgb(var(${cssVar.role('brand')}))`,
          outlineOffset: '2px',
          // The ring is drawn outside the element, so a control flush against a
          // scroll container's edge still shows it.
          borderRadius: 'inherit',
        },

        // Live figures hold their columns so a ticking number does not jitter.
        // Same face as everything else; only the numerals change behaviour.
        'code, kbd, samp, pre, .figure': {
          fontVariantNumeric: 'tabular-nums',
        },

        '@media (prefers-reduced-motion: reduce)': {
          '*, *::before, *::after': {
            animationDuration: '0.01ms !important',
            animationIterationCount: '1 !important',
            transitionDuration: '0.01ms !important',
            scrollBehavior: 'auto !important',
          },
        },
      });

      // `font-mono` no longer changes face — it changes how the numerals sit.
      // That is the whole of what it was ever for here: a price that ticks
      // must not shift the characters beside it.
      addUtilities({ '.font-mono': { fontVariantNumeric: 'tabular-nums' } });
    }),
  ],
};

export default tailwindPreset;
