/**
 * Metadata only.
 *
 * The page itself is a client component — it has state, or a form, or both —
 * and a client component cannot export `metadata`. A segment layout can, and it
 * renders nothing of its own, so this is the whole file: a title and a
 * description for a tab, a search result and a pasted link.
 */
export const metadata = {
  title: 'Log in',
  description: 'Log in to StakeAm and pick up where you left off.',
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
