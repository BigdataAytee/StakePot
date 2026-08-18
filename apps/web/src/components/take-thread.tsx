'use client';

import confetti from 'canvas-confetti';
import { Flag, MessageSquare, Trophy } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';

import { community, type ThreadComment } from '@/lib/community-api';

/**
 * §2.15a's take thread.
 *
 * "Every market has a discussion feed. Each comment displays the commenter's
 * position badge — arguments become accountable; talking your book is visible."
 *
 * The badge is the design. It sits next to the name, in colour, before the
 * words — so a reader knows what somebody stands to gain before they read what
 * they think. A comment from a hedged or closed-out account says "no position",
 * and that is information too.
 */
export function TakeThread({
  marketId,
  outcomes,
  resolved,
  signedIn,
}: {
  marketId: string;
  /** The market's sides, so a badge is coloured like the bar above it. */
  outcomes: { label: string; ordinal: number }[];
  resolved: boolean;
  signedIn: boolean;
}) {
  const t = useTranslations('thread');
  const [comments, setComments] = useState<ThreadComment[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reportingId, setReportingId] = useState<string | null>(null);
  const [reportReason, setReportReason] = useState('');
  const celebrated = useRef(false);

  useEffect(() => {
    void community
      .thread(marketId)
      .then(setComments)
      .catch((caught: Error) => setError(caught.message));
  }, [marketId]);

  // §2.15a's receipt, as a moment rather than a badge you have to notice: if
  // one of *your* calls landed, the thread says so out loud. Once per mount —
  // confetti on every re-render would be a bug people can see.
  useEffect(() => {
    if (!resolved || celebrated.current) return;
    if (!comments.some((comment) => comment.mine && comment.calledIt === true)) return;
    celebrated.current = true;
    void confetti({
      particleCount: 80,
      spread: 70,
      origin: { y: 0.7 },
      colors: ['#0E7A3D', '#E3A81C', '#FAFDF7'],
      disableForReducedMotion: true,
    });
  }, [resolved, comments]);

  async function post(): Promise<void> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await community.post(marketId, text.trim());
      setText('');
      if (result.notice !== null) setNotice(result.notice);
      setComments(await community.thread(marketId));
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function report(commentId: string): Promise<void> {
    try {
      await community.report(commentId, reportReason.trim());
      setReportingId(null);
      setReportReason('');
      setComments(await community.thread(marketId));
    } catch (caught) {
      setError((caught as Error).message);
    }
  }

  return (
    <section className="mt-6">
      <h2 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-text-muted">
        <MessageSquare size={14} /> {t('heading')}
      </h2>

      {signedIn ? (
        <div className="mt-3">
          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            rows={2}
            maxLength={500}
            placeholder={t('placeholder')}
            aria-label={t('placeholder')}
            className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-rise"
          />
          <div className="mt-1.5 flex items-center gap-3">
            <button
              type="button"
              disabled={busy || text.trim().length === 0}
              onClick={() => void post()}
              className="rounded-sm bg-rise px-3 py-1.5 text-sm font-bold text-paper disabled:opacity-40"
            >
              {busy ? t('posting') : t('post')}
            </button>
            <span className="font-mono text-xs text-text-muted">{500 - text.length}</span>
          </div>
        </div>
      ) : (
        <p className="mt-2 text-sm text-text-muted">{t('signedOut')}</p>
      )}

      {error !== null && <p className="mt-2 text-sm text-fall">{error}</p>}
      {notice !== null && (
        <p className="mt-2 rounded-sm border-l-2 border-money bg-money/5 py-2 pl-3 text-sm">
          {notice}
        </p>
      )}

      {comments.length === 0 ? (
        <p className="mt-4 text-sm text-text-muted">{t('empty')}</p>
      ) : (
        <ul className="mt-4 space-y-3">
          {comments.map((comment) => (
            <li key={comment.id} className="border-b border-border pb-3 last:border-0">
              <div className="flex flex-wrap items-center gap-2">
                <Badge
                  badge={comment.badge}
                  outcomes={outcomes}
                  noPositionLabel={t('noPosition')}
                />
                <span className="text-sm font-semibold">
                  {comment.displayName ??
                    (comment.handle === null ? 'Someone' : `@${comment.handle}`)}
                </span>
                {comment.fromTrade && (
                  <span className="font-mono text-[10px] uppercase text-text-muted">
                    {t('fromTrade')}
                  </span>
                )}
                {comment.calledIt === true && (
                  <span className="flex items-center gap-1 rounded-full bg-rise px-2 py-0.5 text-[10px] font-bold text-paper">
                    <Trophy size={10} /> {t('calledIt')}
                  </span>
                )}
                {comment.calledIt === false && (
                  <span className="rounded-full border border-border px-2 py-0.5 text-[10px] text-text-muted">
                    {t('missed')}
                  </span>
                )}
              </div>

              {comment.removed ? (
                <p className="mt-1 text-sm italic text-text-muted">{t('removed')}</p>
              ) : (
                <p className="mt-1 text-sm">{comment.text}</p>
              )}

              {comment.state === 'held' && comment.mine && (
                <p className="mt-1 font-mono text-xs text-money">{t('held')}</p>
              )}
              {comment.state === 'flagged' && (
                <p className="mt-1 font-mono text-xs text-text-muted">{t('flagged')}</p>
              )}

              {signedIn && !comment.mine && !comment.removed && (
                <div className="mt-1.5">
                  {reportingId === comment.id ? (
                    <div className="flex gap-2">
                      <input
                        value={reportReason}
                        onChange={(event) => setReportReason(event.target.value)}
                        placeholder={t('reportReason')}
                        aria-label={t('reportReason')}
                        className="flex-1 rounded-sm border border-border bg-surface px-2 py-1 text-xs"
                      />
                      <button
                        type="button"
                        disabled={reportReason.trim().length < 3}
                        onClick={() => void report(comment.id)}
                        className="rounded-sm border border-border px-2 py-1 text-xs disabled:opacity-30"
                      >
                        {t('report')}
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setReportingId(comment.id)}
                      className="flex items-center gap-1 font-mono text-[10px] text-text-muted"
                    >
                      <Flag size={10} /> {t('report')}
                    </button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * The position badge.
 *
 * Coloured like the argument bar above it — on a binary market the second side
 * is `fall`, the same red the bar and the buy buttons use. A NO badge drawn in
 * green would quietly contradict every other side-coloured thing on the page,
 * and the badge's whole job is to be read at a glance.
 *
 * Always present: "no position" is shown rather than omitted, because the
 * absence of a stake is exactly what a reader wants to know when somebody is
 * talking a market up.
 */
function Badge({
  badge,
  outcomes,
  noPositionLabel,
}: {
  badge: string;
  outcomes: { label: string; ordinal: number }[];
  noPositionLabel: string;
}) {
  if (badge === 'none') {
    return (
      <span className="rounded-sm border border-border px-1.5 py-0.5 font-mono text-[10px] text-text-muted">
        {noPositionLabel}
      </span>
    );
  }

  const [label, pct] = badge.split('@');
  const matched = outcomes.find(
    (outcome) => outcome.label.toUpperCase() === (label ?? '').toUpperCase(),
  );
  // Only a binary market has a semantic losing side; a candidate list has no
  // "no", so every badge there stays neutral rather than inventing a villain.
  const tone =
    outcomes.length === 2 && matched?.ordinal === 1
      ? 'bg-fall/10 text-fall'
      : 'bg-rise/10 text-rise';

  return (
    <span className={`rounded-sm px-1.5 py-0.5 font-mono text-[10px] font-bold ${tone}`}>
      {label}
      {pct !== undefined && <span className="ml-1 text-text-muted">@{pct}%</span>}
    </span>
  );
}
