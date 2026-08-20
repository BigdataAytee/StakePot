# Switching the research pipeline on

The Research tab is honest and empty. This is what stands between that and a
pipeline that actually reads.

Read this before buying anything: **the blocker is not API keys.** Almost
nothing here needs a credential. Two pieces of code are missing, and once they
exist the rest is a list of URLs.

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

### 1. A fetcher that reads anything

`SOURCE_FETCHER` is bound to `DisabledFetcher`, which returns nothing. The only
other implementation is `PoliteFetcher`, and it is a **wrapper** — it throttles
per host and delegates to an inner fetcher that does not exist yet.

So a concrete fetcher has to be written. For the Tier 1 six it needs to handle:

- **RSS/Atom** where a feed exists — parse, map entries to
  `{ headline, url, publishedAt, facts }`.
- **HTML** where one does not, which for Nigerian official bodies is most of
  them. That means a per-source extraction rule: the page to read, the element
  that holds the release, and how to pull the figure out of it.
- **`robots.txt`** — fetch, cache, honour. The `robotsAllows` and
  `robotsCheckedAt` columns exist for this and are currently never written.

Estimate: RSS is a day. HTML extraction is a day per awkward source, and CBN,
NBS and NNPC are all awkward in different ways.

### 2. Nothing verified from here

**No URL below has been checked.** This sandbox cannot reach the public
internet, so every feed path is a starting point for you or the fetcher's first
run to confirm — not a fact. A wrong `feedUrl` shows up as a source that is
enabled, erroring, and visible as `failing` on the Research tab, which is the
right failure but still a wasted cycle.

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

## Switch-on order

1. Write the RSS half of the fetcher. Bind it in `IntelModule` behind
   `PoliteFetcher`.
2. Import **one** source — whichever of the six turns out to have a real feed —
   and watch the Research tab. You want `items in 24h` moving and the source
   reading `ok` rather than `stale`.
3. Add HTML extraction, one source at a time, confirming each on the tab before
   the next. A source added and never read shows as `stale`, which is exactly
   the state this tab was built to make visible.
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
