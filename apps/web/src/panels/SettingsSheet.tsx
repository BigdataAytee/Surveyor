/**
 * Settings — the app's own preferences, and what it is holding.
 *
 * Two things live here. The defaults a new project starts from, which were
 * previously hard-coded and reset every reload — the theme in particular was
 * chosen afresh on every visit, which is the sort of thing that reads as the
 * app not paying attention. And the storage, because everything this app has
 * is in one browser and someone is entitled to see how much of it is used and
 * to get rid of it.
 */

import { useState } from 'react';

import { JURISDICTIONS } from '@surveyor/engine';

import { Button, Card, Field, StatusBadge } from '../ui/primitives.js';
import {
  clearAllData,
  formatBytes,
  loadPreferences,
  savePreferences,
  storageUsed,
  type Preferences,
} from '../state/preferences.js';
import { listProjects } from '../state/library.js';
import './panels.css';

export function SettingsSheet({
  onClose,
  onChanged,
}: {
  readonly onClose: () => void;
  /** Lets the workspace pick up a preference the moment it changes. */
  readonly onChanged: (preferences: Preferences) => void;
}) {
  const [preferences, setPreferences] = useState<Preferences>(() => loadPreferences());
  const [confirming, setConfirming] = useState(false);
  const [used, setUsed] = useState(() => storageUsed());
  const projects = listProjects().length;

  /**
   * A patch where a key set to `undefined` clears it.
   *
   * `Partial` alone cannot say that under `exactOptionalPropertyTypes`, and
   * the difference matters here: no jurisdiction preference and a preference
   * for an empty string are not the same thing to a new project.
   */
  function update(patch: {
    [K in keyof Preferences]?: Preferences[K] | undefined;
  }): void {
    // Spreading the patch would *set* a key to undefined rather than remove
    // it, which under `exactOptionalPropertyTypes` is a different type and, at
    // runtime, a stored `"jurisdiction": undefined` that reads back as present.
    const merged: Record<string, unknown> = { ...preferences };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete merged[key];
      else merged[key] = value;
    }

    const next = merged as unknown as Preferences;
    setPreferences(next);
    savePreferences(next);
    onChanged(next);
    setUsed(storageUsed());
  }

  return (
    <div className="panel">
      <p className="panel__section">Appearance</p>
      <Toggle
        label="Dark mode"
        hint="Remembered between visits"
        checked={preferences.theme === 'dark'}
        onChange={(on) => update({ theme: on ? 'dark' : 'light' })}
      />

      <p className="panel__section">Defaults for the drawing</p>
      <Toggle
        label="Object snapping"
        hint="Latch clicks onto corners, midpoints and crossings"
        checked={preferences.snapping}
        onChange={(on) => update({ snapping: on })}
      />
      <Toggle
        label="Grid"
        checked={preferences.showGrid}
        onChange={(on) => update({ showGrid: on })}
      />
      <Toggle
        label="Labels"
        checked={preferences.showLabels}
        onChange={(on) => update({ showLabels: on })}
      />

      <Field
        label="Usual jurisdiction"
        hint="Pre-selected on a new project. Each project can still differ."
      >
        <select
          className="panel__select"
          aria-label="Usual jurisdiction"
          value={preferences.jurisdiction ?? ''}
          onChange={(event) =>
            update(
              event.target.value.length > 0
                ? { jurisdiction: event.target.value }
                : // Cleared rather than set to "", so a new project falls back
                  // to the app's own default instead of an empty rule set.
                  { jurisdiction: undefined },
            )
          }
        >
          <option value="">No preference</option>
          {[...JURISDICTIONS.values()].map((jurisdiction) => (
            <option key={jurisdiction.id} value={jurisdiction.id}>
              {jurisdiction.name}
            </option>
          ))}
        </select>
      </Field>

      <p className="panel__section">Storage on this device</p>
      <Card tone="sunken">
        <div className="panel__toolbar">
          <span className="panel__body">
            {projects} project{projects === 1 ? '' : 's'}, drawings, documents and settings
          </span>
          <StatusBadge tone={used > 4 * 1024 * 1024 ? 'review' : 'neutral'}>
            {formatBytes(used)}
          </StatusBadge>
        </div>
        <p className="panel__body">
          Everything this app holds is in this browser. It does not sync, it is
          not backed up, and clearing site data removes it. Export anything you
          need to keep.
        </p>
      </Card>

      {/*
        Two taps, and the second one names what goes. This is the one control
        in the app that can destroy every survey at once.
      */}
      {confirming ? (
        <Card tone="sunken">
          <p className="panel__body">
            Delete all {projects} project{projects === 1 ? '' : 's'}, their version
            histories, their attached documents and these settings? Nothing here is
            recoverable afterwards.
          </p>
          <div className="tools__row">
            <Button
              full
              variant="danger"
              onClick={() => {
                // Awaited: the queued photographs are in IndexedDB, and
                // reloading over an unfinished clear leaves them behind.
                //
                // Reloaded rather than patched: half the app is holding state
                // read from storage that has just ceased to exist, and
                // starting clean is the honest way back.
                void clearAllData().then(() => window.location.reload());
              }}
            >
              Delete everything
            </Button>
            <Button full onClick={() => setConfirming(false)}>
              Keep it
            </Button>
          </div>
        </Card>
      ) : null}

      <div className="panel__footer panel__footer--stacked">
        <Button full variant="primary" onClick={onClose}>
          Done
        </Button>
        {!confirming ? (
          <Button full variant="danger" onClick={() => setConfirming(true)}>
            Clear all data on this device
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly checked: boolean;
  readonly onChange: (value: boolean) => void;
}) {
  return (
    <label className="toggle">
      <span>
        {label}
        {hint ? <span className="toggle__hint">{hint}</span> : null}
      </span>
      {/*
        Named explicitly. The input is visually hidden behind the drawn track,
        and a hidden checkbox whose only label is a sibling span is one a
        screen reader announces as an unlabelled checkbox.
      */}
      <input
        type="checkbox"
        aria-label={label}
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="toggle__track" aria-hidden="true">
        <span className="toggle__thumb" />
      </span>
    </label>
  );
}
