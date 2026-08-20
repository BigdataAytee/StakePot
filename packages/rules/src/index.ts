/**
 * `docs/ticket-creation-checklist.md`, as one module.
 *
 * Everything that can create a market on StakeAm reads this package: the AI
 * question engine, the admin wizard in the Market Studio, and the community
 * wizard. Encoding the rules once is the whole design — three copies of a rule
 * set drift, and the first sign of the drift is a market that should never have
 * opened, published by whichever path had the stale copy.
 */
export * from './constants';
export * from './draft';
export * from './health';
export * from './prompt';
export * from './registry';
export * from './sources';
export * from './validators';
