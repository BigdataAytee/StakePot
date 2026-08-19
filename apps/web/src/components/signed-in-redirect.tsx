'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

import { getToken } from '@/lib/session';

/**
 * Send a signed-in visitor from the front door to the markets.
 *
 * §7.6's landing page is server-rendered so it is indexable, which means the
 * server cannot know whether this visitor has a session — the token lives in
 * the browser. So the page renders for everyone and this moves the signed-in
 * ones along. The cost is one client hop; the benefit is that the marketing
 * page stays fully static and crawlable.
 */
export function SignedInRedirect() {
  const router = useRouter();

  useEffect(() => {
    if (getToken() !== null) router.replace('/');
  }, [router]);

  return null;
}
