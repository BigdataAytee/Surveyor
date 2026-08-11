/**
 * The CAD editing tools (Architecture B.3, extended).
 *
 * Every operation here takes a typed value rather than a drag. That is the
 * point of it: dragging is for placing things roughly, and a survey plan is
 * not a rough document. A surveyor moving a building 3 m north means 3.000 m,
 * and the only way to get that from a pointer is to type it.
 *
 * The panel computes nothing. Each button gathers what the surveyor typed,
 * hands it to `@surveyor/engine` through a store action, and the engine
 * produces the coordinates — the same division that stops the canvas from
 * being able to make a drawing that looks right and computes wrong.
 */

import { useState } from 'react';

import type { Coordinates } from '@surveyor/contracts';
import {
  UNIT_ABBREVIATION,
  boundsOf,
  offsetRing,
  polarDisplacement,
  scaleFactorFromReference,
} from '@surveyor/engine';

import { Button, Card, Field, Segmented, TextInput } from '../ui/primitives.js';
import { useProject } from '../state/store.js';
import './panels.css';

type Operation = 'move' | 'rotate' | 'scale' | 'mirror' | 'offset';

export function ToolsSheet({ onClose }: { readonly onClose: () => void }) {
  const { state, dispatch, pipeline } = useProject();
  const [operation, setOperation] = useState<Operation>('move');
  const [error, setError] = useState<string | null>(null);

  const unit = UNIT_ABBREVIATION[state.model.crs.units];
  const selected = state.selectedIds;

  /** The centre of what is selected — the natural base point for a transform. */
  function basePoint(): Coordinates | null {
    const vertices = selectedVertices();
    if (vertices.length === 0) return null;
    const bounds = boundsOf(vertices);
    return {
      easting: (bounds.min.easting + bounds.max.easting) / 2,
      northing: (bounds.min.northing + bounds.max.northing) / 2,
    };
  }

  function selectedVertices(): readonly Coordinates[] {
    const wanted = new Set(selected);
    const vertices: Coordinates[] = [];

    for (const ring of state.model.boundary) {
      if (!wanted.has(ring.id)) continue;
      for (const segment of ring.segments) wanted.add(segment.from);
    }
    for (const point of state.model.points) {
      if (wanted.has(point.id)) vertices.push(point.coordinates);
    }
    for (const feature of state.model.siteFeatures) {
      if (!wanted.has(feature.id)) continue;
      // A circle contributes its extremes rather than its centre, so a
      // transform about the selection's middle accounts for its whole spread.
      const geometry = feature.geometry;
      if (geometry.kind === 'point') vertices.push(geometry.at);
      else if (geometry.kind === 'circle' || geometry.kind === 'arc') {
        vertices.push(
          { easting: geometry.centre.easting - geometry.radius, northing: geometry.centre.northing - geometry.radius },
          { easting: geometry.centre.easting + geometry.radius, northing: geometry.centre.northing + geometry.radius },
        );
      } else vertices.push(...geometry.vertices);
    }
    return vertices;
  }

  const nothingSelected = selected.length === 0;

  return (
    <div className="panel">
      <Card tone="sunken" className="panel__meta">
        <p className="panel__body">
          {nothingSelected
            ? 'Nothing is selected. Tap something on the drawing, or drag a box around several things, then come back.'
            : `${selected.length} object${selected.length === 1 ? '' : 's'} selected: ${selected.join(', ')}`}
        </p>
      </Card>

      <Segmented
        ariaLabel="Editing operation"
        value={operation}
        onChange={(next) => {
          setOperation(next);
          setError(null);
        }}
        options={[
          { value: 'move', label: 'Move' },
          { value: 'rotate', label: 'Rotate' },
          { value: 'scale', label: 'Scale' },
          { value: 'mirror', label: 'Mirror' },
          { value: 'offset', label: 'Offset' },
        ]}
      />

      {error ? (
        <Card tone="sunken">
          <p className="panel__body">{error}</p>
        </Card>
      ) : null}

      {operation === 'move' ? (
        <MoveTool
          unit={unit}
          disabled={nothingSelected}
          onApply={(bearing, distance, copy) => {
            const by = polarDisplacement(bearing, distance);
            dispatch(copy ? { type: 'duplicate-selection', by } : { type: 'transform', transform: { kind: 'move', by } });
            onClose();
          }}
        />
      ) : null}

      {operation === 'rotate' ? (
        <RotateTool
          disabled={nothingSelected}
          onApply={(degrees) => {
            const about = basePoint();
            if (!about) return setError('I could not work out a centre to rotate about.');
            dispatch({ type: 'transform', transform: { kind: 'rotate', about, degrees } });
            onClose();
          }}
        />
      ) : null}

      {operation === 'scale' ? (
        <ScaleTool
          unit={unit}
          disabled={nothingSelected}
          onApply={(factor) => {
            const about = basePoint();
            if (!about) return setError('I could not work out a centre to scale about.');
            dispatch({ type: 'transform', transform: { kind: 'scale', about, factor } });
            onClose();
          }}
          onError={setError}
        />
      ) : null}

      {operation === 'mirror' ? (
        <MirrorTool
          disabled={nothingSelected}
          onApply={(axis) => {
            const about = basePoint();
            if (!about) return setError('I could not work out a line to mirror across.');
            // A mirror needs a line; the two axes people actually want are the
            // ones through the middle of the selection.
            const a = about;
            const b =
              axis === 'north'
                ? { easting: about.easting, northing: about.northing + 100 }
                : { easting: about.easting + 100, northing: about.northing };
            dispatch({ type: 'transform', transform: { kind: 'mirror', a, b } });
            onClose();
          }}
        />
      ) : null}

      {operation === 'offset' ? (
        <OffsetTool
          unit={unit}
          disabled={!pipeline.ok || pipeline.rings.length === 0}
          onApply={(distance) => {
            if (!pipeline.ok) return setError('There is no boundary to offset yet.');
            const ring = pipeline.rings[0];
            if (!ring) return setError('There is no boundary to offset yet.');

            const offset = offsetRing(ring.vertices, distance);
            if (!offset) {
              // Refused rather than approximated: an offset that collapsed the
              // shape would produce a setback line nobody could measure to.
              return setError(
                `A ${Math.abs(distance)} ${unit} offset does not fit inside this boundary — it would collapse the shape.`,
              );
            }

            dispatch({
              type: 'add-feature',
              feature: {
                id: `offset_${Date.now().toString(36)}`,
                type: 'easement',
                geometry: { kind: 'polygon', vertices: offset },
                attributes: {
                  name: `${distance > 0 ? 'Outside' : 'Setback'} ${Math.abs(distance)} ${unit}`,
                },
                // Derived from the boundary by the engine, not measured and
                // not drawn by hand — so it says calculated.
                provenance: { source: 'calculated' },
              },
            });
            onClose();
          }}
        />
      ) : null}

      <div className="panel__footer panel__footer--stacked">
        <Button
          full
          variant="danger"
          disabled={nothingSelected}
          onClick={() => {
            dispatch({ type: 'delete-selection' });
            onClose();
          }}
        >
          Delete selection
        </Button>
        <Button full onClick={onClose}>
          Done
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

function MoveTool({
  unit,
  disabled,
  onApply,
}: {
  readonly unit: string;
  readonly disabled: boolean;
  readonly onApply: (bearing: number, distance: number, copy: boolean) => void;
}) {
  const [bearing, setBearing] = useState('0');
  const [distance, setDistance] = useState('1');

  const values = { bearing: Number(bearing), distance: Number(distance) };
  const valid = Number.isFinite(values.bearing) && Number.isFinite(values.distance);

  return (
    <>
      <Field label="Bearing" hint="Degrees clockwise from north — 90 is due east">
        <TextInput
          numeric
          inputMode="decimal"
          ariaLabel="Move bearing in degrees"
          value={bearing}
          onChange={setBearing}
        />
      </Field>
      <Field label={`Distance (${unit})`} hint="Exactly this far — not as far as you drag">
        <TextInput
          numeric
          inputMode="decimal"
          ariaLabel={`Move distance in ${unit}`}
          value={distance}
          onChange={setDistance}
        />
      </Field>
      <div className="tools__row">
        <Button
          full
          variant="primary"
          disabled={disabled || !valid}
          onClick={() => onApply(values.bearing, values.distance, false)}
        >
          Move
        </Button>
        <Button
          full
          disabled={disabled || !valid}
          onClick={() => onApply(values.bearing, values.distance, true)}
        >
          Copy
        </Button>
      </div>
    </>
  );
}

function RotateTool({
  disabled,
  onApply,
}: {
  readonly disabled: boolean;
  readonly onApply: (degrees: number) => void;
}) {
  const [degrees, setDegrees] = useState('90');
  const value = Number(degrees);

  return (
    <>
      <Field
        label="Angle"
        hint="Degrees clockwise, about the centre of what is selected"
      >
        <TextInput
          numeric
          inputMode="decimal"
          ariaLabel="Rotation angle in degrees"
          value={degrees}
          onChange={setDegrees}
        />
      </Field>
      <Button
        full
        variant="primary"
        disabled={disabled || !Number.isFinite(value)}
        onClick={() => onApply(value)}
      >
        Rotate
      </Button>
    </>
  );
}

function ScaleTool({
  unit,
  disabled,
  onApply,
  onError,
}: {
  readonly unit: string;
  readonly disabled: boolean;
  readonly onApply: (factor: number) => void;
  readonly onError: (message: string) => void;
}) {
  const [mode, setMode] = useState<'factor' | 'reference'>('factor');
  const [factor, setFactor] = useState('1.5');
  const [reference, setReference] = useState('10');
  const [target, setTarget] = useState('15');

  return (
    <>
      <Segmented
        ariaLabel="How to scale"
        value={mode}
        onChange={setMode}
        options={[
          { value: 'factor', label: 'By factor' },
          { value: 'reference', label: 'By reference' },
        ]}
      />

      {mode === 'factor' ? (
        <Field label="Factor" hint="2 doubles it; 0.5 halves it">
          <TextInput
            numeric
            inputMode="decimal"
            ariaLabel="Scale factor"
            value={factor}
            onChange={setFactor}
          />
        </Field>
      ) : (
        <>
          {/* Name a length that should become another length, and the factor
              follows — the same way AutoCAD's Scale ... Reference works. */}
          <Field label={`This length (${unit})`} hint="A distance you can see now">
            <TextInput
              numeric
              inputMode="decimal"
              ariaLabel={`Reference length in ${unit}`}
              value={reference}
              onChange={setReference}
            />
          </Field>
          <Field label={`Should become (${unit})`}>
            <TextInput
              numeric
              inputMode="decimal"
              ariaLabel={`Target length in ${unit}`}
              value={target}
              onChange={setTarget}
            />
          </Field>
        </>
      )}

      <Button
        full
        variant="primary"
        disabled={disabled}
        onClick={() => {
          if (mode === 'factor') {
            const value = Number(factor);
            if (!Number.isFinite(value) || value === 0) {
              onError('A scale factor has to be a number, and cannot be zero.');
              return;
            }
            onApply(value);
            return;
          }
          const derived = scaleFactorFromReference(Number(reference), Number(target));
          if (derived === null) {
            onError('Those two lengths do not give a scale factor.');
            return;
          }
          onApply(derived);
        }}
      >
        Scale
      </Button>
    </>
  );
}

function MirrorTool({
  disabled,
  onApply,
}: {
  readonly disabled: boolean;
  readonly onApply: (axis: 'north' | 'east') => void;
}) {
  const [axis, setAxis] = useState<'north' | 'east'>('north');

  return (
    <>
      <Field label="Mirror across" hint="A line through the centre of the selection">
        <Segmented
          ariaLabel="Mirror axis"
          value={axis}
          onChange={setAxis}
          options={[
            { value: 'north', label: 'North–south' },
            { value: 'east', label: 'East–west' },
          ]}
        />
      </Field>
      <Button full variant="primary" disabled={disabled} onClick={() => onApply(axis)}>
        Mirror
      </Button>
    </>
  );
}

function OffsetTool({
  unit,
  disabled,
  onApply,
}: {
  readonly unit: string;
  readonly disabled: boolean;
  readonly onApply: (distance: number) => void;
}) {
  const [distance, setDistance] = useState('3');
  const value = Number(distance);

  return (
    <>
      <Field
        label={`Setback (${unit})`}
        hint="Inside the boundary. The line is exactly this far from it everywhere."
        explanation={
          'A setback line is drawn parallel to the boundary at a fixed ' +
          'distance, with the corners mitred so you can measure the same ' +
          'distance perpendicular from anywhere along it. It is calculated ' +
          'from your boundary, so it moves when the boundary does.'
        }
      >
        <TextInput
          numeric
          inputMode="decimal"
          ariaLabel={`Setback distance in ${unit}`}
          value={distance}
          onChange={setDistance}
        />
      </Field>
      <div className="tools__row">
        <Button
          full
          variant="primary"
          disabled={disabled || !Number.isFinite(value) || value === 0}
          onClick={() => onApply(-Math.abs(value))}
        >
          Inside
        </Button>
        <Button
          full
          disabled={disabled || !Number.isFinite(value) || value === 0}
          onClick={() => onApply(Math.abs(value))}
        >
          Outside
        </Button>
      </div>
    </>
  );
}
