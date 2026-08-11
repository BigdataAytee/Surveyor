/**
 * DXF export.
 *
 * Unlike the sheet formats, DXF carries the drawing in real survey
 * coordinates: it is handed to another CAD package, where the recipient
 * expects to measure off it. Scale and sheet layout are deliberately not baked
 * in — only the geometry, on named layers.
 *
 * Written as ASCII R12, the dialect essentially every CAD package still reads.
 */

import type { PlacedLabel } from '@surveyor/contracts';

import type { DrawingElement, StrokeStyle } from '../drawing.js';
import type { ComposedPlan } from '../compose/composer.js';

/** AutoCAD colour indices, chosen so layers stay distinguishable on import. */
const LAYER_COLOUR: Readonly<Record<StrokeStyle, number>> = {
  boundary: 7,
  'boundary-curve': 7,
  building: 8,
  road: 9,
  'road-centreline': 9,
  fence: 3,
  access: 4,
  water: 5,
  vegetation: 3,
  easement: 6,
  wall: 8,
  utility: 4,
  annotation: 7,
  dimension: 8,
  'point-marker': 1,
};

const LABEL_LAYER = 'LABELS';

function pair(code: number, value: string | number): string {
  return `${code}\n${value}\n`;
}

export function planToDxf(plan: ComposedPlan): string {
  const layers = new Set<string>([LABEL_LAYER]);
  for (const layer of plan.drawing.layers) {
    for (const element of layer.elements) {
      layers.add(element.kind === 'symbol' ? 'POINTS' : layerName(element.style));
    }
  }

  return [
    header(),
    tables([...layers]),
    entities(plan),
    pair(0, 'EOF'),
  ].join('');
}

function layerName(style: StrokeStyle): string {
  return style.toUpperCase().replace(/-/g, '_');
}

function header(): string {
  return (
    pair(0, 'SECTION') +
    pair(2, 'HEADER') +
    pair(9, '$ACADVER') +
    pair(1, 'AC1009') +
    pair(9, '$INSUNITS') +
    pair(70, 6) + // metres
    pair(0, 'ENDSEC')
  );
}

function tables(layers: readonly string[]): string {
  const entries = layers
    .map((name) => {
      const style = (Object.keys(LAYER_COLOUR) as StrokeStyle[]).find(
        (s) => layerName(s) === name,
      );
      const colour = style ? LAYER_COLOUR[style] : 7;
      return (
        pair(0, 'LAYER') +
        pair(2, name) +
        pair(70, 0) +
        pair(62, colour) +
        pair(6, 'CONTINUOUS')
      );
    })
    .join('');

  return (
    pair(0, 'SECTION') +
    pair(2, 'TABLES') +
    pair(0, 'TABLE') +
    pair(2, 'LAYER') +
    pair(70, layers.length) +
    entries +
    pair(0, 'ENDTAB') +
    pair(0, 'ENDSEC')
  );
}

function entities(plan: ComposedPlan): string {
  const parts: string[] = [pair(0, 'SECTION') + pair(2, 'ENTITIES')];

  for (const layer of plan.drawing.layers) {
    for (const element of layer.elements) {
      parts.push(entity(element));
    }
  }

  const textHeight =
    plan.jurisdiction.minimumLabelHeightMm * plan.transform.worldPerMm;
  for (const label of plan.labels) {
    if (label.outcome === 'dropped') continue;
    parts.push(text(label, textHeight));
  }

  parts.push(pair(0, 'ENDSEC'));
  return parts.join('');
}

function entity(element: DrawingElement): string {
  if (element.kind === 'symbol') {
    return (
      pair(0, 'CIRCLE') +
      pair(8, 'POINTS') +
      pair(10, element.at.easting) +
      pair(20, element.at.northing) +
      pair(30, 0) +
      pair(40, 0.15)
    );
  }

  const layer = layerName(element.style);
  const points = element.points;
  const closed = element.kind === 'polygon';
  const lines: string[] = [];

  const count = closed ? points.length : points.length - 1;
  for (let i = 0; i < count; i += 1) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    lines.push(
      pair(0, 'LINE') +
        pair(8, layer) +
        pair(10, a.easting) +
        pair(20, a.northing) +
        pair(30, 0) +
        pair(11, b.easting) +
        pair(21, b.northing) +
        pair(31, 0),
    );
  }
  return lines.join('');
}

function text(label: PlacedLabel, height: number): string {
  return (
    pair(0, 'TEXT') +
    pair(8, LABEL_LAYER) +
    pair(10, label.position.x) +
    pair(20, label.position.y) +
    pair(30, 0) +
    pair(40, height) +
    pair(1, sanitize(label.text)) +
    pair(50, label.rotation) +
    // Centre the text on its insertion point, matching where it was placed.
    pair(72, 1) +
    pair(11, label.position.x) +
    pair(21, label.position.y) +
    pair(31, 0)
  );
}

/** DXF group values are newline-delimited, so embedded newlines must go. */
function sanitize(value: string): string {
  return value.replace(/[\r\n]+/g, ' ');
}
