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
| [`packages/engine`](./packages/engine) | The deterministic engines: CRS, COGO, editing, snapping, validation, drawing, labelling, composition, export |
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

- **The site name in the title bar** opens Project: what the site is called,
  which jurisdiction's rules it is drawn under, and starting a new one. Starting
  over asks twice, and Undo still reaches back past it.
- **Select / Draw / Measure / Dimension** (B.3). Draw places boundary corners by
  tapping; a new corner is inserted into the edge it sits nearest, so the shape
  does not fold over itself. Measure reports bearing and distance between two
  taps, through the same COGO call the plan's dimensions use. Dimension does
  the same two taps but leaves the result on the plan.
- **Object snapping** latches a click onto a corner, a midpoint, a crossing, a
  perpendicular or the grid, and shows which. A snapped corner shares the other
  object's coordinate exactly — not to within a pixel — which is the difference
  between a drawing that computes correctly and one that only looks right.
- **Add** and **Modify** sit in the tool row, beside the mode picker. They are
  panels rather than modes, so they are buttons — and they are there because
  until recently they had no button at all: Add answered only to the `A` key
  and Modify to `E`, which on a phone meant the whole palette was invisible.
- **Editing** works on a selection: tap, shift-click or drag a box, then Modify.
  Move, copy, rotate, scale, mirror and offset all take a typed value, because
  a surveyor moving a building 3 m north means 3.000 m and no pointer can say
  that. An offset produces a real setback line — mitred corners, exactly the
  distance from the boundary anywhere you measure. **Array** repeats a
  selection on a grid — a terrace, a run of bays — with the whole grid turnable
  onto a bearing so it can follow a road rather than grid north. **Chamfer**
  splays a boundary corner off between its two legs, which is what a corner at
  a road junction usually is; a splay longer than the shorter leg is refused
  with the reason rather than quietly clamped to something that fits.

  Trim, extend, fillet, join and split exist in the engine, with tests, but
  have no UI yet: each needs the user to pick two entities on the canvas (or,
  for fillet, an arc inserted into the boundary ring), which is a canvas
  interaction rather than a form.
- **Dragging** covers the other half: when you want the fence *over there*,
  against that corner, you pick it up. Only something already selected can be
  dragged, so a stray gesture cannot move what you did not choose. The drag
  snaps, and commits once on release — one undo step for one gesture, not a
  hundred. A live readout shows the ground position under the cursor and how
  far the drag has gone.
- **Placed dimensions** (`I`) cover what no rule can infer: the setback from
  the house to the boundary, the width of a drive, the distance from a tree to
  a wall. A dimension stores which two points it measures between and nothing
  about the answer — the number comes from the COGO engine at draw time, so it
  cannot drift from the geometry it describes. Each end becomes a survey point
  if there is not one there already, for the same reason.
- **Layers** can be hidden or locked, which are two different things. Hiding
  takes a layer out of the way. Locking leaves it in view to work against — a
  boundary you are fitting a building to — while making it impossible to nudge.
- **Right-click, or hold a finger down**, for the actions that apply to what is
  under the pointer. Each one shows its keyboard shortcut, so using the menu is
  also how you stop needing it.
- **Add** (`A`) puts the rest of a site plan on the drawing: buildings and
  driveways, fences, walls and service runs, gates, trees drawn at their real
  canopy spread, spot heights, benchmarks and notes. Each is marked existing or
  proposed, and a level is printed from its elevation rather than typed as a
  label — so correcting the figure corrects the plan.
- **Keyboard**: `V`/`D`/`M`/`I` pick a tool, `A` adds, `E` opens Modify, `F` toggles snapping,
  `Delete` removes the selection, `Escape` clears it, `Ctrl+Z` / `Ctrl+Shift+Z`
  undo and redo.
- **Import** accepts a pasted table, an uploaded `.csv`/`.txt`, or a DXF
  drawing — pasted or uploaded, recognised by its own shape rather than by its
  file extension. A DXF put through the table extractor does not fail, it
  succeeds on group codes and hands back a survey of nonsense, so the two are
  told apart before either is read. The largest closed polyline is offered as
  the boundary and confirmed rather than applied. The table extractor
  finds the table inside whatever else came with it — a site name, a date, a
  rule under the headings, a total at the foot — works out the delimiter, the
  header and the column roles, and scores itself. Where it genuinely cannot
  tell — easting/northing order with no headings — it asks rather than picking
  the commoner convention.
- **Paste into the assistant** and it reads the data instead of answering a
  question about it. What it found comes back as a list you confirm; confirming
  loads the points and lays the plan out.
- **Photograph a note** with the camera button. The photo is transcribed and
  shown beside the numbers that were read from it, so the transcription is
  something you check rather than something you take on trust.
- **Traverse entry** takes a deed-style boundary as bearings and distances.
  Closure is computed and shown while you type, because on a traverse — unlike a
  coordinate boundary, which closes by construction — that number decides
  whether the survey is usable.
- **Review** lists the internal angle at every boundary corner beside the
  closure figures, with their total and what it should be — the check a
  surveyor runs by hand. They are computed from the same corners the area and
  the dimensions come from, so a plan checked against a deed shows the deed's
  figures rather than ones measured off the drawing.
- **The menu** (top left) opens a drawer with the app's sections. Profile is
  the identity that prints in the title block, stored once rather than typed
  per plan. Saved is the projects you have starred. Reports writes the survey
  out — summary, point schedule, traverse — from the same figures the plan is
  drawn from, at the same precision the jurisdiction prints, so the two
  documents cannot disagree. Documents keeps the deed, the brief and the
  photographed field note with the project, because when a boundary is
  questioned it is the paperwork that settles it. Settings holds the defaults
  and shows what this browser is storing. Help is the assistant's own task
  guides, the shortcuts and the ideas behind the app.
- **Logout** is honest about what it can be: there is no account, so it
  removes the app's data from this device — which is the real risk on a shared
  site tablet. It says exactly what goes before it goes.
- **Ask for a new project** and the assistant answers with the question that
  actually matters: what should happen to the plan you are leaving. Keeping it
  puts it in Projects; discarding deletes it. Either answer opens a blank
  sheet. It asks only when there is something to lose — an empty plan just
  becomes a new one.
- **Renumber** renames every point in boundary order, rebuilding the ring
  references as it goes — a plan whose corners read PT4, PT1, PT7, PT2 round
  the boundary is one a reviewer has to work at.
- **Revisions** are entered in Project and print in the corner of the sheet,
  newest first, so a reviewer comparing two prints can see which is later and
  what changed.
- **Projects** keeps every survey you have saved, with a thumbnail drawn from
  the stored geometry, when it was last edited, how big it is, and a version
  history. Open, rename, duplicate, delete, or restore an earlier version —
  restoring is itself undoable, because losing the present to recover the past
  is not a recovery feature. Reached from the site name in the title bar.
- **Work is saved** as it changes, debounced, into the open project. A version
  is snapshotted at most once a minute: every keystroke in a coordinate field
  is an edit, and two hundred near-identical versions is a list to scroll past
  rather than a history. Pending AI suggestions deliberately do not survive a
  reload. Storage is this browser only — no sync, and clearing site data clears
  the library.

### What the AI layer does

`apps/web/src/ai/assistant.ts` decides intent: what to say, what to offer, and
what to propose. It proposes geometry as ordinary survey data tagged
`ai-suggested`; the engines derive every dimension, area and label from it once a
human accepts.

It is also the way through the interface. `TASKS` in that file is every action
the app can perform, with the steps and — where the app can simply do it — the
button that does.

### Understanding the question

**The model decides what you meant. The engines decide what is true.**

`apps/web/src/ai/classification.ts` asks a model for a structured
classification, not an answer: a restatement of what you meant, which
capability handles it, whether it is in scope, and how sure it is. The app then
decides what to do with that — the "act or ask" decision belongs to the app,
because handing it to the party that produced the guess would make the
confidence level decorative.

| Verdict | What happens |
|---|---|
| in scope, `high` | the capability's responder answers, reading every figure off the pipeline |
| in scope, `medium` | the same, prefixed with what it assumed, so a misread is visible |
| `low` or `ambiguous` | it asks, with the readings it was choosing between offered as buttons |
| out of scope | it says so in its own words, and says what it is for |

The scope is declared once in `apps/web/src/ai/scope.ts` and feeds all three
consumers: the model's brief, the tool schema, and the router. A scope the model
believes in and a router that disagrees is an assistant that promises things the
app cannot do.

What the model never gets is the number. Every survey value comes from `answer`,
which calls the same deterministic responders the offline planner uses, so a
classification can send a reply to the wrong subject but cannot put a wrong
figure in it. No field in the classification schema accepts a number at all —
that is structural, not a matter of prompting.

Recent turns go with each request, so "what about the garage?" and a bare "yes"
after a clarifying question mean something.

Two planners implement the same interface. Without an endpoint the assistant
falls back to keyword scoring (`bestByKeyword`) — a worse assistant, but one
that needs no credentials and still answers the common questions. Every model
failure lands there too: a rejected classification, a timeout, an unreachable
endpoint. A language model drives it instead when configured:

```bash
ANTHROPIC_API_KEY=... npm run assistant --workspace @surveyor/web
VITE_ASSISTANT_ENDPOINT=http://127.0.0.1:8787/assistant npm run dev
```

The app is given a **URL, never a key** — this is a browser application, and a
key shipped to the browser is a key published to every user, so the model is
reached through an endpoint the operator hosts (`apps/web/server/assistant.mjs`
is a working reference).

Reading a photographed note goes to a second endpoint
(`apps/web/src/ai/vision.ts`), and the model is asked for one thing: a
transcription of the characters on the page. Deciding that the second column is
a northing is a claim about the *survey*, and that stays with `extractPoints` —
deterministic, tested, and scoring its own confidence. A model that returned
finished points would be authoring survey values. The transcription is a claim
about the *document*, which is why the photo is shown next to the numbers: it is
the one part you can check by looking.

The model is bounded twice. A strict tool schema
(`apps/web/src/ai/classification.ts`) enumerates the capabilities and confidence
levels, with no numeric field anywhere. Then `validateClassification` re-derives
every field and rejects whatever it cannot account for — an invented capability,
an argument naming a task or panel that does not exist, a `show` target that is
not on the drawing, a reply claiming to be in scope while naming nothing that
handles it. The schema is the seatbelt; the validator is the crumple zone.

### On a big drawing

Everything above was written for a single plot, so it was measured on
something much larger: an estate of buildings on a grid, opened cold.

| Features | Paint | Pan, fitted | Pan, zoomed in |
| --- | --- | --- | --- |
| 10 (the sample) | 109 ms | flat | flat |
| 200 | 176 ms | flat | flat |
| 600 | 315 ms | ~170 ms of render over 30 frames | flat |
| 1500 | 682 ms | ~950 ms over 30 frames | flat |

Two things make that possible, and both were added after measuring rather
than before. Elements outside the view are skipped, tested by extent so a
boundary running clear across the screen is kept even though both its ends
are off it — which is why panning while zoomed in costs the same at 1500
features as at 10. And label placement indexes its collision sets by
position: it used to search every obstacle for every candidate position of
every label, which at 600 features was over eight million segment tests and
a second and a half of frozen tab. It is now roughly linear in the size of
the drawing.

The remaining honest limit is panning with a very large drawing entirely on
screen — 1500 features fitted is about 30 ms a frame, because that many SVG
elements genuinely have to be re-projected. Zooming in fixes it, and that is
what anyone editing such a drawing does anyway.

## Testing

```bash
npm test                                    # 208 tests across contracts, engine and web
npm run smoke --workspace @surveyor/web     # browser flows (needs a preview server)
```

The smoke test drives the trust loop, the export gate, the drawing and measuring
tools, CAD editing, drawing entities, the project library, import, a messy paste, pasting into the assistant, starting
a new project, asking the assistant for help, traverse entry and persistence in
a real browser, and fails on console errors, on-screen label collisions, or horizontal
overflow at any breakpoint.

The web suites treat model output as hostile input — off-vocabulary actions,
invented element ids, malformed and oversized replies, transport failures, hangs,
and a transcription endpoint that returns prose instead of a table.

```bash
npm run build --workspace @surveyor/web
npx vite preview --port 4173 &
npm run smoke --workspace @surveyor/web
```

The classifier needs its own pass, because the endpoint is inlined at build
time and a build without one can never exercise the model path:

```bash
cd apps/web
VITE_ASSISTANT_ENDPOINT=/__classify npx vite build
npx vite preview --port 4174 &
SMOKE_URL=http://127.0.0.1:4174/ npm run smoke:classifier
```

It stubs the endpoint and checks the half that is ours: the conversation is
sent, a classification is validated before it is believed, an unsure reading
asks instead of answering, and the figure in the reply comes from the engine —
the stub deliberately returns a wrong one, and it must not reach the screen.

## Deploying

[`vercel.json`](./vercel.json) configures the monorepo: Vercel installs at the
repository root, runs `npm run build` — which builds `contracts`, then `engine`,
then the app — and serves `apps/web/dist`. Import the repository in Vercel with
the root directory left as `./` and no further settings are needed.

The app runs entirely in the browser, so a default deployment needs no
environment variables and no server. Two are optional:

| Variable | Where | Effect |
|---|---|---|
| `VITE_ASSISTANT_ENDPOINT` | Build | Set to `/api/assistant` to route the assistant through the model. Unset, the app uses its rule planner. |
| `VITE_EXTRACT_ENDPOINT` | Build | Set to `/api/extract` to enable reading photographed notes. Unset, the camera button says so and points at pasting. |
| `ANTHROPIC_API_KEY` | Runtime | Read by both functions. Unset, they reply 503 and the app falls back to what it can do without them. |

`api/assistant.js` is the local reference server
(`apps/web/server/assistant.mjs`) as a serverless function; `api/extract.js`
transcribes photographs. Both exist so the deployed app can reach a model
without the browser holding a key. Both are **unauthenticated and spend your
Anthropic credits on every call**, and `api/extract.js` also accepts an image
upload. The same-origin check in them stops another site's browser code from
using them; it does not stop anyone with `curl`. Put authentication and rate
limiting in front of them before pointing real traffic at them.

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

Text extraction (`packages/engine/src/document.ts`) finds the table inside a
page, infers its structure and scores its confidence — for a paste, an uploaded
file, a message to the assistant, or a transcribed photograph, all of which
arrive at the same function. It handles grouped thousands in both conventions,
quoted CSV, axis letters written against the values, and notes too ragged to
have columns at all; where a reading is genuinely undecidable it says so rather
than choosing.
