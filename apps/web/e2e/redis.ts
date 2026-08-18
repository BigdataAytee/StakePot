import { createConnection } from 'node:net';

/**
 * Just enough Redis to clear a rate-limit budget between runs.
 *
 * Written against the wire protocol rather than shelling out to `redis-cli`,
 * because the CLI is not installed on a GitHub runner — Redis is a service
 * container there, with no client on the host. The shell-out failed silently,
 * the budget never reset, and CI went red on the second Playwright project
 * with 429s that looked like a product bug and were the limiter working.
 *
 * Not a dependency either: `ioredis` lives in the API's package, and adding it
 * to the web app to support a test would put a server client in a browser
 * bundle's manifest. RESP is a small enough protocol to speak directly.
 */
function command(...args: string[]): string {
  return (
    `*${args.length}\r\n` + args.map((arg) => `$${Buffer.byteLength(arg)}\r\n${arg}\r\n`).join('')
  );
}

/**
 * Delete every key matching a pattern.
 *
 * SCAN rather than KEYS: the same reason production would — KEYS blocks the
 * server, and a test helper should not teach a habit that would be wrong
 * anywhere else.
 */
export async function deleteKeys(pattern: string, url?: string): Promise<number> {
  const target = new URL(url ?? process.env['REDIS_URL'] ?? 'redis://localhost:6379');
  const port = Number(target.port === '' ? 6379 : target.port);
  const host = target.hostname === '' ? 'localhost' : target.hostname;

  return new Promise<number>((resolve) => {
    let deleted = 0;
    let buffer = '';
    let cursor = '0';

    const socket = createConnection({ host, port }, () => {
      socket.write(command('SCAN', cursor, 'MATCH', pattern, 'COUNT', '500'));
    });

    // Any failure at all resolves rather than rejects: this is housekeeping, and
    // a run against a machine with no Redis should meet the real budget rather
    // than fail on the helper.
    const giveUp = (): void => {
      socket.destroy();
      resolve(deleted);
    };
    socket.setTimeout(5_000, giveUp);
    socket.on('error', giveUp);

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      // A SCAN reply is an array of [cursor, [keys…]]; wait for the terminator.
      if (!buffer.endsWith('\r\n')) return;

      const lines = buffer.split('\r\n').filter((line) => line.length > 0);
      buffer = '';

      // Bulk strings arrive as $len then the value; the values are what matter.
      const values = lines.filter((line) => !line.startsWith('*') && !line.startsWith('$'));
      const [next, ...keys] = values;
      cursor = next ?? '0';

      const realKeys = keys.filter((key) => key.startsWith(pattern.replace('*', '')));
      if (realKeys.length > 0) {
        deleted += realKeys.length;
        socket.write(command('DEL', ...realKeys));
      }

      if (cursor === '0') {
        socket.end();
        resolve(deleted);
        return;
      }
      socket.write(command('SCAN', cursor, 'MATCH', pattern, 'COUNT', '500'));
    });
  });
}

/**
 * Give this run its own auth rate-limit budget.
 *
 * §11's limiter counts signups and logins per IP, and the suite does both by
 * the dozen from one address — the shape it exists to refuse. Called once per
 * Playwright project, because two projects in one job share the address and the
 * second would otherwise meet a budget the first had spent.
 *
 * This resets a budget; it does not remove a control. The limiter is tripped
 * and asserted deliberately in the walkthrough's own step.
 */
export async function resetAuthBudget(): Promise<void> {
  await deleteKeys('rl:auth:*');
}
