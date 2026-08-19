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
 * opacity modifiers (`bg-surface/60`) on top of a CSS custom property.
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
 * The §7.4 tokens as a Tailwind preset.
 *
 * Consumers extend it and supply their own `content`. The preset also injects
 * the light/dark custom properties as base styles, so nothing outside this
 * package needs to restate a hex value.
 */
export const tailwindPreset: Partial<Config> = {
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Semantic roles — these flip with the theme.
        surface: themed('surface'),
        'surface-raised': themed('surfaceRaised'),
        text: themed('text'),
        'text-muted': themed('textMuted'),
        border: themed('border'),
        rise: themed('rise'),
        'rise-deep': themed('riseDeep'),
        fall: themed('fall'),
        money: themed('money'),
        // The literal palette, for the rare mark that must not flip.
        ...palette,
      },
      fontFamily: {
        sans: [`var(${cssVar.font.display})`, 'Archivo', 'system-ui', 'sans-serif'],
        display: [`var(${cssVar.font.display})`, 'Archivo', 'system-ui', 'sans-serif'],
        mono: [`var(${cssVar.font.mono})`, 'Space Mono', 'ui-monospace', 'monospace'],
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
      transitionTimingFunction: { bar: motion.barEase },
      transitionDuration: {
        tick: `${motion.priceTickMs}ms`,
        chart: `${motion.chartDrawMs}ms`,
      },
      scale: { press: String(motion.pressScale) },
      backgroundImage: {
        spcoin: `radial-gradient(circle at 30% 25%, ${spcoin.gradient.join(', ')})`,
      },
      keyframes: {
        'tick-up': {
          '0%': { color: themed('rise').replace('<alpha-value>', '1') },
          '100%': { color: 'inherit' },
        },
        'tick-down': {
          '0%': { color: themed('fall').replace('<alpha-value>', '1') },
          '100%': { color: 'inherit' },
        },
        // Half a list-height, because the list is rendered twice — the seam
        // lands exactly where the first copy ended, so there is no jump.
        'marquee-y': {
          '0%': { transform: 'translateY(0)' },
          '100%': { transform: 'translateY(-50%)' },
        },
      },
      animation: {
        'tick-up': `tick-up ${motion.priceTickMs}ms ${motion.barEase}`,
        'tick-down': `tick-down ${motion.priceTickMs}ms ${motion.barEase}`,
        // The featured card's activity column. Linear and unending: it is
        // ambient, and an eased loop would draw the eye on every cycle.
        'marquee-y': 'marquee-y 30s linear infinite',
      },
    },
  },
  plugins: [
    plugin(({ addBase }) => {
      addBase({
        ':root': varsFor('light'),
        // System preference, unless the user has explicitly chosen light.
        '@media (prefers-color-scheme: dark)': {
          ':root:not(.light)': varsFor('dark'),
        },
        // An explicit choice always wins.
        ':root.dark, .dark': varsFor('dark'),

        body: {
          backgroundColor: `rgb(var(${cssVar.role('surface')}))`,
          color: `rgb(var(${cssVar.role('text')}))`,
          fontFamily: `var(${cssVar.font.display}), Archivo, system-ui, sans-serif`,
          fontSize: `${typeScale.base}px`,
          lineHeight: String(lineHeights.base),
          textRendering: 'optimizeLegibility',
          WebkitFontSmoothing: 'antialiased',
        },

        // Live figures are mono and tabular so a ticking number does not jitter.
        'code, kbd, samp, pre, .figure': {
          fontFamily: `var(${cssVar.font.mono}), Space Mono, ui-monospace, monospace`,
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
    }),
  ],
};

export default tailwindPreset;
