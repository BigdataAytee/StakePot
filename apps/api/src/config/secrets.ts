import { createHash } from 'node:crypto';

/**
 * Where secrets come from, and how they are rotated (§2.11).
 *
 * "All credentials/keys in a secrets manager (never in code or env-files in
 * repos); automatic rotation for DB and API keys."
 *
 * This is the seam that makes that possible rather than the manager itself. A
 * hosted manager — Secrets Manager, Vault, whatever the deployment lands on —
 * is a `SecretsProvider` away, and nothing else in the codebase has to change
 * when it arrives, because nothing else in the codebase reads `process.env`
 * for a secret any more.
 *
 * The part that is not just an interface is rotation. A secret that can only
 * ever have one live value cannot be rotated without downtime: every value
 * sealed with the old key becomes unreadable the moment the new one lands. So
 * a secret here is a *list* — the current value, which is what new material is
 * sealed and signed with, followed by any predecessors that are still accepted
 * for reading. Rotating is then two deploys and no outage: publish the new key
 * with the old one retained, then drop the old one once nothing is sealed
 * under it.
 */

/** The secrets this codebase knows how to ask for. */
export type SecretName =
  /** Encrypts TOTP seeds and anything else sealed at rest. */
  | 'SECRETS_KEY'
  /** Signs session tokens. */
  | 'JWT_SECRET'
  /** Signs proof-of-reserves exports (§2.10). */
  | 'RESERVES_SIGNING_KEY';

export interface SecretsProvider {
  /**
   * Every accepted value for a secret, most recent first.
   *
   * A list rather than a value because that is what rotation needs: index 0
   * signs and seals, and the rest are only ever used to verify or open
   * material produced before the last rotation.
   */
  versions(name: SecretName): readonly string[];
}

/**
 * The default provider: the process environment.
 *
 * `NAME` is current. `NAME_PREVIOUS` holds superseded values, comma-separated,
 * newest first — so a rotation is a single variable edit rather than a
 * migration, and dropping a retired key is deleting one entry.
 */
export class EnvSecretsProvider implements SecretsProvider {
  constructor(private readonly source: NodeJS.ProcessEnv = process.env) {}

  versions(name: SecretName): readonly string[] {
    const current = this.source[name];
    const previous = (this.source[`${name}_PREVIOUS`] ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter((value) => value.length > 0);

    return current === undefined || current.length === 0 ? previous : [current, ...previous];
  }
}

export class MissingSecretError extends Error {
  constructor(name: SecretName, minimum: number) {
    super(
      `${name} is not configured, or is shorter than ${minimum} characters — ` +
        `set it in the secrets manager for this environment`,
    );
    this.name = 'MissingSecretError';
  }
}

let provider: SecretsProvider = new EnvSecretsProvider();

/** Swap the provider — a hosted manager in production, a fixture in tests. */
export function useSecretsProvider(next: SecretsProvider): void {
  provider = next;
}

/**
 * A short, non-reversible label for a key.
 *
 * Sealed values carry this so that opening one knows which key to reach for
 * instead of trying all of them, and so an operator can tell at a glance
 * whether a row predates the last rotation. Eight hex characters of a hash:
 * enough to distinguish the two or three keys that are ever live at once, and
 * useless to anybody who does not already hold the key.
 */
export function keyId(material: string): string {
  return createHash('sha256').update(material).digest('hex').slice(0, 8);
}

/** Every accepted value for a secret, newest first. Empty if unconfigured. */
export function secretVersions(name: SecretName, minimum = 32): readonly string[] {
  return provider.versions(name).filter((value) => value.length >= minimum);
}

/** The value new material is signed or sealed with. Throws if unconfigured. */
export function secret(name: SecretName, minimum = 32): string {
  const current = secretVersions(name, minimum)[0];
  if (current === undefined) throw new MissingSecretError(name, minimum);
  return current;
}

/**
 * What the system room shows about key hygiene (§6.9).
 *
 * Deliberately reports ids and counts and never material: this crosses an HTTP
 * boundary to an operator's browser, and a console that can print a key is a
 * console that leaks one.
 */
export function rotationStatus(): {
  name: SecretName;
  configured: boolean;
  currentKeyId: string | null;
  acceptedVersions: number;
}[] {
  const names: SecretName[] = ['SECRETS_KEY', 'JWT_SECRET', 'RESERVES_SIGNING_KEY'];

  return names.map((name) => {
    const versions = secretVersions(name);
    const current = versions[0];
    return {
      name,
      configured: current !== undefined,
      currentKeyId: current === undefined ? null : keyId(current),
      acceptedVersions: versions.length,
    };
  });
}
