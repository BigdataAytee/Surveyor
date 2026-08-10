/**
 * DataSheet and PointEditor (Architecture B.10).
 *
 * Coordinate entry as a clean mobile-native list rather than a spreadsheet,
 * becoming a real table above the tablet breakpoint. Every technical concept
 * carries plain-language guidance from the Knowledge Base.
 */

import { useState } from 'react';

import type { SurveyPoint } from '@surveyor/contracts';
import { parsePointTable, ringFromPointOrder, UNIT_ABBREVIATION } from '@surveyor/engine';

import {
  Button,
  Card,
  EmptyState,
  Field,
  Segmented,
  StatusBadge,
  TextInput,
} from '../ui/primitives.js';
import { FadeIn } from '../ui/motion.js';
import { useProject } from '../state/store.js';
import { EXPLANATIONS } from '../ai/assistant.js';
import './panels.css';

type Mode = 'list' | 'paste';

export function DataSheet({ onClose }: { readonly onClose: () => void }) {
  const { state, dispatch } = useProject();
  const [mode, setMode] = useState<Mode>('list');
  const unit = UNIT_ABBREVIATION[state.model.crs.units];

  return (
    <div className="panel">
      <Card tone="sunken" className="panel__meta">
        <Field
          label="Coordinate system"
          hint="How your survey positions are referenced"
          explanation={EXPLANATIONS.crs}
        >
          <p className="panel__value">{state.model.crs.name}</p>
        </Field>
      </Card>

      <div className="panel__toolbar">
        <Segmented
          ariaLabel="Data entry mode"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'list', label: 'Points' },
            { value: 'paste', label: 'Paste table' },
          ]}
        />
        <span className="panel__count numeric">
          {state.model.points.length} point{state.model.points.length === 1 ? '' : 's'}
        </span>
      </div>

      {mode === 'paste' ? (
        <PasteImporter onDone={() => setMode('list')} />
      ) : state.model.points.length === 0 ? (
        <EmptyState
          title="No survey points yet"
          description="Add your corners one at a time, or paste a table straight from your data collector."
          actions={
            <>
              <Button variant="primary" onClick={() => dispatch(addBlankPoint(state.model.points))}>
                Add point
              </Button>
              <Button onClick={() => setMode('paste')}>Paste table</Button>
            </>
          }
        />
      ) : (
        <>
          <ul className="points">
            {state.model.points.map((point) => (
              <PointEditor key={point.id} point={point} unit={unit} />
            ))}
          </ul>
          <Button
            full
            icon="+"
            onClick={() => dispatch(addBlankPoint(state.model.points))}
          >
            Add point
          </Button>
        </>
      )}

      <div className="panel__footer">
        <Button full variant="primary" onClick={onClose}>
          Done
        </Button>
      </div>
    </div>
  );
}

function addBlankPoint(existing: readonly SurveyPoint[]) {
  const last = existing[existing.length - 1];
  const nextNumber = existing.length + 1;
  return {
    type: 'add-point' as const,
    point: {
      id: `PT${nextNumber}`,
      // A new point starts beside the previous one rather than at the origin,
      // which would throw the drawing off-screen.
      coordinates: last
        ? { easting: last.coordinates.easting + 10, northing: last.coordinates.northing }
        : { easting: 0, northing: 0 },
      provenance: { source: 'user-confirmed' as const },
    },
  };
}

// ---------------------------------------------------------------------------
// Point editor
// ---------------------------------------------------------------------------

function PointEditor({
  point,
  unit,
}: {
  readonly point: SurveyPoint;
  readonly unit: string;
}) {
  const { dispatch } = useProject();
  const needsConfirming =
    point.provenance.confidence !== undefined && point.provenance.confidence < 0.85;

  function update(field: 'easting' | 'northing', raw: string): void {
    const value = Number(raw);
    if (!Number.isFinite(value)) return;
    dispatch({
      type: 'update-point',
      id: point.id,
      point: { ...point, coordinates: { ...point.coordinates, [field]: value } },
    });
  }

  return (
    <li className="point">
      <div className="point__head">
        <span className="point__id">{point.id}</span>
        <div className="point__head-right">
          {/*
            Part C row 6: a low-confidence extraction asks for confirmation
            here rather than being quietly trusted.
          */}
          {needsConfirming ? (
            <StatusBadge tone="review">
              Check — {Math.round((point.provenance.confidence ?? 0) * 100)}% sure
            </StatusBadge>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Delete ${point.id}`}
            onClick={() => dispatch({ type: 'remove-point', id: point.id })}
          >
            ✕
          </Button>
        </div>
      </div>

      <div className="point__fields">
        <label className="point__field">
          <span>Easting</span>
          <TextInput
            numeric
            inputMode="decimal"
            ariaLabel={`${point.id} easting in ${unit}`}
            value={String(point.coordinates.easting)}
            onChange={(value) => update('easting', value)}
          />
        </label>
        <label className="point__field">
          <span>Northing</span>
          <TextInput
            numeric
            inputMode="decimal"
            ariaLabel={`${point.id} northing in ${unit}`}
            value={String(point.coordinates.northing)}
            onChange={(value) => update('northing', value)}
          />
        </label>
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Paste importer
// ---------------------------------------------------------------------------

function PasteImporter({ onDone }: { readonly onDone: () => void }) {
  const { state, dispatch } = useProject();
  const [text, setText] = useState('');
  const result = text.trim().length > 0 ? parsePointTable(text) : null;

  function apply(): void {
    if (!result || result.parsed.length < 3) return;
    dispatch({
      type: 'set-model',
      model: {
        ...state.model,
        points: result.parsed,
        boundary: [
          ringFromPointOrder(
            'ring_1',
            result.parsed.map((p) => p.id),
          ),
        ],
      },
    });
    onDone();
  }

  return (
    <div className="importer">
      <Field
        label="Paste your points"
        hint="One per line: name, easting, northing"
      >
        <textarea
          className="importer__input numeric"
          rows={7}
          value={text}
          placeholder={'PT1, 534800.00, 182900.00\nPT2, 534832.40, 182903.10'}
          onChange={(event) => setText(event.target.value)}
        />
      </Field>

      {result ? (
        <FadeIn>
          <div className="importer__result">
            <StatusBadge tone={result.problems.length > 0 ? 'review' : 'ready'}>
              {result.parsed.length} point{result.parsed.length === 1 ? '' : 's'} read
            </StatusBadge>

            {/* Bad rows are shown with their line and text, never dropped. */}
            {result.problems.length > 0 ? (
              <ul className="importer__problems">
                {result.problems.map((problem) => (
                  <li key={`${problem.line}-${problem.text}`}>
                    <span className="numeric">Line {problem.line}</span> — {problem.message}
                    <code>{problem.text}</code>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </FadeIn>
      ) : null}

      <Button
        full
        variant="primary"
        disabled={!result || result.parsed.length < 3}
        onClick={apply}
      >
        {result && result.parsed.length < 3
          ? 'Need at least 3 points'
          : 'Replace survey points'}
      </Button>
    </div>
  );
}
