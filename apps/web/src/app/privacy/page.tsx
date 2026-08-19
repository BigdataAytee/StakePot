import Link from 'next/link';

import { SiteFooter } from '@/components/site-footer';

/**
 * §2.18's privacy policy.
 *
 * Written from the schema rather than from a template: every claim below is
 * something `apps/api/prisma/schema.prisma` either does or does not store, and
 * it should be re-read against that file whenever the schema changes. A policy
 * that describes a system nobody built is worse than none — it is a promise
 * made on behalf of code that was never asked.
 *
 * **This is not legal advice and has not been through counsel.** Nigeria's Data
 * Protection Act 2023 sets obligations — a Data Protection Officer, a filing
 * with the Commission, a documented lawful basis — that are a person's job, not
 * a page's. Tracked in docs/launch-checklist.md.
 */
export const metadata = {
  title: 'Privacy',
  description:
    'What StakeAm collects, why, how long it is kept, and what you can ask us to do with it.',
};

export default function PrivacyPage() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <Link href="/" className="font-mono text-xs text-text-muted underline">
        ← StakeAm
      </Link>
      <h1 className="mt-4 text-2xl font-black leading-none">Privacy</h1>
      <p className="mt-2 text-md text-text-muted">
        What we hold, why we hold it, and what you can make us do about it. Written against the
        actual database rather than from a template, so it should be short.
      </p>

      <Section title="What we collect">
        <p>
          <strong>To make an account:</strong> one contact — an email address or a phone number —
          and a password. The password is stored only as an argon2id hash; nobody at StakeAm can
          read it, and we cannot tell it back to you if you forget it.
        </p>
        <p className="mt-3">
          <strong>Because you traded:</strong> every stake, exit and settlement, with its price and
          time. This is the ledger. It is append-only by database grant — we cannot edit or delete a
          past entry, and neither can anyone who breaks in. That is deliberate: it is what lets you
          check that a payout was right.
        </p>
        <p className="mt-3">
          <strong>If you create or comment:</strong> your handle, display name, the markets you
          open, and anything you post to a thread, along with the position you held when you posted
          it.
        </p>
        <p className="mt-3">
          <strong>Automatically:</strong> your IP address is used to rate-limit signups and logins.
          It lives in a short-lived cache and is not written to your account record. Staff actions
          in the admin console are recorded with the staff member&rsquo;s IP — that is an audit
          trail of our people, not of you.
        </p>
      </Section>

      <Section title="What we do not collect">
        <p>
          No advertising trackers, no third-party analytics, no cookies for marketing. There is no
          data broker on the other end of this. Product analytics are events we record ourselves
          about what happened — a market viewed, a first stake placed — held against your account
          id.
        </p>
        <p className="mt-3">
          No bank details and no BVN or NIN, because deposits and withdrawals do not exist yet.
          Balances are points. When money becomes real, identity checks come with it (§9) and this
          page changes before that ships, not after.
        </p>
      </Section>

      <Section title="Why we are allowed to hold it">
        <p>
          Your contact and password because you asked for an account and we cannot give you one
          without them. Your trades because we are running a market and the ledger is the record of
          it. Rate-limiting and abuse detection because a platform that cannot tell a person from a
          hundred throwaway accounts cannot pay anybody fairly.
        </p>
      </Section>

      <Section title="Who else sees it">
        <p>
          Our hosting provider, because the servers and database run there. Our email and SMS
          providers, because a verification code has to travel. That is the list. We do not sell
          anything to anybody, and we have no advertising business to sell it to.
        </p>
        <p className="mt-3">
          Public by design: your handle, your markets, your take-thread posts and the position
          badges on them, and your leaderboard standing. Your email, phone and balance are never
          shown to other users.
        </p>
      </Section>

      <Section title="How long we keep it">
        <p>
          The ledger is permanent — it is append-only and it is the proof behind every payout.
          Verification codes expire in minutes. Rate-limit counters expire in minutes. Everything
          else lives as long as your account does.
        </p>
      </Section>

      <Section title="What you can ask for">
        <p>
          A copy of what we hold about you, a correction to anything wrong, or the closure of your
          account. Ask through{' '}
          <Link href="/support" className="font-bold underline">
            support
          </Link>{' '}
          and we will answer.
        </p>
        <p className="mt-3">
          Closing an account does not erase the ledger, and we will not pretend otherwise: those
          entries are the settlement record of markets other people traded in, and removing them
          would break their receipts. We detach what we can and keep what the market&rsquo;s
          integrity needs.
        </p>
        <p className="mt-3">
          If you want to stop yourself trading rather than delete anything,{' '}
          <Link href="/account/limits" className="font-bold underline">
            limits and self-exclusion
          </Link>{' '}
          are yours to set and take effect immediately.
        </p>
      </Section>

      <Section title="Where this is incomplete">
        <p>
          This page is written by the people who built the platform, from the schema, and has not
          been reviewed by a lawyer. Nigeria&rsquo;s Data Protection Act 2023 requires things a page
          cannot do by itself — a named Data Protection Officer and a filing with the Commission
          among them. Those are owed before this carries real money, and they are on the launch
          checklist rather than quietly missing.
        </p>
      </Section>

      <SiteFooter />
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="text-lg font-bold">{title}</h2>
      <div className="mt-2 text-md leading-relaxed text-text-muted">{children}</div>
    </section>
  );
}
