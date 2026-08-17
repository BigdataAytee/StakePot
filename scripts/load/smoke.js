// k6 smoke test — `pnpm test:load`.
//
// k6 is a system install, not an npm package:
//   brew install k6      # macOS
//   sudo apt install k6  # Debian/Ubuntu, via the k6 apt repo
//
// Phase 0 only checks that the API answers and stays fast. The real load
// profile — concurrent buys against one market, proving the trade worker
// serialises correctly — arrives with step 14 hardening.

import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = __ENV.API_URL || 'http://localhost:3001';

export const options = {
  vus: 5,
  duration: '30s',
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<250'],
  },
};

export default function () {
  const res = http.get(`${BASE_URL}/health`);
  check(res, {
    'status is 200': (r) => r.status === 200,
    'reports ok': (r) => r.json('status') === 'ok',
  });
  sleep(1);
}
