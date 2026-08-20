# Switching the research pipeline on

Read this before buying anything: **the blocker is not API keys.** Almost
nothing here needs a credential. What was missing was code, and half of it now
exists — the rest is a list of URLs somebody has to verify.

## Status

- **The RSS/Atom fetcher is built.** `HttpFetcher`, wrapped in `PoliteFetcher`,
  bound when `RESEARCH_FETCHER=http` is set. Conditional requests, robots.txt,
  per-host pacing, guid and URL dedupe, and it never throws — a source having a
  bad day costs one pass, not the sweep. Proven end to end over a real socket in
  `http-fetcher.integration.test.ts`.
- **HTML extraction is not built.** A `crawl` or `sitemap` source can be
  registered and will show on the Research tab, and it is not read: the fetcher
  refuses it with "needs HTML extraction" rather than fetching a home page and
  reporting zero items, which would look like a quiet source rather than an
  unfinished one.
- **Nothing is switched on in production.** `RESEARCH_FETCHER` is unset, so
  every deployment still reads nothing until somebody decides otherwise.

## What already works

- **The registry.** Sources with tiers, trust scores, kill switches per source,
  per tier and globally, politeness intervals and robots state. Bulk import is
  live at `POST /admin/studio/sources/import` (admin only).
- **The pipeline.** `ResearchService.pass()` reads what is due, stores headline,
  link, timestamp, extracted figures and entities — never article text —
  clusters the same story across outlets, links items to markets by relevance,
  and flags disagreements rather than averaging them.
- **The heartbeat.** A `research-sweep` job every five minutes; each source's
  own crawl interval decides whether it is actually due.
- **The screens.** Crawl health, evidence panels on drafts, the live ticket's
  news tab, resolution dossiers.

## What is missing

### 1. HTML extraction

Most Nigerian official bodies publish a page, not a feed — see the verified
findings below. Each needs a per-source rule: the page to read, the element that
holds the release, and how to pull the figure out of it. A day per awkward
source, and CBN, NBS and NNPC are awkward in different ways.

### 2. Verified feed URLs

**No URL is presented here as checked unless the runner checked it.** This
sandbox cannot reach the public internet. Rather than guess, there is a
workflow: **Actions → Discover feeds**. Leave the input blank to sweep the
candidate list, or paste one home page. It reads `robots.txt` first and prints
it, looks for a declared `<link rel="alternate">`, then tries the usual paths,
and marks only those that returned 200 **and** actually began as XML — a site
serving its 404 page with a 200 status is common enough that reading the status
alone produces a list of "feeds" that parse to nothing.

#### What the runner has established

| Source  | Checked     | Result                                                                                                    |
| ------- | ----------- | --------------------------------------------------------------------------------------------------------- |
| **CAF** | 20 Aug 2026 | **No feed.** No `robots.txt` (404), no declared feed, and 404 on all eight usual paths. Needs extraction. |

That was the one I rated most likely to have a feed, and it does not. Do not
onboard a source on the strength of a guess — run the workflow first.

## The Tier 1 six

Tier 1 is the only tier a market may name as its settling source or a dossier
may cite. Get these right before adding breadth.

| Source   | What settles against it              | Likely shape                                                                                                                                            |
| -------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **CBN**  | MPR decisions, official window rates | No public feed I can rely on. MPC communiqués and the rates page are HTML; the rates page is the more machine-readable of the two.                      |
| **NBS**  | CPI, GDP, unemployment               | Publishes report PDFs plus a news listing. The listing is the crawl target; the figure usually needs pulling from the release page rather than the PDF. |
| **NNPC** | Fuel pricing, supply statements      | Press-release listing, HTML. Lowest publication frequency of the six.                                                                                   |
| **INEC** | Declared election results            | Results are published per-election rather than as a feed. Expect a per-event target rather than a standing one.                                         |
| **CAF**  | Match results, AFCON                 | Best chance of a real feed or a usable JSON endpoint of the six.                                                                                        |
| **NPFL** | Nigerian league results              | Fixtures and results pages; check whether the league or its data partner offers anything structured.                                                    |

What you supply per source: the exact page or feed URL, and — for the HTML ones
— which element carries the release and the figure. Politeness defaults to 2s
between requests on the same host; raise it for anything that looks fragile.

## Credentials

None of the six is expected to need one. Where a paid data provider replaces a
scrape (a football data API instead of NPFL's site, say), it goes in the
service environment exactly as `ANTHROPIC_API_KEY` does — `sync: false` in
`render.yaml`, value typed into the dashboard, never committed.

## Onboarding one source: the checklist

Everything you have to supply, and nothing you do not. Add one at a time and
watch its row flip before adding the next — a source added and never read shows
as `stale`, which is exactly what that word is on the tab for.

**Before you type anything:** run **Actions → Discover feeds** against the home
page. Sixty seconds, and it answers the only question that matters.

Then, in the Studio → Research → **Add a source**:

| Field              | What to paste                                                                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Name**           | What a market cites and a reader sees. `CAF`, `CBN`, `Premium Times`. Exact — a market that names its settling source is matched on this string. |
| **Home URL**       | The organisation's own address, `https://` only. Used for attribution and for the `robots.txt` lookup.                                           |
| **Feed URL**       | The RSS/Atom address the discovery run marked `FEED`. Leave blank if there is none.                                                              |
| **Tier**           | 1 only if its publication **is** the fact being settled. 2 for reputable news. 3 for staff-side signal.                                          |
| **Kind**           | `RSS / Atom feed` if you have a feed URL. Anything else registers the source and waits for extraction rules.                                     |
| **Cadence**        | Leave on _follow the markets_ unless you have a reason. See below.                                                                               |
| **Publish window** | Only for calendar publishers. `mon-fri 08:00-10:30`, `d14-18 09:00-15:00` — Lagos time.                                                          |

**For an HTML source, additionally write down** (there is nowhere to type them
yet, so put them in the ticket that asks for the extraction rule): the page URL
that carries the release, the CSS selector for the element holding it, and the
selector or pattern for the figure itself.

Then press **Run a pass now** and read the row. It should say `ok`, with
`checked just now` and a `last item` time. If it says something else:

| Row says                                      | Means                                                                      |
| --------------------------------------------- | -------------------------------------------------------------------------- |
| `fetched, but nothing in it parsed as a feed` | The URL answered but is not a feed. Usually a 404 page served with a 200.  |
| `robots.txt disallows this path`              | They have asked us not to. Honour it; find another entry point.            |
| `HTTP 403` / `HTTP 429`                       | Blocked or rate-limited. Raise politeness, or ask them.                    |
| `stale` with no error                         | It answered and had nothing new. Fine on day one; suspicious on day three. |
| `needs HTML extraction`                       | Registered, not read. Expected for a non-feed source.                      |

## Cadence

Each source keeps its own interval; the five-minute sweep only asks whether it
is due. By default that interval follows the markets:

| Tier         | Interval | When                                                 |
| ------------ | -------- | ---------------------------------------------------- |
| `urgent`     | 1 min    | A market that depends on it settles within 24 hours. |
| `normal`     | 5 min    | A market that depends on it settles within a week.   |
| `background` | 45 min   | Further out, or outside a declared publish window.   |
| idle         | 6 h      | No live market depends on it at all.                 |

Escalation and de-escalation are automatic: a source attached to a market
settling tonight drops to one minute on its own and returns afterwards without
anybody remembering. A source is "attached" to a market either because the
market names it as its settling source or because relevance scoring has already
linked one of its items. Consecutive failures back a source off exponentially,
capped at 32×.

Pin the cadence only for the two cases the markets cannot see: a source that
matters before any market names it, and one that must be kept quiet without
being switched off.

## Switch-on order

1. Set `RESEARCH_FETCHER=http` on the API service. Nothing is read until this
   is set, in production as anywhere else.
2. Import **one** source with a verified feed and press _Run a pass now_. You
   want the row reading `ok`, `items in 24h` moving, and the market's news tab
   filling.
3. Add HTML extraction, one source at a time, confirming each on the tab before
   the next.
4. Only then add Tier 2 breadth. Tier 2 is news that can appear on a context
   panel but never settle anything, so volume matters more than precision and
   the cost of a bad one is lower.

## What stays true regardless

- Tier 3 never reaches a user-facing surface or a dossier. The gate is in
  `packages/rules`, not in any screen.
- Headline, link, timestamp, extracted data points and entities only. No article
  text, ever.
- Sources that disagree are flagged, never averaged.
- Nothing the pipeline produces can settle a market. That is asserted
  structurally in `no-automated-settlement.integration.test.ts`.
