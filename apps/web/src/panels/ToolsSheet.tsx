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
  distanceBetween,
  offsetRing,
  polarDisplacement,
  scaleFactorFromReference,
  type RectangularArrayOptions,
} from '@surveyor/engine';

import { Button, Card, Field, Segmented, TextInput } from '../ui/primitives.js';
import { useProject } from '../state/store.js';
import './panels.css';

type Operation = 'move' | 'rotate' | 'scale' | 'mirror' | 'offset' | 'array' | 'chamfer';

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

  /**
   * The one boundary corner that is selected, if that is what is selected.
   *
   * A chamfer splays a single corner between its two legs. Against several
   * things at once there is no corner to mean, and against a loose detail
   * point there are no legs.
   */
  const corner = (() => {
    if (selected.length !== 1) return null;
    const id = selected[0]!;
    const order = pipeline.ok ? pipeline.rings[0]?.segments.map((s) => s.from) ?? [] : [];
    return order.includes(id) ? id : null;
  })();

  /**
   * How long a splay this corner can take: just under its shorter leg.
   *
   * Anything at or beyond that would run past the end of a leg and fold the
   * boundary through itself, which the engine refuses — so the limit is worth
   * showing before someone types past it rather than after.
   */
  function longestSplayAt(pointId: string): number | null {
    const ring = pipeline.ok ? pipeline.rings[0] : undefined;
    if (!ring) return null;

    const order = ring.segments.map((segment) => segment.from);
    const at = order.indexOf(pointId);
    if (at === -1 || order.length < 3) return null;

    const byId = new Map(state.model.points.map((point) => [point.id, point.coordinates]));
    const here = byId.get(pointId);
    const before = byId.get(order[(at - 1 + order.length) % order.length]!);
    const after = byId.get(order[(at + 1) % order.length]!);
    if (!here || !before || !after) return null;

    return Math.min(distanceBetween(here, before), distanceBetween(here, after));
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
          { value: 'array', label: 'Array' },
          { value: 'chamfer', label: 'Chamfer' },
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

      {operation === 'array' ? (
        <ArrayTool
          unit={unit}
          disabled={nothingSelected}
          onApply={(options) => {
            dispatch({ type: 'array-selection', options });
            onClose();
          }}
        />
      ) : null}

      {operation === 'chamfer' ? (
        <ChamferTool
          unit={unit}
          // A chamfer splays one corner, so exactly one has to be picked.
          // Offering it against a multi-selection would raise the question of
          // which corner, and there is no good answer.
          corner={corner}
          longestSplay={corner ? longestSplayAt(corner) : null}
          onApply={(setback) => {
            if (!corner) return setError('Select one boundary corner to chamfer.');

            // Checked here rather than after dispatching: the reducer refuses a
            // setback that would fold the boundary through itself, and asking
            // the store whether it did would read state React has not updated
            // yet. The engine answers the same question directly.
            const limit = longestSplayAt(corner);
            if (limit === null || setback >= limit) {
              setError(
                `A ${setback} ${unit} splay will not fit on this corner. ` +
                  (limit === null
                    ? 'It does not have two boundary legs to splay between.'
                    : `The shorter leg is ${limit.toFixed(2)} ${unit}, so the splay has to be less than that.`),
              );
              return;
            }

            dispatch({ type: 'chamfer-corner', pointId: corner, setback });
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

/**
 * Array — repeat the selection on a grid.
 *
 * A terrace of houses, a run of bays, a line of parking spaces: the drawing
 * task that is most obviously repetitive, and the one it is least reasonable
 * to ask someone to do by copying and nudging.
 *
 * Spacing is centre to centre, which is how a surveyor reads a terrace off a
 * plan, and the bearing turns the whole grid so an array can follow a
 * boundary rather than the grid north.
 */
function ArrayTool({
  unit,
  disabled,
  onApply,
}: {
  readonly unit: string;
  readonly disabled: boolean;
  readonly onApply: (options: RectangularArrayOptions) => void;
}) {
  const [rows, setRows] = useState('1');
  const [columns, setColumns] = useState('3');
  const [rowSpacing, setRowSpacing] = useState('10');
  const [columnSpacing, setColumnSpacing] = useState('10');
  const [bearing, setBearing] = useState('90');

  const numbers = {
    rows: Number(rows),
    columns: Number(columns),
    rowSpacing: Number(rowSpacing),
    columnSpacing: Number(columnSpacing),
    bearingDegrees: Number(bearing),
  };

  const usable =
    Object.values(numbers).every(Number.isFinite) &&
    numbers.rows >= 1 &&
    numbers.columns >= 1 &&
    numbers.rows * numbers.columns > 1;

  const copies = usable ? numbers.rows * numbers.columns - 1 : 0;

  return (
    <>
      <div className="tools__row">
        <Field label="Rows" hint="Across the bearing">
          <TextInput
            numeric
            inputMode="numeric"
            ariaLabel="Number of rows"
            value={rows}
            onChange={setRows}
          />
        </Field>
        <Field label="Columns" hint="Along the bearing">
          <TextInput
            numeric
            inputMode="numeric"
            ariaLabel="Number of columns"
            value={columns}
            onChange={setColumns}
          />
        </Field>
      </div>

      <div className="tools__row">
        <Field label={`Row spacing (${unit})`} hint="Centre to centre">
          <TextInput
            numeric
            inputMode="decimal"
            ariaLabel={`Row spacing in ${unit}`}
            value={rowSpacing}
            onChange={setRowSpacing}
          />
        </Field>
        <Field label={`Column spacing (${unit})`} hint="Centre to centre">
          <TextInput
            numeric
            inputMode="decimal"
            ariaLabel={`Column spacing in ${unit}`}
            value={columnSpacing}
            onChange={setColumnSpacing}
          />
        </Field>
      </div>

      <Field
        label="Bearing"
        hint="Which way the columns run — 90 is due east"
        explanation={
          'The whole grid turns with this, so a terrace can follow a road or a ' +
          'boundary instead of running along grid north.'
        }
      >
        <TextInput
          numeric
          inputMode="decimal"
          ariaLabel="Array bearing in degrees"
          value={bearing}
          onChange={setBearing}
        />
      </Field>

      <div className="panel__footer">
        <Button
          full
          variant="primary"
          disabled={disabled || !usable}
          onClick={() => onApply(numbers)}
        >
          {copies > 0 ? `Make ${copies} cop${copies === 1 ? 'y' : 'ies'}` : 'Set a row or column count'}
        </Button>
      </div>
    </>
  );
}

/**
 * Chamfer — splay a boundary corner off.
 *
 * The corner where two boundaries meet at a road junction is very often cut
 * across rather than left sharp, and that splay is a boundary in its own
 * right: it has a length, it appears in the schedule, and it has to be drawn
 * as geometry rather than implied.
 *
 * The corner point is replaced rather than kept — after a chamfer it is not a
 * corner of anything, and leaving it would put a survey point out in the
 * middle of the splay where the boundary does not run.
 */
function ChamferTool({
  unit,
  corner,
  longestSplay,
  onApply,
}: {
  readonly unit: string;
  readonly corner: string | null;
  readonly longestSplay: number | null;
  readonly onApply: (setback: number) => void;
}) {
  const [setback, setSetback] = useState('2');
  const value = Number(setback);

  if (!corner) {
    return (
      <Card tone="sunken">
        <p className="panel__body">
          Pick one boundary corner on the drawing to splay. A chamfer runs
          between a corner’s two legs, so it needs exactly one corner — not a
          box of several things, and not a detail point off the boundary.
        </p>
      </Card>
    );
  }

  return (
    <>
      <Field
        label={`Splay back (${unit})`}
        hint={
          longestSplay === null
            ? 'Measured along each leg from the corner'
            : `Along each leg from ${corner} — less than ${longestSplay.toFixed(2)} ${unit}`
        }
        explanation={
          'The corner is cut off by this distance along both of its boundary ' +
          'legs, and the two new points are joined. The old corner is removed, ' +
          'because after the splay the boundary no longer goes there.'
        }
      >
        <TextInput
          numeric
          inputMode="decimal"
          ariaLabel={`Chamfer setback in ${unit}`}
          value={setback}
          onChange={setSetback}
        />
      </Field>

      <div className="panel__footer">
        <Button
          full
          variant="primary"
          disabled={!Number.isFinite(value) || value <= 0}
          onClick={() => onApply(value)}
        >
          Splay {corner}
        </Button>
      </div>
    </>
  );
}
