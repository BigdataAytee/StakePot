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
  /** The feed's own id for the entry, where it gives one. */
  readonly guid?: string | null;
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
  /**
   * Why, when `allowed` is false.
   *
   * A discriminator rather than a note the caller has to read for the word
   * "robots": the source row records a robots verdict, and recording one
   * because *no fetcher is configured* would put a red robots flag on every
   * source in a deployment that has simply never been switched on.
   */
  readonly blockedBy?: 'robots' | 'unsupported' | 'disabled';
}

/** What kind of fetcher is bound, for the crawl-health screen. */
export interface FetcherDescription {
  readonly name: string;
  /** Whether this fetcher talks to the network at all. */
  readonly reads: boolean;
}

/**
 * What a read told us beyond the items, so the source row can record it.
 *
 * `notModified` is the interesting one. A 304 is not "no items" — it is the
 * server telling us nothing has changed since the validator we sent, which is
 * a *success* and must not look like a silent source on the Research tab.
 */
export interface ConditionalResult extends FetchResult {
  readonly notModified?: boolean;
  readonly etag?: string | null;
  readonly lastModified?: string | null;
}

/** Validators from the previous successful read of this source. */
export interface Validators {
  readonly etag?: string | null;
  readonly lastModified?: string | null;
}

export interface SourceFetcher {
  /**
   * `validators` is optional on the way in and ignored by fetchers that do not
   * speak HTTP — declaring it here rather than only on `ConditionalFetcher`
   * means a wrapper can pass it through without knowing which kind it holds.
   */
  fetch(target: FetchTarget, since: Date, validators?: Validators): Promise<ConditionalResult>;
  /**
   * Optional so a fixture fetcher in a test need not implement it; the caller
   * falls back to the class name.
   */
  describe?(): FetcherDescription;
}

/**
 * A fetcher that actually speaks HTTP.
 *
 * Structurally the same as `SourceFetcher` — every extra field a conditional
 * read reports is optional, so a fixture fetcher that knows nothing about
 * validators still satisfies the base. The name is here to say which of the
 * two a given class is meant to be.
 */
export type ConditionalFetcher = SourceFetcher;

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
      blockedBy: 'disabled',
      note: 'no fetcher is configured — nothing is being read',
    };
  }

  describe(): FetcherDescription {
    return { name: 'disabled', reads: false };
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
export class PoliteFetcher implements ConditionalFetcher {
  private readonly lastFetch = new Map<string, number>();

  constructor(
    private readonly inner: SourceFetcher,
    private readonly sleep: (ms: number) => Promise<void> = defaultSleep,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async fetch(
    target: FetchTarget,
    since: Date,
    validators?: Validators,
  ): Promise<ConditionalResult> {
    const host = hostOf(target.feedUrl ?? target.homeUrl);
    const last = this.lastFetch.get(host);
    const wait = last === undefined ? 0 : Math.max(0, target.politenessMs - (this.now() - last));

    if (wait > 0) await this.sleep(wait);
    this.lastFetch.set(host, this.now());

    return this.inner.fetch(target, since, validators);
  }

  describe(): FetcherDescription {
    const inner = this.inner.describe?.() ?? { name: this.inner.constructor.name, reads: true };
    return { name: `polite→${inner.name}`, reads: inner.reads };
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
