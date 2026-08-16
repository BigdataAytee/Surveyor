/**
 * PropertiesSheet (Architecture B.15, B.17).
 *
 * What the selected object is, where its values came from, and what can be
 * done to it. The contents differ per selection type because the actions do:
 * a boundary line's bearing is calculated and therefore read-only, while a
 * building's name is the user's to set.
 */

import type {
  FeatureKind,
  FreeTextBox,
  SiteFeature,
  SurveyPoint,
  TitleScaleBlock,
} from '@surveyor/contracts';
import {
  inverse,
  formatBearing,
  STANDARD_SCALES,
  UNIT_ABBREVIATION,
  type DrawingElement,
} from '@surveyor/engine';

import { Button, Card, Field, Segmented, StatusBadge, TextInput } from '../ui/primitives.js';
import { LineFormatToolbar, TextFormatToolbar } from './FormatToolbar.js';
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

  /*
   * Annotations first, because they are not drawing elements.
   *
   * A text box and the title block are selected the same way and appear in the
   * same panel, but the canvas never produced a `DrawingElement` for them —
   * they are not survey data — so `element` is undefined and the id is what
   * identifies them.
   */
  const selected = state.selectedId;
  /*
   * Any part of the heading opens the heading's own panel.
   *
   * The parts are separate objects on the drawing — separately shown, moved
   * and tapped — but they are one thing to *edit*: which lines appear, what
   * the title says, which scale it states. Splitting the panel per part would
   * make "turn the scale bar on" a place you have to already be.
   */
  const block = state.model.titleBlock;
  if (selected && block && (block.id === selected || selected.startsWith(`${block.id}:`))) {
    return <TitleBlockProperties block={block} onClose={onClose} />;
  }
  const textBox = (state.model.textBoxes ?? []).find((box) => box.id === selected);
  if (textBox) return <TextBoxProperties box={textBox} onClose={onClose} />;

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

// ---------------------------------------------------------------------------
// Annotations
// ---------------------------------------------------------------------------

/**
 * A free text box.
 *
 * Its text is edited in place, in the same panel every other object is edited
 * in — which is the point: an annotation is another object on the drawing, not
 * a special case with its own editor.
 */
function TextBoxProperties({
  box,
  onClose,
}: {
  readonly box: FreeTextBox;
  readonly onClose: () => void;
}) {
  const { dispatch } = useProject();

  return (
    <div className="panel">
      <Field label="Text" hint="Drag it anywhere on the drawing. It is not snapped to the survey.">
        <TextInput
          ariaLabel="Text box contents"
          value={box.text}
          placeholder="Fence in poor repair"
          onChange={(text) => dispatch({ type: 'update-text-box', id: box.id, patch: { text } })}
        />
      </Field>

      <TextFormatToolbar id={box.id} style={box.style} />

      <div className="panel__footer panel__footer--stacked">
        <Button
          full
          variant="danger"
          onClick={() => {
            dispatch({ type: 'remove-text-box', id: box.id });
            onClose();
          }}
        >
          Delete this note
        </Button>
        <Button full variant="primary" onClick={onClose}>
          Done
        </Button>
      </div>
    </div>
  );
}

/**
 * The title, representative fraction and scale bar.
 *
 * Each sub-field is edited here, and a field left empty stays computed from
 * the plan. That is the whole "mark it confirmed" rule made concrete: typing a
 * title *is* confirming it, and from then on nothing regenerates it — because
 * the code that fills the block only ever fills what is absent.
 */
function TitleBlockProperties({
  block,
  onClose,
}: {
  readonly block: TitleScaleBlock;
  readonly onClose: () => void;
}) {
  const { state, dispatch } = useProject();
  // Explicit `undefined` clears a field back to being computed from the plan,
  // which the action's own patch type allows and `Partial` does not.
  const patch = (next: { [K in keyof TitleScaleBlock]?: TitleScaleBlock[K] | undefined }) =>
    dispatch({ type: 'update-title-block', patch: next });

  return (
    <div className="panel">
      <Field
        label="Title"
        hint={
          block.title === undefined
            ? `Taken from the plan: “${state.model.metadata.siteAddress ?? 'Untitled plan'}”. Type here to set your own.`
            : 'Yours. Clear it to go back to the plan’s own name.'
        }
      >
        <TextInput
          ariaLabel="Title block title"
          value={block.title ?? ''}
          placeholder={state.model.metadata.siteAddress ?? 'Untitled plan'}
          onChange={(title) => patch(title.length > 0 ? { title } : { title: undefined })}
        />
      </Field>

      <Field label="Subtitle" hint="Optional — a lot number, a purpose, a client">
        <TextInput
          ariaLabel="Title block subtitle"
          value={block.subtitle ?? ''}
          placeholder="Survey for title registration"
          onChange={(subtitle) => patch(subtitle.length > 0 ? { subtitle } : { subtitle: undefined })}
        />
      </Field>

      <Field
        label="Scale"
        hint="Left on Automatic it follows the plan. Choose one and it stays."
        explanation={
          'The bar and the fraction always agree, whichever you pick — the bar ' +
          'is drawn from the same number the fraction states, so measuring the ' +
          'bar on a printed sheet gives the scale it claims.'
        }
      >
        <select
          className="panel__select"
          aria-label="Scale"
          value={block.scaleDenominator ?? ''}
          onChange={(event) =>
            patch(
              event.target.value === ''
                ? { scaleDenominator: undefined }
                : { scaleDenominator: Number(event.target.value) },
            )
          }
        >
          <option value="">Automatic</option>
          {STANDARD_SCALES.map((scale) => (
            <option key={scale} value={scale}>
              1:{scale}
            </option>
          ))}
        </select>
      </Field>

      <Field
        label="Show"
        hint="Each line is its own object on the drawing — tap one to move it."
        explanation={
          'A plan states these as separate underlined lines above the drawing, ' +
          'not inside a box: the title, the scale, the origin and the area are ' +
          'four different claims, and a reader checks them one at a time. ' +
          'Origin and area are on by default because a plan without them cannot ' +
          'be re-established on the ground.'
        }
      >
        <div className="format__row">
          {(
            [
              ['showTitle', 'Title'],
              ['showRepresentativeFraction', 'Scale as 1:N'],
              ['showScaleBar', 'Scale bar'],
              ['showOrigin', 'Origin'],
              ['showArea', 'Area'],
            ] as const
          ).map(([key, label]) => (
            <Button
              key={key}
              size="sm"
              variant={block[key] ? 'primary' : 'secondary'}
              aria-pressed={block[key] ?? false}
              onClick={() => patch({ [key]: !block[key] })}
            >
              {label}
            </Button>
          ))}
        </div>
      </Field>

      {block.offsets && Object.keys(block.offsets).length > 0 ? (
        <Field label="Layout" hint="One or more lines have been moved from where they started.">
          <Button
            size="sm"
            onClick={() => patch({ offsets: undefined })}
          >
            Line them back up
          </Button>
        </Field>
      ) : null}

      <TextFormatToolbar id={block.id} style={block.style} />

      <div className="panel__footer panel__footer--stacked">
        <Button
          full
          variant="danger"
          onClick={() => {
            dispatch({ type: 'remove-title-block' });
            onClose();
          }}
        >
          Remove the title block
        </Button>
        <Button full variant="primary" onClick={onClose}>
          Done
        </Button>
      </div>
    </div>
  );
}
