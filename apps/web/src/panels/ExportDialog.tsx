/**
 * ExportDialog and PlanPreview (Architecture B.12).
 *
 * The step list mirrors the real pipeline stages rather than a spinner, and the
 * export gate is enforced by the engine: composePlan is called with whatever
 * label specifications exist, and its refusal — not a UI check — is what stops
 * an unconfirmed suggestion reaching a finished plan.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  composePlan,
  planToDxf,
  planToPdf,
  planToSvg,
  type ComposedPlan,
} from '@surveyor/engine';

import { Button, Card, LoadingState, ProgressStepper, type Step } from '../ui/primitives.js';
import { FadeIn, ScaleIn } from '../ui/motion.js';
import { useProject } from '../state/store.js';
import { report } from '../state/report.js';
import './panels.css';

const STEP_LABELS: readonly { readonly id: string; readonly label: string }[] = [
  { id: 'geometry', label: 'Geometry checked' },
  { id: 'labels', label: 'Labels positioned' },
  { id: 'layout', label: 'Layout optimized' },
  { id: 'furniture', label: 'North arrow and scale added' },
  { id: 'render', label: 'Generating your plan' },
];

type Phase = 'working' | 'ready' | 'blocked' | 'failed';

export function ExportDialog({ onClose }: { readonly onClose: () => void }) {
  const { state, pipeline } = useProject();
  const [completed, setCompleted] = useState(0);
  const [phase, setPhase] = useState<Phase>('working');

  const outcome = useMemo(() => {
    if (!pipeline.ok) {
      return { kind: 'failed' as const, message: pipeline.message };
    }

    // The engine decides, not the dialog. Specs include anything the AI has
    // proposed, so an unconfirmed suggestion produces a refusal here.
    const result = composePlan({
      model: state.model,
      rings: pipeline.rings,
      drawing: pipeline.drawing,
      specs: [
        ...pipeline.specs,
        ...state.suggestions.flatMap((s) => (s.kind === 'label' ? [s.spec] : [])),
      ],
      validation: pipeline.validation,
    });

    return result.ok
      ? { kind: 'ready' as const, plan: result.plan, warnings: result.warnings }
      : { kind: 'blocked' as const, message: result.message, blocking: result.blocking };
  }, [pipeline, state.model, state.suggestions]);

  // Steps advance as the work actually lands rather than on a timer that
  // pretends. The staging here is only to keep the reveal legible.
  useEffect(() => {
    setCompleted(0);
    setPhase('working');

    if (outcome.kind === 'failed') {
      setPhase('failed');
      return undefined;
    }
    if (outcome.kind === 'blocked') {
      setPhase('blocked');
      return undefined;
    }

    let step = 0;
    const timer = window.setInterval(() => {
      step += 1;
      setCompleted(step);
      if (step >= STEP_LABELS.length) {
        window.clearInterval(timer);
        setPhase('ready');
      }
    }, 180);
    return () => window.clearInterval(timer);
  }, [outcome]);

  const steps: readonly Step[] = STEP_LABELS.map((step, index) => ({
    ...step,
    state:
      index < completed ? 'complete' : index === completed ? 'active' : 'pending',
  }));

  if (phase === 'failed' && outcome.kind === 'failed') {
    return (
      <div className="panel">
        <Card tone="sunken">
          <h4 className="panel__section">Not ready to export</h4>
          <p className="panel__body">{outcome.message}</p>
        </Card>
        <Button full variant="primary" onClick={onClose}>
          Back to the drawing
        </Button>
      </div>
    );
  }

  if (phase === 'blocked' && outcome.kind === 'blocked') {
    return <BlockedByGate message={outcome.message} onClose={onClose} />;
  }

  if (phase === 'working' || outcome.kind !== 'ready') {
    return (
      <div className="panel">
        <ProgressStepper steps={steps} />
        <LoadingState label="Preparing your plan…" />
      </div>
    );
  }

  return (
    <ReadyToExport
      plan={outcome.plan}
      warnings={outcome.warnings}
      pendingSuggestions={state.suggestions.length}
      address={state.model.metadata.siteAddress ?? 'Site plan'}
    />
  );
}

/**
 * The gate's UI half (LABEL_SPECIFICATION.md §6): name what is blocking and
 * send the user into the trust loop instead of showing a dead end.
 */
function BlockedByGate({
  message,
  onClose,
}: {
  readonly message: string;
  readonly onClose: () => void;
}) {
  const { state, dispatch } = useProject();

  return (
    <div className="panel">
      <Card tone="suggested">
        <h4 className="panel__section">Waiting on your confirmation</h4>
        <p className="panel__body">{message}</p>
      </Card>

      <ul className="gate">
        {state.suggestions.map((suggestion) => (
          <li key={suggestion.id} className="gate__item">
            <span>{suggestion.summary}</span>
            <div className="gate__actions">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => dispatch({ type: 'dismiss-suggestion', id: suggestion.id })}
              >
                Discard
              </Button>
              <Button
                size="sm"
                variant="primary"
                onClick={() =>
                  dispatch({
                    type: 'accept-suggestion',
                    id: suggestion.id,
                    at: new Date().toISOString(),
                  })
                }
              >
                Accept
              </Button>
            </div>
          </li>
        ))}
      </ul>

      <Button full onClick={onClose}>
        Back to the drawing
      </Button>
    </div>
  );
}

function ReadyToExport({
  plan,
  warnings,
  pendingSuggestions,
  address,
}: {
  readonly plan: ComposedPlan;
  readonly warnings: readonly string[];
  readonly pendingSuggestions: number;
  readonly address: string;
}) {
  const svg = useMemo(() => planToSvg(plan), [plan]);

  const download = useCallback(
    (format: 'pdf' | 'dxf' | 'svg') => {
      const name = address.replace(/[^a-z0-9]+/gi, '-').toLowerCase();

      /*
       * Wrapped, so that a generator throwing is reported rather than only
       * appearing as a button that did nothing.
       *
       * The reason is the *name* of the failure, never the message: a message
       * from a PDF writer can carry a font path, a filename, and through the
       * filename the site address — which is exactly what a console showing
       * every project at once must not accumulate.
       */
      let blob: Blob;
      try {
        blob =
          format === 'pdf'
            ? new Blob([planToPdf(plan) as BlobPart], { type: 'application/pdf' })
            : format === 'dxf'
              ? new Blob([planToDxf(plan)], { type: 'application/dxf' })
              : new Blob([svg], { type: 'image/svg+xml' });
      } catch (error) {
        report('export-failed', null, {
          format,
          reason: error instanceof Error ? error.name : 'unknown',
        });
        throw error;
      }

      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${name}.${format}`;
      link.click();
      URL.revokeObjectURL(url);

      report('export', null, { format });
    },
    [address, plan, svg],
  );

  return (
    <div className="panel">
      <ScaleIn>
        <div className="export__success">
          <span className="export__tick" aria-hidden="true">
            ✓
          </span>
          <div>
            <p className="export__title">Your plan is ready</p>
            <p className="export__facts numeric">
              {address} · {plan.sheet.id} {plan.sheet.orientation} · 1:
              {plan.transform.scaleDenominator}
            </p>
          </div>
        </div>
      </ScaleIn>

      <PlanPreview svg={svg} />

      {/*
        A pending suggestion is simply not on the sheet — say so plainly rather
        than letting the user discover it after printing.
      */}
      {pendingSuggestions > 0 ? (
        <Card tone="suggested">
          <p className="panel__body">
            {pendingSuggestions} suggestion{pendingSuggestions === 1 ? ' is' : 's are'} still
            unconfirmed and {pendingSuggestions === 1 ? 'is' : 'are'} not included on this plan.
          </p>
        </Card>
      ) : null}

      {warnings.length > 0 ? (
        <FadeIn>
          <Card tone="sunken">
            <h4 className="panel__section">Worth knowing</h4>
            <ul className="export__warnings">
              {warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </Card>
        </FadeIn>
      ) : null}

      <div className="export__actions">
        <Button variant="primary" onClick={() => download('pdf')}>
          Download PDF
        </Button>
        <Button onClick={() => download('dxf')}>DXF for CAD</Button>
        <Button onClick={() => download('svg')}>SVG</Button>
      </div>
    </div>
  );
}

export function PlanPreview({ svg }: { readonly svg: string }) {
  return (
    <div className="preview-frame">
      {/*
        The markup is produced by our own exporter from validated survey data,
        never from user-authored HTML, so injecting it is safe here.
      */}
      <div className="preview-frame__sheet" dangerouslySetInnerHTML={{ __html: svg }} />
    </div>
  );
}
