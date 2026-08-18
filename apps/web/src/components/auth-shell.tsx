import Link from 'next/link';

/**
 * The frame around the signup, login and verification screens.
 *
 * Three things it fixes, all of which only showed up once the screens were
 * looked at on a phone:
 *
 *   * **It says where you are.** Both forms were naked — no wordmark, nothing
 *     naming the product. Someone arriving from a shared link met a password
 *     box belonging to nobody in particular.
 *   * **There is a way out.** No route back to the front door, which on a
 *     phone means the browser's back button or nothing.
 *   * **It sits at the top, not the middle.** Vertical centring wasted the top
 *     third of a phone screen and, worse, moved the whole form when the
 *     keyboard opened — the fields jumping out from under a thumb mid-typing.
 *     Centred only once there is room to spare.
 */
export function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col px-4 pb-12 pt-6 sm:justify-center sm:pt-12">
      <Link
        href="/"
        className="mb-8 inline-flex w-fit items-center gap-2 py-2 text-xl font-black leading-none"
      >
        <span aria-hidden className="text-text-muted">
          ←
        </span>
        StakeAm
      </Link>
      {children}
    </main>
  );
}
