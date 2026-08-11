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
import './panels.css';

export function ProjectSheet({
  onClose,
  onNewProject,
}: {
  readonly onClose: () => void;
  readonly onNewProject: () => void;
}) {
  const { state, dispatch } = useProject();
  const [confirming, setConfirming] = useState(false);

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
          Two taps, because it replaces everything. Undo still reaches back past
          it — said here rather than left for the user to discover.
        */}
        {confirming ? (
          <>
            <p className="panel__body">
              This replaces the current plan. Undo brings it back if you change
              your mind.
            </p>
            <Button
              full
              variant="danger"
              onClick={() => {
                dispatch({ type: 'set-model', model: EMPTY_MODEL });
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
            <Button full variant="danger" onClick={() => setConfirming(true)}>
              Start a new project
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
