'use client';

import { Check, Share2 } from 'lucide-react';
import { useState } from 'react';

/**
 * §2.14d's share kit, from the market page.
 *
 * "Auto-generated market card… sized for WhatsApp status and X; one-tap share."
 * One tap is the native share sheet where the browser has one, and a copied
 * link where it does not — the fallback matters, because a share button that
 * silently does nothing on desktop is a share button nobody trusts twice.
 *
 * Every link carries `?src=`, which is what turns §2.14d's "traffic sources"
 * from a guess into a count.
 */
export function ShareSheet({ marketId, question }: { marketId: string; question: string }) {
  const [copied, setCopied] = useState(false);

  const link = typeof window === 'undefined' ? '' : `${window.location.origin}/market/${marketId}`;

  async function share(): Promise<void> {
    const url = `${link}?src=share`;
    if (typeof navigator !== 'undefined' && 'share' in navigator) {
      try {
        await navigator.share({ title: question, url });
        return;
      } catch {
        // Cancelled, or refused. Fall through to the copy path rather than
        // telling somebody their share failed when they just changed their mind.
      }
    }
    await navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => void share()}
        className="flex items-center gap-1.5 rounded-sm border border-border px-3 py-1.5 text-sm font-semibold"
      >
        {copied ? <Check size={14} className="text-rise" /> : <Share2 size={14} />}
        {copied ? 'Link copied' : 'Share'}
      </button>
      <a
        href={`/api/share/${marketId}?format=story`}
        target="_blank"
        rel="noreferrer"
        className="font-mono text-xs text-text-muted underline underline-offset-2"
      >
        status card
      </a>
    </div>
  );
}
