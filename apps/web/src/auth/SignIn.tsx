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
 *
 * There is no way past this screen, by design. It is only ever shown when the
 * accounts service answered and said nobody is signed in — so signing in is
 * possible, and it is the thing to do. The "work without an account" escape
 * lives on the gate's unreachable screen, where signing in is impossible and
 * refusing to open the app would strand a surveyor with no signal.
 */

import { useEffect, useId, useRef, useState } from 'react';

import { Button, Card } from '../ui/primitives.js';
import {
  confirmEmail,
  createAccount,
  linkFromUrl,
  requestPasswordReset,
  resendVerification,
  resetPassword,
  signIn,
  type Account,
} from './session.js';
import './auth.css';

/** Mirrors the server's rule, so the message arrives before the request does. */
const MIN_PASSWORD_LENGTH = 10;

/**
 * What this screen is doing at the moment.
 *
 * One machine rather than a handful of booleans, because the states are
 * genuinely exclusive and the bug the architecture warns about — being half
 * signed in and half waiting to confirm — is exactly what a set of independent
 * flags produces.
 */
type Screen =
  | { readonly kind: 'form' }
  /** Registered; the next step is in their inbox. */
  | { readonly kind: 'awaiting-verification'; readonly message: string }
  /** Arrived on a reset link and choosing a new password. */
  | { readonly kind: 'reset'; readonly token: string }
  /** Something finished and there is nothing to do but read it. */
  | { readonly kind: 'said'; readonly message: string; readonly tone: 'good' | 'bad' };

export function SignIn({ onSignedIn }: { readonly onSignedIn: (account: Account) => void }) {
  const [mode, setMode] = useState<'in' | 'up'>('in');
  const [screen, setScreen] = useState<Screen>({ kind: 'form' });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [remember, setRemember] = useState(true);
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Set when the server says the address needs confirming, so we can offer it. */
  const [unverified, setUnverified] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const emailId = useId();
  const passwordId = useId();
  const nameId = useId();
  const emailRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    emailRef.current?.focus();
  }, []);

  /**
   * A link somebody arrived on.
   *
   * Read once, on mount, and taken out of the address bar as it is read — a
   * one-time token left in `location.href` ends up in history, in a
   * screenshot, and in the next request's `Referer`.
   */
  useEffect(() => {
    const link = linkFromUrl();
    if (!link) return;

    if (link.kind === 'reset') {
      setScreen({ kind: 'reset', token: link.token });
      return;
    }

    void confirmEmail(link.token).then((result) => {
      setScreen(
        result.ok
          ? { kind: 'said', message: result.message, tone: 'good' }
          : { kind: 'said', message: result.error, tone: 'bad' },
      );
    });
  }, []);

  const tooShort = mode === 'up' && password.length > 0 && password.length < MIN_PASSWORD_LENGTH;

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;

    setError(null);
    setNotice(null);
    setUnverified(false);
    setBusy(true);

    const result =
      mode === 'in'
        ? await signIn(email, password, remember)
        : await createAccount(email, password, name, remember);

    setBusy(false);

    if (!result.ok) {
      setError(result.error);
      setUnverified(result.reason === 'unverified');
      return;
    }

    /*
     * Registered but not signed in.
     *
     * Kept as its own screen rather than dropped into the app, because the
     * account genuinely is not usable yet and showing the drawing would be a
     * lie the next request would contradict.
     */
    if ('awaitingVerification' in result) {
      setScreen({ kind: 'awaiting-verification', message: result.message });
      return;
    }

    onSignedIn(result.account);
  }

  async function resend(): Promise<void> {
    setBusy(true);
    const message = await resendVerification(email);
    setBusy(false);
    setNotice(message);
  }

  async function forgotten(): Promise<void> {
    if (email.trim().length === 0) {
      setError('Enter your email address first, and we will send a reset link to it.');
      return;
    }
    setBusy(true);
    const message = await requestPasswordReset(email);
    setBusy(false);
    setError(null);
    setNotice(message);
  }

  if (screen.kind === 'awaiting-verification') {
    return (
      <Standalone title="Check your email" subtitle={screen.message}>
        {notice ? <p className="auth__note" role="status">{notice}</p> : null}
        <Button full disabled={busy} onClick={() => void resend()}>
          {busy ? 'Working…' : 'Send it again'}
        </Button>
        <Button
          full
          variant="primary"
          onClick={() => {
            setScreen({ kind: 'form' });
            setMode('in');
            setPassword('');
          }}
        >
          Back to sign in
        </Button>
      </Standalone>
    );
  }

  if (screen.kind === 'said') {
    return (
      <Standalone title="Surveyor" subtitle={screen.message} tone={screen.tone}>
        <Button full variant="primary" onClick={() => setScreen({ kind: 'form' })}>
          Sign in
        </Button>
      </Standalone>
    );
  }

  if (screen.kind === 'reset') {
    return (
      <ChooseNewPassword
        token={screen.token}
        onDone={(message) => setScreen({ kind: 'said', message, tone: 'good' })}
      />
    );
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
            {unverified ? (
              /*
               * The one failure with a next step, so it gets a button.
               *
               * A wrong password gets no button, because there is nothing to
               * offer — and a screen that treated the two the same would
               * either be useless here or would tell a guesser, by its own
               * shape, that this address has an account.
               */
              <Button size="sm" disabled={busy} onClick={() => void resend()}>
                Send the confirmation link again
              </Button>
            ) : null}
          </Card>
        ) : null}

        {notice ? (
          <Card tone="sunken">
            <p className="auth__note" role="status">
              {notice}
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

        {mode === 'in' ? (
          <p className="auth__switch">
            <button type="button" className="auth__link" onClick={() => void forgotten()}>
              I have forgotten my password
            </button>
          </p>
        ) : null}

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
              setNotice(null);
              setUnverified(false);
            }}
          >
            {mode === 'in' ? 'Create one' : 'Sign in'}
          </button>
        </p>

      </form>
    </div>
  );
}

/**
 * Choosing a new password, having arrived on a reset link.
 *
 * Its own component because it is its own screen with its own single job, and
 * because it must not inherit the sign-in form's fields — a reset page that
 * quietly carried an email and a password from the previous screen is a reset
 * page that can apply to the wrong account.
 */
function ChooseNewPassword({
  token,
  onDone,
}: {
  readonly token: string;
  readonly onDone: (message: string) => void;
}) {
  const [password, setPassword] = useState('');
  const [current, setCurrent] = useState(token);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reveal, setReveal] = useState(false);
  const fieldId = useId();

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;

    setBusy(true);
    const result = await resetPassword(current, password);
    setBusy(false);

    if (result.ok) {
      onDone(result.message);
      return;
    }
    setError(result.error);
    // The server hands back a fresh link when it was the password it did not
    // like, so a typo costs a retry rather than a trip to the inbox.
    if (result.token) setCurrent(result.token);
  }

  return (
    <div className="auth">
      <form className="auth__card" onSubmit={submit} noValidate>
        <header className="auth__head">
          <h1 className="auth__title">Choose a new password</h1>
          <p className="auth__subtitle">
            Everything signed in to this account will be signed out.
          </p>
        </header>

        {error ? (
          <Card tone="sunken">
            <p className="auth__error" role="alert">
              {error}
            </p>
          </Card>
        ) : null}

        <div className="auth__field">
          <div className="auth__label-row">
            <label htmlFor={fieldId}>New password</label>
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
            id={fieldId}
            className="input"
            type={reveal ? 'text' : 'password'}
            autoComplete="new-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <p className="auth__hint">At least {MIN_PASSWORD_LENGTH} characters.</p>
        </div>

        <Button full variant="primary" disabled={busy} type="submit">
          {busy ? 'Working…' : 'Set my new password'}
        </Button>
      </form>
    </div>
  );
}

/** A card with a message and a way onward, for the states that are just news. */
function Standalone({
  title,
  subtitle,
  tone = 'good',
  children,
}: {
  readonly title: string;
  readonly subtitle: string;
  readonly tone?: 'good' | 'bad';
  readonly children: React.ReactNode;
}) {
  return (
    <div className="auth">
      <div className="auth__card">
        <header className="auth__head">
          <h1 className="auth__title">{title}</h1>
          <p className={tone === 'bad' ? 'auth__error' : 'auth__subtitle'} role="status">
            {subtitle}
          </p>
        </header>
        {children}
      </div>
    </div>
  );
}
