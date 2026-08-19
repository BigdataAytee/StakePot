import Link from 'next/link';

/**
 * The footer, and the only place on the site where every public page is one tap
 * from every other.
 *
 * §2.18 asks for the legal pages to be "linked from signup, footer, and every
 * market's rules card" — there was no footer, so a page nothing linked to was a
 * page nobody found. The rules, the privacy policy and the FAQ each answer a
 * question somebody has *before* they stake, and a link is what makes an answer
 * reachable.
 *
 * Deliberately not on the signed-in market screens: those are for trading, and
 * a wall of links under a live price is noise. The header carries navigation
 * there.
 */
export function SiteFooter() {
  return (
    <footer className="mt-16 border-t border-border pt-8 text-sm">
      <nav aria-label="Site" className="flex flex-wrap gap-x-6 gap-y-3">
        <FooterLink href="/markets">Markets</FooterLink>
        <FooterLink href="/leaderboard">Leaderboard</FooterLink>
        <FooterLink href="/rules">Rules</FooterLink>
        <FooterLink href="/faq">FAQ</FooterLink>
        <FooterLink href="/privacy">Privacy</FooterLink>
        <FooterLink href="/support">Support</FooterLink>
        <FooterLink href="/status">Status</FooterLink>
      </nav>

      <p className="mt-6 text-text-muted">
        StakeAm is a prediction market, not a betting site: winners split the pot and there is no
        house on the other side of your trade.{' '}
        <Link href="/rules" className="underline">
          How that works
        </Link>
        .
      </p>

      {/*
        Said plainly and near the bottom, where somebody looking for the catch
        looks. Points, not naira, until the licence lands (§9) — a platform that
        is coy about this is the kind people are right to distrust.
      */}
      <p className="mt-3 text-text-muted">
        Play money while we are pre-licence. Balances are points, they cannot be withdrawn, and
        nothing here is a real-money wager. 18+.
      </p>
    </footer>
  );
}

function FooterLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="min-h-11 py-2 font-bold underline decoration-border underline-offset-4 hover:decoration-rise"
    >
      {children}
    </Link>
  );
}
