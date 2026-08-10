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

### What the AI layer does

`apps/web/src/ai/assistant.ts` decides intent: what to say, what to offer, and
what to propose. It proposes geometry as ordinary survey data tagged
`ai-suggested`; the engines derive every dimension, area and label from it once a
human accepts. The planner is deterministic and rule-based — swapping it for a
language model changes only that file, because the intent vocabulary, the
proposal shapes and the trust loop are the contract.

## Testing

```bash
npm test                                    # 84 tests across contracts and engine
npm run smoke --workspace @surveyor/web     # browser flows (needs a preview server)
```

The smoke test drives the trust loop, the export gate and survey-data editing in
a real browser, and fails on console errors, on-screen label collisions, or
horizontal overflow at any breakpoint.

```bash
npm run build --workspace @surveyor/web
npx vite preview --port 4173 &
npm run smoke --workspace @surveyor/web
```

## Status

The pipeline, the exporters and the workspace are built and working end to end.
Not yet done: Document AI/OCR ingestion has its contract and confidence plumbing
(`DocumentExtraction` in `packages/engine/src/input.ts`) but no extractor behind
it, and the assistant's planner is rule-based rather than a language model.
