/**
 * DataSheet and PointEditor (Architecture B.10).
 *
 * Coordinate entry as a clean mobile-native list rather than a spreadsheet,
 * becoming a real table above the tablet breakpoint. Every technical concept
 * carries plain-language guidance from the Knowledge Base.
 */

import { useMemo, useState } from 'react';

import type { SurveyPoint } from '@surveyor/contracts';
import {
  dxfToSurvey,
  extractPoints,
  looksLikeDxf,
  parseDxf,
  pointsFromExtraction,
  ringFromPointOrder,
  UNIT_ABBREVIATION,
  type DxfImport,
  type TableAnalysis,
} from '@surveyor/engine';

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
import { ObservationEditor } from './ObservationEditor.js';
import { EXPLANATIONS } from '../ai/assistant.js';
import './panels.css';

type Mode = 'list' | 'paste' | 'traverse';

/** Matches the Validation Engine's threshold, so the two agree on "unsure". */
const LOW_CONFIDENCE = 0.85;

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
            { value: 'traverse', label: 'Traverse' },
          ]}
        />
        <span className="panel__count numeric">
          {state.model.points.length} point{state.model.points.length === 1 ? '' : 's'}
        </span>
      </div>

      {mode === 'traverse' ? (
        <ObservationEditor onDone={() => setMode('list')} />
      ) : mode === 'paste' ? (
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
          <div className="tools__row">
            <Button
              full
              icon="+"
              onClick={() => dispatch(addBlankPoint(state.model.points))}
            >
              Add point
            </Button>
            {/*
              Points entered out of sequence read PT4, PT1, PT7 round the
              boundary, which is a plan a reviewer has to work at. Renumbering
              rebuilds the ring's references too, so the boundary survives it.
            */}
            <Button
              full
              title="Rename every point PT1 upward, in boundary order"
              onClick={() => dispatch({ type: 'renumber-points' })}
            >
              Renumber
            </Button>
          </div>
        </>
      )}

      {/*
        Import has its own primary action, and a pinned "Done" would sit on
        top of it — the confirm button was hidden behind this bar.
      */}
      {mode === 'list' ? (
        <div className="panel__footer">
          <Button full variant="primary" onClick={onClose}>
            Done
          </Button>
        </div>
      ) : null}
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

/**
 * Import, driven by the Document AI extractor.
 *
 * The user pastes or uploads whatever they have; the engine works out the
 * shape and says how sure it is. Anything it is not sure about — chiefly the
 * easting/northing order when there are no headings — is shown as a decision
 * for the user rather than a silent assumption (Part C row 6).
 */
function PasteImporter({ onDone }: { readonly onDone: () => void }) {
  const { state, dispatch } = useProject();
  const [text, setText] = useState('');
  const [swapped, setSwapped] = useState(false);
  const [dxf, setDxf] = useState<DxfImport | null>(null);

  // A drawing pasted into the box is still a drawing. This is checked before
  // the extractor runs, because a DXF put through the table reader does not
  // fail — it succeeds, on group codes, and hands back a survey of nonsense.
  const pasted = useMemo(
    () => (looksLikeDxf(text) ? dxfToSurvey(parseDxf(text)) : null),
    [text],
  );

  const result = useMemo(
    () =>
      text.trim().length > 0 && !looksLikeDxf(text)
        ? extractPoints(text, { swapEastingNorthing: swapped })
        : null,
    [text, swapped],
  );

  const points = result ? pointsFromExtraction(result) : [];
  const uncertain = points.filter(
    (p) => (p.provenance.confidence ?? 1) < LOW_CONFIDENCE,
  ).length;

  async function readFile(file: File): Promise<void> {
    const contents = await file.text();

    // A DXF is not a table, and running it through the table extractor would
    // find numbers in it and produce nonsense. Recognised by its own shape
    // rather than by the file extension, because a drawing renamed .txt is
    // still a drawing.
    if (/^\s*0\s*[\r\n]+\s*SECTION/i.test(contents) || file.name.toLowerCase().endsWith('.dxf')) {
      setDxf(dxfToSurvey(parseDxf(contents)));
      setText('');
      return;
    }

    setDxf(null);
    setText(contents);
    setSwapped(false);
  }

  function apply(): void {
    if (points.length < 3) return;
    dispatch({
      type: 'set-model',
      model: {
        ...state.model,
        // Confirmed by pressing the button, so the extraction confidence has
        // served its purpose and the points become user-confirmed data.
        points: points.map((point) => ({
          ...point,
          provenance: { source: 'user-confirmed' as const },
        })),
        boundary: [ringFromPointOrder('ring_1', points.map((p) => p.id))],
      },
    });
    onDone();
  }

  // Uploaded or pasted, it is the same drawing and gets the same confirmation.
  const drawing = dxf ?? pasted;

  if (drawing) {
    return (
      <DxfPreview
        result={drawing}
        onCancel={() => {
          setDxf(null);
          setText('');
        }}
        onApply={() => {
          const ring = drawing.rings[0];
          const points =
            ring && ring.length >= 3
              ? ring.map((coordinates, index) => ({
                  id: `PT${index + 1}`,
                  coordinates,
                  provenance: { source: 'user-confirmed' as const },
                }))
              : drawing.points.map((point) => ({
                  ...point,
                  provenance: { source: 'user-confirmed' as const },
                }));

          dispatch({
            type: 'set-model',
            model: {
              ...state.model,
              points,
              boundary:
                points.length >= 3
                  ? [ringFromPointOrder('ring_1', points.map((p) => p.id))]
                  : [],
            },
          });
          setDxf(null);
          setText('');
          onDone();
        }}
      />
    );
  }

  return (
    <div className="importer">
      <label className="importer__file">
        <input
          type="file"
          accept=".csv,.txt,.tsv,.dxf,text/plain,text/csv"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void readFile(file);
          }}
        />
        <span>Choose a file — table or DXF drawing</span>
      </label>

      <Field label="…or paste your points" hint="Any common layout — we work out the columns">
        <textarea
          className="importer__input numeric"
          rows={6}
          value={text}
          placeholder={'Point, Easting, Northing\nPT1, 534800.00, 182900.00'}
          onChange={(event) => {
            setText(event.target.value);
            setSwapped(false);
          }}
        />
      </Field>

      {result ? (
        <FadeIn>
          <div className="importer__result">
            <StatusBadge
              tone={
                result.problems.length > 0 || uncertain > 0 ? 'review' : 'ready'
              }
            >
              {points.length} point{points.length === 1 ? '' : 's'} read
            </StatusBadge>

            <DetectedColumns analysis={result.analysis} />

            {/*
              The one inference the engine cannot make honestly. Rather than
              picking the commoner convention, it asks — getting this wrong
              mirrors the entire site.
            */}
            {uncertain > 0 ? (
              <Card tone="sunken">
                <p className="panel__body">
                  There were no column headings, so I read the columns as
                  {swapped ? ' northing then easting' : ' easting then northing'}.
                  Does that look right?
                </p>
                <Button size="sm" onClick={() => setSwapped((s) => !s)}>
                  No — swap them
                </Button>
              </Card>
            ) : null}

            {/*
              What the extractor decided about the paste as a whole — which
              lines it set aside as not being part of the table, and any
              reading it could not settle from the text alone.
            */}
            {result.analysis.warnings.map((warning) => (
              <p key={warning} className="importer__warning">
                {warning}
              </p>
            ))}

            {result.problems.length > 0 ? (
              <ul className="importer__problems">
                {result.problems.map((problem) => (
                  <li key={`${problem.line}-${problem.text}`}>
                    <span className="numeric">Line {problem.line}</span> — {problem.message}
                    {problem.text ? <code>{problem.text}</code> : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </FadeIn>
      ) : null}

      <Button full variant="primary" disabled={points.length < 3} onClick={apply}>
        {result && points.length < 3
          ? 'Need at least 3 points'
          : uncertain > 0
            ? 'Confirm and use these points'
            : 'Use these points'}
      </Button>
    </div>
  );
}

/** What the extractor decided each column holds, and how sure it was. */
function DetectedColumns({ analysis }: { readonly analysis: TableAnalysis }) {
  const named = analysis.columns.filter((column) => column.role !== 'unknown');
  if (named.length === 0) return null;

  return (
    <ul className="detected">
      {named.map((column) => (
        <li key={column.index} className="detected__item">
          <span className="detected__role">{COLUMN_LABEL[column.role]}</span>
          <span className="detected__source numeric">
            {column.header ?? `column ${column.index + 1}`}
          </span>
          {column.confidence < LOW_CONFIDENCE ? (
            <StatusBadge tone="review">unsure</StatusBadge>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * What was found in a drawing, before any of it becomes survey data.
 *
 * The boundary candidate is the largest closed polyline, which is right far
 * more often than not — but "far more often than not" is not a standard to
 * import someone's boundary on, so it is shown and confirmed.
 */
function DxfPreview({
  result,
  onApply,
  onCancel,
}: {
  readonly result: DxfImport;
  readonly onApply: () => void;
  readonly onCancel: () => void;
}) {
  const ring = result.rings[0];
  const usable = (ring?.length ?? 0) >= 3 || result.points.length >= 3;

  return (
    <div className="importer">
      <div className="importer__result">
        <StatusBadge tone={usable ? 'ready' : 'review'}>
          {ring
            ? `A closed outline with ${ring.length} corners`
            : `${result.points.length} point${result.points.length === 1 ? '' : 's'}`}
        </StatusBadge>

        {ring ? (
          <p className="panel__body">
            I found {result.rings.length} closed shape
            {result.rings.length === 1 ? '' : 's'} and took the largest as the
            boundary. {result.points.length > 0
              ? `There ${result.points.length === 1 ? 'is' : 'are'} also ${result.points.length} loose point${result.points.length === 1 ? '' : 's'}, which this does not use.`
              : ''}
          </p>
        ) : (
          <p className="panel__body">
            There is no closed outline in this drawing, so the points are used
            in the order they appear. Check the boundary afterwards.
          </p>
        )}

        {result.problems.length > 0 ? (
          <ul className="importer__problems">
            {result.problems.map((problem) => (
              <li key={`${problem.line}-${problem.message}`}>{problem.message}</li>
            ))}
          </ul>
        ) : null}
      </div>

      <div className="tools__row">
        <Button full variant="primary" disabled={!usable} onClick={onApply}>
          {usable ? 'Use this drawing' : 'Not enough to draw a boundary'}
        </Button>
        <Button full onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

const COLUMN_LABEL: Record<string, string> = {
  id: 'Name',
  easting: 'Easting',
  northing: 'Northing',
  elevation: 'Elevation',
  description: 'Description',
};
