/**
 * PDF export.
 *
 * A small, self-contained PDF 1.4 writer. A survey plan needs vector lines,
 * rotated text in one standard font, and exact page dimensions — that is a
 * narrow enough target that a dependency-free writer is simpler to reason
 * about than a general-purpose library, and it keeps the engine runnable in a
 * browser as well as in Node.
 *
 * Everything is laid out in millimetres by the composer, so this file only
 * converts to points and flips the y axis.
 */

import type { PlacedLabel } from '@surveyor/contracts';

import type { DrawingElement, StrokeStyle } from '../drawing.js';
import { projectToSheet, type ComposedPlan } from '../compose/composer.js';

const PT_PER_MM = 72 / 25.4;

interface Pen {
  readonly width: number;
  readonly rgb: readonly [number, number, number];
  readonly dash?: readonly number[];
  readonly fill?: readonly [number, number, number];
}

const PENS: Readonly<Record<StrokeStyle, Pen>> = {
  boundary: { width: 0.5, rgb: [0.07, 0.09, 0.15] },
  'boundary-curve': { width: 0.5, rgb: [0.07, 0.09, 0.15] },
  building: { width: 0.3, rgb: [0.22, 0.25, 0.32], fill: [0.95, 0.96, 0.97] },
  road: { width: 0.25, rgb: [0.42, 0.45, 0.5], fill: [0.98, 0.98, 0.98] },
  'road-centreline': { width: 0.18, rgb: [0.61, 0.64, 0.69], dash: [4, 2] },
  fence: { width: 0.2, rgb: [0.42, 0.45, 0.5], dash: [3, 1.5] },
  access: { width: 0.25, rgb: [0.42, 0.45, 0.5], dash: [2, 2] },
  water: { width: 0.22, rgb: [0.23, 0.51, 0.96], fill: [0.94, 0.96, 1] },
  vegetation: { width: 0.22, rgb: [0.09, 0.64, 0.29], fill: [0.94, 0.99, 0.95] },
  easement: { width: 0.22, rgb: [0.49, 0.23, 0.93], dash: [5, 2] },
  wall: { width: 0.35, rgb: [0.22, 0.25, 0.32] },
  utility: { width: 0.18, rgb: [0.03, 0.57, 0.7], dash: [6, 2] },
  annotation: { width: 0.18, rgb: [0.07, 0.09, 0.15] },
  dimension: { width: 0.15, rgb: [0.42, 0.45, 0.5] },
  'point-marker': { width: 0.25, rgb: [0.07, 0.09, 0.15] },
};

export function planToPdf(plan: ComposedPlan): Uint8Array {
  const widthPt = plan.sheet.widthMm * PT_PER_MM;
  const heightPt = plan.sheet.heightMm * PT_PER_MM;

  const content = buildContent(plan);
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${round(widthPt)} ${round(heightPt)}] ` +
      `/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ];

  return assemble(objects);
}

// ---------------------------------------------------------------------------
// Content stream
// ---------------------------------------------------------------------------

function buildContent(plan: ComposedPlan): string {
  const ops: string[] = ['1 J 1 j'];
  const toPt = (xMm: number, yMm: number): [number, number] => [
    xMm * PT_PER_MM,
    (plan.sheet.heightMm - yMm) * PT_PER_MM,
  ];

  // Sheet frame
  ops.push(...strokeRect(plan.frame, toPt, [0.07, 0.09, 0.15], 0.4));

  for (const layer of plan.drawing.layers) {
    for (const element of layer.elements) {
      ops.push(...elementOps(element, plan, toPt));
    }
  }

  for (const label of plan.labels) {
    if (label.outcome === 'dropped') continue;
    ops.push(...labelOps(label, plan, toPt));
  }

  ops.push(...northArrowOps(plan, toPt));
  ops.push(...scaleBarOps(plan, toPt));
  ops.push(...titleBlockOps(plan, toPt));
  ops.push(...notesOps(plan, toPt));

  return ops.join('\n');
}

type ToPt = (xMm: number, yMm: number) => [number, number];

function elementOps(
  element: DrawingElement,
  plan: ComposedPlan,
  toPt: ToPt,
): string[] {
  if (element.kind === 'symbol') {
    const p = projectToSheet(element.at, plan.transform);
    const pen = PENS['point-marker'];
    const size = 1;
    const [x1, y1] = toPt(p.xMm - size, p.yMm);
    const [x2, y2] = toPt(p.xMm + size, p.yMm);
    const [x3, y3] = toPt(p.xMm, p.yMm - size);
    const [x4, y4] = toPt(p.xMm, p.yMm + size);
    return [
      colourOps(pen.rgb, undefined, pen.width, undefined),
      `${round(x1)} ${round(y1)} m ${round(x2)} ${round(y2)} l S`,
      `${round(x3)} ${round(y3)} m ${round(x4)} ${round(y4)} l S`,
    ];
  }

  const pen = PENS[element.style];
  const filled = element.kind === 'polygon' && pen.fill !== undefined;
  const path = element.points.map((c) => {
    const p = projectToSheet(c, plan.transform);
    return toPt(p.xMm, p.yMm);
  });
  if (path.length < 2) return [];

  const ops: string[] = [colourOps(pen.rgb, pen.fill, pen.width, pen.dash)];
  const [first, ...rest] = path;
  ops.push(`${round(first![0])} ${round(first![1])} m`);
  for (const [x, y] of rest) ops.push(`${round(x)} ${round(y)} l`);
  if (element.kind === 'polygon') ops.push('h');
  ops.push(filled ? 'B' : 'S');

  return ops;
}

function labelOps(label: PlacedLabel, plan: ComposedPlan, toPt: ToPt): string[] {
  const ops: string[] = [];
  const size = plan.jurisdiction.minimumLabelHeightMm * 1.35 * PT_PER_MM;

  if (label.leader) {
    const from = projectToSheet(label.leader.from, plan.transform);
    const to = projectToSheet(label.leader.to, plan.transform);
    const [x1, y1] = toPt(from.xMm, from.yMm);
    const [x2, y2] = toPt(to.xMm, to.yMm);
    ops.push(
      colourOps([0.42, 0.45, 0.5], undefined, 0.15, undefined),
      `${round(x1)} ${round(y1)} m ${round(x2)} ${round(y2)} l S`,
    );
  }

  const centre = projectToSheet(label.position, plan.transform);
  const [cx, cy] = toPt(centre.xMm, centre.yMm);

  // Text is placed from its baseline-left corner, so the estimated width is
  // used to centre it on the position the placement engine chose.
  const width = approximateWidthPt(label.text, size);
  const rad = (label.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = -width / 2;
  const dy = -size * 0.36;
  const tx = cx + dx * cos - dy * sin;
  const ty = cy + dx * sin + dy * cos;

  ops.push(
    '0.07 0.09 0.15 rg',
    'BT',
    `/F1 ${round(size)} Tf`,
    `${round(cos)} ${round(sin)} ${round(-sin)} ${round(cos)} ${round(tx)} ${round(ty)} Tm`,
    `(${escapePdfString(label.text)}) Tj`,
    'ET',
  );
  return ops;
}

function northArrowOps(plan: ComposedPlan, toPt: ToPt): string[] {
  const { at, sizeMm } = plan.northArrow;
  const half = sizeMm / 2;
  const tip = toPt(at.xMm, at.yMm - half);
  const right = toPt(at.xMm + half * 0.42, at.yMm + half);
  const waist = toPt(at.xMm, at.yMm + half * 0.55);
  const left = toPt(at.xMm - half * 0.42, at.yMm + half);
  const labelAt = toPt(at.xMm - 1.1, at.yMm - half - 2.4);

  return [
    '0.07 0.09 0.15 rg',
    `${round(tip[0])} ${round(tip[1])} m`,
    `${round(right[0])} ${round(right[1])} l`,
    `${round(waist[0])} ${round(waist[1])} l`,
    `${round(left[0])} ${round(left[1])} l h f`,
    'BT',
    `/F1 ${round(3.2 * PT_PER_MM)} Tf`,
    `${round(labelAt[0])} ${round(labelAt[1])} Td (N) Tj`,
    'ET',
  ];
}

function scaleBarOps(plan: ComposedPlan, toPt: ToPt): string[] {
  const { at, lengthMm, label } = plan.scaleBar;
  const segments = 4;
  const step = lengthMm / segments;
  const ops: string[] = ['0.07 0.09 0.15 RG 0.15 w'];

  for (let i = 0; i < segments; i += 1) {
    const [x, y] = toPt(at.xMm + i * step, at.yMm + 1.4);
    const w = step * PT_PER_MM;
    const h = 1.4 * PT_PER_MM;
    const shade = i % 2 === 0 ? '0.07 0.09 0.15 rg' : '1 1 1 rg';
    ops.push(shade, `${round(x)} ${round(y)} ${round(w)} ${round(h)} re B`);
  }

  const [tx, ty] = toPt(at.xMm, at.yMm + 5.6);
  ops.push(
    '0.22 0.25 0.32 rg',
    'BT',
    `/F1 ${round(2.6 * PT_PER_MM)} Tf`,
    `${round(tx)} ${round(ty)} Td (${escapePdfString(`${label}   1:${plan.transform.scaleDenominator}`)}) Tj`,
    'ET',
  );
  return ops;
}

function titleBlockOps(plan: ComposedPlan, toPt: ToPt): string[] {
  const area = plan.titleBlockArea;
  const ops = strokeRect(area, toPt, [0.07, 0.09, 0.15], 0.4);
  const lineHeight = Math.min(
    5,
    (area.heightMm - 4) / Math.max(plan.titleBlock.length, 1),
  );

  plan.titleBlock.forEach((entry, index) => {
    const y = area.yMm + 4 + index * lineHeight;
    const [lx, ly] = toPt(area.xMm + 2, y);
    const value = entry.missing ? '—' : entry.value;
    const size = 2.3 * PT_PER_MM;
    const [vx, vy] = toPt(
      area.xMm + area.widthMm - 2 - approximateWidthPt(value, size) / PT_PER_MM,
      y,
    );

    ops.push(
      '0.42 0.45 0.5 rg',
      'BT',
      `/F1 ${round(2.2 * PT_PER_MM)} Tf`,
      `${round(lx)} ${round(ly)} Td (${escapePdfString(entry.label)}) Tj`,
      'ET',
      entry.missing ? '0.72 0.11 0.11 rg' : '0.07 0.09 0.15 rg',
      'BT',
      `/F1 ${round(size)} Tf`,
      `${round(vx)} ${round(vy)} Td (${escapePdfString(value)}) Tj`,
      'ET',
    );
  });
  return ops;
}

function notesOps(plan: ComposedPlan, toPt: ToPt): string[] {
  if (plan.notes.length === 0) return [];
  const ops: string[] = ['0.29 0.33 0.39 rg'];
  const bottom = plan.frame.yMm + plan.frame.heightMm - 14;

  plan.notes.forEach((note, index) => {
    const y = bottom - (plan.notes.length - 1 - index) * 3.4;
    const [x, py] = toPt(plan.frame.xMm + 4, y);
    ops.push(
      'BT',
      `/F1 ${round(2.3 * PT_PER_MM)} Tf`,
      `${round(x)} ${round(py)} Td (${escapePdfString(note)}) Tj`,
      'ET',
    );
  });
  return ops;
}

function strokeRect(
  rect: { xMm: number; yMm: number; widthMm: number; heightMm: number },
  toPt: ToPt,
  rgb: readonly [number, number, number],
  width: number,
): string[] {
  const [x, y] = toPt(rect.xMm, rect.yMm + rect.heightMm);
  return [
    colourOps(rgb, undefined, width, undefined),
    `${round(x)} ${round(y)} ${round(rect.widthMm * PT_PER_MM)} ${round(rect.heightMm * PT_PER_MM)} re S`,
  ];
}

function colourOps(
  rgb: readonly [number, number, number],
  fill: readonly [number, number, number] | undefined,
  width: number,
  dash: readonly number[] | undefined,
): string {
  const parts = [
    `${rgb[0]} ${rgb[1]} ${rgb[2]} RG`,
    `${round(width * PT_PER_MM)} w`,
    dash
      ? `[${dash.map((d) => round(d * PT_PER_MM)).join(' ')}] 0 d`
      : '[] 0 d',
  ];
  if (fill) parts.push(`${fill[0]} ${fill[1]} ${fill[2]} rg`);
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Text encoding
// ---------------------------------------------------------------------------

/** Helvetica advance widths, close enough to centre text on its anchor. */
function approximateWidthPt(text: string, sizePt: number): number {
  let ratio = 0;
  for (const char of text) {
    if (char === ' ') ratio += 0.28;
    else if ('iljtIf.,:;\'"|!'.includes(char)) ratio += 0.28;
    else if ('mwMW@'.includes(char)) ratio += 0.85;
    else ratio += 0.55;
  }
  return ratio * sizePt;
}

/** Characters WinAnsi has but Latin-1 does not. */
const WIN_ANSI_EXTRAS: Readonly<Record<string, number>> = {
  '—': 0x97,
  '–': 0x96,
  '’': 0x92,
  '‘': 0x91,
  '“': 0x93,
  '”': 0x94,
  '•': 0x95,
  '€': 0x80,
};

export function escapePdfString(text: string): string {
  let out = '';
  for (const char of text) {
    const extra = WIN_ANSI_EXTRAS[char];
    const code = extra ?? char.codePointAt(0) ?? 63;

    if (char === '(' || char === ')' || char === '\\') out += `\\${char}`;
    else if (code < 32) out += ' ';
    else if (code < 127) out += char;
    else if (code <= 255) out += `\\${code.toString(8).padStart(3, '0')}`;
    else out += '?';
  }
  return out;
}

// ---------------------------------------------------------------------------
// Document assembly
// ---------------------------------------------------------------------------

/**
 * Builds the file body, then the cross-reference table.
 *
 * Offsets are byte offsets, and every character written here is in the 0-255
 * range, so string length and byte length stay identical — which is what makes
 * computing the xref from string offsets safe.
 */
function assemble(objects: readonly string[]): Uint8Array {
  let body = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  const offsets: number[] = [];

  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });

  const xrefOffset = body.length;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    xref += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }

  const trailer =
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
    `startxref\n${xrefOffset}\n%%EOF\n`;

  const document = body + xref + trailer;
  const bytes = new Uint8Array(document.length);
  for (let i = 0; i < document.length; i += 1) {
    bytes[i] = document.charCodeAt(i) & 0xff;
  }
  return bytes;
}

function round(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(3);
}
