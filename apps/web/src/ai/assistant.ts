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
  | { readonly kind: 'open'; readonly panel: PanelName }
  | { readonly kind: 'explain'; readonly topic: ExplainTopic }
  /** Walk the user through doing something themselves. */
  | { readonly kind: 'guide'; readonly task: TaskName }
  /** Switch the canvas tool, so "let me measure that" can just do it. */
  | { readonly kind: 'tool'; readonly tool: 'select' | 'draw' | 'measure' }
  | { readonly kind: 'new-project' }
  /**
   * The second half of starting a new project, after the user has been told
   * what it replaces.
   *
   * Deliberately absent from the model's vocabulary (`ACTION_KINDS` in
   * intent-schema.ts). `new-project` asks; this one acts. A model that could
   * emit this could skip the question, and the confirmation is the only thing
   * standing between a misread message and someone's survey.
   */
  | { readonly kind: 'confirm-new-project' }
  | { readonly kind: 'none' };

export type PanelName = 'data' | 'validation' | 'export' | 'layers' | 'project';

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
        'Let’s start your site plan. Paste your points straight into this box, ' +
        'photograph a note with the camera button, or add them by hand — then ' +
        'I’ll work out the boundary, area and dimensions for you. Ask me how to ' +
        'do anything in here and I’ll walk you through it.',
      actions: [
        { id: nextId('act'), label: 'Add points', intent: { kind: 'open', panel: 'data' }, tone: 'primary' },
        { id: nextId('act'), label: 'Draw the boundary', intent: { kind: 'guide', task: 'draw-boundary' } },
        { id: nextId('act'), label: 'What can you do?', intent: { kind: 'none' } },
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

/**
 * How big the parcel is, in every sense of the question.
 *
 * "How many metres is the size of this land" is one question with three
 * reasonable answers — area, perimeter, and the length of each side — and the
 * old reply gave only the first. Guessing which one was meant is a worse bet
 * than giving all three, because the engine has already computed every one of
 * them and none of them is long to say.
 *
 * Every number here comes off the pipeline. The assistant is reading them out,
 * not working them out.
 */
function describeParcel(ctx: AssistantContext): AssistantMessage {
  const ring = ctx.pipeline.ok ? ctx.pipeline.rings[0] : undefined;

  if (!ring) {
    return {
      id: nextId('msg'),
      role: 'assistant',
      text:
        ctx.model.points.length === 0
          ? 'There is nothing on the drawing yet, so there is no size to report. Paste your points in and I’ll work it out.'
          : 'I don’t have a closed boundary yet, so I can’t give you an area. Check the boundary order in Data.',
      actions: [
        { id: nextId('act'), label: 'Getting your points in', intent: { kind: 'guide', task: 'enter-data' }, tone: 'primary' },
      ],
    };
  }

  const sides = ring.segments.map((segment) => segment.distance);
  const sideText =
    sides.length > 0 && sides.length <= 8
      ? ` Its ${sides.length} sides are ${listOf(sides.map((d) => d.toFixed(2)))} m.`
      : '';

  return {
    id: nextId('msg'),
    role: 'assistant',
    text:
      `The boundary encloses ${ring.area.toFixed(1)} m² — that is ` +
      `${(ring.area / 10000).toFixed(4)} hectares, or about ` +
      `${Math.round(Math.sqrt(ring.area))} m square if it helps to picture it. ` +
      `The perimeter is ${ring.perimeter.toFixed(2)} m.${sideText} ` +
      `Every one of those is calculated from your corners, not typed in.`,
    actions: [
      { id: nextId('act'), label: 'How is the area worked out?', intent: { kind: 'explain', topic: 'area' } },
      { id: nextId('act'), label: 'Measure something myself', intent: { kind: 'tool', tool: 'measure' } },
    ],
    references: [ring.ringId],
  };
}

function listOf(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

interface Rule {
  readonly test: RegExp;
  /**
   * Words that point at this rule regardless of how the sentence is built.
   *
   * The regexes below are precise and fast, and they were also the whole
   * problem: `size of (the )?(plot|site|parcel|land)` answers "size of the
   * land" and misses "size of this land", which is the same question with one
   * different word in the middle. Phrases people actually type do not hold
   * still. These terms are scored instead of matched, so word order, filler
   * and phrasing stop mattering — see `bestByKeyword`.
   */
  readonly terms: readonly string[];
  readonly respond: (ctx: AssistantContext, match: RegExpExecArray | null) => AssistantMessage;
}

const RULES: readonly Rule[] = [
  {
    test: /\b(area|acreage|how big|how large|dimension|dimensions|size)\b/i,
    terms: [
      'area', 'acreage', 'hectare', 'hectares', 'acre', 'acres', 'size', 'big',
      'large', 'dimension', 'dimensions', 'measurement', 'measurements',
      'metres', 'meters', 'metre', 'meter', 'long', 'length', 'wide', 'width',
      'perimeter', 'side', 'sides', 'land', 'plot', 'parcel', 'square',
      'how big', 'how large', 'how long', 'how many metres', 'how many meters',
    ],
    respond: (ctx) => describeParcel(ctx),
  },
  {
    test: /\b(show|find|where|zoom).*\b(building|house|garage)\b/i,
    terms: ['building', 'house', 'garage', 'shed', 'outbuilding', 'structure', 'dwelling'],
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
    terms: ['add a building', 'add a garage', 'add a shed', 'new building', 'put a building'],
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
          // `match` is null when this rule was reached by keyword score rather
          // than by its pattern, so there is no captured name to use.
          intent: { kind: 'suggest-building', label: capitalise(match?.[1] ?? 'Building') },
          tone: 'primary',
        },
      ],
    }),
  },
  {
    test: /\b(closure|close|misclos)/i,
    terms: ['closure', 'close', 'closes', 'closed', 'misclosure', 'misclose', 'precision', 'traverse error', 'gap'],
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
    terms: ['coordinate system', 'crs', 'datum', 'projection', 'epsg', 'grid', 'osgb', 'utm', 'reference system'],
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
    terms: ['export', 'pdf', 'dxf', 'svg', 'download', 'print', 'share', 'issue', 'send'],
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
    terms: ['suggestion', 'suggested', 'provenance', 'trust', 'purple', 'confirm', 'unconfirmed', 'where did it come from'],
    respond: () => ({
      id: nextId('msg'),
      role: 'assistant',
      text: EXPLANATIONS.provenance,
    }),
  },
  {
    test: /\b(point|coordinate|easting|northing|edit data)\b/i,
    terms: ['point', 'points', 'coordinate', 'coordinates', 'easting', 'northing', 'corner', 'corners', 'station'],
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

// ---------------------------------------------------------------------------
// What the app can do (B.4 — the assistant as a way through the interface)
// ---------------------------------------------------------------------------

export type TaskName =
  | 'new-project'
  | 'name-site'
  | 'add-points'
  | 'paste-table'
  | 'photograph-note'
  | 'traverse'
  | 'enter-data'
  | 'draw-boundary'
  | 'measure'
  | 'add-building'
  | 'add-note'
  | 'labels'
  | 'review'
  | 'export'
  | 'undo';

/**
 * Every action the app can perform, in the words someone would ask for it.
 *
 * This exists because the assistant sits where a menu would, and an assistant
 * that cannot answer "how do I start a new project" is worse than a menu. The
 * failure it fixes was literal: nothing in the rule table mentioned projects at
 * all, so asking about one fell through to a generic list of unrelated things.
 *
 * Each entry gives the steps *and*, where the app can simply do it, the button
 * that does. Being told where a control is beats being told nothing; having it
 * opened for you beats both.
 */
export interface TaskGuide {
  readonly task: TaskName;
  readonly title: string;
  readonly match: RegExp;
  /** Scored when the pattern misses — see `bestByKeyword`. */
  readonly terms: readonly string[];
  readonly steps: readonly string[];
  readonly action?: { readonly label: string; readonly intent: Intent };
}

export const TASKS: readonly TaskGuide[] = [
  {
    task: 'new-project',
    title: 'Start a new project',
    match: /\b(new|another|start|create|begin|fresh|blank|empty|different|second)\b.{0,20}\b(project|plan|survey|site|job|drawing|one)\b|\bstart (over|again)\b|\bclear (everything|it all|the (plan|drawing))\b/i,
    terms: ['new project', 'another project', 'new plan', 'new survey', 'new job', 'start over', 'start again', 'from scratch', 'blank', 'fresh', 'clear everything', 'reset'],
    steps: [
      'Tap the site name at the top of the screen to open Project.',
      'Choose “Start a new project”, then confirm.',
      'Your current work is replaced, but Undo still brings it back.',
    ],
    action: { label: 'Start a new project', intent: { kind: 'new-project' } },
  },
  {
    task: 'name-site',
    title: 'Name the site',
    match: /\b(name|rename|title|address|call)\b.{0,20}\b(site|project|plan|drawing|it)\b|\bwhat.{0,10}(it|this) called\b/i,
    terms: ['name', 'rename', 'title', 'address', 'call it', 'site name', 'what is it called'],
    steps: [
      'Tap the site name at the top of the screen.',
      'Type the address. It appears in the title block on the exported plan.',
    ],
    action: { label: 'Open Project', intent: { kind: 'open', panel: 'project' } },
  },
  {
    task: 'add-points',
    title: 'Enter coordinates by hand',
    match: /\b(add|enter|type|input|key ?in|put in)\b.{0,20}\b(point|points|coordinate|coordinates|corner|corners|easting|northing)\b/i,
    terms: ['add point', 'add points', 'enter coordinates', 'type coordinates', 'key in', 'by hand', 'manually'],
    steps: [
      'Open Data from the bar at the bottom.',
      'Stay on Points and tap “Add point”.',
      'Type the easting and northing for each corner.',
    ],
    action: { label: 'Open Data', intent: { kind: 'open', panel: 'data' } },
  },
  {
    task: 'paste-table',
    title: 'Paste or import a table',
    match: /\b(paste|import|upload|load|csv|spreadsheet|excel|data ?collector|total ?station|file)\b/i,
    terms: ['paste', 'import', 'upload', 'csv', 'spreadsheet', 'excel', 'data collector', 'total station', 'file', 'table'],
    steps: [
      'Paste your table straight into this box — I read it here.',
      'Or open Data, choose “Paste table”, and paste or upload a .csv there.',
      'Either way you see what was read before anything is used.',
    ],
    action: { label: 'Open Data', intent: { kind: 'open', panel: 'data' } },
  },
  {
    task: 'photograph-note',
    title: 'Read a photographed note',
    // `photo\w*` rather than `photo`, because people write "photographed" and
    // "photos" — and the next task along matches the word "note", so a near
    // miss here does not fail, it answers the wrong question.
    match: /\b(photo\w*|pic|picture|camera|snap\w*|scan\w*|image|handwritten|field ?book|notebook)\b/i,
    terms: ['photo', 'photograph', 'picture', 'camera', 'snap', 'scan', 'image', 'handwritten', 'field book', 'notebook'],
    steps: [
      'Tap the camera button beside this box.',
      'Take a straight, close shot of the table of coordinates.',
      'The photo is transcribed and shown next to the numbers so you can check them.',
    ],
  },
  {
    task: 'traverse',
    title: 'Enter a traverse',
    match: /\b(traverse|bearing|bearings|deed|metes|distance and bearing|dms)\b/i,
    terms: ['traverse', 'bearing', 'bearings', 'deed', 'metes', 'bounds', 'dms', 'legs'],
    steps: [
      'Open Data and choose Traverse.',
      'Type one leg per line: from, to, bearing, distance.',
      'Closure is worked out as you type, because on a traverse that is the number that decides whether the survey is usable.',
    ],
    action: { label: 'Open Data', intent: { kind: 'open', panel: 'data' } },
  },
  {
    // Sits after the four specific routes so "how do I paste a table" still
    // gets the paste answer. This catches the question underneath all of them,
    // which people ask far more often: "how do I get my points in?"
    task: 'enter-data',
    title: 'Getting your points in',
    match: /\b(get\w*|bring|put|load|entering|capture|record|start with)\b.{0,25}\b(data|points|coordinates|survey|numbers|measurements|figures)\b|\bdata in\b|\bpoints in\b/i,
    terms: ['get my data in', 'get my points in', 'load my data', 'bring my data', 'start with my data', 'my numbers', 'my measurements'],
    steps: [
      'Paste a table straight into this box — that is the quickest.',
      'Or photograph a note with the camera button beside it.',
      'Or open Data to type coordinates by hand, or enter a traverse of bearings and distances.',
      'Whichever you use, you see what was read before any of it is used.',
    ],
    action: { label: 'Open Data', intent: { kind: 'open', panel: 'data' } },
  },
  {
    task: 'draw-boundary',
    title: 'Draw the boundary',
    match: /\b(draw|sketch|trace|tap out|plot)\b.{0,20}\b(boundary|outline|shape|corner|corners|parcel|plot)\b|\bdraw(ing)? tool\b/i,
    terms: ['draw', 'sketch', 'trace', 'plot the boundary', 'draw tool', 'tap the corners'],
    steps: [
      'Choose Draw in the toolbar under the drawing.',
      'Tap each corner. A new corner joins the edge it sits nearest, so the shape does not fold over.',
      'Switch back to Select when you are done.',
    ],
    action: { label: 'Switch to Draw', intent: { kind: 'tool', tool: 'draw' } },
  },
  {
    task: 'measure',
    title: 'Measure between two points',
    match: /\b(measure|distance between|how far|length between|check the distance)\b/i,
    terms: ['measure', 'distance between', 'how far', 'ruler'],
    steps: [
      'Choose Measure in the toolbar under the drawing.',
      'Tap two points. The bearing and distance come from the same COGO call the plan’s dimensions use.',
    ],
    action: { label: 'Switch to Measure', intent: { kind: 'tool', tool: 'measure' } },
  },
  {
    task: 'add-building',
    title: 'Add a building',
    match: /\b(building|house|garage|shed|outbuilding|extension|structure)\b/i,
    terms: ['building', 'house', 'garage', 'shed', 'outbuilding', 'extension', 'structure'],
    steps: [
      'Ask me for one — “add a garage” — and I will place a proposal on the drawing.',
      'It stays a proposal, drawn in purple, until you accept it.',
      'The engines work out its dimensions and area once you do; I never write those.',
    ],
    action: { label: 'Propose a building', intent: { kind: 'suggest-building', label: 'Building' } },
  },
  {
    task: 'add-note',
    title: 'Add a note to the plan',
    match: /\b(note|notes|annotation|annotate|caption|remark|text on the plan)\b/i,
    terms: ['note', 'notes', 'annotation', 'annotate', 'caption', 'remark', 'text on the plan'],
    steps: [
      'Ask me for a note and I will draft one.',
      'It appears as a proposal; accepting it puts it in the plan’s notes block.',
    ],
    action: { label: 'Draft a note', intent: { kind: 'suggest-note' } },
  },
  {
    task: 'labels',
    title: 'Show or hide labels and the grid',
    match: /\b(label|labels|grid|layer|layers|hide|show|declutter|too busy|crowded)\b/i,
    terms: ['label', 'labels', 'grid', 'layer', 'layers', 'hide', 'declutter', 'too busy', 'crowded'],
    steps: ['Open Layers from the bar at the bottom.', 'Toggle Labels or Grid.'],
    action: { label: 'Open Layers', intent: { kind: 'open', panel: 'layers' } },
  },
  {
    task: 'review',
    title: 'Check the drawing',
    match: /\b(check|review|validate|validation|problem|problems|wrong|error|warning|ready)\b/i,
    terms: ['check', 'review', 'validate', 'validation', 'problem', 'problems', 'wrong', 'error', 'warning', 'is it ready'],
    steps: [
      'Open Review from the status badge at the top, or from the bar at the bottom.',
      'Everything found is listed in plain language, with what to do about it.',
    ],
    action: { label: 'Open Review', intent: { kind: 'open', panel: 'validation' } },
  },
  {
    task: 'export',
    title: 'Export the plan',
    match: /\b(export|pdf|dxf|svg|download|print|share|send|issue)\b/i,
    terms: ['export', 'pdf', 'dxf', 'svg', 'download', 'print', 'share', 'issue', 'send'],
    steps: [
      'Open Export from the bar at the bottom.',
      'Choose PDF, DXF or SVG.',
      'Anything still marked as a suggestion has to be accepted first — the export is refused while a value on the sheet is one I proposed.',
    ],
    action: { label: 'Open Export', intent: { kind: 'open', panel: 'export' } },
  },
  {
    task: 'undo',
    title: 'Undo a change',
    match: /\b(undo|redo|revert|go back|mistake|by accident|didn.?t mean)\b/i,
    terms: ['undo', 'redo', 'revert', 'go back', 'mistake', 'by accident'],
    steps: [
      'Use the ↺ and ↻ buttons at the top right.',
      'Ctrl+Z and Ctrl+Shift+Z work too on a keyboard.',
    ],
  },
];

/**
 * Phrasing that asks how to do something, rather than about the survey.
 *
 * Deliberately narrower than it first was. "I want to add a garage" and "can I
 * export this" read as requests to act, not requests for instructions, and
 * routing them to a guide answered a question the surveyor had not asked —
 * they get handled by the rules below, which do the thing. Only wording that
 * can only mean "tell me how" belongs here.
 */
const HOW_TO =
  /\b(how (do|can|would|should) i|how to|how does one|where (do|is|are|can) i|show me how|guide me|walk me through|teach me)\b/i;

function guideMessage(guide: TaskGuide): AssistantMessage {
  return {
    id: nextId('msg'),
    role: 'assistant',
    text: [`${guide.title}:`, ...guide.steps.map((step, i) => `${i + 1}. ${step}`)].join('\n'),
    actions: [
      ...(guide.action
        ? [
            {
              id: nextId('act'),
              label: guide.action.label,
              intent: guide.action.intent,
              tone: 'primary' as const,
            },
          ]
        : []),
      { id: nextId('act'), label: 'What else can you do?', intent: { kind: 'none' as const } },
    ],
  };
}

export function findTask(input: string): TaskGuide | undefined {
  return TASKS.find((guide) => guide.match.test(input));
}

// ---------------------------------------------------------------------------
// Matching what was actually asked
// ---------------------------------------------------------------------------

/**
 * Score every rule and task by the words in the question, and take the best.
 *
 * The patterns above are precise, which makes them fast and makes them brittle
 * in the same stroke. "How many metres is the size of this land" missed every
 * one of them — the area pattern wanted `size of the land` and got `size of
 * this land` — and the reply was a menu, which reads as the assistant not
 * understanding a plain question. It was not understanding it: nothing had been
 * written down that this sentence could match.
 *
 * Scoring loosens that. A question does not have to be phrased any particular
 * way; it has to contain words the topic is about. Multi-word terms count for
 * more than single words, because "start over" is better evidence than "start".
 * Nothing scores, nothing matches — a fallback is still better than a confident
 * answer to a question nobody asked.
 */
export function bestByKeyword(
  input: string,
): { readonly kind: 'rule'; readonly rule: Rule } | { readonly kind: 'task'; readonly guide: TaskGuide } | null {
  const text = ` ${input.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ')} `;
  const words = new Set(text.trim().split(' '));

  const score = (terms: readonly string[]): number =>
    terms.reduce((total, term) => {
      if (term.includes(' ')) return total + (text.includes(` ${term} `) ? 3 : 0);
      return total + (words.has(term) ? 1 : 0);
    }, 0);

  let best: { score: number; value: ReturnType<typeof bestByKeyword> } = { score: 0, value: null };

  // Rules first on a tie: a question about this survey should be answered with
  // this survey's numbers rather than with instructions for finding them.
  for (const rule of RULES) {
    const value = score(rule.terms);
    if (value > best.score) best = { score: value, value: { kind: 'rule', rule } };
  }
  for (const guide of TASKS) {
    const value = score(guide.terms);
    if (value > best.score) best = { score: value, value: { kind: 'task', guide } };
  }

  return best.value;
}

export function respond(input: string, ctx: AssistantContext): AssistantMessage {
  // "How do I …" wants the steps; "what is …" wants the answer. Both reach the
  // same knowledge, in the order that suits the question.
  const asksHowTo = HOW_TO.test(input);

  if (asksHowTo) {
    const guide = findTask(input);
    if (guide) return guideMessage(guide);
  }

  for (const rule of RULES) {
    const match = rule.test.exec(input);
    if (match) return rule.respond(ctx, match);
  }

  const guide = findTask(input);
  if (guide) return guideMessage(guide);

  // Nothing was phrased the way anything was written down. Fall back to what
  // the question is *about* rather than to a menu.
  const scored = bestByKeyword(input);
  if (scored?.kind === 'rule') return scored.rule.respond(ctx, null);
  if (scored?.kind === 'task') return guideMessage(scored.guide);

  return capabilitiesMessage();
}

/**
 * What to say when nothing matched.
 *
 * The old version named six topics and left the user to guess the wording. The
 * complaint that produced this one was exact: asked to start a new project, it
 * replied about area and dimensions. Offering the actual tasks as buttons means
 * a miss costs one tap rather than another guess.
 */
export function capabilitiesMessage(): AssistantMessage {
  return {
    id: nextId('msg'),
    role: 'assistant',
    text:
      'I can walk you through anything in here, or just do it. Getting data in: ' +
      'type coordinates, paste a table, photograph a note, or enter a traverse. ' +
      'On the drawing: draw the boundary, measure, add a building or a note. ' +
      'Then check it and export it. Ask in your own words — “how do I start a ' +
      'new project” works.',
    actions: [
      { id: nextId('act'), label: 'Start a new project', intent: { kind: 'new-project' }, tone: 'primary' },
      { id: nextId('act'), label: 'Get my data in', intent: { kind: 'guide', task: 'paste-table' } },
      { id: nextId('act'), label: 'Draw the boundary', intent: { kind: 'guide', task: 'draw-boundary' } },
      { id: nextId('act'), label: 'Check the drawing', intent: { kind: 'open', panel: 'validation' } },
    ],
  };
}

export function taskMessage(task: TaskName): AssistantMessage {
  const guide = TASKS.find((entry) => entry.task === task);
  return guide ? guideMessage(guide) : capabilitiesMessage();
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
