/**
 * Reports — the survey written out as a document.
 *
 * Everything here already exists somewhere in the app: the closure figures are
 * on the Review panel, the coordinates are in Survey data, the area is on the
 * drawing. What it did not have was a way to produce the thing a client or a
 * checking surveyor actually asks for — one page with the schedule, the
 * closure and the issues on it, that can be sent to somebody.
 *
 * Nothing is computed here. Every number is read from the pipeline that drew
 * the plan, so a report and the sheet it accompanies cannot disagree: if they
 * could, one of them would be wrong and there would be no way to tell which.
 */

import { useMemo, useState } from 'react';

import {
  DEFAULT_FORMAT_RULES,
  JURISDICTIONS,
  UNIT_ABBREVIATION,
  formatBearing,
} from '@surveyor/engine';

import { Button, Card, EmptyState, Segmented, StatusBadge } from '../ui/primitives.js';
import { useProject } from '../state/store.js';
import { loadPreferences } from '../state/preferences.js';
import './panels.css';

type Report = 'summary' | 'points' | 'traverse';

export function ReportsSheet({ onClose }: { readonly onClose: () => void }) {
  const { state, pipeline } = useProject();
  const [report, setReport] = useState<Report>('summary');
  const [copied, setCopied] = useState(false);

  const unit = UNIT_ABBREVIATION[state.model.crs.units];

  const text = useMemo(
    () => (pipeline.ok ? renderReport(report, state.model, pipeline, unit) : ''),
    [report, state.model, pipeline, unit],
  );

  if (!pipeline.ok) {
    return (
      <div className="panel">
        <EmptyState
          icon="❋"
          title="Nothing to report yet"
          description={
            'A report is made from the finished survey. Add your points and ' +
            'close the boundary, and the schedule, closure and area will be here.'
          }
        />
        <div className="panel__footer">
          <Button full variant="primary" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    );
  }

  const closure = pipeline.validation.closure[0];

  return (
    <div className="panel">
      <div className="panel__toolbar">
        <Segmented
          ariaLabel="Which report"
          value={report}
          onChange={(next) => {
            setReport(next);
            setCopied(false);
          }}
          options={[
            { value: 'summary', label: 'Summary' },
            { value: 'points', label: 'Points' },
            { value: 'traverse', label: 'Traverse' },
          ]}
        />
        {closure ? (
          <StatusBadge tone={closure.withinTolerance ? 'ready' : 'review'}>
            {precision(closure.precisionRatio)}
          </StatusBadge>
        ) : null}
      </div>

      {/*
        Shown as the text that will be sent, not as a styled preview of it.
        A report that looks one way here and arrives another is a report
        nobody trusts twice.
      */}
      <pre className="report">{text}</pre>

      <div className="panel__footer panel__footer--stacked">
        <div className="tools__row">
          <Button
            full
            variant="primary"
            onClick={() => {
              void navigator.clipboard?.writeText(text).then(
                () => setCopied(true),
                // Clipboard access can be refused. Saying so beats a button
                // that appears to have worked.
                () => setCopied(false),
              );
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </Button>
          <Button
            full
            onClick={() => {
              const name = state.model.metadata.siteAddress ?? 'survey';
              const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
              const url = URL.createObjectURL(blob);
              const link = document.createElement('a');
              link.href = url;
              link.download = `${name} — ${REPORT_NAME[report]}.txt`;
              link.click();
              URL.revokeObjectURL(url);
            }}
          >
            Download
          </Button>
        </div>
        <Button full onClick={onClose}>
          Done
        </Button>
      </div>
    </div>
  );
}

const REPORT_NAME: Readonly<Record<Report, string>> = {
  summary: 'summary',
  points: 'point schedule',
  traverse: 'traverse',
};

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

type Ready = Extract<ReturnType<typeof useProject>['pipeline'], { ok: true }>;

function renderReport(
  report: Report,
  model: ReturnType<typeof useProject>['state']['model'],
  pipeline: Ready,
  unit: string,
): string {
  const heading = header(model);
  /*
   * The same precision the plan prints at.
   *
   * Hard-coding three decimals here produced a report reading 32.548 m beside
   * a drawing reading 32.55 m for the same boundary — the same number, looking
   * like a discrepancy, in the two documents a checker holds side by side. The
   * jurisdiction decides how many decimals a distance carries, and the report
   * is not exempt from that.
   */
  const decimals =
    (JURISDICTIONS.get(model.metadata.jurisdiction)?.format ?? DEFAULT_FORMAT_RULES)
      .distanceDecimals;

  if (report === 'points') return `${heading}\n${pointSchedule(model, unit, decimals)}`;
  if (report === 'traverse') return `${heading}\n${traverse(pipeline, model, unit, decimals)}`;
  return `${heading}\n${summary(model, pipeline, unit, decimals)}`;
}

/** A precision ratio, or "exact" — a boundary from coordinates closes perfectly. */
function precision(ratio: number): string {
  return Number.isFinite(ratio) ? `1:${Math.round(ratio).toLocaleString()}` : 'exact';
}

function header(model: ReturnType<typeof useProject>['state']['model']): string {
  const profile = loadPreferences().profile;
  const lines = [
    model.metadata.siteAddress ?? 'Untitled plan',
    '='.repeat((model.metadata.siteAddress ?? 'Untitled plan').length),
    '',
    `Coordinate system   ${model.crs.name}`,
    `Datum               ${model.crs.datum}`,
  ];

  if (model.metadata.jobNumber) lines.push(`Job number          ${model.metadata.jobNumber}`);
  if (model.metadata.client) lines.push(`Client              ${model.metadata.client}`);

  // The surveyor on the plan wins over the one in the profile: the plan is the
  // record, and a report that renamed its author would be a forgery.
  const author = model.metadata.surveyor ?? [profile.name, profile.firm].filter(Boolean).join(', ');
  if (author) lines.push(`Surveyor            ${author}`);
  if (profile.registration) lines.push(`Registration        ${profile.registration}`);

  lines.push(`Report produced     ${new Date().toISOString().slice(0, 10)}`, '');
  return lines.join('\n');
}

function summary(
  model: ReturnType<typeof useProject>['state']['model'],
  pipeline: Ready,
  unit: string,
  decimals: number,
): string {
  const lines = ['SUMMARY', '-------', ''];

  const ring = pipeline.rings[0];
  if (ring?.area !== undefined) {
    lines.push(`Area                ${ring.area.toFixed(2)} ${unit}²`);
  }
  lines.push(
    `Boundary corners    ${model.points.length}`,
    `Site features       ${model.siteFeatures.length}`,
  );

  const closure = pipeline.validation.closure[0];
  if (closure) {
    lines.push(
      '',
      'CLOSURE',
      '-------',
      '',
      `Misclosure          ${closure.misclosure.toFixed(decimals)} ${unit}`,
      `Precision           ${precision(closure.precisionRatio)}`,
      `Tolerance           ${closure.tolerance.toFixed(decimals)} ${unit}`,
      `Result              ${closure.withinTolerance ? 'Within tolerance' : 'OUTSIDE TOLERANCE'}`,
    );
  }

  const issues = pipeline.validation.issues;
  lines.push('', 'CHECKS', '------', '');
  if (issues.length === 0) {
    lines.push('No issues found.');
  } else {
    for (const issue of issues) {
      lines.push(`[${issue.severity.toUpperCase()}] ${issue.message}`);
      if (issue.subjects.length > 0) lines.push(`         ${issue.subjects.join(', ')}`);
    }
  }

  const revisions = model.metadata.revisions ?? [];
  if (revisions.length > 0) {
    lines.push('', 'REVISIONS', '---------', '');
    // Newest first, as they print on the sheet.
    for (const revision of [...revisions].reverse()) {
      lines.push(`${revision.code}  ${revision.date.slice(0, 10)}  ${revision.description}`);
    }
  }

  if (model.notes.length > 0) {
    lines.push('', 'NOTES', '-----', '');
    for (const note of model.notes) lines.push(`- ${note.text}`);
  }

  return lines.join('\n');
}

function pointSchedule(
  model: ReturnType<typeof useProject>['state']['model'],
  unit: string,
  decimals: number,
): string {
  const lines = [
    'POINT SCHEDULE',
    '--------------',
    '',
    `Point       Easting        Northing       Elevation   Source`,
  ];

  for (const point of model.points) {
    lines.push(
      [
        point.id.padEnd(11),
        point.coordinates.easting.toFixed(3).padStart(14),
        point.coordinates.northing.toFixed(3).padStart(15),
        (point.coordinates.elevation === undefined
          ? '—'
          : point.coordinates.elevation.toFixed(3)
        ).padStart(12),
        `   ${point.provenance.source}`,
      ].join(''),
    );
  }

  lines.push('', `Coordinates in ${unit}. ${model.points.length} points.`);
  return lines.join('\n');
}

function traverse(
  pipeline: Ready,
  model: ReturnType<typeof useProject>['state']['model'],
  unit: string,
  decimals: number,
): string {
  const ring = pipeline.rings[0];
  if (!ring) return 'TRAVERSE\n--------\n\nNo closed boundary.';

  const convention = model.crs.bearingConvention === 'azimuth' ? 'azimuth' : 'quadrant';
  const lines = [
    'TRAVERSE',
    '--------',
    '',
    'From    To      Bearing                 Distance',
  ];

  let total = 0;
  for (const segment of ring.segments) {
    total += segment.distance;
    lines.push(
      [
        segment.from.padEnd(8),
        segment.to.padEnd(8),
        formatBearing(segment.bearing, convention).padEnd(24),
        `${segment.distance.toFixed(decimals)} ${unit}`,
      ].join(''),
    );
  }

  lines.push('', `Perimeter           ${total.toFixed(decimals)} ${unit}`);
  if (ring.area !== undefined) lines.push(`Area                ${ring.area.toFixed(2)} ${unit}²`);

  const closure = pipeline.validation.closure[0];
  if (closure) {
    lines.push(
      `Misclosure          ${closure.misclosure.toFixed(decimals)} ${unit}`,
      `Precision           ${precision(closure.precisionRatio)}`,
    );
  }

  return lines.join('\n');
}
