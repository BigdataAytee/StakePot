-- News pinned to a market needs somewhere to point.
--
-- §7.2a's annotations already carry the *what* — "CBN holds rate", "fixture
-- postponed" — and drop a mark on the chart at the moment it happened. What
-- they could not carry is the *where*: a headline with no link is a claim the
-- reader has to take on trust, which is the opposite of what a market settling
-- against one named source is for.
--
-- Nullable, because most annotation types are events the platform generated
-- itself — a market opening, a freeze, a settlement — and those have no source
-- to cite. Only `news`, pinned by staff from the Market Studio, will carry one.
ALTER TABLE "market_annotations" ADD COLUMN "url" TEXT;

-- Who pinned it, for the audit trail. A news item on a live market is an
-- editorial act that moves a price, so it is attributable by construction
-- rather than by hoping somebody also wrote an admin_audit row.
ALTER TABLE "market_annotations" ADD COLUMN "pinnedBy" TEXT;
