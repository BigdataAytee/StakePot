/**
 * RSS and Atom, parsed without a dependency.
 *
 * A feed parser is a small amount of code and a large amount of other people's
 * malformed XML. The rules here are all defensive, and each one is a thing a
 * real feed has done:
 *
 * - **Never throw.** A malformed feed must cost one source one pass, not the
 *   whole sweep. Everything returns what it could parse.
 * - **Skip an item rather than the feed.** One entry with no link is one entry
 *   lost; refusing the feed over it loses the other forty.
 * - **A missing date is now, not epoch.** Dating an undated item 1970 buries
 *   it below everything for ever, which is worse than being slightly early.
 *
 * Regex rather than a DOM parser, deliberately. The alternative is pulling a
 * full XML stack into the API image to read title, link and date out of a
 * document we do not otherwise care about, and the failure mode of a strict
 * parser here — throwing on a stray ampersand — is exactly what must not
 * happen.
 */

export interface ParsedItem {
  readonly headline: string;
  readonly url: string;
  readonly publishedAt: Date;
  /** The feed's own id for the entry, where it gives one. */
  readonly guid: string | null;
}

const ITEM = /<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi;

export function parseFeed(xml: string, now: Date = new Date()): ParsedItem[] {
  const items: ParsedItem[] = [];
  if (typeof xml !== 'string' || xml.length === 0) return items;

  for (const match of xml.matchAll(ITEM)) {
    const block = match[2] ?? '';
    const headline = decode(tag(block, 'title'));
    const url = linkOf(block);
    if (headline.length === 0 || url === null) continue;

    items.push({
      headline,
      url,
      publishedAt: dateOf(block, now),
      guid: decode(tag(block, 'guid')) || decode(tag(block, 'id')) || null,
    });
  }
  return items;
}

/** The first non-empty value of a tag, ignoring attributes and namespaces. */
function tag(block: string, name: string): string {
  const match = new RegExp(`<(?:\\w+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${name}>`, 'i').exec(
    block,
  );
  return (match?.[1] ?? '').trim();
}

/**
 * The entry's link.
 *
 * RSS puts it in `<link>text</link>`; Atom uses `<link href="..."/>` and often
 * several of them, where `rel="alternate"` (or no rel at all) is the human
 * page and `rel="self"`, `rel="enclosure"` and friends are not.
 */
function linkOf(block: string): string | null {
  const plain = tag(block, 'link');
  if (plain.startsWith('http')) return decode(plain);

  const hrefs = [...block.matchAll(/<link\b([^>]*)\/?>/gi)].map((match) => match[1] ?? '');
  for (const attrs of hrefs) {
    const rel = /rel\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1]?.toLowerCase();
    if (rel !== undefined && rel !== 'alternate') continue;
    const href = /href\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
    if (href !== undefined && href.startsWith('http')) return decode(href);
  }
  return null;
}

function dateOf(block: string, now: Date): Date {
  for (const name of ['pubDate', 'published', 'updated', 'date']) {
    const raw = tag(block, name);
    if (raw.length === 0) continue;
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  // Undated. Now rather than epoch: an item dated 1970 sorts below everything
  // for ever and would never reach a context panel.
  return now;
}

function decode(value: string): string {
  return (
    value
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#0?39;|&apos;/g, "'")
      .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
      // Ampersand last, or every entity above is decoded twice.
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim()
  );
}
