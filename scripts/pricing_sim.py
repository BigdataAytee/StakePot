import numpy as np

rng = np.random.default_rng(42)

class Market:
    """Hybrid engine: LMSR-curve share issuance, pot-share payouts."""
    def __init__(self, n_outcomes, L):
        self.n = n_outcomes
        self.L = L
        self.q = np.zeros(n_outcomes)   # shares outstanding
        self.pot = 0.0                   # naira collected
        self.holdings = {}               # user -> shares per outcome
        self.paid = {}                   # user -> net money in (for P&L)

    def C(self, q):
        # log-sum-exp, stable
        m = q.max()/self.L
        return self.L*(m + np.log(np.sum(np.exp(q/self.L - m))))

    def prices(self):
        e = np.exp((self.q - self.q.max())/self.L)
        return e/e.sum()

    def buy(self, user, outcome, money):
        """Spend `money` on `outcome`; returns shares granted (closed form)."""
        p = self.prices()[outcome]
        delta = self.L*np.log((np.exp(money/self.L) - 1 + p)/p)
        self.q[outcome] += delta
        self.pot += money
        h = self.holdings.setdefault(user, np.zeros(self.n))
        h[outcome] += delta
        self.paid[user] = self.paid.get(user, 0.0) + money
        return delta

    def sell(self, user, outcome, shares):
        """Sell shares back along the same curve; refund from pot."""
        h = self.holdings[user]
        shares = min(shares, h[outcome])
        c0 = self.C(self.q)
        q2 = self.q.copy(); q2[outcome] -= shares
        refund = c0 - self.C(q2)
        assert refund <= self.pot + 1e-9, "SOLVENCY BREACH"
        self.q = q2
        self.pot -= refund
        h[outcome] -= shares
        self.paid[user] -= refund
        return refund

    def resolve(self, winner, fee_rate=0.03):
        fee = self.pot*fee_rate
        distributable = self.pot - fee
        total_win_shares = sum(h[winner] for h in self.holdings.values())
        payouts = {}
        for u, h in self.holdings.items():
            payouts[u] = distributable*h[winner]/total_win_shares if total_win_shares > 0 else 0
        return fee, payouts

def run(n_traders, L, label, n_outcomes=2, avg_stake=2000):
    mkt = Market(n_outcomes, L)
    # sentiment drifts: outcome 0 is mildly favoured, news shock mid-way
    price_path = [mkt.prices()[0]]
    for t in range(n_traders):
        belief = 0.55 if t < n_traders//2 else 0.65   # news favours 0 mid-way
        outcome = 0 if rng.random() < belief else 1
        stake = max(200, rng.normal(avg_stake, avg_stake/2))
        mkt.buy(f"u{t}", outcome, stake)
        # 15% of traders exit half their position later
        if rng.random() < 0.15 and t > 2:
            u = f"u{rng.integers(0, t)}"
            if u in mkt.holdings:
                o = int(np.argmax(mkt.holdings[u]))
                mkt.sell(u, o, mkt.holdings[u][o]*0.5)
        price_path.append(mkt.prices()[0])

    moves = np.abs(np.diff(price_path))*100
    fee, payouts = mkt.resolve(0)
    collected = sum(max(v,0) for v in [mkt.paid[u] for u in mkt.paid])  # net money in
    total_in = sum(mkt.paid.values())
    total_out = sum(payouts.values()) + fee
    platform_cost = total_in - total_out   # should be ~0 (pot fully distributed)

    print(f"\n{label}: {n_traders} traders, L={L}")
    print(f"  final price of favourite: {price_path[-1]*100:.1f}%  (started 50.0%)")
    print(f"  avg price move per trade: {moves.mean():.2f} pts | max single move: {moves.max():.2f} pts")
    print(f"  pot at close: ₦{mkt.pot:,.0f} | fee: ₦{fee:,.0f}")
    print(f"  platform cost (should be ~0): ₦{platform_cost:,.2f}")
    print(f"  pot ever negative: NO (asserted on every exit)")

print("="*70)
print("SIM 1 — same L, three market sizes (shows why L must scale)")
for n, lbl in [(5,"Tiny"), (50,"Medium"), (500,"Large")]:
    run(n, L=10000, label=lbl)

print("\n" + "="*70)
print("SIM 2 — L sized to expected volume (the tuning rule: L ≈ 8% of expected volume)")
for n in [5, 50, 500]:
    expected_volume = n*2000
    run(n, L=max(3000, 0.08*expected_volume*10), label=f"Tuned")

print("\n" + "="*70)
print("SIM 3 — pathological: one whale, empty market, then exit (stress test)")
mkt = Market(2, 5000)
sh = mkt.buy("whale", 0, 50000)
print(f"whale buys ₦50,000 alone → price jumps to {mkt.prices()[0]*100:.1f}%, pot ₦{mkt.pot:,.0f}")
refund = mkt.sell("whale", 0, sh)
print(f"whale exits fully → refund ₦{refund:,.2f} (paid ₦50,000) → pot left ₦{mkt.pot:,.2f}")
print(f"round-trip loss to whale: ₦{50000-refund:,.2f} (spread cost, stays in pot) — pot never negative")
