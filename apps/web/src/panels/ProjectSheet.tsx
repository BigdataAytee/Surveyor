/**
 * ProjectSheet (Architecture B.14).
 *
 * The plan's identity — what site it is, whose rules it is drawn under — and
 * the one destructive action in the app.
 *
 * "Start a new project" used to live at the foot of the Layers panel, behind a
 * toggle for the grid, which is nobody's idea of where a project lives. It is
 * here now, reached by tapping the site name in the title bar, which is the
 * thing on screen that names the project and so the thing people reach for.
 */

import { useState } from 'react';

import { JURISDICTIONS } from '@surveyor/engine';

import { Button, Card, Field, TextInput } from '../ui/primitives.js';
import { EMPTY_MODEL, useProject } from '../state/store.js';
import { newProjectId } from '../state/library.js';
import './panels.css';

export function ProjectSheet({
  onClose,
  onNewProject,
  onOpenLibrary,
}: {
  readonly onClose: () => void;
  readonly onNewProject: () => void;
  readonly onOpenLibrary: () => void;
}) {
  const { state, dispatch } = useProject();
  const [confirming, setConfirming] = useState(false);
  const [revision, setRevision] = useState('');

  const points = state.model.points.length;
  const features = state.model.siteFeatures.length;

  return (
    <div className="panel">
      <Field
        label="Site name or address"
        hint="Printed in the title block on the exported plan"
      >
        <TextInput
          ariaLabel="Site name or address"
          value={state.model.metadata.siteAddress ?? ''}
          placeholder="25 High Street"
          onChange={(value) =>
            dispatch({
              type: 'set-metadata',
              // Cleared rather than set to an empty string: the title block
              // treats a missing site as missing, and "" is not that.
              metadata: { siteAddress: value.length > 0 ? value : undefined },
            })
          }
        />
      </Field>

      <Field
        label="Drawn under"
        hint="Decides the title block, the required notes and the closure tolerance"
      >
        <select
          className="panel__select"
          aria-label="Jurisdiction"
          value={state.model.metadata.jurisdiction}
          onChange={(event) =>
            dispatch({
              type: 'set-metadata',
              metadata: { jurisdiction: event.target.value },
            })
          }
        >
          {[...JURISDICTIONS.values()].map((jurisdiction) => (
            <option key={jurisdiction.id} value={jurisdiction.id}>
              {jurisdiction.name}
            </option>
          ))}
        </select>
      </Field>

      {/*
        A drawing that has been reissued has to say so and say what changed.
        The newest revision is the current issue and prints on the sheet.
      */}
      <Field
        label="Revisions"
        hint="Printed on the sheet, newest first"
      >
        <ul className="revisions">
          {(state.model.metadata.revisions ?? []).map((revision) => (
            <li key={`${revision.code}-${revision.date}`} className="revisions__item">
              <span className="numeric">{revision.code}</span>
              <span>{revision.description}</span>
              <span className="project__meta numeric">{revision.date.slice(0, 10)}</span>
            </li>
          ))}
          {(state.model.metadata.revisions ?? []).length === 0 ? (
            <li className="panel__body">First issue — no revisions yet.</li>
          ) : null}
        </ul>
      </Field>

      <div className="tools__row">
        <TextInput
          ariaLabel="Revision description"
          value={revision}
          placeholder="Boundary corrected after re-survey"
          onChange={setRevision}
        />
        <Button
          disabled={revision.trim().length === 0}
          onClick={() => {
            const existing = state.model.metadata.revisions ?? [];
            dispatch({
              type: 'set-metadata',
              metadata: {
                revisions: [
                  ...existing,
                  {
                    // A, B, C… which is what a drawing office uses and what a
                    // reviewer expects to read in the corner of the sheet.
                    code: String.fromCharCode(65 + existing.length),
                    date: new Date().toISOString(),
                    description: revision.trim(),
                  },
                ],
              },
            });
            setRevision('');
          }}
        >
          Add revision
        </Button>
      </div>

      <Card tone="sunken">
        <p className="panel__body">
          {points === 0
            ? 'This project has no survey points yet.'
            : `${points} survey point${points === 1 ? '' : 's'}${
                features > 0 ? ` and ${features} feature${features === 1 ? '' : 's'}` : ''
              }.`}
        </p>
      </Card>

      <div className="panel__footer panel__footer--stacked">
        {/*
          Two taps, because starting a new one leaves this one. It is not
          destructive any more — the library keeps it — but a surveyor who
          expects the old behaviour deserves to be told that before it happens.
        */}
        {confirming ? (
          <>
            <p className="panel__body">
              This starts a separate project. “{state.model.metadata.siteAddress ?? 'This plan'}”
              stays saved and you can reopen it from Projects.
            </p>
            <Button
              full
              variant="danger"
              onClick={() => {
                // A *new* project, not this one emptied. Overwriting the open
                // one would destroy it, which is what the library exists to
                // stop happening.
                dispatch({ type: 'open-project', id: newProjectId(), model: EMPTY_MODEL });
                setConfirming(false);
                onNewProject();
              }}
            >
              Yes, start a new project
            </Button>
            <Button full variant="ghost" onClick={() => setConfirming(false)}>
              Keep this one
            </Button>
          </>
        ) : (
          <>
            <Button full variant="primary" onClick={onClose}>
              Done
            </Button>
            <Button full onClick={onOpenLibrary}>
              All projects
            </Button>
            <Button full variant="danger" onClick={() => setConfirming(true)}>
              Start a new project
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
