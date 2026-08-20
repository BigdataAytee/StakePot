/**
 * The seam between "we decided to read this source" and "something went over
 * the network".
 *
 * Everything above this line is testable without a network call, which is the
 * only way the pipeline's rules — relevance, clustering, conflict detection,
 * budgets, politeness — can be exercised at all. It is also why nothing in
 * this repository points at a real newsroom until somebody deliberately
 * registers one and switches it on: the fetcher is injected, and the default
 * in tests reads fixtures.
 */

export interface FetchedItem {
  readonly headline: string;
  readonly url: string;
  readonly publishedAt: Date;
  /**
   * Figures, dates, scores and statements pulled out of the item.
   *
   * Never the article body. Storing somebody else's journalism in full is a
   * licensing problem this platform has no reason to take on, and the facts
   * are the only part the pipeline reads.
   */
  readonly facts: Readonly<Record<string, string | number>>;
}

export interface FetchTarget {
  readonly id: string;
  readonly name: string;
  readonly kind: 'api' | 'rss' | 'sitemap' | 'crawl';
  readonly homeUrl: string;
  readonly feedUrl: string | null;
  /** The minimum gap between two requests to this host. */
  readonly politenessMs: number;
}

export interface FetchResult {
  readonly items: readonly FetchedItem[];
  /** False when robots.txt, a ToS or a rate limit said no. Not an error. */
  readonly allowed: boolean;
  readonly note?: string;
}

export interface SourceFetcher {
  fetch(target: FetchTarget, since: Date): Promise<FetchResult>;
}

export const SOURCE_FETCHER = Symbol('stakeam:source-fetcher');

/**
 * A fetcher that reads nothing.
 *
 * The default binding, and deliberately so. A pipeline that starts crawling
 * the moment the service boots is one that crawls from a developer's laptop,
 * from CI, and from every preview environment — and the first anybody hears
 * about it is a complaint from a newsroom. Reading the world is something an
 * operator turns on.
 */
export class DisabledFetcher implements SourceFetcher {
  async fetch(): Promise<FetchResult> {
    return {
      items: [],
      allowed: false,
      note: 'no fetcher is configured — nothing is being read',
    };
  }
}

/**
 * Per-host politeness, wrapped around any fetcher.
 *
 * Held in memory rather than in Redis on purpose: this is a courtesy to the
 * host, and a courtesy enforced per process is the one that survives Redis
 * being down. The cost of getting it slightly wrong across two instances is
 * two requests where there should have been one; the cost of it depending on
 * a cache is no politeness at all on the day the cache fails.
 */
export class PoliteFetcher implements SourceFetcher {
  private readonly lastFetch = new Map<string, number>();

  constructor(
    private readonly inner: SourceFetcher,
    private readonly sleep: (ms: number) => Promise<void> = defaultSleep,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async fetch(target: FetchTarget, since: Date): Promise<FetchResult> {
    const host = hostOf(target.feedUrl ?? target.homeUrl);
    const last = this.lastFetch.get(host);
    const wait = last === undefined ? 0 : Math.max(0, target.politenessMs - (this.now() - last));

    if (wait > 0) await this.sleep(wait);
    this.lastFetch.set(host, this.now());

    return this.inner.fetch(target, since);
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return url;
  }
}
