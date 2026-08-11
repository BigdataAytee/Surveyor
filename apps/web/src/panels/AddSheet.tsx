/**
 * Putting things on the drawing that are not boundary corners.
 *
 * A site plan is more than a parcel outline: it carries the house, the fences
 * and walls, the gates, the trees, the driveway, the services, the spot
 * heights and the benchmark they were measured from. Each of those has a
 * conventional way of being drawn and labelled, and the point of naming the
 * kind — rather than drawing a generic grey line — is that the engine then
 * knows which.
 *
 * Everything created here is placed relative to the boundary the survey
 * already has, at a size the surveyor typed. Nothing is positioned by eye:
 * the numbers are what will be measured off the finished plan.
 */

import { useState } from 'react';

import type { Coordinates, FeatureKind, FeatureStatus, SiteFeature } from '@surveyor/contracts';
import { UNIT_ABBREVIATION, boundsOf, polarDisplacement, translate } from '@surveyor/engine';

import { Button, Card, Field, Segmented, TextInput } from '../ui/primitives.js';
import { useProject } from '../state/store.js';
import './panels.css';

/** What can be added, and how each one is built. */
type Shape = 'area' | 'line' | 'circle' | 'marker';

interface Kind {
  readonly kind: FeatureKind;
  readonly label: string;
  readonly shape: Shape;
  readonly hint: string;
}

const KINDS: readonly Kind[] = [
  { kind: 'building', label: 'Building', shape: 'area', hint: 'A house, garage or outbuilding' },
  { kind: 'driveway', label: 'Driveway', shape: 'area', hint: 'Hard standing and access' },
  { kind: 'fence', label: 'Fence', shape: 'line', hint: 'Drawn broken, as a fence is' },
  { kind: 'wall', label: 'Wall', shape: 'line', hint: 'Drawn solid and heavier than a fence' },
  { kind: 'utility', label: 'Service run', shape: 'line', hint: 'Drains, water, power' },
  { kind: 'gate', label: 'Gate', shape: 'marker', hint: 'An opening in a boundary' },
  { kind: 'tree', label: 'Tree', shape: 'circle', hint: 'Canopy drawn at its real spread' },
  { kind: 'level', label: 'Spot height', shape: 'marker', hint: 'A measured level' },
  { kind: 'benchmark', label: 'Benchmark', shape: 'marker', hint: 'What the levels are measured from' },
  { kind: 'annotation', label: 'Note on the plan', shape: 'marker', hint: 'Free text at a point' },
];

export function AddSheet({ onClose }: { readonly onClose: () => void }) {
  const { state, dispatch, pipeline } = useProject();
  const [selected, setSelected] = useState<FeatureKind>('building');
  const [status, setStatus] = useState<FeatureStatus>('existing');
  const [name, setName] = useState('');
  const [width, setWidth] = useState('6');
  const [depth, setDepth] = useState('4');
  const [radius, setRadius] = useState('3');
  const [level, setLevel] = useState('45.20');
  const [error, setError] = useState<string | null>(null);

  const unit = UNIT_ABBREVIATION[state.model.crs.units];
  const kind = KINDS.find((entry) => entry.kind === selected)!;

  /**
   * Where a new object goes: the middle of the site.
   *
   * Deliberately not "wherever there is room" — the surveyor is going to move
   * it to where it was measured, and a predictable starting place is easier to
   * find than a clever one.
   */
  function centre(): Coordinates | null {
    if (!pipeline.ok || pipeline.rings.length === 0) {
      const points = state.model.points.map((point) => point.coordinates);
      if (points.length === 0) return null;
      const bounds = boundsOf(points);
      return {
        easting: (bounds.min.easting + bounds.max.easting) / 2,
        northing: (bounds.min.northing + bounds.max.northing) / 2,
      };
    }
    const bounds = boundsOf(pipeline.rings[0]!.vertices);
    return {
      easting: (bounds.min.easting + bounds.max.easting) / 2,
      northing: (bounds.min.northing + bounds.max.northing) / 2,
    };
  }

  function build(): SiteFeature | string {
    const at = centre();
    if (!at) return 'There is no survey yet to place this on. Add your boundary points first.';

    const id = `${selected}_${Date.now().toString(36)}`;
    const attributes: Record<string, string | number> = {};
    if (name.trim().length > 0) attributes.name = name.trim();

    const base = {
      id,
      type: selected,
      status,
      attributes,
      // Drawn by the surveyor, so it is theirs — not measured, not suggested.
      provenance: { source: 'user-confirmed' as const },
    };

    switch (kind.shape) {
      case 'area': {
        const w = Number(width);
        const d = Number(depth);
        if (!Number.isFinite(w) || !Number.isFinite(d) || w <= 0 || d <= 0) {
          return 'A building needs a width and a depth, both greater than zero.';
        }
        // Built about the centre so the typed size is the size, whatever the
        // site coordinates happen to be.
        const corners: readonly Coordinates[] = [
          { easting: -w / 2, northing: -d / 2 },
          { easting: w / 2, northing: -d / 2 },
          { easting: w / 2, northing: d / 2 },
          { easting: -w / 2, northing: d / 2 },
        ].map((offset) => ({
          easting: at.easting + offset.easting,
          northing: at.northing + offset.northing,
        }));
        return { ...base, geometry: { kind: 'polygon', vertices: corners } };
      }
      case 'line': {
        const length = Number(width);
        if (!Number.isFinite(length) || length <= 0) {
          return 'A run needs a length greater than zero.';
        }
        const along = polarDisplacement(90, length);
        const start = { easting: at.easting - along.de / 2, northing: at.northing - along.dn / 2 };
        return {
          ...base,
          geometry: { kind: 'polyline', vertices: translate([start], { de: 0, dn: 0 }).concat({
            easting: start.easting + along.de,
            northing: start.northing + along.dn,
          }) },
        };
      }
      case 'circle': {
        const r = Number(radius);
        if (!Number.isFinite(r) || r <= 0) return 'A canopy needs a radius greater than zero.';
        // Kept as centre and radius, so the spread stays a number the drawing
        // knows rather than one you measure off it.
        return { ...base, geometry: { kind: 'circle', centre: at, radius: r } };
      }
      case 'marker': {
        if (selected === 'level' || selected === 'benchmark') {
          const value = Number(level);
          if (!Number.isFinite(value)) return 'A level has to be a number.';
          attributes.elevation = value;
        }
        if (selected === 'annotation' && name.trim().length === 0) {
          return 'A note needs some text.';
        }
        return { ...base, attributes, geometry: { kind: 'point', at } };
      }
    }
  }

  return (
    <div className="panel">
      <Field label="What is it?" hint={kind.hint}>
        <select
          className="panel__select"
          aria-label="Feature kind"
          value={selected}
          onChange={(event) => {
            setSelected(event.target.value as FeatureKind);
            setError(null);
          }}
        >
          {KINDS.map((entry) => (
            <option key={entry.kind} value={entry.kind}>
              {entry.label}
            </option>
          ))}
        </select>
      </Field>

      <Field
        label="Existing or proposed"
        hint="A plan that shows both has to say which is which"
      >
        <Segmented
          ariaLabel="Feature status"
          value={status}
          onChange={setStatus}
          options={[
            { value: 'existing', label: 'Existing' },
            { value: 'proposed', label: 'Proposed' },
          ]}
        />
      </Field>

      <Field
        label={selected === 'annotation' ? 'Text' : 'Name'}
        hint={selected === 'annotation' ? 'Printed on the plan as written' : 'Printed on the plan; leave blank for none'}
      >
        <TextInput
          ariaLabel={selected === 'annotation' ? 'Note text' : 'Feature name'}
          value={name}
          placeholder={selected === 'annotation' ? 'Rights of way to be confirmed' : 'House'}
          onChange={setName}
        />
      </Field>

      {kind.shape === 'area' ? (
        <div className="tools__row">
          <Field label={`Width (${unit})`}>
            <TextInput numeric inputMode="decimal" ariaLabel={`Width in ${unit}`} value={width} onChange={setWidth} />
          </Field>
          <Field label={`Depth (${unit})`}>
            <TextInput numeric inputMode="decimal" ariaLabel={`Depth in ${unit}`} value={depth} onChange={setDepth} />
          </Field>
        </div>
      ) : null}

      {kind.shape === 'line' ? (
        <Field label={`Length (${unit})`} hint="Drawn east–west; rotate it to the bearing you measured">
          <TextInput numeric inputMode="decimal" ariaLabel={`Length in ${unit}`} value={width} onChange={setWidth} />
        </Field>
      ) : null}

      {kind.shape === 'circle' ? (
        <Field label={`Canopy radius (${unit})`} hint="Half the spread, from the trunk">
          <TextInput numeric inputMode="decimal" ariaLabel={`Radius in ${unit}`} value={radius} onChange={setRadius} />
        </Field>
      ) : null}

      {selected === 'level' || selected === 'benchmark' ? (
        <Field
          label={`Level (${unit})`}
          hint="Above the datum the survey is referenced to"
          explanation={
            'A spot height is a measured level at one point. It is printed as ' +
            'a figure beside a cross, and it is read off this value — so ' +
            'correcting it here corrects it on the plan.'
          }
        >
          <TextInput numeric inputMode="decimal" ariaLabel={`Level in ${unit}`} value={level} onChange={setLevel} />
        </Field>
      ) : null}

      {error ? (
        <Card tone="sunken">
          <p className="panel__body">{error}</p>
        </Card>
      ) : null}

      <div className="panel__footer panel__footer--stacked">
        <Button
          full
          variant="primary"
          onClick={() => {
            const built = build();
            if (typeof built === 'string') {
              setError(built);
              return;
            }
            dispatch({ type: 'add-feature', feature: built });
            onClose();
          }}
        >
          Add to the drawing
        </Button>
        <Button full onClick={onClose}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
