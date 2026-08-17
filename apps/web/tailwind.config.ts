import { tailwindPreset } from '@stakeam/tokens';
import type { Config } from 'tailwindcss';

/**
 * The §7.4 tokens arrive entirely through the preset — no colour, radius or
 * type value is restated here. Anything this file adds is layout-only.
 */
export default {
  presets: [tailwindPreset],
  content: ['./src/**/*.{ts,tsx,mdx}'],
} satisfies Config;
