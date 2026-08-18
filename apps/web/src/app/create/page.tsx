'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useFieldArray, useForm } from 'react-hook-form';
import { z } from 'zod';

import { BalanceMeter } from '@/components/balance-meter';
import { API_URL } from '@/lib/api';
import { TICKET_TEMPLATES, type TicketTemplate } from '@/lib/templates';

/**
 * Community market creation (§2.5, §2.14a).
 *
 * The schema is the same shape the server screens, so a creator finds out
 * they've missed the source or the void date while they're still typing rather
 * than after they've committed a ₦2,000 bond. The server screens again
 * regardless — a client-side check is a courtesy, never a control.
 */
const schema = z.object({
  question: z
    .string()
    .min(15, 'Give the question enough detail that a stranger could settle it.')
    .refine((q) => q.trim().endsWith('?'), 'Write it as a question, ending in a question mark.'),
  outcomes: z
    .array(
      z.object({
        label: z.string().min(1, 'Name the outcome.'),
        criteria: z.string().min(10, 'Say what makes this the result.'),
      }),
    )
    .min(2, 'List at least two outcomes.'),
  otherLabel: z.string().optional(),
  sourceName: z.string().min(1, 'Name the official source that settles this.'),
  sourceUrl: z.string().url('Link the source.').startsWith('https://', 'Use an https link.'),
  eventDate: z.string().min(1, 'When does it happen?'),
  voidDate: z.string().min(1, 'When does it void if nothing settles it?'),
  /** §2.4: the creator chooses the activation path, and it is not reversible. */
  activationPath: z.enum(['organic', 'seeded']),
});

type FormValues = z.infer<typeof schema>;

export default function CreatePage() {
  const [template, setTemplate] = useState<TicketTemplate | null>(null);
  const [submitted, setSubmitted] = useState<{ state: string; reason?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      question: '',
      outcomes: [
        { label: 'YES', criteria: '' },
        { label: 'NO', criteria: '' },
      ],
      sourceName: '',
      sourceUrl: '',
      eventDate: '',
      voidDate: '',
      activationPath: 'organic',
    },
  });

  const outcomes = useFieldArray({ control: form.control, name: 'outcomes' });

  function applyTemplate(picked: TicketTemplate): void {
    setTemplate(picked);
    form.reset({
      question: picked.question,
      outcomes: picked.outcomes,
      ...(picked.otherLabel === undefined ? {} : { otherLabel: picked.otherLabel }),
      sourceName: picked.sourceName,
      sourceUrl: picked.sourceUrl,
      eventDate: '',
      voidDate: '',
      activationPath: form.getValues('activationPath'),
    });
  }

  async function onSubmit(values: FormValues): Promise<void> {
    setError(null);
    const token = window.localStorage.getItem('stakeam.token');
    if (token === null) {
      setError('Sign in to open a market.');
      return;
    }

    try {
      const response = await fetch(`${API_URL}/community/markets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(values),
      });
      const body = (await response.json()) as { state?: string; reason?: string; message?: string };
      if (!response.ok) throw new Error(body.message ?? `Submission failed (${response.status})`);
      setSubmitted({
        state: body.state ?? 'suggested',
        ...(body.reason ? { reason: body.reason } : {}),
      });
    } catch (caught) {
      setError((caught as Error).message);
    }
  }

  if (submitted !== null) {
    return (
      <main className="mx-auto max-w-2xl px-4 py-10">
        <h1 className="text-xl font-black">
          {submitted.state === 'rejected' ? 'Not this one' : 'Sent for review'}
        </h1>
        <p className="mt-3 text-md text-text-muted">
          {submitted.reason ??
            'A reviewer checks every new market before it opens. You keep your bond either way unless you settle dishonestly.'}
        </p>
        <a
          href="/"
          className="mt-6 inline-block font-semibold text-rise underline underline-offset-2"
        >
          Back to markets
        </a>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-2xl px-4 py-8">
      <header className="mb-6">
        <h1 className="text-xl font-black leading-tight">Talk your own</h1>
        <p className="mt-2 text-md text-text-muted">
          Open a market for your people to call. You put up a bond, you settle it against one named
          source, and you earn a cut of the losing pool.
        </p>
      </header>

      <section className="mb-8">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-text-muted">
          Start from a template
        </h2>
        <div className="mt-3 grid grid-cols-2 gap-2">
          {TICKET_TEMPLATES.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => applyTemplate(option)}
              aria-pressed={template?.id === option.id}
              className={`rounded-md border px-3 py-2.5 text-left text-sm transition-colors ${
                template?.id === option.id
                  ? 'border-rise bg-rise/10'
                  : 'border-border hover:border-rise'
              }`}
            >
              <span className="block font-semibold">{option.name}</span>
              <span className="block font-mono text-xs text-text-muted">{option.category}</span>
            </button>
          ))}
        </div>
      </section>

      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
        <Field label="The question" error={form.formState.errors.question?.message}>
          <textarea
            {...form.register('question')}
            rows={2}
            placeholder="Will the Super Eagles beat Ivory Coast on Saturday?"
            className="w-full rounded-md border border-border bg-surface px-3 py-2.5 outline-none focus:border-rise"
          />
        </Field>

        <BalanceMeter estimate={null} low={0.35} high={0.65} />

        <section>
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">Outcomes</h2>
            <button
              type="button"
              onClick={() => outcomes.append({ label: '', criteria: '' })}
              className="flex items-center gap-1 text-sm text-rise"
            >
              <Plus size={14} /> Add outcome
            </button>
          </div>
          <p className="mt-1 text-sm text-text-muted">
            List every way this can end. If the field is open, add an &ldquo;Any other&rdquo;
            bucket.
          </p>

          <div className="mt-3 space-y-3">
            {outcomes.fields.map((field, index) => (
              <div key={field.id} className="rounded-md border border-border p-3">
                <div className="flex items-center gap-2">
                  <input
                    {...form.register(`outcomes.${index}.label`)}
                    placeholder="YES"
                    className="w-32 rounded-sm border border-border bg-surface px-2 py-1.5 font-semibold outline-none focus:border-rise"
                  />
                  {outcomes.fields.length > 2 && (
                    <button
                      type="button"
                      onClick={() => outcomes.remove(index)}
                      aria-label={`Remove outcome ${index + 1}`}
                      className="ml-auto text-text-muted hover:text-fall"
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
                <input
                  {...form.register(`outcomes.${index}.criteria`)}
                  placeholder="What exactly makes this the result?"
                  className="mt-2 w-full rounded-sm border border-border bg-surface px-2 py-1.5 text-sm outline-none focus:border-rise"
                />
                <p className="mt-1 text-sm text-fall">
                  {form.formState.errors.outcomes?.[index]?.criteria?.message}
                </p>
              </div>
            ))}
          </div>
        </section>

        <Field label="Official source" error={form.formState.errors.sourceName?.message}>
          <input
            {...form.register('sourceName')}
            placeholder="CBN official rate"
            className="w-full rounded-md border border-border bg-surface px-3 py-2.5 outline-none focus:border-rise"
          />
        </Field>

        <Field label="Source link" error={form.formState.errors.sourceUrl?.message}>
          <input
            {...form.register('sourceUrl')}
            placeholder="https://www.cbn.gov.ng/rates/"
            className="w-full rounded-md border border-border bg-surface px-3 py-2.5 font-mono text-sm outline-none focus:border-rise"
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Event date" error={form.formState.errors.eventDate?.message}>
            <input
              type="datetime-local"
              {...form.register('eventDate')}
              className="w-full rounded-md border border-border bg-surface px-3 py-2.5 font-mono text-sm outline-none focus:border-rise"
            />
          </Field>
          <Field label="Voids after" error={form.formState.errors.voidDate?.message}>
            <input
              type="datetime-local"
              {...form.register('voidDate')}
              className="w-full rounded-md border border-border bg-surface px-3 py-2.5 font-mono text-sm outline-none focus:border-rise"
            />
          </Field>
        </div>

        <ActivationPathChooser
          value={form.watch('activationPath')}
          onChange={(path) => form.setValue('activationPath', path)}
        />

        {error !== null && <p className="text-sm text-fall">{error}</p>}

        <button
          type="submit"
          disabled={form.formState.isSubmitting}
          className="w-full rounded-md bg-rise py-3.5 font-bold text-paper transition-transform active:scale-press disabled:opacity-40"
        >
          {form.formState.isSubmitting ? 'Sending…' : 'Send for review'}
        </button>

        <p className="text-sm text-text-muted">
          A reviewer checks every new market. Your ₦2,000 bond is held while it runs and comes back
          when you settle it — or if it never gets off the ground.
        </p>
      </form>
    </main>
  );
}

/**
 * The two ways a market can open (§2.4, Rulebook Part 3 §2).
 *
 * Presented as a real trade-off rather than a default and an advanced option:
 * Path A costs nothing but has to fill on its own; Path B opens now because the
 * creator (or a syndicate) put money on every outcome at once. The one thing a
 * creator must not misread is that seeding is not betting — the seed is
 * symmetric, so it cannot pay off for the person who also settles the market.
 */
function ActivationPathChooser({
  value,
  onChange,
}: {
  value: 'organic' | 'seeded';
  onChange: (path: 'organic' | 'seeded') => void;
}) {
  const options = [
    {
      id: 'organic' as const,
      title: 'Let it fill',
      blurb: 'Free. Opens for staking, and goes live if enough people back both sides in time.',
    },
    {
      id: 'seeded' as const,
      title: 'Seed it open',
      blurb:
        'You (or sponsors you invite) put equal money on every outcome, and it goes live at once.',
    },
  ];

  return (
    <section>
      <h2 className="text-sm font-semibold">How should it open?</h2>
      <div className="mt-2 grid grid-cols-2 gap-2">
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            onClick={() => onChange(option.id)}
            aria-pressed={value === option.id}
            className={`rounded-md border px-3 py-2.5 text-left transition-colors ${
              value === option.id ? 'border-rise bg-rise/10' : 'border-border hover:border-rise'
            }`}
          >
            <span className="block text-sm font-semibold">{option.title}</span>
            <span className="mt-1 block text-sm text-text-muted">{option.blurb}</span>
          </button>
        ))}
      </div>
      {value === 'seeded' && (
        <p className="mt-2 text-sm text-text-muted">
          The seed is split equally across every outcome, so you never hold a side in a market you
          settle. It still needs real backers by the deadline — otherwise the market voids and your
          seed comes back in full.
        </p>
      )}
    </section>
  );
}

function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string | undefined;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-sm font-semibold">{label}</span>
      <div className="mt-1.5">{children}</div>
      {error !== undefined && <p className="mt-1 text-sm text-fall">{error}</p>}
    </label>
  );
}
