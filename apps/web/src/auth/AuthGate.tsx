/**
 * What the app shows before it knows who you are.
 *
 * The rules, in order:
 *
 *   No endpoint configured  — the app opens straight into the drawing, exactly
 *                             as it always has. Sign-in is a deployment
 *                             choice, and a build without one must not sit
 *                             behind a login that can never succeed.
 *   Checking                — a brief wait, not a sign-in form. Flashing the
 *                             form at someone who is already signed in and
 *                             then replacing it is worse than a moment's wait.
 *   Signed in               — the app.
 *   Signed out              — the sign-in screen, with a way past it, because
 *                             the drawing tools work offline and a surveyor on
 *                             a site with no signal still has a job to do.
 *   Unreachable             — said plainly, with the same way past. Telling
 *                             someone to sign in when the server is down sends
 *                             them round a loop they cannot leave.
 *
 * The account is offered to the rest of the app through context, so nothing
 * has to thread it down by hand.
 */

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

import { Button, Card } from '../ui/primitives.js';
import { SignIn } from './SignIn.js';
import {
  accountsEnabled,
  signOut as endSession,
  whoAmI,
  type Account,
  type AuthState,
} from './session.js';
import './auth.css';

interface AuthContextValue {
  readonly state: AuthState;
  readonly account: Account | null;
  readonly signOut: () => Promise<void>;
  /** Re-ask the server. Used after a password change ends the session. */
  readonly refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth outside AuthGate');
  return value;
}

export function AuthGate({ children }: { readonly children: ReactNode }) {
  const [state, setState] = useState<AuthState>(() =>
    accountsEnabled ? { kind: 'checking' } : { kind: 'disabled' },
  );
  /**
   * Set when someone chooses to work without an account.
   *
   * Not remembered between visits. Skipping sign-in is a decision about right
   * now — no signal, or a borrowed device — and quietly remembering it would
   * mean an account that is never used again after one bad afternoon.
   */
  const [offline, setOffline] = useState(false);

  const refresh = useCallback(async () => {
    if (!accountsEnabled) return;
    setState(await whoAmI());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const signOut = useCallback(async () => {
    await endSession();
    setOffline(false);
    setState({ kind: 'signed-out' });
  }, []);

  const account = state.kind === 'signed-in' ? state.account : null;
  const value: AuthContextValue = { state, account, signOut, refresh };

  if (state.kind === 'checking') {
    return (
      <div className="auth__waiting" role="status">
        <span>Checking your session…</span>
      </div>
    );
  }

  const blocked = (state.kind === 'signed-out' || state.kind === 'unreachable') && !offline;

  if (blocked) {
    return (
      <AuthContext.Provider value={value}>
        {state.kind === 'unreachable' ? (
          <div className="auth">
            <div className="auth__card">
              <header className="auth__head">
                <h1 className="auth__title">Surveyor</h1>
                <p className="auth__subtitle">Accounts are not answering.</p>
              </header>
              <Card tone="sunken">
                <p className="auth__error" role="alert">
                  {state.reason}
                </p>
              </Card>
              <Button full variant="primary" onClick={() => void refresh()}>
                Try again
              </Button>
              <Button full onClick={() => setOffline(true)}>
                Work without an account
              </Button>
              <p className="auth__note">
                The drawing tools do not need the network. Your work stays on this
                device.
              </p>
            </div>
          </div>
        ) : (
          <SignIn
            onSignedIn={(signedIn) => setState({ kind: 'signed-in', account: signedIn })}
            onContinueOffline={() => setOffline(true)}
          />
        )}
      </AuthContext.Provider>
    );
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
