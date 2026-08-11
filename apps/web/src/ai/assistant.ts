/**
 * The AI layer.
 *
 * This is the half of the system that decides *intent* — what should be on the
 * plan, what to say about it, what to offer next. It never computes geometry:
 * every proposal it makes is expressed as survey data or a LabelSpecification
 * and handed to the engines, which decide where things actually go.
 *
 * The planner here is deterministic and rule-based. Swapping it for a language
 * model changes only this file: the intent vocabulary, the proposal shapes, and
 * the trust loop that gates them are the contract, and they stay identical.
 * That boundary is the point — an LLM gets the same authority this planner has,
 * which is to say none over coordinates or survey values.
 */

import type { SiteFeature, SurveyDataModel } from '@surveyor/contracts';
import {
  centroid,
  forward,
  inverse,
  pointInPolygon,
  type PipelineResult,
} from '@surveyor/engine';

import type { Suggestion } from '../state/store.js';

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export type Intent =
  | { readonly kind: 'suggest-building'; readonly label: string }
  | { readonly kind: 'suggest-note' }
  | { readonly kind: 'show'; readonly elementId: string }
  | { readonly kind: 'open'; readonly panel: 'data' | 'validation' | 'export' | 'layers' }
  | { readonly kind: 'explain'; readonly topic: ExplainTopic }
  | { readonly kind: 'none' };

export type ExplainTopic = 'crs' | 'closure' | 'provenance' | 'area' | 'scale';

export interface AssistantAction {
  readonly id: string;
  readonly label: string;
  readonly intent: Intent;
  readonly tone?: 'primary' | 'secondary';
}

/**
 * Something the user dropped into the conversation for the extractor to read —
 * a pasted table, or a photograph of one.
 *
 * It hangs off the message rather than being folded into `text` because it is
 * not something anyone said. The reading of it is done by the Document AI
 * extractor and confirmed by the user; the conversation only carries it.
 */
export interface ExtractionOffer {
  readonly id: string;
  /** The text as it arrived, kept so the reading can be redone on request. */
  readonly text: string;
  /** A photograph the text was transcribed from, shown beside the numbers. */
  readonly imageUrl?: string;
}

export interface AssistantMessage {
  readonly id: string;
  readonly role: 'assistant' | 'user';
  readonly text: string;
  readonly actions?: readonly AssistantAction[];
  /** Object ids to pulse on the canvas while this message is the latest. */
  readonly references?: readonly string[];
  /** Data awaiting the user's confirmation before it enters the survey. */
  readonly offer?: ExtractionOffer;
}

// ---------------------------------------------------------------------------
// Knowledge base copy (A.3)
// ---------------------------------------------------------------------------

export const EXPLANATIONS: Readonly<Record<ExplainTopic, string>> = {
  crs:
    'A coordinate system tells us what your eastings and northings are measured ' +
    'from. Without it the numbers are just numbers — we would not know where on ' +
    'Earth they sit, or how to convert measured distances onto the page.',
  closure:
    'Closure checks your boundary. If you walk every bearing and distance in ' +
    'turn you should arrive back where you started. The gap left over is the ' +
    'misclosure, and it tells you how much measurement error crept in. We report ' +
    'it rather than quietly adjusting your figures.',
  provenance:
    'Every value on the plan is tagged with where it came from: measured, ' +
    'calculated from your measurements, confirmed by you, or suggested by me. ' +
    'Anything I suggest stays visually distinct and cannot reach a finished plan ' +
    'until you accept it.',
  area:
    'The area is calculated from your boundary corners, including any curved ' +
    'boundaries. It is never typed in by hand, so it always matches the drawing.',
  scale:
    'The scale sets how much ground fits on the paper. 1:200 means one ' +
    'centimetre on the page is two metres on the ground. We pick the largest ' +
    'scale that still fits your site on a standard sheet.',
};

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface AssistantContext {
  readonly model: SurveyDataModel;
  readonly pipeline: PipelineResult;
  readonly suggestions: readonly Suggestion[];
}

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}_${counter}`;
}

/** The message shown when the assistant opens, tailored to the current state. */
export function openingMessage(ctx: AssistantContext): AssistantMessage {
  const { model, pipeline } = ctx;

  if (model.points.length === 0) {
    return {
      id: nextId('msg'),
      role: 'assistant',
      text:
        'Let’s start your site plan. Add your survey points and I’ll work out ' +
        'the boundary, area and dimensions for you.',
      actions: [
        { id: nextId('act'), label: 'Add points', intent: { kind: 'open', panel: 'data' }, tone: 'primary' },
        { id: nextId('act'), label: 'What is a coordinate system?', intent: { kind: 'explain', topic: 'crs' } },
      ],
    };
  }

  if (!pipeline.ok) {
    return {
      id: nextId('msg'),
      role: 'assistant',
      text: `${pipeline.message} I’ve kept everything else as it is — nothing has been changed.`,
      actions: [
        { id: nextId('act'), label: 'Review issues', intent: { kind: 'open', panel: 'validation' }, tone: 'primary' },
        { id: nextId('act'), label: 'What is closure?', intent: { kind: 'explain', topic: 'closure' } },
      ],
    };
  }

  const ring = pipeline.rings[0];
  const areaText = ring ? `${Math.round(ring.area)} m²` : 'unknown';
  const needsReview = pipeline.validation.status === 'needs-review';

  return {
    id: nextId('msg'),
    role: 'assistant',
    text: needsReview
      ? `Your boundary is complete and encloses ${areaText}. A couple of things ` +
        `are worth a look before you export.`
      : `Your boundary is complete. I've calculated the area as ${areaText}. ` +
        `What would you like to add?`,
    actions: [
      { id: nextId('act'), label: 'Building', intent: { kind: 'suggest-building', label: 'Garage' } },
      { id: nextId('act'), label: 'Note', intent: { kind: 'suggest-note' } },
      { id: nextId('act'), label: 'Review', intent: { kind: 'open', panel: 'validation' } },
      { id: nextId('act'), label: 'Export', intent: { kind: 'open', panel: 'export' }, tone: 'primary' },
    ],
    ...(ring ? { references: ['ring_1'] } : {}),
  };
}

// ---------------------------------------------------------------------------
// Free text
// ---------------------------------------------------------------------------

interface Rule {
  readonly test: RegExp;
  readonly respond: (ctx: AssistantContext, match: RegExpExecArray) => AssistantMessage;
}

const RULES: readonly Rule[] = [
  {
    test: /\b(area|how big|size of (the )?(plot|site|parcel|land))\b/i,
    respond: (ctx) => {
      const ring = ctx.pipeline.ok ? ctx.pipeline.rings[0] : undefined;
      return {
        id: nextId('msg'),
        role: 'assistant',
        text: ring
          ? `The parcel encloses ${ring.area.toFixed(1)} m² (${(ring.area / 10000).toFixed(4)} ha). ` +
            `That is calculated from your boundary corners, not typed in.`
          : 'I don’t have a closed boundary yet, so there is no area to report.',
        actions: [
          { id: nextId('act'), label: 'How is this worked out?', intent: { kind: 'explain', topic: 'area' } },
        ],
        ...(ring ? { references: ['ring_1'] } : {}),
      };
    },
  },
  {
    test: /\b(show|find|where|zoom).*\b(building|house|garage)\b/i,
    respond: (ctx) => {
      const building = ctx.model.siteFeatures.find((f) => f.type === 'building');
      return building
        ? {
            id: nextId('msg'),
            role: 'assistant',
            text: `Here it is — ${String(building.attributes.name ?? 'the building')}, highlighted on the drawing.`,
            references: [building.id],
          }
        : {
            id: nextId('msg'),
            role: 'assistant',
            text: 'There is no building on the plan yet. Shall I propose one?',
            actions: [
              {
                id: nextId('act'),
                label: 'Propose a building',
                intent: { kind: 'suggest-building', label: 'Building' },
                tone: 'primary',
              },
            ],
          };
    },
  },
  {
    test: /\badd\b.*\b(garage|shed|outbuilding|extension|building)\b/i,
    respond: (_ctx, match) => ({
      id: nextId('msg'),
      role: 'assistant',
      text:
        'I’ve sketched one on the drawing. Check the position and size, then ' +
        'accept it to make it part of the survey.',
      actions: [
        {
          id: nextId('act'),
          label: 'Propose it',
          intent: { kind: 'suggest-building', label: capitalise(match[1] ?? 'Building') },
          tone: 'primary',
        },
      ],
    }),
  },
  {
    test: /\b(closure|close|misclos)/i,
    respond: (ctx) => {
      const closure = ctx.pipeline.ok ? ctx.pipeline.validation.closure[0] : undefined;
      return {
        id: nextId('msg'),
        role: 'assistant',
        text: closure
          ? closure.misclosure < 1e-9
            ? 'Your boundary closes exactly — the corners are defined by coordinates, so there is no traverse error to report.'
            : `Your boundary closes to ${closure.misclosure.toFixed(3)} m, a precision of about 1:${Math.round(closure.precisionRatio).toLocaleString()}.`
          : 'I don’t have a boundary to check yet.',
        actions: [
          { id: nextId('act'), label: 'What does that mean?', intent: { kind: 'explain', topic: 'closure' } },
        ],
      };
    },
  },
  {
    test: /\b(coordinate system|crs|datum|projection)\b/i,
    respond: (ctx) => ({
      id: nextId('msg'),
      role: 'assistant',
      text: `This survey is on ${ctx.model.crs.name} (${ctx.model.crs.datum}), in ${ctx.model.crs.units}s.`,
      actions: [
        { id: nextId('act'), label: 'Why does it matter?', intent: { kind: 'explain', topic: 'crs' } },
      ],
    }),
  },
  {
    test: /\b(export|pdf|dxf|download|print)\b/i,
    respond: () => ({
      id: nextId('msg'),
      role: 'assistant',
      text: 'I can produce a PDF, DXF or SVG. Everything on the sheet has to be confirmed first.',
      actions: [
        { id: nextId('act'), label: 'Open export', intent: { kind: 'open', panel: 'export' }, tone: 'primary' },
      ],
    }),
  },
  {
    test: /\b(suggest|ai|trust|why.*purple|provenance)\b/i,
    respond: () => ({
      id: nextId('msg'),
      role: 'assistant',
      text: EXPLANATIONS.provenance,
    }),
  },
  {
    test: /\b(point|coordinate|easting|northing|edit data)\b/i,
    respond: (ctx) => ({
      id: nextId('msg'),
      role: 'assistant',
      text: `You have ${ctx.model.points.length} survey points. You can edit them in the data panel.`,
      actions: [
        { id: nextId('act'), label: 'Open survey data', intent: { kind: 'open', panel: 'data' }, tone: 'primary' },
      ],
    }),
  },
];

export function respond(input: string, ctx: AssistantContext): AssistantMessage {
  for (const rule of RULES) {
    const match = rule.test.exec(input);
    if (match) return rule.respond(ctx, match);
  }

  return {
    id: nextId('msg'),
    role: 'assistant',
    text:
      'I can help with the boundary, area, dimensions, buildings, notes and ' +
      'exporting. Try asking about the area, or ask me to add a garage.',
    actions: [
      { id: nextId('act'), label: 'What’s the area?', intent: { kind: 'none' } },
      { id: nextId('act'), label: 'Review the drawing', intent: { kind: 'open', panel: 'validation' } },
    ],
  };
}

export function userMessage(text: string): AssistantMessage {
  return { id: nextId('msg'), role: 'user', text };
}

export function explainMessage(topic: ExplainTopic): AssistantMessage {
  return { id: nextId('msg'), role: 'assistant', text: EXPLANATIONS[topic] };
}

// ---------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------

/**
 * Propose a small rectangular building inside the boundary.
 *
 * Note what this does and does not do: it picks a *position and size* as a
 * proposal, expressed as ordinary survey geometry with `ai-suggested`
 * provenance. It does not write a label, a dimension, or an area — those are
 * derived by the engines once the user accepts it, from the geometry itself.
 */
export function proposeBuilding(
  ctx: AssistantContext,
  name: string,
): Suggestion | null {
  if (!ctx.pipeline.ok) return null;
  const ring = ctx.pipeline.rings[0];
  if (!ring) return null;

  const width = 6;
  const depth = 4;
  const existing = ctx.model.siteFeatures.filter(
    (f) => f.geometry.kind === 'polygon',
  );

  // Align the building with the boundary it sits behind, which is what a
  // draughtsman would do rather than snapping it to grid north.
  const first = ring.segments[0];
  const bearing = first ? first.bearing : 90;

  const corners = placeClearOfExisting(
    ring.vertices,
    existing,
    width,
    depth,
    bearing,
  );
  if (!corners) return null;

  const feature: SiteFeature = {
    id: `bld_ai_${Date.now().toString(36)}`,
    type: 'building',
    geometry: { kind: 'polygon', vertices: corners },
    attributes: { name },
    provenance: { source: 'ai-suggested' },
  };

  return {
    id: feature.id,
    kind: 'feature',
    summary: `AI suggestion — ${name}, ${width}m × ${depth}m`,
    feature,
  };
}

type Point = { easting: number; northing: number };

/**
 * Find a footprint inside the boundary that clears everything already drawn.
 *
 * The rectangle itself is tested, rather than a circle around its centre.
 * Circle approximations are either too loose — which put a proposed garage
 * inside the house — or, once tightened enough to prevent that, too strict to
 * find the garden it would have fitted in.
 */
function placeClearOfExisting(
  boundary: readonly Point[],
  existing: readonly SiteFeature[],
  width: number,
  depth: number,
  bearing: number,
): readonly Point[] | null {
  const middle = centroid(boundary);
  const step = Math.max(width, depth) * 0.6;

  const anchors: Point[] = [middle];
  for (let ring = 1; ring <= 6; ring += 1) {
    for (const direction of [180, 0, 90, 270, 135, 225, 45, 315]) {
      anchors.push(forward(middle, direction, step * ring));
    }
  }

  const obstacles = existing.flatMap((f) =>
    f.geometry.kind === 'polygon' ? [f.geometry.vertices] : [],
  );

  for (const anchor of anchors) {
    const corners = rectangleAt(anchor, bearing, width, depth);
    // A metre of breathing room, so a proposal never lands flush against a wall.
    const padded = rectangleAt(anchor, bearing, width + 2, depth + 2);

    if (!corners.every((c) => pointInPolygon(c, boundary))) continue;
    if (obstacles.some((obstacle) => convexOverlap(padded, obstacle))) continue;
    return corners;
  }
  return null;
}

function rectangleAt(
  centre: Point,
  bearing: number,
  width: number,
  depth: number,
): readonly Point[] {
  const halfW = width / 2;
  const halfD = depth / 2;
  return [
    forward(forward(centre, bearing, -halfW), bearing + 90, -halfD),
    forward(forward(centre, bearing, halfW), bearing + 90, -halfD),
    forward(forward(centre, bearing, halfW), bearing + 90, halfD),
    forward(forward(centre, bearing, -halfW), bearing + 90, halfD),
  ];
}

/** Separating-axis overlap test for two convex footprints. */
function convexOverlap(a: readonly Point[], b: readonly Point[]): boolean {
  for (const polygon of [a, b]) {
    for (let i = 0; i < polygon.length; i += 1) {
      const p = polygon[i]!;
      const q = polygon[(i + 1) % polygon.length]!;
      const axis = { e: -(q.northing - p.northing), n: q.easting - p.easting };
      if (Math.hypot(axis.e, axis.n) < 1e-12) continue;

      const spanA = project(a, axis);
      const spanB = project(b, axis);
      if (spanA.max < spanB.min || spanB.max < spanA.min) return false;
    }
  }
  return true;
}

function project(
  polygon: readonly Point[],
  axis: { e: number; n: number },
): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const point of polygon) {
    const value = point.easting * axis.e + point.northing * axis.n;
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  return { min, max };
}

export function proposeNote(): Suggestion {
  const id = `note_ai_${Date.now().toString(36)}`;
  return {
    id,
    kind: 'note',
    summary: 'AI suggestion — plan note',
    note: {
      id,
      text: 'Dimensions are in metres. Areas are calculated from measured corners.',
      provenance: { source: 'ai-suggested' },
    },
  };
}

function capitalise(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}
