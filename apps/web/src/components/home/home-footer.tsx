import Link from 'next/link';

import { TOPICS } from '@/lib/home';

/**
 * The front page's footer.
 *
 * Wider than the one the inner pages carry, because this is the page a stranger
 * and a search crawler both land on: the topic column is how somebody who came
 * for the naira finds out there is a football shelf, and it is also the only
 * internal linking the topic views get. The legal lines are at the bottom in
 * plain words rather than in a collapsed "Legal" accordion — somebody looking
 * for the catch should find it without a click.
 */
export function HomeFooter() {
  return (
    <footer className="mt-16 border-t border-border pt-10">
      <div className="mx-auto grid max-w-[1350px] gap-8 px-4 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <p className="text-lg font-black leading-none tracking-tight">
            Stake<span className="text-rise">Am</span>
          </p>
          <p className="mt-3 max-w-xs text-sm text-text-muted">
            Nigeria argues about everything. This is where the arguments get settled — winners split
            the pot, and there is no house on the other side of your trade.
          </p>
        </div>

        <Column title="Topics">
          {TOPICS.map((topic) => (
            <FooterLink key={topic.key} href={`/?topic=${topic.key}`}>
              {topic.label}
            </FooterLink>
          ))}
        </Column>

        <Column title="Markets">
          <FooterLink href="/markets">All markets</FooterLink>
          <FooterLink href="/markets?shelf=official">Official shelf</FooterLink>
          <FooterLink href="/markets?shelf=community">Community shelf</FooterLink>
          <FooterLink href="/create">Open your own market</FooterLink>
          <FooterLink href="/leaderboard">Leaderboard</FooterLink>
          <FooterLink href="/studio">Creator studio</FooterLink>
        </Column>

        <Column title="Company">
          <FooterLink href="/rules">Rules</FooterLink>
          <FooterLink href="/faq">FAQ</FooterLink>
          <FooterLink href="/support">Support</FooterLink>
          <FooterLink href="/status">Platform status</FooterLink>
          <FooterLink href="/privacy">Privacy</FooterLink>
          <FooterLink href="/account/limits">Your limits</FooterLink>
        </Column>
      </div>

      <div className="mx-auto mt-10 max-w-[1350px] border-t border-border px-4 py-6 text-xs text-text-muted">
        <p>
          StakeAm is a prediction market, not a betting site: winners split the pot and there is no
          house taking the other side.{' '}
          <Link href="/rules" className="underline">
            How that works
          </Link>
          .
        </p>
        <p className="mt-2">
          Play money while we are pre-licence. Balances are points, they cannot be withdrawn, and
          nothing here is a real-money wager. 18+. Play responsibly — StakeAm is entertainment, not
          income.
        </p>
        <p className="mt-3">© {new Date().getFullYear()} StakeAm</p>
      </div>
    </footer>
  );
}

function Column({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <nav aria-label={title}>
      <h2 className="text-xs font-black uppercase tracking-widest text-text-muted">{title}</h2>
      <ul className="mt-3 flex flex-col gap-1">{children}</ul>
    </nav>
  );
}

function FooterLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <li>
      <Link href={href} className="block py-1 text-sm hover:text-rise hover:underline">
        {children}
      </Link>
    </li>
  );
}
