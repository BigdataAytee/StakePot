"""
AI Question Engine — Backtest Harness v1
=========================================
Question: if the AI engine had drafted markets on real past Nigerian events,
using its threshold rules, would those markets have been BALANCED (35-65%)
and would they have EARNED well?

Method:
- Historical event set: real outcomes (public record) + what consensus/priors
  looked like BEFORE the event (approximated from polls/forecasts/odds of the time).
- Two drafting strategies compared:
    NAIVE  : round-number thresholds / obvious framings (what an untrained
             question-writer does)
    ENGINE : AI rules — threshold pitched AT consensus, multi-outcome where
             possible, reject drafts outside 35-65% estimated balance
- For each drafted market, simulate crowd trading with the v1.1 pricing engine
  (crowd belief ~ consensus + noise), then resolve with the REAL outcome.
- Score: balance of final pools, fee earned per ₦100k volume, % of markets
  that would have activated (both sides present).
"""
import numpy as np
rng = np.random.default_rng(7)

# ---------------------------------------------------------------- pricing engine (v1.1)
class Market:
    def __init__(self, n, L):
        self.n, self.L = n, L
        self.q = np.zeros(n); self.pot = 0.0
        self.money_in = np.zeros(n)  # per-outcome stakes (for balance measurement)
    def prices(self):
        e = np.exp((self.q - self.q.max())/self.L); return e/e.sum()
    def buy(self, i, m):
        p = self.prices()[i]
        d = self.L*np.log((np.exp(m/self.L)-1+p)/p)
        self.q[i] += d; self.pot += m; self.money_in[i] += m
        return d

# ---------------------------------------------------------------- historical event set
# (event, consensus prob of YES/favourite before event, actual outcome index,
#  naive framing prob, n_outcomes, note)
# Consensus figures are approximations of pre-event public expectations.
EVENTS = [
    # --- Economic (threshold questions: engine pitches AT consensus; naive picks round/obvious lines)
    ("Naira ends month above ₦1,500/$ (mid-2024 style vol)", 0.50, 0, 0.95, 2, "naive line: 'above ₦1,000' = obvious yes"),
    ("NBS inflation above 33% (2024 peak period)",            0.55, 0, 0.98, 2, "naive: 'above 20%' when trend obviously higher"),
    ("CBN holds MPR at scheduled MPC (typical meeting)",      0.60, 0, 0.60, 2, "consensus genuinely split"),
    ("Fuel price above ₦900 by quarter end (2024)",           0.45, 1, 0.90, 2, "naive: 'above ₦500' post-subsidy = obvious"),
    ("NBS inflation falls month-on-month (2025 disinflation)",0.55, 0, 0.55, 2, "balanced either way"),
    # --- Football (engine: multi-outcome W/D/L or tuned lines; naive: 'will favourite win?')
    ("AFCON 2023 final: Nigeria beats Côte d'Ivoire",         0.55, 1, 0.55, 2, "genuine toss-up; NGA lost"),
    ("Super Eagles beat minnow in qualifier",                 0.80, 0, 0.80, 2, "engine REJECTS (out of band) -> W/D/L reframe"),
    ("Nigeria reaches AFCON 2023 final",                      0.40, 0, 0.40, 2, "longshot-ish that landed"),
    ("Super Eagles W/D/L vs strong opponent (multi)",         0.45, 0, 0.45, 3, "multi-outcome, split 45/30/25"),
    ("Osimhen scores in the match",                           0.55, 1, 0.55, 2, "coin-flip prop"),
    # --- Elections (engine: candidate list multi-outcome; naive: 'will incumbent party win?')
    ("2023 Presidential: Tinubu wins (3-way race, multi)",    0.45, 0, 0.45, 4, "multi: 45/30/20/5 - tight 3-way"),
    ("2023 Lagos Gov: incumbent wins",                        0.60, 0, 0.60, 2, "competitive after presidential shock"),
    ("Edo 2024 Gov: APC wins (tight race)",                   0.50, 0, 0.50, 2, "genuinely tight"),
    ("Ondo 2024 Gov: incumbent wins",                         0.65, 0, 0.65, 2, "at edge of band"),
    ("2023: LP wins Lagos presidential vote (upset)",         0.35, 0, 0.35, 2, "longshot that LANDED"),
    # --- Entertainment (BBNaija-style: engine multi-outcome; naive: 'will favourite win?')
    ("BBNaija season winner = pre-final favourite (multi 5)", 0.40, 0, 0.75, 5, "naive frames favourite as near-lock"),
    ("Grammy: Burna wins category (competitive field)",       0.35, 1, 0.35, 4, "favourite elsewhere; didn't win"),
    ("Headline artist announces Dec Lagos show by Nov 30",    0.55, 0, 0.90, 2, "naive undated/obvious framing"),
]

def simulate(market_frame, consensus, outcome, n_outcomes, volume=100_000, traders=120):
    """Crowd trades toward consensus with noise; returns balance & fee metrics."""
    L = 0.6*volume  # per v1.1 tuning rule
    mkt = Market(n_outcomes, L)
    stake = volume/traders
    if n_outcomes == 2:
        beliefs = np.clip(rng.normal(consensus, 0.10, traders), 0.03, 0.97)
        for b in beliefs:
            mkt.buy(0 if rng.random() < b else 1, stake)
    else:
        # spread: favourite gets `consensus`, rest split remainder in declining shares
        rest = (1-consensus)
        weights = np.array([consensus] + list(rest*np.linspace(1.6,0.4,n_outcomes-1)/np.sum(np.linspace(1.6,0.4,n_outcomes-1))))
        for _ in range(traders):
            w = np.clip(weights + rng.normal(0,0.05,n_outcomes), 0.01, None); w/=w.sum()
            mkt.buy(rng.choice(n_outcomes, p=w), stake)
    losing = mkt.pot - mkt.money_in[outcome]
    fee = 0.03*losing
    top_share = mkt.money_in.max()/mkt.pot
    # activation proxy: every outcome pool must reach half its 'fair share' (0.5/n)
    both_sides = (mkt.money_in.min()/mkt.pot) > 0.5/mkt.n
    return top_share, losing, 0.03*losing, both_sides

def run(strategy):
    rows = []
    for (name, cons, outcome, naive_p, n_out, note) in EVENTS:
        if strategy == "ENGINE":
            p, n = cons, n_out
            # engine rule: reject binary drafts outside 35-65 -> reframe multi (adds outcomes, splits favourite)
            if n == 2 and not (0.35 <= p <= 0.65):
                n, p = 3, min(max(p*0.72, 0.35), 0.60)   # W/D/L-style reframe
        else:
            p, n = naive_p, (2 if n_out<=2 else 2)        # naive: always binary, obvious line
        top, losing, fee, act = simulate(name, p, min(outcome, n-1), n)
        rows.append((name, top, fee, act))
    return rows

print(f"{'':52s}  {'NAIVE':>22s}  {'ENGINE':>22s}")
print(f"{'EVENT':52s}  {'top-side%':>10s} {'fee₦':>7s} {'act':>3s}  {'top-side%':>10s} {'fee₦':>7s} {'act':>3s}")
print("-"*106)
naive, engine = run("NAIVE"), run("ENGINE")
for (name,t1,f1,a1),(_,t2,f2,a2) in zip(naive, engine):
    print(f"{name[:52]:52s}  {t1*100:9.0f}% {f1:7.0f} {'✔' if a1 else '✘':>3s}  {t2*100:9.0f}% {f2:7.0f} {'✔' if a2 else '✘':>3s}")

def summary(rows, label):
    tops = np.array([r[1] for r in rows]); fees = np.array([r[2] for r in rows]); acts=np.array([r[3] for r in rows])
    print(f"\n{label}:")
    print(f"  avg dominant-side share : {tops.mean()*100:.0f}%   (50% = perfect balance)")
    print(f"  markets in 35-65 band   : {(tops<=0.65).mean()*100:.0f}%")
    print(f"  would-activate rate     : {acts.mean()*100:.0f}%")
    print(f"  avg fee per ₦100k market: ₦{fees.mean():,.0f}   | total: ₦{fees.sum():,.0f}")
print("="*106)
summary(naive,  "NAIVE drafting (round numbers, favourite-framing)")
summary(engine, "ENGINE drafting (consensus thresholds, 35-65 gate, multi-outcome reframes)")
