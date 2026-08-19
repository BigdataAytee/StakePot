#!/usr/bin/env node
/**
 * An SMTP server that accepts everything and delivers nothing.
 *
 * The API refuses to claim it sent a verification code when no channel took it
 * — which is correct, and which means an environment with no mail transport
 * cannot complete Tier 1. That is true of a real deployment and it is true of
 * the test stack, so the journeys need a transport rather than an exception.
 *
 * This is that transport. Sixty lines of socket instead of a mail container:
 * SMTP's happy path is a handful of numeric replies, and the suite needs a
 * server that accepts a message, not one that stores or forwards it.
 *
 *   node scripts/dev/smtp-sink.mjs &
 *   SMTP_URL=smtp://127.0.0.1:1025 pnpm --filter @stakeam/api start
 *
 * Nothing is written anywhere: the code the test reads still comes out of the
 * notification row the API wrote, and what this adds is the part that was
 * missing — proof that the send itself succeeded.
 *
 * Deliberately does not advertise STARTTLS or AUTH, so a client has nothing to
 * negotiate. Bound to loopback only.
 */
import { createServer } from 'node:net';

const PORT = Number(process.env['SMTP_SINK_PORT'] ?? 1025);
const HOST = '127.0.0.1';

const server = createServer((socket) => {
  let inData = false;
  let buffer = '';

  socket.setEncoding('utf8');
  socket.write('220 stakeam-smtp-sink ready\r\n');

  socket.on('data', (chunk) => {
    buffer += chunk;

    for (;;) {
      const end = buffer.indexOf('\r\n');
      if (end === -1) break;
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);

      if (inData) {
        // A lone dot ends the message. Everything before it is discarded — the
        // point of a sink is that the send succeeded, not what was in it.
        if (line === '.') {
          inData = false;
          socket.write('250 2.0.0 accepted\r\n');
        }
        continue;
      }

      const verb = line.split(' ')[0]?.toUpperCase() ?? '';
      switch (verb) {
        case 'EHLO':
        case 'HELO':
          // No extensions offered on purpose: nothing to negotiate, nothing to
          // fail on a machine with no certificates.
          socket.write('250 stakeam-smtp-sink\r\n');
          break;
        case 'DATA':
          inData = true;
          socket.write('354 go ahead\r\n');
          break;
        case 'QUIT':
          socket.write('221 2.0.0 bye\r\n');
          socket.end();
          break;
        case 'RSET':
        case 'NOOP':
        case 'MAIL':
        case 'RCPT':
          socket.write('250 2.0.0 ok\r\n');
          break;
        default:
          socket.write('502 5.5.2 not implemented\r\n');
      }
    }
  });

  socket.on('error', () => socket.destroy());
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`smtp sink listening on ${HOST}:${PORT}\n`);
});
