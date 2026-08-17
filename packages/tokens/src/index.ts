/**
 * StakeAm design tokens — architecture §7.4.
 *
 * `tailwindPreset` is the intended entry point for apps; the raw token objects
 * are exported for the places Tailwind cannot reach (canvas, share cards,
 * chart series colours).
 */
export {
  borderWidth,
  cssVar,
  darkBase,
  fonts,
  fontWeights,
  lineHeights,
  motion,
  palette,
  radii,
  semantic,
  shadows,
  spacingUnit,
  typeScale,
  typeScaleAliases,
} from './tokens';
export type { SemanticRole } from './tokens';

export { tailwindPreset } from './preset';
export { default } from './preset';
