/**
 * The annotation layer: title block, scale, free text, and formatting.
 *
 * Everything here defends one of the three rules the annotation architecture
 * is built on, and each test is written so it fails if the rule is broken
 * rather than if the implementation merely changes:
 *
 *   1. An absent field means "read it from the plan"; a present field means a
 *      surveyor decided it. Only absent fields may be filled in.
 *   2. Adding a part is additive. Nothing that adds may turn anything off, and
 *      nothing may overwrite text a person typed.
 *   3. Formatting is presentation. No control that changes appearance may
 *      reach a coordinate, a calculated value or a provenance tag.
 *
 * The chat command and the suggestion card are tested against the *same*
 * reducer, because the architecture's rule is that they are one code path —
 * a test that exercised them separately would pass on the day they diverged.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type { SurveyDataModel, TitleScaleBlock } from '@surveyor/contracts';
import { runPipeline, ringFromPointOrder } from '@surveyor/engine';

import { respond, titleScaleIntent, type AssistantContext, type Intent } from '../src/ai/assistant.js';
import { annotationAnchor, makeTextBox, makeTitleBlock, withParts } from '../src/state/annotations.js';
import { reducer, initialState, type Action, type ProjectState } from '../src/state/store.js';

const MODEL: SurveyDataModel = {
  metadata: { jurisdiction: 'ng-survey-plan', siteAddress: 'Plot 15, Adeola Close' },
  crs: {
    code: 'EPSG:26331',
    name: 'Minna / Nigeria West Belt',
    datum: 'Minna',
    units: 'metre',
    bearingConvention: 'quadrant',
  },
  points: [
    { id: 'PT1', coordinates: { easting: 544800, northing: 718900 }, provenance: { source: 'measured' } },
    { id: 'PT2', coordinates: { easting: 544830, northing: 718900 }, provenance: { source: 'measured' } },
    { id: 'PT3', coordinates: { easting: 544830, northing: 718920 }, provenance: { source: 'measured' } },
    { id: 'PT4', coordinates: { easting: 544800, northing: 718920 }, provenance: { source: 'measured' } },
  ],
  boundary: [ringFromPointOrder('ring_1', ['PT1', 'PT2', 'PT3', 'PT4'])],
  siteFeatures: [],
  notes: [],
};

function start(model: SurveyDataModel = MODEL): ProjectState {
  return { ...initialState(), model };
}

function run(state: ProjectState, ...actions: readonly Action[]): ProjectState {
  return actions.reduce(reducer, state);
}

/** The model as it stands after a sequence of actions. */
function after(...actions: readonly Action[]): SurveyDataModel {
  return run(start(), ...actions).model;
}

// ---------------------------------------------------------------------------
// Rule 1 — absent means "read it from the plan"
// ---------------------------------------------------------------------------

test('a new title block decides nothing about its own contents', () => {
  const block = makeTitleBlock({ easting: 0, northing: 0 });

  // The three that matter. A block that arrived with a title baked in would
  // stop following the plan the moment the site was renamed, and nothing in
  // the interface would say why.
  assert.equal(block.title, undefined);
  assert.equal(block.subtitle, undefined);
  assert.equal(block.scaleDenominator, undefined);
});

test('a typed title is the surveyor’s, and clearing it hands the field back', () => {
  const block = makeTitleBlock({ easting: 0, northing: 0 });
  const typed = after(
    { type: 'add-title-block', block },
    { type: 'update-title-block', patch: { title: 'Survey of Plot 15' } },
  );
  assert.equal(typed.titleBlock?.title, 'Survey of Plot 15');

  // Clearing it must remove the field rather than store an empty string —
  // "" is a title someone chose, `undefined` is the plan's own name.
  const cleared = run(
    start(typed),
    { type: 'update-title-block', patch: { title: undefined } },
  ).model;
  assert.equal(cleared.titleBlock?.title, undefined);
  assert.ok(
    !Object.prototype.hasOwnProperty.call(cleared.titleBlock ?? {}, 'title') ||
      cleared.titleBlock?.title === undefined,
  );
});

// ---------------------------------------------------------------------------
// Rule 2 — adding a part is additive
// ---------------------------------------------------------------------------

test('adding a part can only ever turn one on', () => {
  const block: TitleScaleBlock = {
    ...makeTitleBlock({ easting: 0, northing: 0 }),
    showTitle: true,
    showRepresentativeFraction: false,
    showScaleBar: false,
    title: 'Mine',
    scaleDenominator: 500,
  };

  const patch = withParts(block, { scaleBar: true });
  const merged = { ...block, ...patch };

  assert.equal(merged.showScaleBar, true, 'the part asked for did not appear');
  assert.equal(merged.showTitle, true, 'a part already on was turned off');
  assert.equal(merged.title, 'Mine', 'a typed title was overwritten');
  assert.equal(merged.scaleDenominator, 500, 'a chosen scale was overwritten');

  // The stronger statement: whatever is asked for, no key in the patch is
  // ever `false`, so there is no argument that turns a part off.
  for (const parts of [
    { title: true },
    { representativeFraction: true },
    { scaleBar: true },
    { title: true, representativeFraction: true, scaleBar: true },
    {},
  ]) {
    for (const [key, value] of Object.entries(withParts(block, parts))) {
      assert.notEqual(value, false, `withParts turned ${key} off`);
    }
  }
});

test('asking for one part twice changes nothing the second time', () => {
  const block = makeTitleBlock({ easting: 0, northing: 0 }, { title: true });
  const once = { ...block, ...withParts(block, { scaleBar: true }) };
  const twice = { ...once, ...withParts(once, { scaleBar: true }) };
  assert.deepEqual(twice, once);
});

// ---------------------------------------------------------------------------
// The chat command and the card are one code path
// ---------------------------------------------------------------------------

test('typed commands reach the same intent the card’s buttons carry', () => {
  const cases: readonly (readonly [string, Partial<Extract<Intent, { kind: 'add-title-block' }>>])[] = [
    ['add a title block', { title: true }],
    ['put the title on the plan', { title: true }],
    ['add a scale bar', { scaleBar: true }],
    ['show the scale bar', { scaleBar: true }],
    ['add the title and scale bar', { title: true, scaleBar: true }],
    ['add the scale as 1:500', { representativeFraction: true }],
    ['show the representative fraction', { representativeFraction: true }],
    ['add the title and scale', { title: true, scaleBar: true, representativeFraction: true }],
  ];

  for (const [question, expected] of cases) {
    const intent = titleScaleIntent(question);
    assert.ok(intent, `no intent for: ${question}`);
    assert.equal(intent.kind, 'add-title-block');
    for (const [key, value] of Object.entries(expected)) {
      assert.equal(
        (intent as Record<string, unknown>)[key],
        value,
        `"${question}" did not ask for ${key}`,
      );
    }
  }
});

test('the title/scale command does not swallow unrelated questions', () => {
  // The failure this guards: a broad "scale" match stealing the modify tool's
  // scale, and "title" stealing a question about land title.
  for (const question of [
    'how do I scale the building',
    'scale this drawing by 2',
    'is my title deed needed',
    'what is the area',
    'how do I export a pdf',
  ]) {
    assert.equal(titleScaleIntent(question), null, `stolen: ${question}`);
  }
});

test('the offer and the command produce the same model', () => {
  const at = { easting: 544800, northing: 718880 };

  // What the card's "Add all three" does.
  const fromCard = after({ type: 'add-title-block', block: makeTitleBlock(at) });

  // What typing it does, through the intent the chat produces.
  const intent = titleScaleIntent('add the title and scale');
  assert.ok(intent && intent.kind === 'add-title-block');
  const fromChat = after({
    type: 'add-title-block',
    block: makeTitleBlock(at, {
      ...(intent.title === undefined ? {} : { title: intent.title }),
      ...(intent.representativeFraction === undefined
        ? {}
        : { representativeFraction: intent.representativeFraction }),
      ...(intent.scaleBar === undefined ? {} : { scaleBar: intent.scaleBar }),
    }),
  });

  const shown = (model: SurveyDataModel) => ({
    showTitle: model.titleBlock?.showTitle,
    showRepresentativeFraction: model.titleBlock?.showRepresentativeFraction,
    showScaleBar: model.titleBlock?.showScaleBar,
    at: model.titleBlock?.at,
  });
  assert.deepEqual(shown(fromChat), shown(fromCard));
});

// ---------------------------------------------------------------------------
// Rule 3 — formatting is presentation only
// ---------------------------------------------------------------------------

/** Everything about a plan that is not how it looks. */
function substance(model: SurveyDataModel) {
  return JSON.stringify({
    points: model.points,
    boundary: model.boundary,
    siteFeatures: model.siteFeatures,
    metadata: model.metadata,
    crs: model.crs,
    notes: model.notes.map((note) => ({ ...note, style: undefined })),
    textBoxes: (model.textBoxes ?? []).map((box) => ({ ...box, style: undefined })),
    titleBlock: model.titleBlock ? { ...model.titleBlock, style: undefined } : undefined,
  });
}

test('formatting an annotation changes nothing but its appearance', () => {
  const box = makeTextBox({ easting: 544805, northing: 718890 }, 'Fence in poor repair');
  const block = makeTitleBlock({ easting: 544800, northing: 718880 });
  const base = after(
    { type: 'add-text-box', box },
    { type: 'add-title-block', block },
  );

  const styled = run(
    start(base),
    { type: 'set-text-style', id: box.id, style: { bold: true, fontSize: 18, color: '#b91c1c' } },
    { type: 'set-text-style', id: block.id, style: { italic: true } },
  ).model;

  assert.equal(substance(styled), substance(base), 'formatting reached something it should not');
  assert.equal(styled.textBoxes?.[0]?.style?.bold, true, 'the formatting did not apply');
  assert.equal(styled.titleBlock?.style?.italic, true);

  // The one that would be quietly catastrophic: a styled annotation losing
  // the tag that says who put it there.
  assert.deepEqual(styled.textBoxes?.[0]?.provenance, box.provenance);
  assert.deepEqual(styled.titleBlock?.provenance, block.provenance);
});

test('formatting a line leaves its geometry and its length alone', () => {
  const base = start();
  const before = runPipeline(base.model);

  const styled = run(base, {
    type: 'set-line-style',
    id: 'ring_1',
    style: { dashed: true, strokeWidth: 0.7, color: '#1d4ed8' },
  }).model;

  assert.equal(substance(styled), substance(base.model));

  // Measured through the engine rather than by reading fields back, because
  // what a surveyor would notice is the numbers on the plan changing.
  const afterStyling = runPipeline(styled);
  assert.deepEqual(
    afterStyling.ok ? afterStyling.rings : null,
    before.ok ? before.rings : null,
  );
});

test('moving an annotation moves nothing else', () => {
  const box = makeTextBox({ easting: 544805, northing: 718890 }, 'Note');
  const base = after({ type: 'add-text-box', box });
  const moved = run(start(base), {
    type: 'update-text-box',
    id: box.id,
    patch: { at: { easting: 544815, northing: 718875 } },
  }).model;

  assert.deepEqual(moved.points, base.points, 'a survey point moved with the note');
  assert.deepEqual(moved.boundary, base.boundary);
  assert.deepEqual(moved.textBoxes?.[0]?.at, { easting: 544815, northing: 718875 });
});

// ---------------------------------------------------------------------------
// Where a new annotation lands
// ---------------------------------------------------------------------------

test('the title block lands below the drawing, clear of the survey', () => {
  const pipeline = runPipeline(MODEL);
  assert.ok(pipeline.ok);
  const bounds = pipeline.drawing.bounds;

  const at = annotationAnchor(MODEL, bounds, 0, 'title-block');
  assert.ok(at.northing < bounds.min.northing, 'the title block landed on top of the survey');
});

test('a note does not land underneath the title block', () => {
  // The bug this is here for: both kinds shared one anchor, so the first note
  // added after a title block arrived under its plate — untappable, and
  // indistinguishable from nothing having happened.
  const pipeline = runPipeline(MODEL);
  assert.ok(pipeline.ok);
  const bounds = pipeline.drawing.bounds;

  const block = annotationAnchor(MODEL, bounds, 0, 'title-block');
  const note = annotationAnchor(MODEL, bounds, 0, 'text');

  const height = bounds.max.northing - bounds.min.northing;
  assert.ok(
    Math.hypot(note.easting - block.easting, note.northing - block.northing) > height * 0.1,
    'a new note lands on the title block',
  );
  assert.ok(note.northing <= bounds.max.northing, 'a note landed off the top of the drawing');
  assert.ok(note.northing >= bounds.min.northing, 'a note landed off the bottom of the drawing');
});

test('successive notes do not stack on each other', () => {
  const pipeline = runPipeline(MODEL);
  assert.ok(pipeline.ok);
  const bounds = pipeline.drawing.bounds;
  const height = bounds.max.northing - bounds.min.northing;

  const places = [0, 1, 2, 3].map((index) => annotationAnchor(MODEL, bounds, index, 'text'));
  for (let i = 0; i < places.length; i += 1) {
    for (let j = i + 1; j < places.length; j += 1) {
      const a = places[i]!;
      const b = places[j]!;
      assert.ok(
        Math.hypot(a.easting - b.easting, a.northing - b.northing) > height * 0.05,
        `notes ${i} and ${j} land on top of each other`,
      );
    }
  }
});

test('an annotation on an empty plan still has somewhere to be', () => {
  // No geometry means no bounds. It must not produce NaN — a text box at
  // NaN,NaN disappears with no error and no way to get it back.
  const at = annotationAnchor({ ...MODEL, points: [], boundary: [] }, null, 0);
  assert.ok(Number.isFinite(at.easting) && Number.isFinite(at.northing));
});

// ---------------------------------------------------------------------------
// The assistant only offers; it never writes
// ---------------------------------------------------------------------------

test('the assistant offers the title block rather than adding it', () => {
  const context: AssistantContext = { model: MODEL, pipeline: runPipeline(MODEL), suggestions: [] };
  const reply = respond('add the title and scale', context);

  // Whatever it says, the model it was handed still has no title block. The
  // only thing that adds one is the reducer, reached by a tap or by the
  // command path — never by the text of a reply.
  assert.equal(context.model.titleBlock, undefined);
  assert.equal(MODEL.titleBlock, undefined);
  assert.ok(reply);
});
