/**
 * What the extractor made of something the user dropped into the conversation
 * (Architecture A.3, B.7).
 *
 * The assistant is allowed to notice that a message was data rather than a
 * question, and to run it through the Document AI extractor. It is not allowed
 * to decide the numbers: everything shown here is read deterministically from
 * the user's own text or from a transcription they can see beside it, and
 * nothing reaches the Survey Data Model until the button is pressed.
 *
 * The card is deliberately not a preview of a plan. It is a list of what was
 * read and what the extractor was unsure about, because that is the decision
 * the user is being asked to make.
 */

import { useMemo, useState } from 'react';

import type { SurveyPoint } from '@surveyor/contracts';
import {
  extractPoints,
  pointsFromExtraction,
  ringFromPointOrder,
  UNIT_ABBREVIATION,
  type PointExtraction,
} from '@surveyor/engine';

import { Button, Card, StatusBadge } from '../ui/primitives.js';
import { useProject } from '../state/store.js';
import type { ExtractionOffer } from './assistant.js';
import './ai.css';

/** Matches the Validation Engine's threshold, so the two agree on "unsure". */
const LOW_CONFIDENCE = 0.85;

export function ExtractionCard({
  offer,
  onApplied,
}: {
  readonly offer: ExtractionOffer;
  readonly onApplied: (count: number) => void;
}) {
  const { state, dispatch } = useProject();
  const [swapped, setSwapped] = useState(false);
  const [used, setUsed] = useState(false);
  const unit = UNIT_ABBREVIATION[state.model.crs.units];

  const result: PointExtraction = useMemo(
    () => extractPoints(offer.text, { swapEastingNorthing: swapped }),
    [offer.text, swapped],
  );

  const points = useMemo(() => pointsFromExtraction(result), [result]);
  const unsure = points.filter((p) => (p.provenance.confidence ?? 1) < LOW_CONFIDENCE);

  function apply(): void {
    if (points.length < 3) return;

    // Pressing the button is the confirmation, so the extraction confidence has
    // done its work and these become user-confirmed survey data. The plan
    // redraws from the pipeline as soon as the model changes.
    const confirmed: SurveyPoint[] = points.map((point) => ({
      ...point,
      provenance: { source: 'user-confirmed' as const },
    }));

    dispatch({
      type: 'set-model',
      model: {
        ...state.model,
        points: confirmed,
        boundary: [ringFromPointOrder('ring_1', confirmed.map((p) => p.id))],
      },
    });
    setUsed(true);
    onApplied(confirmed.length);
  }

  if (used) {
    return (
      <Card tone="sunken" className="extraction">
        <StatusBadge tone="ready">{points.length} points on the drawing</StatusBadge>
      </Card>
    );
  }

  return (
    <Card tone="suggested" className="extraction">
      {offer.imageUrl ? (
        <img
          className="extraction__image"
          src={offer.imageUrl}
          alt="The note this was read from"
        />
      ) : null}

      <div className="extraction__head">
        <StatusBadge tone={unsure.length > 0 || result.problems.length > 0 ? 'review' : 'ready'}>
          {points.length} point{points.length === 1 ? '' : 's'} read
        </StatusBadge>
        {result.analysis.hasHeader ? (
          <span className="extraction__note">headings recognised</span>
        ) : null}
      </div>

      {points.length > 0 ? (
        <ul className="extraction__points">
          {points.slice(0, 6).map((point) => (
            <li key={point.id}>
              <span className="extraction__id">{point.id}</span>
              <span className="numeric">
                {point.coordinates.easting.toFixed(2)} E,{' '}
                {point.coordinates.northing.toFixed(2)} N {unit}
              </span>
            </li>
          ))}
          {points.length > 6 ? (
            <li className="extraction__more">and {points.length - 6} more</li>
          ) : null}
        </ul>
      ) : null}

      {/*
        Every uncertainty the extractor recorded, in the words it recorded them
        in. A.3 routes these to the user rather than resolving them, and the
        coordinate order is the one that matters — getting it wrong mirrors the
        whole site rather than failing visibly.
      */}
      {result.analysis.warnings.map((warning) => (
        <p key={warning} className="extraction__warning">
          {warning}
        </p>
      ))}

      {unsure.length > 0 ? (
        <Button size="sm" onClick={() => setSwapped((s) => !s)}>
          {swapped ? 'Put easting back first' : 'Swap easting and northing'}
        </Button>
      ) : null}

      {result.problems.length > 0 ? (
        <ul className="extraction__problems">
          {result.problems.slice(0, 4).map((problem) => (
            <li key={`${problem.line}-${problem.text}`}>
              <span className="numeric">Line {problem.line}</span> — {problem.message}
            </li>
          ))}
        </ul>
      ) : null}

      <Button full variant="primary" disabled={points.length < 3} onClick={apply}>
        {points.length < 3
          ? 'I need at least 3 points to draw a boundary'
          : 'Use these points and draw the plan'}
      </Button>
    </Card>
  );
}
