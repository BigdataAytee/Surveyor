/**
 * PropertiesSheet (Architecture B.15, B.17).
 *
 * What the selected object is, where its values came from, and what can be
 * done to it. The contents differ per selection type because the actions do:
 * a boundary line's bearing is calculated and therefore read-only, while a
 * building's name is the user's to set.
 */

import type { FeatureKind, SiteFeature, SurveyPoint } from '@surveyor/contracts';
import { inverse, UNIT_ABBREVIATION, formatBearing, type DrawingElement } from '@surveyor/engine';

import { Button, Card, Field, Segmented, StatusBadge, TextInput } from '../ui/primitives.js';
import { useProject } from '../state/store.js';
import './panels.css';

const FEATURE_KINDS: readonly { readonly value: FeatureKind; readonly label: string }[] = [
  { value: 'building', label: 'Building' },
  { value: 'road', label: 'Road' },
  { value: 'fence', label: 'Fence' },
  { value: 'water', label: 'Water' },
];

const PROVENANCE_LABEL: Record<string, string> = {
  measured: 'Measured on site',
  calculated: 'Calculated from your measurements',
  'user-confirmed': 'Confirmed by you',
  'ai-suggested': 'Suggested — not yet confirmed',
};

export function PropertiesSheet({
  element,
  onClose,
}: {
  readonly element: DrawingElement | undefined;
  readonly onClose: () => void;
}) {
  const { state } = useProject();

  if (!element) {
    return (
      <div className="panel">
        <p className="panel__body">Nothing is selected.</p>
      </div>
    );
  }

  const unit = UNIT_ABBREVIATION[state.model.crs.units];

  switch (element.subject.kind) {
    case 'point':
      return <PointProperties id={element.subject.pointId} unit={unit} onClose={onClose} />;
    case 'segment':
      return (
        <SegmentProperties
          from={element.subject.from}
          to={element.subject.to}
          unit={unit}
        />
      );
    case 'feature':
      return <FeatureProperties id={element.subject.featureId} onClose={onClose} />;
    default:
      return (
        <div className="panel">
          <p className="panel__body">This object has no editable properties.</p>
        </div>
      );
  }
}

// ---------------------------------------------------------------------------
// Point
// ---------------------------------------------------------------------------

function PointProperties({
  id,
  unit,
  onClose,
}: {
  readonly id: string;
  readonly unit: string;
  readonly onClose: () => void;
}) {
  const { state, dispatch } = useProject();
  const point = state.model.points.find((p) => p.id === id);
  if (!point) return null;

  function update(next: SurveyPoint): void {
    dispatch({ type: 'update-point', id, point: next });
  }

  return (
    <div className="panel">
      <Provenance point={point} />

      <Field label="Name">
        <TextInput
          value={point.id}
          ariaLabel="Point name"
          onChange={(value) => value.trim().length > 0 && update({ ...point, id: value.trim() })}
        />
      </Field>

      <Field label={`Easting (${unit})`}>
        <TextInput
          numeric
          inputMode="decimal"
          ariaLabel="Easting"
          value={String(point.coordinates.easting)}
          onChange={(value) =>
            Number.isFinite(Number(value)) &&
            update({
              ...point,
              coordinates: { ...point.coordinates, easting: Number(value) },
            })
          }
        />
      </Field>

      <Field label={`Northing (${unit})`}>
        <TextInput
          numeric
          inputMode="decimal"
          ariaLabel="Northing"
          value={String(point.coordinates.northing)}
          onChange={(value) =>
            Number.isFinite(Number(value)) &&
            update({
              ...point,
              coordinates: { ...point.coordinates, northing: Number(value) },
            })
          }
        />
      </Field>

      <Button
        full
        variant="danger"
        onClick={() => {
          dispatch({ type: 'remove-point', id });
          onClose();
        }}
      >
        Delete {point.id}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Segment
// ---------------------------------------------------------------------------

function SegmentProperties({
  from,
  to,
  unit,
}: {
  readonly from: string;
  readonly to: string;
  readonly unit: string;
}) {
  const { state } = useProject();
  const a = state.model.points.find((p) => p.id === from);
  const b = state.model.points.find((p) => p.id === to);
  if (!a || !b) return null;

  const reading = inverse(a.coordinates, b.coordinates);

  return (
    <div className="panel">
      <Card tone="sunken">
        <h4 className="panel__section">Boundary line</h4>
        <dl className="properties">
          <div>
            <dt>From</dt>
            <dd className="numeric">{from}</dd>
          </div>
          <div>
            <dt>To</dt>
            <dd className="numeric">{to}</dd>
          </div>
          <div>
            <dt>Bearing</dt>
            <dd className="numeric">
              {formatBearing(reading.bearing, state.model.crs.bearingConvention)}
            </dd>
          </div>
          <div>
            <dt>Distance</dt>
            <dd className="numeric">
              {reading.distance.toFixed(2)} {unit}
            </dd>
          </div>
        </dl>
      </Card>

      {/*
        These are outputs of the COGO engine, not inputs. Editing them here
        would mean the drawing and the corner coordinates could disagree, so
        the corners are the thing to change.
      */}
      <p className="panel__body">
        Bearing and distance are calculated from {from} and {to}. To change them,
        move a corner.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Feature
// ---------------------------------------------------------------------------

function FeatureProperties({
  id,
  onClose,
}: {
  readonly id: string;
  readonly onClose: () => void;
}) {
  const { state, dispatch } = useProject();
  const feature = state.model.siteFeatures.find((f) => f.id === id);
  if (!feature) return null;

  function update(next: SiteFeature): void {
    dispatch({ type: 'update-feature', id, feature: next });
  }

  const name = String(feature.attributes.name ?? '');

  return (
    <div className="panel">
      <Card tone="sunken">
        <StatusBadge
          tone={feature.provenance.source === 'ai-suggested' ? 'suggested' : 'neutral'}
        >
          {PROVENANCE_LABEL[feature.provenance.source] ?? feature.provenance.source}
        </StatusBadge>
      </Card>

      <Field label="Name" hint="Shown on the plan">
        <TextInput
          value={name}
          ariaLabel="Feature name"
          onChange={(value) =>
            update({ ...feature, attributes: { ...feature.attributes, name: value } })
          }
        />
      </Field>

      <Field label="Type" hint="Sets the symbol and legend entry">
        <Segmented
          ariaLabel="Feature type"
          value={feature.type}
          onChange={(value) => update({ ...feature, type: value })}
          options={FEATURE_KINDS}
        />
      </Field>

      <Button
        full
        variant="danger"
        onClick={() => {
          dispatch({ type: 'remove-feature', id });
          onClose();
        }}
      >
        Delete {name || 'feature'}
      </Button>
    </div>
  );
}

function Provenance({ point }: { readonly point: SurveyPoint }) {
  const confidence = point.provenance.confidence;
  const uncertain = confidence !== undefined && confidence < 0.85;

  return (
    <Card tone="sunken">
      <StatusBadge tone={uncertain ? 'review' : 'neutral'}>
        {uncertain
          ? `Read from your document — ${Math.round((confidence ?? 0) * 100)}% sure`
          : (PROVENANCE_LABEL[point.provenance.source] ?? point.provenance.source)}
      </StatusBadge>
    </Card>
  );
}
