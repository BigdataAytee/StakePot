/**
 * Which build of the web app is answering.
 *
 * The API says this at its root, and the web app said it nowhere — so when a
 * change to a *page* did not appear, there was no way to tell "the deploy did
 * not take" from "the change does not work", and the only recourse was to
 * redeploy and look again. The shelf chips cost a round of exactly that.
 *
 *   curl https://stakeam-web.onrender.com/version
 *
 * Rendered per request, not baked at build time: this has to describe the
 * running service, and a `NEXT_PUBLIC_*` value would be a photograph of the
 * machine that built it.
 */
export const dynamic = 'force-dynamic';

export function GET(): Response {
  const commit = process.env['RENDER_GIT_COMMIT'] ?? process.env['GIT_COMMIT'] ?? '';
  return Response.json(
    {
      service: 'stakeam-web',
      commit: commit.length === 0 ? 'unknown' : commit.slice(0, 7),
    },
    // Never cached, by anything. A cached answer to "what is running?" is worse
    // than no answer: it is the previous deploy claiming to be this one.
    { headers: { 'cache-control': 'no-store, must-revalidate' } },
  );
}
