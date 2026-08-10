/**
 * SVG export.
 *
 * The composed plan is already a complete description of the sheet in
 * millimetres, so every exporter is a straight transcription — no layout
 * decisions are taken here. That is deliberate: three exporters that each made
 * their own choices would produce three different plans.
 */

import type { PlacedLabel } from '@surveyor/contracts';

import type { DrawingElement, StrokeStyle } from '../drawing.js';
import {
  projectToSheet,
  type ComposedPlan,
  type SheetPoint,
} from '../compose/composer.js';

export interface SvgOptions {
  /** Render provenance-distinct styling for unconfirmed suggestions (B.13). */
  readonly showProvenance?: boolean;
  /** Draw the sheet furniture. Off gives just the geometry, for the canvas. */
  readonly chrome?: boolean;
}

interface StrokeSpec {
  readonly width: number;
  readonly colour: string;
  readonly dash?: string;
  readonly fill?: string;
}

/**
 * Line weights in millimetres, following ordinary drafting hierarchy: the
 * boundary is the heaviest line on the sheet, detail sits below it.
 */
const STROKES: Readonly<Record<StrokeStyle, StrokeSpec>> = {
  boundary: { width: 0.5, colour: '#111827' },
  'boundary-curve': { width: 0.5, colour: '#111827' },
  building: { width: 0.3, colour: '#374151', fill: '#f3f4f6' },
  road: { width: 0.25, colour: '#6b7280', fill: '#f9fafb' },
  'road-centreline': { width: 0.18, colour: '#9ca3af', dash: '4 2 1 2' },
  fence: { width: 0.2, colour: '#6b7280', dash: '3 1.5' },
  access: { width: 0.25, colour: '#6b7280', dash: '2 2' },
  water: { width: 0.22, colour: '#3b82f6', fill: '#eff6ff' },
  vegetation: { width: 0.22, colour: '#16a34a', fill: '#f0fdf4' },
  easement: { width: 0.22, colour: '#7c3aed', dash: '5 2' },
  'point-marker': { width: 0.25, colour: '#111827' },
};

export function planToSvg(plan: ComposedPlan, options: SvgOptions = {}): string {
  const chrome = options.chrome ?? true;
  const parts: string[] = [];

  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" ` +
      `width="${plan.sheet.widthMm}mm" height="${plan.sheet.heightMm}mm" ` +
      `viewBox="0 0 ${plan.sheet.widthMm} ${plan.sheet.heightMm}">`,
  );
  parts.push(
    `<rect x="0" y="0" width="${plan.sheet.widthMm}" height="${plan.sheet.heightMm}" fill="#ffffff"/>`,
  );

  if (chrome) parts.push(frame(plan));

  for (const layer of plan.drawing.layers) {
    parts.push(`<g id="layer-${layer.id}">`);
    for (const element of layer.elements) {
      parts.push(renderElement(element, plan, options));
    }
    parts.push('</g>');
  }

  parts.push('<g id="labels">');
  for (const label of plan.labels) {
    parts.push(renderLabel(label, plan, options));
  }
  parts.push('</g>');

  if (chrome) {
    parts.push(northArrow(plan));
    parts.push(scaleBar(plan));
    parts.push(titleBlock(plan));
    parts.push(legend(plan));
    parts.push(notes(plan));
  }

  parts.push('</svg>');
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

function pointsAttribute(
  element: Extract<DrawingElement, { kind: 'polyline' | 'polygon' }>,
  plan: ComposedPlan,
): string {
  return element.points
    .map((c) => {
      const p = projectToSheet(c, plan.transform);
      return `${fmt(p.xMm)},${fmt(p.yMm)}`;
    })
    .join(' ');
}

function renderElement(
  element: DrawingElement,
  plan: ComposedPlan,
  options: SvgOptions,
): string {
  const suggested =
    options.showProvenance && element.provenance.source === 'ai-suggested';

  if (element.kind === 'symbol') {
    const p = projectToSheet(element.at, plan.transform);
    const stroke = STROKES['point-marker'];
    const size = element.symbol === 'boundary-corner' ? 1.1 : 0.9;
    const opacity = suggested ? ' opacity="0.55"' : '';

    if (element.symbol === 'boundary-corner') {
      return (
        `<circle data-id="${escapeAttr(element.id)}" cx="${fmt(p.xMm)}" cy="${fmt(p.yMm)}" ` +
        `r="${size}" fill="none" stroke="${stroke.colour}" stroke-width="${stroke.width}"${opacity}/>`
      );
    }
    return (
      `<path data-id="${escapeAttr(element.id)}" d="M ${fmt(p.xMm - size)} ${fmt(p.yMm)} ` +
      `L ${fmt(p.xMm + size)} ${fmt(p.yMm)} M ${fmt(p.xMm)} ${fmt(p.yMm - size)} ` +
      `L ${fmt(p.xMm)} ${fmt(p.yMm + size)}" stroke="${stroke.colour}" ` +
      `stroke-width="${stroke.width}"${opacity}/>`
    );
  }

  const stroke = STROKES[element.style];
  const points = pointsAttribute(element, plan);
  const dash = stroke.dash ? ` stroke-dasharray="${stroke.dash}"` : '';
  const provenance = suggested ? ` stroke-dasharray="2 1.5" opacity="0.7"` : dash;
  const fill =
    element.kind === 'polygon' ? (stroke.fill ?? 'none') : 'none';
  const tag = element.kind === 'polygon' ? 'polygon' : 'polyline';

  return (
    `<${tag} data-id="${escapeAttr(element.id)}" points="${points}" fill="${fill}" ` +
    `stroke="${stroke.colour}" stroke-width="${stroke.width}" ` +
    `stroke-linejoin="round" stroke-linecap="round"${provenance}/>`
  );
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

function renderLabel(
  label: PlacedLabel,
  plan: ComposedPlan,
  options: SvgOptions,
): string {
  if (label.outcome === 'dropped') return '';

  const p = projectToSheet(label.position, plan.transform);
  const height = plan.jurisdiction.minimumLabelHeightMm;
  const suggested =
    options.showProvenance && label.spec.provenance.source === 'ai-suggested';

  // Sheet y grows downward while survey northing grows upward, so a rotation
  // measured counter-clockwise in the world is clockwise on the sheet.
  const rotation = -label.rotation;
  const transform =
    Math.abs(rotation) < 1e-9
      ? ''
      : ` transform="rotate(${fmt(rotation)} ${fmt(p.xMm)} ${fmt(p.yMm)})"`;

  const leader = label.leader
    ? (() => {
        const from = projectToSheet(label.leader.from, plan.transform);
        const to = projectToSheet(label.leader.to, plan.transform);
        return (
          `<line x1="${fmt(from.xMm)}" y1="${fmt(from.yMm)}" x2="${fmt(to.xMm)}" ` +
          `y2="${fmt(to.yMm)}" stroke="#6b7280" stroke-width="0.15"/>`
        );
      })()
    : '';

  const style = suggested
    ? `fill="#7c3aed" font-style="italic"`
    : `fill="#111827"`;

  return (
    leader +
    `<text data-label="${escapeAttr(label.spec.id)}" x="${fmt(p.xMm)}" y="${fmt(p.yMm)}" ` +
    `font-family="Inter, Helvetica, Arial, sans-serif" font-size="${fmt(height * 1.35)}" ` +
    `text-anchor="middle" dominant-baseline="central" ${style}${transform}>` +
    `${escapeText(label.text)}</text>`
  );
}

// ---------------------------------------------------------------------------
// Sheet furniture
// ---------------------------------------------------------------------------

function frame(plan: ComposedPlan): string {
  return (
    `<rect x="${plan.frame.xMm}" y="${plan.frame.yMm}" width="${plan.frame.widthMm}" ` +
    `height="${plan.frame.heightMm}" fill="none" stroke="#111827" stroke-width="0.4"/>`
  );
}

function northArrow(plan: ComposedPlan): string {
  const { at, sizeMm } = plan.northArrow;
  const half = sizeMm / 2;
  return (
    `<g id="north-arrow">` +
    `<path d="M ${fmt(at.xMm)} ${fmt(at.yMm - half)} L ${fmt(at.xMm + half * 0.42)} ${fmt(at.yMm + half)} ` +
    `L ${fmt(at.xMm)} ${fmt(at.yMm + half * 0.55)} L ${fmt(at.xMm - half * 0.42)} ${fmt(at.yMm + half)} Z" ` +
    `fill="#111827"/>` +
    `<text x="${fmt(at.xMm)}" y="${fmt(at.yMm - half - 1.6)}" font-family="Inter, Helvetica, Arial, sans-serif" ` +
    `font-size="3.2" text-anchor="middle" fill="#111827">N</text></g>`
  );
}

function scaleBar(plan: ComposedPlan): string {
  const { at, lengthMm, label } = plan.scaleBar;
  const segments = 4;
  const step = lengthMm / segments;

  const ticks: string[] = [];
  for (let i = 0; i < segments; i += 1) {
    ticks.push(
      `<rect x="${fmt(at.xMm + i * step)}" y="${fmt(at.yMm)}" width="${fmt(step)}" height="1.4" ` +
        `fill="${i % 2 === 0 ? '#111827' : '#ffffff'}" stroke="#111827" stroke-width="0.15"/>`,
    );
  }
  return (
    `<g id="scale-bar">${ticks.join('')}` +
    `<text x="${fmt(at.xMm)}" y="${fmt(at.yMm + 4.4)}" font-family="Inter, Helvetica, Arial, sans-serif" ` +
    `font-size="2.6" fill="#374151">${escapeText(label)}   ` +
    `1:${plan.transform.scaleDenominator}</text></g>`
  );
}

function titleBlock(plan: ComposedPlan): string {
  const area = plan.titleBlockArea;
  const rows: string[] = [
    `<rect x="${area.xMm}" y="${area.yMm}" width="${area.widthMm}" height="${area.heightMm}" ` +
      `fill="#ffffff" stroke="#111827" stroke-width="0.4"/>`,
  ];

  const lineHeight = Math.min(
    5,
    (area.heightMm - 4) / Math.max(plan.titleBlock.length, 1),
  );
  plan.titleBlock.forEach((entry, index) => {
    const y = area.yMm + 4 + index * lineHeight;
    rows.push(
      `<text x="${fmt(area.xMm + 2)}" y="${fmt(y)}" font-family="Inter, Helvetica, Arial, sans-serif" ` +
        `font-size="2.2" fill="#6b7280">${escapeText(entry.label)}</text>`,
      `<text x="${fmt(area.xMm + area.widthMm - 2)}" y="${fmt(y)}" text-anchor="end" ` +
        `font-family="Inter, Helvetica, Arial, sans-serif" font-size="2.4" ` +
        `fill="${entry.missing ? '#b91c1c' : '#111827'}">` +
        `${escapeText(entry.missing ? '—' : entry.value)}</text>`,
    );
  });

  return `<g id="title-block">${rows.join('')}</g>`;
}

function legend(plan: ComposedPlan): string {
  if (plan.legend.length === 0) return '';
  const x = plan.frame.xMm + 4;
  const top = plan.frame.yMm + 6;

  const rows = plan.legend.map((entry, index) => {
    const y = top + index * 4.4;
    const stroke = STROKES[entry.style];
    const dash = stroke.dash ? ` stroke-dasharray="${stroke.dash}"` : '';
    return (
      `<line x1="${fmt(x)}" y1="${fmt(y)}" x2="${fmt(x + 8)}" y2="${fmt(y)}" ` +
      `stroke="${stroke.colour}" stroke-width="${stroke.width}"${dash}/>` +
      `<text x="${fmt(x + 10)}" y="${fmt(y + 0.9)}" font-family="Inter, Helvetica, Arial, sans-serif" ` +
      `font-size="2.4" fill="#374151">${escapeText(entry.description)}</text>`
    );
  });

  return `<g id="legend">${rows.join('')}</g>`;
}

function notes(plan: ComposedPlan): string {
  if (plan.notes.length === 0) return '';
  const x = plan.frame.xMm + 4;
  const bottom = plan.frame.yMm + plan.frame.heightMm - 14;

  const rows = plan.notes.map(
    (note, index) =>
      `<text x="${fmt(x)}" y="${fmt(bottom - (plan.notes.length - 1 - index) * 3.4)}" ` +
      `font-family="Inter, Helvetica, Arial, sans-serif" font-size="2.3" fill="#4b5563">` +
      `${escapeText(note)}</text>`,
  );

  return `<g id="notes">${rows.join('')}</g>`;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function fmt(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(3);
}

export function escapeText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function escapeAttr(text: string): string {
  return escapeText(text).replace(/"/g, '&quot;');
}

export type { SheetPoint };
