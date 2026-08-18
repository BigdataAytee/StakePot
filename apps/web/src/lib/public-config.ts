'use client';

import { useEffect, useState } from 'react';

import { API_URL } from './api';

/**
 * The config values the logged-out screens quote (§6.7).
 *
 * Fetched rather than hardcoded because "every tunable value lives in config,
 * never in code" applies to the sentence on the signup button just as much as
 * to the fee split — a starter balance baked into marketing copy is a number
 * that goes quietly wrong the day finance changes it.
 */
export interface PublicConfig {
  starterBalanceSpc: string;
  signupBonusSpc: string;
  exitFeeRate: number;
}

export function usePublicConfig(): PublicConfig | null {
  const [config, setConfig] = useState<PublicConfig | null>(null);

  useEffect(() => {
    let live = true;
    void fetch(`${API_URL}/config/public`)
      .then((response) => (response.ok ? response.json() : null))
      .then((value: PublicConfig | null) => {
        // Null is a valid state, not an error: every caller renders a sentence
        // that works without the number, so an unreachable API costs a detail
        // rather than the screen.
        if (live && value !== null) setConfig(value);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  return config;
}
