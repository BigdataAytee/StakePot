import { createHmac, timingSafeEqual } from 'node:crypto';

import { keyId, secretVersions } from '../config/secrets';

/**
 * §2.10's proof-of-reserves export.
 *
 * "One-click signed export: total user liabilities (from ledger) vs held
 * funds, timestamped — feeds external attestations and regulator reports."
 *
 * The console already showed these figures. What it could not do was hand
 * somebody a file, and a solvency figure that only exists inside our own admin
 * panel is not evidence of anything — the whole point of an attestation is
 * that the recipient does not have to trust the sender's screen. So the export
 * is a document that leaves the building and carries its own integrity with
 * it.
 *
 * HMAC-SHA256 rather than a public-key signature, deliberately, and the
 * limitation is worth stating plainly: this proves the document was produced
 * by this platform and has not been altered since. It does not let a third
 * party verify it without holding the key, so an external auditor is given the
 * verification key out of band. A regulator-facing asymmetric signature is a
 * licensed-phase change to `sign` alone — the canonical form below is what
 * would carry over, and it is the part that is hard to get right later.
 */
export interface ReservesFigures {
  currency: string;
  /** What the platform owes members, from the ledger. */
  userLiabilities: string;
  /** What has been issued in total, against which those liabilities sit. */
  totalIssued: string;
  platformFees: string;
  surplus: string;
  byFundClass: Record<string, string>;
  /** How many accounts the liabilities are spread across. */
  accounts: number;
  /** The last reconciliation run, which is what makes the figures credible. */
  reconciliation: { runDate: string | null; status: string; diff: string | null };
}

export interface SignedReserves extends ReservesFigures {
  document: 'stakeam.proof-of-reserves';
  version: 1;
  generatedAt: string;
  solvent: boolean;
  signature: {
    algorithm: 'HMAC-SHA256';
    keyId: string;
    value: string;
    /** How to check it without reading our source. */
    canonicalisation: string;
  } | null;
}

/**
 * The exact bytes that get signed.
 *
 * Not `JSON.stringify(document)`: key order in JSON is an implementation
 * detail, and a verifier that re-serialises with a different order computes a
 * different digest and reports a forgery that never happened. So the signed
 * form is an explicit, ordered, newline-separated list of `field=value`. It is
 * dull on purpose — a canonical form that anybody can reproduce in five lines
 * of any language is worth more than an elegant one that only our own code
 * agrees with.
 *
 * Fund classes are sorted by name so that a change in how Postgres happens to
 * return them cannot change the signature.
 */
export function canonicalise(figures: ReservesFigures, generatedAt: string): string {
  const lines = [
    'stakeam.proof-of-reserves/1',
    `generatedAt=${generatedAt}`,
    `currency=${figures.currency}`,
    `userLiabilities=${figures.userLiabilities}`,
    `totalIssued=${figures.totalIssued}`,
    `platformFees=${figures.platformFees}`,
    `surplus=${figures.surplus}`,
    `accounts=${figures.accounts}`,
    `reconciliation.runDate=${figures.reconciliation.runDate ?? ''}`,
    `reconciliation.status=${figures.reconciliation.status}`,
    `reconciliation.diff=${figures.reconciliation.diff ?? ''}`,
    ...Object.keys(figures.byFundClass)
      .sort()
      .map((name) => `fundClass.${name}=${figures.byFundClass[name] ?? '0'}`),
  ];
  return lines.join('\n');
}

const CANONICALISATION =
  'HMAC-SHA256, hex, over the newline-joined "field=value" lines listed in ' +
  'the order shown by canonicalise(): header, generatedAt, currency, ' +
  'userLiabilities, totalIssued, platformFees, surplus, accounts, the three ' +
  'reconciliation fields, then fundClass.<name> entries sorted by name.';

/**
 * Sign the figures, or say plainly that they are unsigned.
 *
 * An export with no signing key configured still produces every figure and
 * sets `signature: null` rather than throwing. Refusing to show a finance
 * operator their own solvency position because a key is missing would be a
 * worse failure than handing them numbers marked "not attestable" — and the
 * null is impossible to mistake for a signature that passed.
 */
export function signReserves(figures: ReservesFigures, generatedAt: string): SignedReserves {
  const material = secretVersions('RESERVES_SIGNING_KEY')[0];
  const solvent = !figures.surplus.trim().startsWith('-');

  const base = {
    document: 'stakeam.proof-of-reserves' as const,
    version: 1 as const,
    generatedAt,
    solvent,
    ...figures,
  };

  if (material === undefined) return { ...base, signature: null };

  return {
    ...base,
    signature: {
      algorithm: 'HMAC-SHA256',
      keyId: keyId(material),
      value: createHmac('sha256', material)
        .update(canonicalise(figures, generatedAt))
        .digest('hex'),
      canonicalisation: CANONICALISATION,
    },
  };
}

/**
 * Check a document against the accepted keys.
 *
 * Every accepted version, not just the current one, because an export signed
 * last quarter must still verify after a key rotation — an attestation that
 * expires when we rotate our own keys is not an attestation.
 */
export function verifyReserves(document: SignedReserves): boolean {
  const signature = document.signature;
  if (signature === null) return false;

  const expected = canonicalise(document, document.generatedAt);
  const offered = Buffer.from(signature.value, 'hex');

  return secretVersions('RESERVES_SIGNING_KEY').some((material) => {
    const candidate = createHmac('sha256', material).update(expected).digest();
    // Length-checked first: timingSafeEqual throws on a mismatch rather than
    // returning false, and a truncated signature is a tampered one.
    return candidate.length === offered.length && timingSafeEqual(candidate, offered);
  });
}
