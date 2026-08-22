#!/usr/bin/env node
/**
 * Every service must have somebody who calls it.
 *
 * Three defects in one morning had the same shape: a service written, tested,
 * registered in a module — and never invoked by anything. `DossierService` had
 * no endpoint, so a dossier could be written to the database and no human could
 * see it. `ResearchService.pass()` had no scheduler, so the "continuous"
 * pipeline never ran and every screen downstream rendered an empty list that
 * looked exactly like a quiet news week. Template curation had endpoints and no
 * caller.
 *
 * None of the three failed a test, because each one's tests called it directly.
 * That is the gap this closes: tests prove a unit works, and nothing proved it
 * was reachable.
 *
 * **A module registration does not count as a consumer.** That is the whole
 * point — all three bugs were correctly registered. `*.module.ts` files are
 * excluded from the search, so "provided and exported" reads as orphaned here,
 * which is what it actually is.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SRC = join(ROOT, 'apps/api/src');

/**
 * Services with no in-process caller, and why that is correct.
 *
 * Deliberately small and each entry has to say what invokes it instead. A
 * growing allowlist is the failure mode here: the check is only worth having
 * while adding to this list feels like an admission.
 */
const ALLOWED = new Map([
  ['RealtimeGateway', 'attached to the Fastify instance in main.ts, not injected anywhere'],
  ['PrismaService', 'the base client — injected by almost everything, matched by its own name'],
  // DEBT, not an exemption. This one is genuinely dead in production: nothing
  // injects it, and it is kept alive only by `trade.integration.test.ts` using
  // `create()` to build fixture markets. Delete it when that suite's fixtures
  // move to the paths production actually uses (OfficialMarketService, the
  // Studio, or plain inserts). Listed here so the check stays honest about the
  // rest rather than being switched off over one known case.
  ['MarketService', 'DEBT: dead in production, kept compiling by one test suite’s fixtures'],
  // A stub with no caller *by design*, and the only entry here that is
  // supposed to stay. §2.16's fintech connector is registered now, throwing
  // NotImplemented, so that the shape of "reserve, capture, release" is fixed
  // while it is still free to choose — rather than being invented under a
  // launch deadline as a single "take the money" call with no reservation and
  // no refund path. Nothing calls it because nothing may: TEST mode has no
  // real balance to draw on and LIVE mode is unreachable until licensing.
  // Delete this line when the real connector lands and the seed tool calls it.
  [
    'StubFundingConnector',
    'a deliberate stub: the funding seam is fixed now, unreachable until licensing',
  ],
]);

function walk(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const files = walk(SRC).filter((path) => path.endsWith('.ts'));
const sources = new Map(files.map((path) => [path, readFileSync(path, 'utf8')]));

/** Every `@Injectable()` class, with the file that declares it. */
const services = [];
for (const [path, text] of sources) {
  if (path.endsWith('.test.ts')) continue;
  for (const match of text.matchAll(/@Injectable\(\)[\s\S]{0,200}?export class (\w+)/g)) {
    services.push({ name: match[1], path });
  }
}

const orphans = [];
for (const service of services) {
  if (ALLOWED.has(service.name)) continue;

  const used = [...sources.entries()].some(([path, text]) => {
    if (path === service.path) return false;
    // A module registration is not a consumer. All three of the bugs this
    // check exists for were provided and exported correctly.
    if (path.endsWith('.module.ts')) return false;
    // Nor is a test: every one of them had tests that called the service
    // directly, which is exactly why the tests all passed.
    if (path.endsWith('.test.ts')) return false;
    return new RegExp(`\\b${service.name}\\b`).test(text);
  });

  if (!used) orphans.push(service);
}

if (orphans.length > 0) {
  console.error('wiring: services with no caller\n');
  for (const orphan of orphans) {
    console.error(`  ${orphan.name}`);
    console.error(`    ${relative(ROOT, orphan.path)}`);
    console.error(
      '    Registered in a module but never injected or called outside tests.\n' +
        '    Give it a controller, a worker, or a caller — or add it to ALLOWED\n' +
        '    in scripts/check-wiring.mjs with the reason it is reachable anyway.\n',
    );
  }
  console.error(
    `${orphans.length} orphaned service${orphans.length === 1 ? '' : 's'}. ` +
      'A service nothing calls is a feature nobody can use.',
  );
  process.exit(1);
}

console.log(`wiring: clean — ${services.length} services, every one of them called`);
