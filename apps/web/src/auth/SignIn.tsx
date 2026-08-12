/**
 * The sign-in screen.
 *
 * One form that does both jobs, because "sign in" and "create an account" ask
 * for almost the same thing and two screens mostly produce people on the wrong
 * one. The mode is switchable at any point without losing what has been typed.
 *
 * Nothing here decides whether a password is right — it collects, checks what
 * can be checked early to save a round trip, and shows what the server says.
 * The client-side rules are a courtesy, not a control: the same request can be
 * made without ever loading this page, which is why the server repeats every
 * one of them.
 */

import { useEffect, useId, useRef, useState } from 'react';

import { Button, Card } from '../ui/primitives.js';
import { createAccount, signIn, type Account } from './session.js';
import './auth.css';

/** Mirrors the server's rule, so the message arrives before the request does. */
const MIN_PASSWORD_LENGTH = 10;

export function SignIn({
  onSignedIn,
  onContinueOffline,
}: {
  readonly onSignedIn: (account: Account) => void;
  /** Present only when the app is usable without an account. */
  readonly onContinueOffline?: () => void;
}) {
  const [mode, setMode] = useState<'in' | 'up'>('in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [remember, setRemember] = useState(true);
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const emailId = useId();
  const passwordId = useId();
  const nameId = useId();
  const emailRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    emailRef.current?.focus();
  }, []);

  const tooShort = mode === 'up' && password.length > 0 && password.length < MIN_PASSWORD_LENGTH;

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;

    setError(null);
    setBusy(true);

    const result =
      mode === 'in'
        ? await signIn(email, password, remember)
        : await createAccount(email, password, name, remember);

    setBusy(false);

    if (!result.ok) {
      setError(result.error);
      return;
    }
    onSignedIn(result.account);
  }

  return (
    <div className="auth">
      <form className="auth__card" onSubmit={submit} noValidate>
        <header className="auth__head">
          <h1 className="auth__title">Surveyor</h1>
          <p className="auth__subtitle">
            {mode === 'in' ? 'Sign in to your account.' : 'Create an account.'}
          </p>
        </header>

        {error ? (
          // Announced, because someone who submitted with the keyboard is not
          // necessarily looking at the top of the form.
          <Card tone="sunken">
            <p className="auth__error" role="alert">
              {error}
            </p>
          </Card>
        ) : null}

        {mode === 'up' ? (
          <div className="auth__field">
            <label htmlFor={nameId}>Your name</label>
            <input
              id={nameId}
              className="input"
              type="text"
              autoComplete="name"
              value={name}
              placeholder="R. Surveyor"
              onChange={(event) => setName(event.target.value)}
            />
          </div>
        ) : null}

        <div className="auth__field">
          <label htmlFor={emailId}>Email</label>
          <input
            ref={emailRef}
            id={emailId}
            className="input"
            type="email"
            /*
             * `username` rather than `email`, and `current-password` versus
             * `new-password` below: these are what tell a password manager to
             * offer the right entry and to save a new one. Get them wrong and
             * people end up typing passwords by hand, which is how short ones
             * happen.
             */
            autoComplete="username"
            inputMode="email"
            required
            value={email}
            placeholder="you@practice.co.uk"
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>

        <div className="auth__field">
          <div className="auth__label-row">
            <label htmlFor={passwordId}>Password</label>
            <button
              type="button"
              className="auth__reveal"
              aria-pressed={reveal}
              onClick={() => setReveal((on) => !on)}
            >
              {reveal ? 'Hide' : 'Show'}
            </button>
          </div>
          <input
            id={passwordId}
            className="input"
            type={reveal ? 'text' : 'password'}
            autoComplete={mode === 'in' ? 'current-password' : 'new-password'}
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            aria-describedby={mode === 'up' ? `${passwordId}-hint` : undefined}
          />
          {mode === 'up' ? (
            <p id={`${passwordId}-hint`} className={`auth__hint${tooShort ? ' is-short' : ''}`}>
              At least {MIN_PASSWORD_LENGTH} characters. A few words you will remember beats
              a short one you will not.
            </p>
          ) : null}
        </div>

        <label className="auth__remember">
          <input
            type="checkbox"
            checked={remember}
            onChange={(event) => setRemember(event.target.checked)}
          />
          <span>Keep me signed in</span>
        </label>

        <Button full variant="primary" disabled={busy} type="submit">
          {busy ? 'Working…' : mode === 'in' ? 'Sign in' : 'Create account'}
        </Button>

        <p className="auth__switch">
          {mode === 'in' ? 'No account yet?' : 'Already have an account?'}{' '}
          <button
            type="button"
            className="auth__link"
            onClick={() => {
              // What has been typed is kept. Losing a carefully typed
              // password because the wrong tab was open is a small cruelty.
              setMode((current) => (current === 'in' ? 'up' : 'in'));
              setError(null);
            }}
          >
            {mode === 'in' ? 'Create one' : 'Sign in'}
          </button>
        </p>

        {onContinueOffline ? (
          <>
            <hr className="auth__rule" />
            <Button full onClick={onContinueOffline}>
              Work without an account
            </Button>
            <p className="auth__note">
              The drawing tools work with no signal and no account. Your work stays
              on this device until you sign in.
            </p>
          </>
        ) : null}
      </form>
    </div>
  );
}
