/**
 * ObservationEditor (Architecture B.17).
 *
 * Deed-style entry: a boundary described by bearings and distances rather than
 * coordinates. The COGO engine has always supported this — `computeRing` walks
 * observed bearings and distances forward from a single known point — but
 * until now there was no way to type one in.
 *
 * This is also the entry path where closure actually means something. A
 * coordinate boundary closes by construction; a traverse closes only if the
 * measurements agree, so the misclosure is shown as you type rather than being
 * discovered at export.
 */

import { useMemo, useState } from 'react';

import type { BoundarySegment, SurveyPoint } from '@surveyor/contracts';
import {
  computeRing,
  extractTraverse,
  formatBearing,
  UNIT_ABBREVIATION,
} from '@surveyor/engine';

import { Button, Card, Field, StatusBadge } from '../ui/primitives.js';
import { FadeIn } from '../ui/motion.js';
import { useProject } from '../state/store.js';
import './panels.css';

const PLACEHOLDER = [
  'PT1 PT2 N 90°00\'00" E 30.00',
  'PT2 PT3 N 00°00\'00" E 20.00',
  'PT3 PT4 S 90°00\'00" W 30.00',
  'PT4 PT1 S 00°00\'00" E 20.00',
].join('\n');

export function ObservationEditor({ onDone }: { readonly onDone: () => void }) {
  const { state, dispatch } = useProject();
  const [text, setText] = useState('');
  const unit = UNIT_ABBREVIATION[state.model.crs.units];

  const parsed = useMemo(
    () => (text.trim().length > 0 ? extractTraverse(text) : null),
    [text],
  );

  const segments: readonly BoundarySegment[] = useMemo(
    () => parsed?.segments.map((field) => field.value) ?? [],
    [parsed],
  );

  /**
   * The traverse is computed from a single start point, so closure reflects the
   * observations rather than being forced to zero by stored coordinates.
   */
  const preview = useMemo(() => {
    if (segments.length < 3) return null;

    const first = segments[0]!;
    const origin: SurveyPoint = state.model.points.find((p) => p.id === first.from) ?? {
      id: first.from,
      coordinates: { easting: 0, northing: 0 },
      provenance: { source: 'user-confirmed' },
    };

    const result = computeRing(
      { id: 'ring_1', segments, closed: segments[segments.length - 1]!.to === first.from },
      [origin],
    );
    return result.ok ? { ring: result.ring, origin } : { error: result.reason };
  }, [segments, state.model.points]);

  function apply(): void {
    if (!preview || 'error' in preview || !preview.ring) return;

    // Every corner the traverse computed becomes a real point, so the rest of
    // the app treats it exactly like a coordinate-entered boundary.
    const points: SurveyPoint[] = preview.ring.segments.map((segment) => ({
      id: segment.from,
      coordinates: segment.start,
      provenance: { source: 'measured' },
    }));

    dispatch({
      type: 'set-model',
      model: {
        ...state.model,
        points,
        boundary: [{ id: 'ring_1', segments, closed: true }],
      },
    });
    onDone();
  }

  const closure = preview && 'ring' in preview ? preview.ring.closure : null;
  const ready = segments.length >= 3 && preview !== null && !('error' in preview);

  return (
    <div className="importer">
      <Field
        label="Bearings and distances"
        hint="One leg per line: from, to, bearing, distance"
        explanation={
          'A traverse describes the boundary by walking it — each line is a ' +
          'direction and a length from one corner to the next. We compute where ' +
          'the corners land, and how close the walk comes back to its start.'
        }
      >
        <textarea
          className="importer__input numeric"
          rows={6}
          value={text}
          placeholder={PLACEHOLDER}
          onChange={(event) => setText(event.target.value)}
        />
      </Field>

      {parsed ? (
        <FadeIn>
          <div className="importer__result">
            <StatusBadge tone={parsed.problems.length > 0 ? 'review' : 'ready'}>
              {segments.length} leg{segments.length === 1 ? '' : 's'} read
            </StatusBadge>

            {parsed.problems.length > 0 ? (
              <ul className="importer__problems">
                {parsed.problems.map((problem) => (
                  <li key={`${problem.line}-${problem.text}`}>
                    <span className="numeric">Line {problem.line}</span> — {problem.message}
                    <code>{problem.text}</code>
                  </li>
                ))}
              </ul>
            ) : null}

            {preview && 'error' in preview ? (
              <p className="panel__body">{preview.error}</p>
            ) : null}

            {/*
              Closure shown while typing. On a traverse this is the number that
              decides whether the survey is usable, so it should not wait until
              export to appear.
            */}
            {closure ? (
              <Card tone="sunken">
                <h4 className="panel__section">Closure</h4>
                <dl className="closure">
                  <div>
                    <dt>Misclosure</dt>
                    <dd className="numeric">
                      {closure.misclosure.toFixed(3)} {unit}
                    </dd>
                  </div>
                  <div>
                    <dt>Precision</dt>
                    <dd className="numeric">
                      {Number.isFinite(closure.precisionRatio)
                        ? `1:${Math.round(closure.precisionRatio).toLocaleString()}`
                        : 'exact'}
                    </dd>
                  </div>
                  <div>
                    <dt>Perimeter</dt>
                    <dd className="numeric">
                      {preview && 'ring' in preview
                        ? `${preview.ring.perimeter.toFixed(2)} ${unit}`
                        : '—'}
                    </dd>
                  </div>
                </dl>
              </Card>
            ) : null}

            {segments.length > 0 ? (
              <ul className="legs">
                {segments.map((segment) => (
                  <li key={`${segment.from}-${segment.to}`} className="legs__item">
                    <span className="numeric">
                      {segment.from} → {segment.to}
                    </span>
                    <span className="numeric legs__value">
                      {formatBearing(segment.bearing ?? 0, state.model.crs.bearingConvention)}
                      {'  '}
                      {(segment.distance ?? 0).toFixed(2)} {unit}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </FadeIn>
      ) : null}

      <Button full variant="primary" disabled={!ready} onClick={apply}>
        {segments.length > 0 && segments.length < 3
          ? 'Need at least 3 legs'
          : 'Use this traverse'}
      </Button>
    </div>
  );
}
