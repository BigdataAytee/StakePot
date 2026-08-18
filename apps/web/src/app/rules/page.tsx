import Link from 'next/link';

/**
 * §2.18 — "Legal pages in-app... linked from signup, footer, and every market's
 * rules card."
 *
 * This is the Phase 0 version: the rules that actually govern how money moves,
 * written plainly, sourced from the market rulebook rather than from counsel.
 * The terms of service, privacy policy and licence details that belong beside
 * it are a licensed-phase deliverable with a named owner — so this page says
 * what it is rather than pretending to be the finished set.
 */
export const metadata = {
  title: 'Rules · StakeAm',
  description: 'How StakeAm markets open, trade, settle and pay out.',
};

export default function RulesPage() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <Link href="/" className="font-mono text-xs text-text-muted underline">
        ← StakeAm
      </Link>
      <h1 className="mt-4 text-2xl font-black leading-none">The rules</h1>
      <p className="mt-2 text-md text-text-muted">
        How a market opens, how it trades, and how it pays. If any of this ever disagrees with what
        the app does, the app is wrong — tell us.
      </p>

      <Rule title="Every market names its source before it opens">
        A market states the exact source that will settle it — INEC, CBN, CAF, the official
        broadcast — along with what counts as a yes, what counts as a no, and the edge cases. Those
        criteria are fixed when the market opens and cannot be edited afterwards.
      </Rule>

      <Rule title="Prices are what the crowd thinks, not odds we set">
        The price of an outcome is the share of the pot backing it. It moves as people stake. There
        is no house on the other side of your trade and no house edge built into the price.
      </Rule>

      <Rule title="Your stake is held in escrow">
        Money you stake leaves your available balance and is held against that market until it
        settles. It is shown separately in your wallet as &ldquo;in open markets&rdquo;. Winners are
        paid only from the pot.
      </Rule>

      <Rule title="Trading freezes when the event starts">
        Once the event begins, the market freezes — no new stakes and no exits. Everything after
        that is resolution.
      </Rule>

      <Rule title="You can leave early, for a fee">
        Before the freeze you can sell out of a position at the current price. A small early-exit
        fee is withheld from your proceeds; it is shown on the ticket before you confirm, never
        after.
      </Rule>

      <Rule title="Results are posted with evidence, then challengeable">
        A proposed result is published with the evidence behind it and a window in which anybody can
        dispute it. Payouts settle after that window closes. Disputes are decided by people, and the
        decision is published.
      </Rule>

      <Rule title="Winners split the pot in proportion">
        When a market settles, the pot is divided among everyone holding the winning outcome, in
        proportion to what they hold. The platform fee is taken from the losing side, and it is
        stated on every market&rsquo;s rules card before you stake.
      </Rule>

      <Rule title="If a market cannot be settled fairly, it voids">
        A market whose source never publishes, or whose question turns out to be ambiguous, is
        voided and every stake is refunded in full. A void is not a loss.
      </Rule>

      <Rule title="Community markets carry a bond">
        Anybody at Tier 1 can open a market, but they post a bond to do it and are responsible for
        resolving it honestly against the source they named. A creator who abandons or misresolves a
        market forfeits the bond.
      </Rule>

      <Rule title="18+, and built to be walked away from">
        You must be 18 or older. You can set your own stake and loss limits, take a cool-off, or
        self-exclude at any time from{' '}
        <Link href="/account/limits" className="underline">
          your limits
        </Link>
        . The app tells you how long you have been in a session whether or not you ask.
      </Rule>

      <p className="mt-10 border-t border-border pt-6 text-sm text-text-muted">
        This is the Phase 0 rulebook, covering how markets work. Full terms of service, the privacy
        policy and licence details are published before real-money play. Questions:{' '}
        <Link href="/support" className="underline">
          support
        </Link>
        .
      </p>
    </main>
  );
}

function Rule({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="text-md font-bold">{title}</h2>
      <p className="mt-1.5 text-sm text-text-muted">{children}</p>
    </section>
  );
}
