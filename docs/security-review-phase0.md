# Security review — Phase 0 (step 14)

The §8 build order's "security review", done as a documented pass over the four
surfaces that matter on a money platform: who you are, what you may do, how
money moves, and what the platform accepts as input. Each claim below was
checked against the code, not against the intention. The gaps section is the
important half — a review that finds nothing has usually looked at nothing.

## Method

Read-through of every controller, guard and money-path service; grep-driven
sweeps for the classic failure shapes (raw SQL, secret literals, unscoped
queries, unvalidated input); and adversarial fixtures in the test suite where a
claim could be executed rather than read (a one-legged ledger insert, a staff
account at the trade path, a frozen account, a poisoned queue entry).

## What holds

### Identity

- Passwords are argon2id (19.4 MiB memory cost, t=2) — sized to make offline
  cracking expensive without turning a login burst into an outage.
- Sessions are short-lived stateless JWTs signed with an env-validated secret
  (≥32 chars enforced at boot; the process refuses to start on a weak one).
- Staff step-up: every four-eyes approval requires a live TOTP code (§2.11),
  and enrolment is two-phase so a half-finished setup cannot lock anyone out.
- Tier gates hold where they matter: leaderboards, prizes and creator fees are
  Tier 1+ — and the prize path re-checks tier at _payment_, not just at draw.

### Authorisation

- The role matrix is a guard stack declared next to each handler; money actions
  additionally require the Finance/Admin role _and_ a second signature through
  the approvals workflow. There is no code path that edits a balance directly —
  `ledger.adjust` through four-eyes is the only door, by construction.
- IDOR sweeps: every "my X" query is scoped by the authenticated user id taken
  from the verified token, never from a request parameter. The trade-status
  endpoint refuses another account's request ids. Creator analytics 404 rather
  than 403 on someone else's market, so existence is not leaked.
- Staff cannot trade at all (§2.7), enforced in the one service every trade
  passes through rather than at any endpoint. Creators cannot take a side in
  their own market. A frozen account keeps its money and loses the ability to
  open positions — a freeze is a stop, not a seizure.

### Money

- The ledger is append-only twice over: REVOKE against the app role, and a
  trigger for when the app connects as the table owner. CI proves both bind.
- `assertBalanced` requires postings summing to zero to the digit, and since
  step 13 the stored rows satisfy it exactly (postings are quantised to the
  storage scale before balancing).
- The six-hourly audit re-derives the invariants from the rows themselves —
  ledger sums to zero, escrow per open market equals pot + bond, no negative
  user balances — and a violation opens an incident and pages, because
  arithmetic on our own rows failing is a bug by definition. The adversarial
  test writes a one-legged insert at the SQL layer and confirms the audit
  catches it.
- Idempotency: client request ids are unique-constrained; the queue also checks
  before enqueueing, so a retry cannot double-fill through either path.

### Input and injection

- One global `ValidationPipe` with `whitelist + forbidNonWhitelisted +
transform`: undeclared fields are a 400, not a silently-accepted extra.
- Money crosses the wire as decimal strings matched against `^\d+(\.\d{1,18})?$`
  — floats never enter the money path.
- All raw SQL uses Prisma's tagged templates (parameterised). The only
  `executeRawUnsafe` calls in `src/` are the test-fixture trigger toggles in
  `testing/reset.ts` with constant strings, and the deliberately-hostile
  fixture in the hardening tests.
- Comment text is stored verbatim and rendered as React text nodes (no
  `dangerouslySetInnerHTML` anywhere in the web app), so stored XSS through the
  thread has no sink.
- helmet's headers are applied through Fastify's request hook; CORS is pinned
  to the configured web origin.

### Abuse and rate limiting (new in this step)

- Redis-backed budgets per user _and_ per IP on trades, market creation, auth
  and comments, with honest 429s. Degraded mode is per-node counters — wrong by
  the replica count, chosen over failing open (control gone) or closed (outage).
- Wash-trading, stake-flood and multi-account detection file evidence a
  reviewer can check; nothing freezes anybody automatically, and a cleared flag
  is never re-raised from the same evidence.

## Gaps, stated plainly

1. **Tokens live in `localStorage`.** An XSS anywhere in the app would expose
   them. Mitigated by the absence of HTML sinks and by 15-minute expiry, but
   the robust answer is httpOnly cookies + CSRF protection, which changes the
   session model and belongs with the licensed-phase auth hardening.
2. **JWTs cannot be revoked mid-lifetime.** A frozen account is blocked from
   trading (checked in-service, per request) but a stolen staff token keeps its
   read access until expiry. Short expiry bounds this; a denylist would close it.
3. **TOTP secrets are stored unencrypted** in `users.totpSecret`. A database
   leak would compromise second factors along with first. They should be
   encrypted at rest with a key the database never sees.
4. **Device fingerprints are client-asserted** and therefore spoofable. They
   are deliberately only a queue hint, never a gate — but a farm that knows
   this simply omits them. Server-side signals (IP clustering over time) would
   harden it.
5. **The 10× load test has not been executed.** `scripts/load/peak.js` encodes
   the election-night profile and its thresholds, but k6 is a system install
   absent from this environment and CI. It must run against staging before any
   real event.
6. ~~**E2E journeys are not in CI.**~~ Closed: the `e2e` job boots the real
   stack (Postgres, Redis, API, web) and drives the four journeys in Chromium,
   keeping the Playwright report as an artifact when one fails.
7. ~~**No dependency audit gate.**~~ Closed: the `audit` job fails the build on
   high and critical advisories and reports the rest without blocking. Four
   transitive highs were open when the gate went in — `postcss` and `sharp`
   under `next`, `deepmerge-ts` under `prisma` — each pinned to a patched
   floor through `pnpm.overrides` rather than by dropping the parent. The tree
   is clean at every severity as of this review; the overrides are meant to be
   removed as the parents catch up, not kept for ever.
