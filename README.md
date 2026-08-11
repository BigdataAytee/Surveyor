# Surveyor

AI-powered survey plan drafting agent — turns raw survey data (points, bearings, distances) into professional, labelled site plans via a deterministic geometry/COGO pipeline with AI-assisted labelling, wrapped in a mobile-first CAD-grade UI.

## The central rule

> **The AI decides intent. The engines decide geometry. Every value on the page carries a provenance tag.**

No AI-authored coordinate or survey value reaches a finished plan. The UI's job is to make that visible, not to hide it.

## Repository map

| Path | What it is |
|---|---|
| [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) | Full system architecture — Part A (data & geometry), Part B (experience layer), Part C (cross-cutting contract) |
| [`docs/contracts/LABEL_SPECIFICATION.md`](./docs/contracts/LABEL_SPECIFICATION.md) | The AI ↔ Label Placement Engine contract, formalized |
| [`packages/contracts`](./packages/contracts) | Shared types and structural guards for the Part A ↔ Part B boundary |
| [`packages/engine`](./packages/engine) | The deterministic engines: CRS, COGO, validation, drawing, labelling, composition, export |
| [`apps/web`](./apps/web) | The mobile-first workspace: canvas, assistant, data entry, review, export |

## Getting started

```bash
npm install
npm test          # engine + contracts test suites
npm run dev       # the workspace at http://127.0.0.1:5173
```

Other useful commands:

```bash
npm run typecheck                                   # every workspace
npm run build                                       # every workspace
node packages/engine/scripts/sample-plan.mjs        # render a plan to SVG/PDF/DXF
```

## How it fits together

```
Survey Data Model
      │
      ▼
CRS ─► COGO ─► Validation ─► Drawing ─► Labelling ─► Composition ─► PDF / DXF / SVG
                    │                                     │
                    └── ValidationSheet                   └── export gate
                                                              (blocks ai-suggested)
```

`runPipeline(model)` runs the whole chain and emits a stage event as each engine
starts and finishes. The UI's progress list is driven by those events, so it
reports real progress rather than animating a timer.

### What the engines guarantee

- **Nothing is invented.** Label text is rendered from the Survey Data Model
  through a template registry; the AI supplies a template id and references, never
  a number. See `packages/engine/src/labeling/templates.ts`.
- **Nothing is silently corrected.** A traverse that does not close, a boundary
  that crosses itself, or a coordinate system that cannot be determined stops the
  pipeline with a plain-language question and a set of options.
- **Nothing unconfirmed is exported.** `composePlan` refuses while any label is
  still `ai-suggested`, and names the ones blocking it.

### Working in the app

- **Select / Draw / Measure** (B.3). Draw places boundary corners by tapping;
  a new corner is inserted into the edge it sits nearest, so the shape does not
  fold over itself. Measure reports bearing and distance between two taps,
  through the same COGO call the plan's dimensions use.
- **Import** accepts a pasted table or an uploaded `.csv`/`.txt`. The extractor
  works out the delimiter, the header and the column roles, and scores itself.
  Where it genuinely cannot tell — easting/northing order with no headings — it
  asks rather than picking the commoner convention.
- **Traverse entry** takes a deed-style boundary as bearings and distances.
  Closure is computed and shown while you type, because on a traverse — unlike a
  coordinate boundary, which closes by construction — that number decides
  whether the survey is usable.
- **Work is saved** to local storage as it changes, debounced. Pending AI
  suggestions deliberately do not survive a reload.

### What the AI layer does

`apps/web/src/ai/assistant.ts` decides intent: what to say, what to offer, and
what to propose. It proposes geometry as ordinary survey data tagged
`ai-suggested`; the engines derive every dimension, area and label from it once a
human accepts.

Two planners implement that interface. The default is rule-based and needs no
credentials. A language model can drive it instead:

```bash
ANTHROPIC_API_KEY=... npm run assistant --workspace @surveyor/web
VITE_ASSISTANT_ENDPOINT=http://127.0.0.1:8787/assistant npm run dev
```

The app is given a **URL, never a key** — this is a browser application, and a
key shipped to the browser is a key published to every user, so the model is
reached through an endpoint the operator hosts (`apps/web/server/assistant.mjs`
is a working reference).

The model is bounded twice. A strict tool schema
(`apps/web/src/ai/intent-schema.ts`) enumerates the intent vocabulary, and
nothing in it accepts a number — so a model cannot express a coordinate,
dimension, or bearing. Then `validateProposal` re-derives every action from
scratch and rejects whatever it cannot account for, checking `show` targets
against the ids actually in the survey. The schema is the seatbelt; the
validator is the crumple zone. A rejected reply falls back to the rule planner,
so the assistant degrades rather than going silent.

## Testing

```bash
npm test                                    # 119 tests across contracts, engine and web
npm run smoke --workspace @surveyor/web     # browser flows (needs a preview server)
```

The smoke test drives the trust loop, the export gate, the drawing and measuring
tools, import, traverse entry and persistence in a real browser, and fails on
console errors, on-screen label collisions, or horizontal overflow at any
breakpoint.

The web suite (`apps/web/test/intent-schema.test.ts`) treats model output as
hostile input: off-vocabulary actions, invented element ids, malformed replies,
oversized replies, transport failures and hangs.

```bash
npm run build --workspace @surveyor/web
npx vite preview --port 4173 &
npm run smoke --workspace @surveyor/web
```

## Status

The pipeline, the exporters, the workspace and the model seam are built and
working end to end. Points, pasted tables and deed traverses all enter; the
engines compute; the plan exports to PDF, DXF and SVG once every value is
confirmed.

The assistant ships with the rule planner as its default because that needs no
credentials, not because the model path is unfinished. Both planners implement
one interface, and a language model gets exactly the authority the rule planner
has — which is none over coordinates or survey values. Running against a real
model needs only an endpoint URL; what that endpoint returns is validated by
tests that require no key.

Text extraction (`packages/engine/src/document.ts`) infers structure and scores
its confidence for pasted and uploaded tables. Vision/OCR plugs into the same
seam: produce a `DocumentExtraction` with honest per-field confidences and
nothing downstream changes.
