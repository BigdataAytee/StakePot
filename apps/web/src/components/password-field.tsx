'use client';

import { useId, useState } from 'react';

/**
 * A password input with a reveal toggle.
 *
 * On a phone, typing ten-plus characters entirely blind on a soft keyboard —
 * with autocorrect and a shifting layout — is a real reason people abandon a
 * signup, and the usual recovery is to give up rather than retype. The toggle
 * is a 44px target and starts hidden, so nothing is exposed until asked for.
 *
 * The label is bound by `htmlFor` rather than by wrapping. Wrapping puts the
 * toggle button inside the label, which makes the input's accessible name
 * "Password Show password At least 10 characters" — every word in the group
 * read out as if it were the field's name. Screen readers get "Password"; the
 * hint is attached separately with `aria-describedby`, which is what it is.
 */
export function PasswordField({
  label,
  value,
  onChange,
  autoComplete,
  minLength,
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: string;
  minLength?: number;
  hint?: string;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const [visible, setVisible] = useState(false);

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-bold">
        {label}
      </label>
      <div className="relative flex">
        <input
          id={id}
          required
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          autoComplete={autoComplete}
          {...(minLength === undefined ? {} : { minLength })}
          {...(hint === undefined ? {} : { 'aria-describedby': hintId })}
          className="w-full rounded-md border border-border bg-surface-raised py-3 pl-3 pr-16 text-md outline-none focus-visible:border-rise"
        />
        <button
          type="button"
          onClick={() => setVisible((shown) => !shown)}
          // Labelled rather than an eye glyph: an icon here is guessed at, and
          // this is the control standing between somebody and their account.
          aria-label={visible ? 'Hide password' : 'Show password'}
          aria-pressed={visible}
          className="absolute right-0 top-0 flex h-full min-w-[3.5rem] items-center justify-center px-3 font-mono text-xs text-text-muted"
        >
          {visible ? 'Hide' : 'Show'}
        </button>
      </div>
      {hint !== undefined && (
        <span id={hintId} className="font-mono text-xs text-text-muted">
          {hint}
        </span>
      )}
    </div>
  );
}
