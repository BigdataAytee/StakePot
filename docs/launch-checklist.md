# Launch checklist

`build-plan.md` defines it in one line:

> **Launch =** Phase 5 gate + the six official markets created + rulebook
> thresholds set + first-100-users plan ready.

That expands into the six phase gates plus three launch-specific items. Each row
below says what the gate actually requires, whether it is met, and who has to
move it. **Owner is either _Claude_ (a code change I can make and verify here) or
_You_ (a decision, a credential, an environment, or an act of judgement that is
not mine to make).**

Status is evidence-based. Where something is claimed done, the evidence is named
so it can be re-checked rather than trusted.

---

## Phase gates

### Phase 0 — Engine property suite green · CI passes · docker compose up works

| Item                        | Status      | Owner  | Evidence / what remains                                                                                                                                                                                                                                                                         |
| --------------------------- | ----------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Engine property suite green | **Done**    | Claude | 44 engine tests, fast-check over 2–8 outcomes and five magnitude bands; `pnpm test:props`                                                                                                                                                                                                       |
| CI passes                   | **Done**    | Claude | Four green jobs on `main`: verify, e2e journeys, images build, dependency audit                                                                                                                                                                                                                 |
| Deployable from a Blueprint | **Done**    | Claude | `render.yaml` describes Postgres, Key Value, the API and the web app, all on free plans. Read its closing notes before it carries anything real — free Postgres expires after 30 days, and the ledger's append-only grants need a restricted database role that Render's generated owner is not |
| `docker compose up` works   | **Pending** | You    | Both images build in CI. There is no Docker daemon in this container, so the composed stack cannot be brought up here at all — it needs one run on a machine with Docker                                                                                                                        |

### Phase 1 — Reconciliation clean · corruption test freezes withdrawals · ledger immutable at DB level

| Item                           | Status      | Owner  | Evidence / what remains                                                                                                                                            |
| ------------------------------ | ----------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Reconciliation clean           | **Done**    | Claude | `GET /admin/abuse/ledger-audit` → `clean: true`, 4 checks, run against a database that had just taken real trades and a settlement                                 |
| Corruption freezes withdrawals | **Partial** | Claude | The audit detects a one-legged insert and opens an incident (adversarial test). Withdrawals themselves are a licensed-phase surface and do not exist to freeze yet |
| Ledger immutable at DB level   | **Done**    | Claude | REVOKE + trigger, both proven against live Postgres on every CI run                                                                                                |

### Phase 2 — Full market runs on a phone · duplicate trades execute once · receipt shows ₦0.00 platform cost

| Item                              | Status   | Owner  | Evidence / what remains                                                                                                                                                                                           |
| --------------------------------- | -------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full market runs on a phone       | **Done** | Claude | The walkthrough runs on a 393×851 phone viewport as well as desktop — 36 specs green, screenshots in `docs/walkthrough/phone/`, no horizontal overflow on any page. A real handset is still worth one manual pass |
| Duplicate trades execute once     | **Done** | Claude | Request-id unique constraint plus a queue-level pre-check; pinned by the hardening integration suite                                                                                                              |
| Receipt shows ₦0.00 platform cost | **Done** | Claude | Conservation asserted by property tests; stored ledger balances to exactly zero since the step-13 quantisation change                                                                                             |

### Phase 3 — Outsider creates→funds→resolves a ticket · all void paths refund exactly · AI never self-publishes

| Item                                | Status      | Owner  | Evidence / what remains                                                                                                                                                                     |
| ----------------------------------- | ----------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Outsider creates → funds → resolves | **Blocked** | You    | The wizard's review step calls the question engine, which needs `ANTHROPIC_API_KEY`. Proven at API level in the integration suite; never run against the real model. Needs a key in staging |
| Void paths refund exactly           | **Done**    | Claude | Refund paths covered in the resolution integration suite, including the funding-window void                                                                                                 |
| AI never self-publishes             | **Done**    | Claude | Drafts require an explicit human open; no code path publishes a generated market                                                                                                            |

### Phase 4 — Self-exclusion works · no-god-button test passes · SLA escalation fires

| Item                 | Status   | Owner  | Evidence / what remains                                                                                                                           |
| -------------------- | -------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Self-exclusion works | **Done** | Claude | RG module: limits, cool-off, self-exclusion, reality check; integration tested                                                                    |
| No-god-button        | **Done** | Claude | No code path edits a balance directly — `ledger.adjust` through four-eyes is the only door. Asserted in the security review by sweep, not assumed |
| SLA escalation fires | **Done** | Claude | Support ticketing with SLA timers and escalation, integration tested                                                                              |

### Phase 5 — 10× load test holds · share/challenge loop works · abuse flags surface

| Item                                     | Status                   | Owner  | Evidence / what remains                                                                                                                                                                                                |
| ---------------------------------------- | ------------------------ | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10× load test holds                      | **Done (dev container)** | Claude | Run and passing: 3,534 trades, 100% accepted, p95 64ms, ledger clean and pot identity exactly zero afterwards. Found and fixed two real defects — see `docs/loadtest.md`. Still owed a **staging** run, which is yours |
| Share / challenge loop works             | **Done**                 | Claude | Challenge link lands a signed-out visitor on the argument with the challenger's position; e2e journey in CI                                                                                                            |
| Abuse flags surface                      | **Done**                 | Claude | Five accounts on one device fingerprint → five `multi_account` flags in the Trust & Safety queue, each with evidence a reviewer can check                                                                              |
| Rate limits on auth/trade/create/comment | **Done**                 | Claude | All four classes decorated and live; a burst returns 429 with a human message; asserted on every walkthrough run                                                                                                       |

---

## Launch-specific items

| Item                         | Status                | Owner | What remains                                                                                                                                                                                |
| ---------------------------- | --------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Six official markets created | **Not started**       | You   | Which six questions open the platform is an editorial decision. Once chosen, opening them is a few minutes in the admin drafts queue                                                        |
| Rulebook thresholds set      | **Awaiting sign-off** | You   | Defaults are in config and working: `starter_balance_spc` 5,000 · `signup_bonus_spc` 10,000 · `exit_fee_rate` 1% · fee 7% · activation floors. They need your explicit yes, not my defaults |
| First-100-users plan         | **Not started**       | You   | Go-to-market, not code                                                                                                                                                                      |
| §2.9 activation amendment    | **Awaiting decision** | You   | `community_activation_mode` — still open from step 7                                                                                                                                        |

---

## Things I would not launch without, that no gate names

These came out of the security review and the walkthrough. None is a blocker the
build plan lists; all four are things I would want closed before real money.

| Item                                     | Status   | Owner                      | Note                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------- | -------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tokens in `localStorage`                 | **Open** | Claude, on your word       | An XSS anywhere exposes sessions. The fix is httpOnly cookies + CSRF, which changes the session model — worth doing with licensed-phase auth, and `src/lib/session.ts` is the single seam it goes through                                                                                                  |
| JWTs cannot be revoked                   | **Done** | Claude                     | Closed: `jti` denylist plus a per-account `iat` cutoff (`apps/api/src/auth/token-revocation.service.ts`), so one token or every token for an account can be killed. Fails open on a Redis outage rather than locking everybody out                                                                         |
| TOTP secrets unencrypted at rest         | **Done** | Claude                     | Closed: AES-256-GCM under `SECRETS_KEY` (`apps/api/src/auth/secret-box.ts`), a key the database never sees. Rotating it locks enrolled staff out of their authenticator, so it is generated once per environment and kept                                                                                  |
| No signup/login on mobile viewport check | **Done** | Claude                     | Closed: `apps/web/e2e/auth-screens.spec.ts` runs both auth screens at 393px, checking 44px tap targets and no sideways scroll. Looking at them found a 16px checkbox gating the only button on the screen                                                                                                  |
| Verification gate on withdrawal          | **Open** | Claude, when payments land | Entry is deliberately unverified — Tier 0 trades both shelves. A verified contact is required before money leaves, and there is no withdrawal path yet to carry the check (§9, licensed phase). Recorded on `apps/api/src/integrations/paystack.stub.ts` so it lands with the feature rather than after it |
| Privacy policy not reviewed by counsel   | **Open** | You                        | `/privacy` is written from the schema and is accurate about what the platform holds, but Nigeria's Data Protection Act 2023 wants what a page cannot supply on its own — a named Data Protection Officer and a filing with the Commission. Owed before real money                                          |
| No mail or SMS transport configured      | **Open** | You                        | Nobody can reach Tier 1 without one: the code goes to email or SMS and nowhere else, and the API now refuses to claim it sent one that no channel took. Set `SMTP_URL` or `TERMII_KEY` on the deployed API. Tier 0 signup and trading work without it                                                      |
| `verify` not a required status check     | **Open** | You                        | CI runs on every PR but nothing blocks a merge when it is red. Repo setting: Settings → Branches → `main`. Worth requiring all four checks (verify, e2e journeys, images build, dependency audit). I cannot set this — the session's token is refused by the branch-protection API                         |

---

## How to re-check this document

Nothing here should be believed because it is written down:

```bash
./scripts/dev/ensure-services.sh                       # Postgres + Redis + migrations
pnpm typecheck && pnpm lint && pnpm test && pnpm test:props && pnpm build

# the money invariants, re-derived from the rows
curl -H "authorization: Bearer $STAFF_TOKEN" localhost:3001/admin/abuse/ledger-audit

# the product, in a browser, with screenshots
psql "$TEST_DATABASE_URL" -f scripts/dev/seed-walkthrough.sql
pnpm --filter @stakeam/web exec playwright test walkthrough
```
