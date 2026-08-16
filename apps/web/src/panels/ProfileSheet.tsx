/**
 * Profile — who is drawing.
 *
 * There is no account system here and this is not one. What a surveyor
 * actually needs from a "profile" in a drafting tool is the identity that
 * prints in the title block: their name, their firm, and the registration
 * number that makes the plan theirs. That was being typed into every project
 * separately, which means a typo has to be found and fixed once per plan.
 *
 * Held apart from the survey on purpose. These details belong to the person,
 * not the site — folding them into the model would copy someone's contact
 * details into every exported file.
 */

import { useState } from 'react';

import { Button, Card, Field, TextInput } from '../ui/primitives.js';
import { useAuth } from '../auth/AuthGate.js';
import { accountsEnabled, changePassword, isAdmin } from '../auth/session.js';
import { useProject } from '../state/store.js';
import {
  loadPreferences,
  savePreferences,
  type SurveyorProfile,
} from '../state/preferences.js';
import './panels.css';

export function ProfileSheet({ onClose }: { readonly onClose: () => void }) {
  const { state, dispatch } = useProject();
  const auth = useAuth();
  const [profile, setProfile] = useState<SurveyorProfile>(() => loadPreferences().profile);
  const [applied, setApplied] = useState(false);

  function update(patch: Partial<SurveyorProfile>): void {
    const next = { ...profile, ...patch };
    setProfile(next);
    savePreferences({ ...loadPreferences(), profile: next });
    setApplied(false);
  }

  /** What the title block would print, given what has been filled in. */
  const signature = [profile.name, profile.firm].filter(Boolean).join(', ');
  const onThisPlan = state.model.metadata.surveyor;
  const differs = signature.length > 0 && onThisPlan !== signature;

  return (
    <div className="panel">
      <Field label="Your name" hint="Printed in the title block as the surveyor">
        <TextInput
          ariaLabel="Your name"
          value={profile.name ?? ''}
          placeholder="R. Surveyor"
          onChange={(value) => update({ name: value })}
        />
      </Field>

      <Field label="Firm or practice">
        <TextInput
          ariaLabel="Firm or practice"
          value={profile.firm ?? ''}
          placeholder="Surveyor & Co"
          onChange={(value) => update({ firm: value })}
        />
      </Field>

      <Field
        label="Registration number"
        hint="Your licence or registration, as it should appear on the sheet"
        explanation={
          'Many jurisdictions require the plan to carry the registration ' +
          'number of the person responsible for it. It is stored here so it ' +
          'is typed once rather than once per plan, and it is checked by you ' +
          'rather than by this app — we cannot verify a registration.'
        }
      >
        <TextInput
          ariaLabel="Registration number"
          value={profile.registration ?? ''}
          placeholder="MRICS 123456"
          onChange={(value) => update({ registration: value })}
        />
      </Field>

      <Field label="Email">
        <TextInput
          ariaLabel="Email"
          value={profile.email ?? ''}
          placeholder="you@practice.co.uk"
          onChange={(value) => update({ email: value })}
        />
      </Field>

      <Field label="Phone">
        <TextInput
          ariaLabel="Phone"
          value={profile.phone ?? ''}
          placeholder="01234 567890"
          onChange={(value) => update({ phone: value })}
        />
      </Field>

      {/*
        The account and the plan's signature are two different things, and the
        panel says so. Someone can be signed in as one person and be drawing a
        plan a colleague will sign; conflating them would put the wrong name
        on a legal document.
      */}
      {auth.account ? (
        <Card tone="sunken">
          <div className="account">
            <div>
              <p className="account__email">{auth.account.email}</p>
              <p className="panel__body">Signed in on this device</p>
            </div>
            <Button size="sm" onClick={() => void auth.signOut()}>
              Log out
            </Button>
          </div>

          {/*
            The way into the console, for the people it is for.

            A plain link out to a separate page, not a tab in here — the
            console is a different surface with a different audience, and one
            of the two reasons it is separate is that a surveyor should never
            come across it. Hiding it is a courtesy either way: the server
            answers a surveyor's request with a 404 whether or not this link
            was ever drawn.
          */}
          {isAdmin(auth.account) ? (
            <p className="panel__body">
              <a href="/admin/" className="panel__link">
                Open the monitoring console →
              </a>{' '}
              <span className="panel__hint">
                Signed in as {auth.account.role}. Console sessions are shorter than this one.
              </span>
            </p>
          ) : null}
        </Card>
      ) : (
        <Card tone="sunken">
          <p className="panel__body">
            {accountsEnabled
              ? 'You are working without an account. What you type here is saved on this device only.'
              : 'Saved on this device as you type. This build has no accounts service, so nothing here is sent anywhere.'}
          </p>
        </Card>
      )}

      {auth.account ? <PasswordChange /> : null}

      {/*
        Applied on request rather than automatically. The open plan may have
        been drawn by a colleague, and silently restamping someone else's
        drawing with your name is not a convenience.
      */}
      {signature.length > 0 ? (
        <Card tone={differs ? 'suggested' : 'sunken'}>
          <p className="panel__body">
            {differs
              ? `This plan is currently signed “${onThisPlan ?? 'nobody'}”. Put your name on it?`
              : `This plan is signed “${signature}”.`}
          </p>
          {differs ? (
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                dispatch({ type: 'set-metadata', metadata: { surveyor: signature } });
                setApplied(true);
              }}
            >
              Sign this plan
            </Button>
          ) : null}
          {applied ? <p className="panel__body">Signed.</p> : null}
        </Card>
      ) : null}

      <div className="panel__footer">
        <Button full variant="primary" onClick={onClose}>
          Done
        </Button>
      </div>
    </div>
  );
}

/**
 * Changing a password.
 *
 * The current one is required, because a session left open on an unattended
 * machine must not be enough to lock its owner out of their own account.
 * Succeeding ends every session including this one, so the panel says so
 * before it happens rather than appearing to have signed the user out by
 * accident.
 */
function PasswordChange() {
  const auth = useAuth();
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  if (!open) {
    return (
      <Button onClick={() => setOpen(true)}>Change password</Button>
    );
  }

  return (
    <Card tone="sunken">
      <Field label="Current password">
        <input
          className="input"
          type="password"
          autoComplete="current-password"
          aria-label="Current password"
          value={current}
          onChange={(event) => setCurrent(event.target.value)}
        />
      </Field>
      <Field label="New password" hint="At least 10 characters">
        <input
          className="input"
          type="password"
          autoComplete="new-password"
          aria-label="New password"
          value={next}
          onChange={(event) => setNext(event.target.value)}
        />
      </Field>

      {problem ? (
        <p className="panel__body" role="alert">
          {problem}
        </p>
      ) : null}

      <p className="panel__body">
        Changing it signs you out everywhere, including here.
      </p>

      <div className="tools__row">
        <Button
          full
          variant="primary"
          disabled={busy || current.length === 0 || next.length === 0}
          onClick={() => {
            setBusy(true);
            setProblem(null);
            void changePassword(current, next).then((result) => {
              setBusy(false);
              if (!result.ok) {
                setProblem(result.error ?? 'That did not work.');
                return;
              }
              // The server has already ended the session; the app has to catch
              // up or it will keep showing an account that no longer answers.
              void auth.refresh();
            });
          }}
        >
          {busy ? 'Changing…' : 'Change it'}
        </Button>
        <Button full onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}
