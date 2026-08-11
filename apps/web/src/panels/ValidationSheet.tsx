/**
 * ValidationSheet (Architecture B.11, Part C row 2).
 *
 * Where the Validation Engine's findings surface. Each issue keeps the plain
 * language the engine wrote, offers the options the engine allows, and can
 * point the canvas at the geometry involved. Nothing here fixes anything on the
 * user's behalf — A.1 §4.
 */

import { useMemo } from 'react';

import type { ValidationIssue, ValidationReport } from '@surveyor/contracts';
import { formatAngle, internalAngles } from '@surveyor/engine';

import { Button, Card, StatusBadge, SuccessState, type StatusTone } from '../ui/primitives.js';
import { SlideUp } from '../ui/motion.js';
import { useProject } from '../state/store.js';
import './panels.css';

const TONE: Record<ValidationReport['status'], StatusTone> = {
  ready: 'ready',
  'needs-review': 'review',
  error: 'error',
};

export const STATUS_LABEL: Record<ValidationReport['status'], string> = {
  ready: 'Ready',
  'needs-review': 'Needs review',
  error: 'Error',
};

const OPTION_LABEL: Record<string, string> = {
  accept: 'Accept as is',
  adjust: 'Fix the data',
  reject: 'Start over',
  confirm: 'Confirm',
};

export function ValidationSheet({ onOpenData }: { readonly onOpenData: () => void }) {
  const { pipeline, dispatch } = useProject();

  /** The angle at each boundary corner, named by the corner it belongs to. */
  const angles = useMemo(() => {
    const ring = pipeline.ok ? pipeline.rings[0] : undefined;
    if (!ring) return [];
    return internalAngles(ring.vertices).map((angle, index) => ({
      id: ring.segments[index]?.from ?? `#${index + 1}`,
      degrees: angle.degrees,
    }));
  }, [pipeline]);

  const angleTotal = angles.reduce((sum, angle) => sum + angle.degrees, 0);

  const report: ValidationReport | undefined = pipeline.ok
    ? pipeline.validation
    : pipeline.validation;

  if (!report) {
    return (
      <div className="panel">
        <Card tone="sunken">
          <p>{pipeline.ok ? '' : pipeline.message}</p>
        </Card>
        <Button full variant="primary" onClick={onOpenData}>
          Open survey data
        </Button>
      </div>
    );
  }

  if (report.issues.length === 0) {
    const ring = pipeline.ok ? pipeline.rings[0] : undefined;
    return (
      <div className="panel">
        <SuccessState
          title="Everything checks out"
          facts={[
            `${ring ? ring.segments.length : 0} boundary lines`,
            ring ? `Area ${Math.round(ring.area)} m²` : 'No area',
            closureText(report),
          ]}
        />
      </div>
    );
  }

  return (
    <div className="panel">
      <div className="panel__toolbar">
        <StatusBadge tone={TONE[report.status]}>{STATUS_LABEL[report.status]}</StatusBadge>
        <span className="panel__count">
          {report.issues.length} item{report.issues.length === 1 ? '' : 's'}
        </span>
      </div>

      <ul className="issues">
        {report.issues.map((issue, index) => (
          <SlideUp key={`${issue.code}-${issue.subjects.join('-')}`} delay={index * 40}>
            <IssueRow
              issue={issue}
              onShow={() => {
                const subject = issue.subjects[0];
                if (subject) dispatch({ type: 'highlight', id: subject });
              }}
              onAdjust={onOpenData}
            />
          </SlideUp>
        ))}
      </ul>

      {report.closure.length > 0 ? (
        <Card tone="sunken">
          <h4 className="panel__section">Closure</h4>
          {report.closure.map((closure) => (
            <dl key={closure.ringId} className="closure">
              <div>
                <dt>Misclosure</dt>
                <dd className="numeric">{closure.misclosure.toFixed(3)} m</dd>
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
                <dt>Allowed</dt>
                <dd className="numeric">{closure.tolerance} m</dd>
              </div>
            </dl>
          ))}
        </Card>
      ) : null}

      {/*
        The angles a deed quotes, computed from the same corners the area and
        the dimensions come from — so a plan checked against a deed shows the
        deed's figures rather than ones measured off the drawing. The sum is
        shown beside them because it is the check a surveyor runs by hand.
      */}
      {angles.length > 0 ? (
        <Card tone="sunken">
          <h4 className="panel__section">Internal angles</h4>
          <ul className="angles">
            {angles.map((angle) => (
              <li key={angle.id} className="angles__item">
                <span className="numeric">{angle.id}</span>
                <span className="numeric">{formatAngle(angle.degrees)}</span>
              </li>
            ))}
          </ul>
          <p className="panel__body">
            They add up to {formatAngle(angleTotal)}, which for {angles.length} corners
            should be {formatAngle((angles.length - 2) * 180)}.
          </p>
        </Card>
      ) : null}
    </div>
  );
}

function IssueRow({
  issue,
  onShow,
  onAdjust,
}: {
  readonly issue: ValidationIssue;
  readonly onShow: () => void;
  readonly onAdjust: () => void;
}) {
  return (
    <li className={`issue issue--${issue.severity}`}>
      <div className="issue__head">
        <StatusBadge tone={issue.severity === 'error' ? 'error' : 'review'}>
          {issue.severity === 'error' ? 'Error' : 'Review'}
        </StatusBadge>
        {issue.subjects.length > 0 ? (
          <button type="button" className="issue__subjects" onClick={onShow}>
            {issue.subjects.slice(0, 3).join(', ')}
          </button>
        ) : null}
      </div>

      <p className="issue__message">{issue.message}</p>

      {issue.detail ? (
        <details className="issue__detail">
          <summary>Technical detail</summary>
          <p className="numeric">{issue.detail}</p>
        </details>
      ) : null}

      <div className="issue__options">
        {issue.options.map((option) => (
          <Button
            key={option}
            size="sm"
            variant={option === 'adjust' ? 'primary' : 'secondary'}
            onClick={option === 'adjust' ? onAdjust : onShow}
          >
            {OPTION_LABEL[option] ?? option}
          </Button>
        ))}
      </div>
    </li>
  );
}

function closureText(report: ValidationReport): string {
  const closure = report.closure[0];
  if (!closure) return 'No closure to check';
  return closure.misclosure < 1e-9
    ? 'Boundary closes exactly'
    : `Closes to ${closure.misclosure.toFixed(3)} m`;
}
