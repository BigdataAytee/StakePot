/**
 * Thrown by every integration that is waiting on a licence.
 *
 * Deliberately loud: a stub must never look like a silent success to a caller
 * that is about to move money.
 */
export class NotImplementedError extends Error {
  constructor(reason = 'licensed phase') {
    super(`not implemented: ${reason}`);
    this.name = 'NotImplementedError';
  }
}

/** An upstream provider answered, but not with something usable. */
export class IntegrationError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'IntegrationError';
  }
}
