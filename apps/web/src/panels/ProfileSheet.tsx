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
import { useProject } from '../state/store.js';
import {
  loadPreferences,
  savePreferences,
  type SurveyorProfile,
} from '../state/preferences.js';
import './panels.css';

export function ProfileSheet({ onClose }: { readonly onClose: () => void }) {
  const { state, dispatch } = useProject();
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

      <Card tone="sunken">
        <p className="panel__body">
          Saved on this device as you type. Nothing here is sent anywhere —
          there is no account and no server behind this app.
        </p>
      </Card>

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
