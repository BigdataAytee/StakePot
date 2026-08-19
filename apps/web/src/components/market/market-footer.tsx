import Link from 'next/link';
import { PAGE_WIDTH } from '@/lib/layout';

/**
 * The footer.
 *
 * The reference has none — it is a markets screen and stops at the grid. This
 * is kept, small and in the new system, for one reason: §2.18 requires the
 * rules, the privacy policy and the FAQ to be linked from the footer, and a
 * page nothing links to is a page nobody finds. It also carries the pre-licence
 * statement, which belongs somewhere a person looking for the catch will look.
 */
export function MarketFooter() {
  return (
    <footer className="mt-6 border-t border-border">
      <div className={`px-4 py-6 sm:px-5 text-sm text-text-muted ${PAGE_WIDTH}`}>
        <nav aria-label="Site" className="flex flex-wrap gap-x-5 gap-y-2">
          <FooterLink href="/markets">All markets</FooterLink>
          <FooterLink href="/create">Open a market</FooterLink>
          <FooterLink href="/leaderboard">Leaderboard</FooterLink>
          <FooterLink href="/rules">Rules</FooterLink>
          <FooterLink href="/faq">FAQ</FooterLink>
          <FooterLink href="/support">Support</FooterLink>
          <FooterLink href="/privacy">Privacy</FooterLink>
          <FooterLink href="/status">Status</FooterLink>
        </nav>

        <p className="mt-4">
          StakeAm is a prediction market, not a betting site: winners split the pot and there is no
          house on the other side of your trade.{' '}
          <Link href="/rules" className="text-brand underline">
            How that works
          </Link>
          .
        </p>
        <p className="mt-2">
          Play money while we are pre-licence. Balances are points, they cannot be withdrawn, and
          nothing here is a real-money wager. 18+. Play responsibly — StakeAm is entertainment, not
          income.
        </p>
      </div>
    </footer>
  );
}

function FooterLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="font-medium hover:text-text">
      {children}
    </Link>
  );
}
