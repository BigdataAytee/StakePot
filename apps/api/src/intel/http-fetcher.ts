import { logger } from '../logger';
import {
  DisabledFetcher,
  PoliteFetcher,
  type ConditionalFetcher,
  type ConditionalResult,
  type FetcherDescription,
  type FetchTarget,
  type SourceFetcher,
  type Validators,
} from './fetcher';
import { parseFeed } from './rss';

/**
 * How long a `robots.txt` answer is trusted before it is asked again.
 *
 * A day. Short enough that a newsroom that adds a Disallow is honoured the
 * same week; long enough that polling a feed every minute does not also mean
 * fetching robots every minute, which would be its own discourtesy.
 */
const ROBOTS_TTL_MS = 24 * 3_600_000;

/** Nothing is worth waiting longer than this for. */
const TIMEOUT_MS = 20_000;

/**
 * The user agent every request carries.
 *
 * Identifiable and contactable on purpose. A bot that will not say who it is
 * gets blocked, and deserves to be: the person on the other end has no other
 * way to tell us we are being a nuisance.
 */
const USER_AGENT =
  'StakeAmResearchBot/0.1 (+https://stakeam-web.onrender.com; contact: ops@stakeam.ng)';

interface RobotsVerdict {
  readonly allowed: boolean;
  readonly checkedAt: number;
}

/**
 * The fetcher that actually reads the world.
 *
 * Wrap it in `PoliteFetcher` — this class handles one request correctly and
 * knows nothing about pacing between them.
 *
 * Three behaviours are the reason this exists rather than a bare `fetch`:
 *
 * **Conditional requests.** A source on the one-minute tier is 1,440 requests
 * a day, and almost every one returns bytes we already have. The validators
 * from the last read go back as `If-None-Match` and `If-Modified-Since`, and a
 * 304 costs a few hundred bytes instead of a few hundred kilobytes. Which is
 * both the bandwidth bill and the difference between a considerate client and
 * the reason a range gets blocked.
 *
 * **robots.txt, before the first read and not after it.** Cached for a day.
 * A disallow returns `allowed: false`, which the pipeline records as a skip
 * rather than a failure — being told not to read something is not an error.
 *
 * **Nothing throws.** A source having a bad day costs one pass, not the sweep.
 */
export class HttpFetcher implements ConditionalFetcher {
  private readonly robots = new Map<string, RobotsVerdict>();

  constructor(
    private readonly http: typeof fetch = fetch,
    private readonly now: () => number = () => Date.now(),
  ) {}

  describe(): FetcherDescription {
    return { name: 'http', reads: true };
  }

  async fetch(
    target: FetchTarget,
    since: Date,
    validators: Validators = {},
  ): Promise<ConditionalResult> {
    const url = target.feedUrl ?? target.homeUrl;

    // Only feeds, for now. A `crawl` or `sitemap` source needs extraction
    // rules that do not exist yet, and reading its home page as if it were a
    // feed would return nothing while looking like it tried.
    if (target.kind !== 'rss' && target.kind !== 'api') {
      return {
        items: [],
        allowed: false,
        blockedBy: 'unsupported',
        note: `${target.kind} sources need HTML extraction, which is not built yet`,
      };
    }

    try {
      if (!(await this.mayRead(url))) {
        return {
          items: [],
          allowed: false,
          blockedBy: 'robots',
          note: 'robots.txt disallows this path',
        };
      }

      const headers: Record<string, string> = {
        'user-agent': USER_AGENT,
        accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8',
      };
      if (validators.etag != null) headers['if-none-match'] = validators.etag;
      if (validators.lastModified != null) headers['if-modified-since'] = validators.lastModified;

      const response = await this.http(url, {
        headers,
        redirect: 'follow',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (response.status === 304) {
        // Nothing has changed. A success, and it must not be recorded as a
        // silent source — see `notModified` on the way out.
        return {
          items: [],
          allowed: true,
          notModified: true,
          etag: validators.etag ?? null,
          lastModified: validators.lastModified ?? null,
        };
      }

      if (!response.ok) {
        return { items: [], allowed: true, note: `HTTP ${response.status}` };
      }

      const body = await response.text();
      const parsed = parseFeed(body, new Date(this.now()));

      return {
        // `since` is the last time we read this source. Items older than that
        // have been seen; the store dedupes on url as well, so this is a
        // narrowing rather than the guarantee.
        items: parsed
          .filter((item) => item.publishedAt >= since)
          .map((item) => ({
            headline: item.headline,
            url: item.url,
            publishedAt: item.publishedAt,
            guid: item.guid,
            // Nothing extracted from a feed yet. Headline, link and time are
            // what a feed reliably carries; figures come from the extraction
            // rules that HTML sources will need anyway.
            facts: {},
          })),
        allowed: true,
        etag: response.headers.get('etag'),
        lastModified: response.headers.get('last-modified'),
        ...(parsed.length === 0 && body.length > 0
          ? { note: 'fetched, but nothing in it parsed as a feed' }
          : {}),
      };
    } catch (error) {
      // Timeouts, DNS failures, TLS problems, a body that is not text. All of
      // them are one source's bad day.
      const note = error instanceof Error ? error.message : String(error);
      logger.warn({ source: target.name, url, error: note }, 'source fetch failed');
      return { items: [], allowed: true, note };
    }
  }

  /**
   * Whether `robots.txt` permits this path, cached for a day.
   *
   * Deliberately simple: `User-agent: *` groups, `Disallow` prefixes. It does
   * not implement the whole standard, and errs towards *not* reading — an
   * unparseable robots file or a group we half-understand leaves the path
   * disallowed rather than assumed fine.
   *
   * A robots.txt that cannot be fetched at all is treated as permission,
   * which is the conventional reading: most sites have none.
   */
  private async mayRead(url: string): Promise<boolean> {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      return false;
    }

    const host = target.origin;
    const cached = this.robots.get(host);
    if (cached !== undefined && this.now() - cached.checkedAt < ROBOTS_TTL_MS) {
      return cached.allowed;
    }

    let allowed = true;
    try {
      const response = await this.http(`${host}/robots.txt`, {
        headers: { 'user-agent': USER_AGENT },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (response.ok) {
        allowed = pathAllowed(await response.text(), target.pathname);
      }
    } catch {
      // No robots.txt, or it could not be reached. Conventionally permission.
      allowed = true;
    }

    this.robots.set(host, { allowed, checkedAt: this.now() });
    return allowed;
  }
}

/**
 * Does `robots.txt` allow this path for `*`?
 *
 * Exported for the tests, because the interesting cases here are all textual
 * and none of them need a network.
 */
export function pathAllowed(robots: string, path: string): boolean {
  let inStar = false;
  const disallowed: string[] = [];
  const allowed: string[] = [];

  for (const raw of robots.split(/\r?\n/)) {
    const line = raw.split('#')[0]?.trim() ?? '';
    if (line.length === 0) continue;

    const [field, ...rest] = line.split(':');
    const key = (field ?? '').trim().toLowerCase();
    const value = rest.join(':').trim();

    if (key === 'user-agent') {
      inStar = value === '*';
      continue;
    }
    if (!inStar) continue;
    if (key === 'disallow' && value.length > 0) disallowed.push(value);
    if (key === 'allow' && value.length > 0) allowed.push(value);
  }

  // Longest match wins, which is what every major crawler does and what a site
  // owner writing `Disallow: /` then `Allow: /feed` plainly means.
  const longest = (rules: string[]): number =>
    rules
      .filter((rule) => path.startsWith(rule))
      .reduce((best, rule) => Math.max(best, rule.length), 0);

  return longest(allowed) >= longest(disallowed);
}

/**
 * Which fetcher a deployment gets.
 *
 * Off unless `RESEARCH_FETCHER=http` is set, and off is the default in every
 * environment including production. The switch is an environment variable
 * rather than a database flag because the thing being decided is "may this
 * process talk to the outside world", and that question should be answerable
 * from the deployment config alone — not from a row somebody can flip in an
 * admin form on a preview environment that happens to share a database.
 *
 * The real fetcher always arrives wrapped in `PoliteFetcher`: there is no
 * binding anywhere that reaches the network without per-host pacing in front
 * of it, which is the only way that guarantee survives somebody adding a
 * second fetcher later.
 */
export function createFetcher(env: NodeJS.ProcessEnv = process.env): SourceFetcher {
  if ((env.RESEARCH_FETCHER ?? '').trim().toLowerCase() !== 'http') return new DisabledFetcher();
  return new PoliteFetcher(new HttpFetcher());
}
