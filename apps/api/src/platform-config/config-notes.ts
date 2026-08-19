/**
 * What each setting actually does, and what breaks if you get it wrong.
 *
 * §6.4b calls the config console a "maximum-security zone" and asks for a
 * per-parameter blast-radius note. This is that note, and it is the substance
 * of the screen rather than help text on it: `exit_fee_rate` and
 * `comment_max_length` are both one number in one table, and a console that
 * renders them identically invites somebody to treat them identically. One of
 * them changes what every member pays on every early exit.
 *
 * `blast` is the honest answer to "who feels this, and how fast":
 *  - `money`    — changes what somebody is paid or charged. Four-eyes, always.
 *  - `market`   — changes whether markets open, close or void.
 *  - `guard`    — a safety limit. Loosening it is the dangerous direction.
 *  - `cosmetic` — changes copy, pagination or a display threshold.
 *
 * Keys with no entry render without a note rather than with a wrong one. A
 * confidently wrong blast radius is worse than a missing one, so this is
 * deliberately not generated from the schema.
 */
export interface ConfigNote {
  blast: 'money' | 'market' | 'guard' | 'cosmetic';
  /** One sentence: what it controls. */
  what: string;
  /** One sentence: what goes wrong if it is set badly. */
  risk: string;
}

export const CONFIG_KEY_NOTES: Record<string, ConfigNote> = {
  // ------------------------------------------------------------------ money
  official_fee_bps: {
    blast: 'money',
    what: 'The platform’s cut of an official market’s losing pool, in basis points.',
    risk: 'Applies at settlement to markets already trading, so a raise takes money people expected to win.',
  },
  community_fee_bps: {
    blast: 'money',
    what: 'The total cut on a community market, split between creator and platform.',
    risk: 'Creators were shown an earnings preview at creation; changing this after the fact breaks that promise.',
  },
  community_creator_bps: {
    blast: 'money',
    what: 'The creator’s share of the community fee.',
    risk: 'Must sum with community_platform_bps to community_fee_bps, or the split silently under- or over-pays.',
  },
  community_platform_bps: {
    blast: 'money',
    what: 'The platform’s share of the community fee.',
    risk: 'See community_creator_bps — these three move together or not at all.',
  },
  exit_fee_rate: {
    blast: 'money',
    what: 'What an early exit costs, as a fraction of proceeds.',
    risk: 'Charged on every sell immediately. Above 2% the engine rejects it; near 2% early exit stops being usable.',
  },
  conduct_bond_spc: {
    blast: 'money',
    what: 'What a creator escrows to open a market.',
    risk: 'Raising it prices out new creators; lowering it makes dishonest settlement cheap.',
  },
  starter_balance_spc: {
    blast: 'money',
    what: 'Points credited on signup.',
    risk: 'Issues real liability on the ledger for every new account, including farmed ones.',
  },
  signup_bonus_spc: {
    blast: 'money',
    what: 'Points credited when contact is verified.',
    risk: 'Same as the starter balance, and it is the number a multi-account farm optimises against.',
  },

  // ----------------------------------------------------------------- market
  funding_window_hours: {
    blast: 'market',
    what: 'How long a Path A market has to fill.',
    risk: 'Shortening it voids markets that would have made it; only affects markets created after the change.',
  },
  community_activation_pool_spc: {
    blast: 'market',
    what: 'The stake a community market needs before it opens.',
    risk: 'Raising it while windows are open can void markets whose backers already committed.',
  },
  community_activation_backers: {
    blast: 'market',
    what: 'How many distinct backers activation requires.',
    risk: 'The anti-single-whale rule. Lowering it to 1 lets one account open any market it likes.',
  },
  community_activation_mode: {
    blast: 'market',
    what: 'Whether activation is measured per outcome or on the total pot.',
    risk: 'Switching mid-window changes the test a live market is being judged by.',
  },
  participation_floor_users: {
    blast: 'market',
    what: 'Distinct participants required at window close.',
    risk: 'The re-check that voids thin markets. Raising it voids more; lowering it lets two-person markets run.',
  },
  dispute_window_hours: {
    blast: 'market',
    what: 'How long members have to dispute a proposed result.',
    risk: 'Shortening it can close a window somebody was mid-way through using.',
  },
  resolution_proposal_hours: {
    blast: 'market',
    what: 'How long a creator has to propose a result before it escalates.',
    risk: 'Too short and honest creators get escalated; too long and settlement stalls.',
  },
  symmetric_seed_per_outcome_spc: {
    blast: 'market',
    what: 'The equal seed a Path B creator puts on every outcome.',
    risk: 'This is what stops a seed being a directional bet. It must stay symmetric.',
  },

  // ------------------------------------------------------------------ guard
  config_change_delay_hours: {
    blast: 'guard',
    what: 'How long an approved config change waits before it takes effect.',
    risk: 'This is the safeguard on every other row here. Setting it to 0 removes the window to notice a mistake.',
  },
  rg_platform_stake_limit_spc: {
    blast: 'guard',
    what: 'The platform-wide stake ceiling behind a member’s own limits.',
    risk: 'Raising it weakens a responsible-gambling control for everyone at once.',
  },
  rg_platform_loss_limit_spc: {
    blast: 'guard',
    what: 'The platform-wide loss ceiling.',
    risk: 'As above. Loosening an RG limit is the one direction that needs the most scrutiny.',
  },
  rg_cooloff_max_days: {
    blast: 'guard',
    what: 'The longest cool-off a member can set.',
    risk: 'Lowering it below an active cool-off must never shorten one already in force.',
  },
  tier0_stake_cap_spc: {
    blast: 'guard',
    what: 'Total exposure an unverified account may hold.',
    risk: 'The anti-farming ceiling. Raising it increases what an unverified account can move.',
  },
  kyc_required_at: {
    blast: 'guard',
    what: 'Whether KYC is demanded at deposit or at withdrawal.',
    risk: 'A licensing-relevant control. Changing it has regulatory consequences, not just product ones.',
  },
  comment_min_tier: {
    blast: 'guard',
    what: 'The tier required to post in a take thread.',
    risk: 'Dropping it to 0 is what opens the threads to drive-by spam.',
  },

  // --------------------------------------------------------------- cosmetic
  leaderboard_page_size: {
    blast: 'cosmetic',
    what: 'How many rows a leaderboard page returns.',
    risk: 'Large values make the board slow to load; nothing is paid differently.',
  },
  comment_max_length: {
    blast: 'cosmetic',
    what: 'Longest comment allowed.',
    risk: 'Lowering it does not truncate comments already posted.',
  },
  reality_check_minutes: {
    blast: 'cosmetic',
    what: 'How often the session reality-check interrupts.',
    risk: 'A §2.12 duty-of-care prompt — long intervals weaken it, but nothing breaks.',
  },
  official_shelf_slots: {
    blast: 'cosmetic',
    what: 'How many official markets the shelf plans for.',
    risk: 'Only governs how many drafts the engine offers; it closes nothing already open.',
  },
};
