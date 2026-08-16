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

### Coordinate systems

A new plan is drawn on **Minna / UTM zone 31N** (`EPSG:26331`) under the
**Nigeria — survey plan** template, with whole-circle bearings. The other four
Nigerian systems on the Minna datum are offered beside it — UTM zone 32N and
the West, Mid and East Belts — and so are the systems for elsewhere, so a
survey brought in from another country can still say what it is.

Two things about this deserve stating plainly.

**Picking a system records what the survey was measured in; it does not
reproject it.** The same easting and northing is a different place on the
ground in each system, and a conversion needs the datum transformation for the
area. Quietly moving a surveyor's figures because a dropdown changed would be
the app authoring survey values, which is the one thing it does not do. Pick
the wrong one and the plan is mislabelled and can be corrected; rewrite the
numbers and there is no way back.

**No scale factor is assumed.** UTM's is 0.9996 on the central meridian and
about 1.0004 at the edge of a zone, and the combined factor also depends on
height. There is no correct constant, so distances are treated as grid
distances until a surveyor supplies the factor for their site.

The engine's central rule is unchanged by any of this: a *default* is what a
blank sheet starts on, never an inference. An imported survey naming a system
the app does not know still halts and asks, and one naming `EPSG:27700` still
gets the British National Grid.

### Putting the survey on a map

Maps speak WGS 84 and nothing else, and the survey is in Minna. The workflow,
in `packages/engine/src/geodesy`, is one direction only:

```
the survey stays in Minna  →  a converted copy is made  →  the map uses the copy
```

Nothing is written back. `wgs84Copy(model)` reads the Survey Data Model and
returns a *separate* structure — not a modified model, not a model at all. The
Minna eastings and northings stay exactly as measured for viewing, editing,
exporting and the survey record, because those are the numbers on the plan that
gets lodged and they are the legal description of the parcel. The Map panel is
the only place in the app that works in degrees.

The conversion is done properly, not approximated:

| Step | How |
|---|---|
| Grid → geographic | Transverse Mercator, Redfearn series, on Clarke 1880 (RGS) — the ellipsoid Minna is defined on, not one of the other Clarke 1880s |
| Geographic → geocentric | Exact, on the source ellipsoid |
| Datum shift | Helmert. Minna → WGS 84 uses **EPSG:1310, "Minna to WGS 84 (1)"** — a geocentric translation of −92, −93, +122 m, stated accuracy of the order of 3 m |
| Geocentric → geographic | Iterated to double precision, not Bowring's approximation |

Nothing is guessed. A grid the app has no projection for, or a datum with no
named transformation, produces a refusal that names what is missing — never a
number. That matters more than it sounds: an invented datum shift produces
coordinates that plot beautifully on a satellite image and are a hundred metres
from the truth, and nothing downstream can notice.

The transformation's accuracy travels with everything it produces — on screen,
and in the properties of every GeoJSON file. A position good to a few metres is
exactly right for finding a site and exactly wrong for setting a boundary peg,
and the only way anyone can tell which they are holding is if the number is
attached to it. A surveyor with parameters derived from control observed in
their own area can supply them through the `transformation` option, and they
replace the national set rather than adjusting it.

The projection is checked against numerical integration of the meridional
radius of curvature rather than against itself, the same place converts
identically whether it was computed on UTM zone 31N or the West Belt, and the
Minna shift is asserted to move a position by the order of magnitude that datum
is known to differ by — a shift of a few metres would mean it had not been
applied, one of several kilometres would mean the wrong ellipsoid or a sign
error, and both are invisible on a map.

#### The map itself

A slippy map, hand-rolled, in about two hundred lines. Leaflet or MapLibre
would each add a few hundred kilobytes and a second interaction model to an app
that is already a canvas with its own gestures, and what is needed here is: put
these tiles in a grid, put this parcel on top, let a thumb move it. Pan, pinch,
wheel and buttons; the tile arithmetic lives in
`packages/engine/src/geodesy/web-mercator.ts` where it is tested.

Web Mercator is display arithmetic and is kept away from everything else. It
treats the earth as a sphere, which is right for deciding which pixel something
lands on and wrong by up to twenty kilometres for anything measured — so it is
fed degrees from the converted copy and no survey value passes through it.

Two basemaps, switched from a control on the map itself:

| Layer | Source | Why |
|---|---|---|
| **Streets** (default) | OpenStreetMap | Which road the plot is off, and what the neighbours are called |
| **Satellite** | Esri World Imagery | What is actually standing on it |

Neither replaces the other, and both credit their source under the map —
attribution is a licence condition for each, not decoration. A deployment with
its own licensed imagery can replace either through `VITE_MAP_TILES` /
`VITE_MAP_SATELLITE_TILES` and their attribution variables; anyone deploying
this should satisfy themselves that their use sits within the provider's terms.

**Switching layer cannot move the parcel**, and that is structural rather than
careful. The overlay is positioned from the view — centre and zoom — and takes
no layer argument, so there is no seam for one to reach through. What *could*
break it is a provider on a different tile scheme: 512-pixel tiles, or a TMS
origin at the bottom of the world. Every layer therefore states its scheme and
the map asserts it, because a layer that got this wrong would draw a thoroughly
convincing map with the boundary in the wrong field.

Each layer also states how deep its imagery goes. Past that the last real level
is stretched rather than requesting tiles the provider does not have — which
would be a wall of 404s on somebody else's server, and a blank screen at exactly
the zoom a surveyor most wants.

Tiles that have actually been looked at are kept in their own capped cache, so
a surveyor who viewed the site with signal sees it again without. That is a
cache of what someone looked at, not a download of a region — the thing tile
providers ask people not to do. When tiles cannot be fetched at all the map
does not break: the failed ones are hidden rather than left as broken-image
borders, the parcel is still drawn from the converted coordinates, and the map
says why the background is empty.

### Working in the app

- **The site name in the title bar** opens Project: what the site is called,
  which coordinate system it was measured in, which jurisdiction's rules it is
  drawn under, and starting a new one. Starting over asks twice, and Undo still
  reaches back past it.
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

## Annotations: the title block, the scale and free text

Text on the sheet is not survey data, and the code says so structurally rather
than by convention. The heading and free text boxes live in their own layer,
carry no provenance beyond "a person put this here", and nothing about them
feeds the geometry — moving a note changes no bearing, no area and no
coordinate.

**The heading is laid out the way a lodged survey plan lays it out**: centred
*above* the drawing, as separate underlined lines — title, scale, scale bar,
`ORIGIN:-`, `AREA:-` — with no box around any of it. That is modelled on a
real Nigerian plan rather than on a CAD tool's title block, and it is not a
style preference: a plan's heading is a series of distinct claims, each
underlined so a reader can check them one at a time, and the underline is what
separates them where there is no box to. Origin and area are on by default,
because a plan that does not state the origin its bearings were measured from
cannot be re-established on the ground.

Each line is **its own object** — separately shown, moved, tapped and deleted.
Tapping the scale bar selects the scale bar; dragging it moves only it;
deleting it hides that line rather than the heading. Lines that have not been
moved stack automatically, so a heading nobody has rearranged stays tidy, and
"Line them back up" puts a rearranged one back.

The heading grows **upward** from its anchor, and that detail is load-bearing:
its height is text, so it is pixels, while its clearance from the drawing is
ground. Stacking downward meant the clearance shrank as you zoomed out while
the heading did not, and the `AREA:-` line ended up written across a boundary
dimension. Pinning its bottom to the anchor makes it impossible at any zoom,
which the smoke run checks at three of them.

They *are* positioned in survey coordinates, which is not a contradiction: an
annotation pinned to the screen would slide across the drawing on every pan,
and a note reading "fence in poor repair" is about a place. It travels with the
plan; it is simply not part of it.

One rule governs the whole layer, and it is written into the types: **a field
that is present was decided by the surveyor, a field that is absent is read
from the plan, and only absent fields may ever be filled in.** So a title block
follows the site name until somebody types a title, and from that moment
nothing regenerates it. "Add scale bar" is additive by construction — the patch
it produces can turn a part on and has no way to turn one off.

**The scale bar is drawn at its true on-screen length.** A bar that did not
shrink as you zoomed out would be a measuring stick that lies, which is worse
than no bar at all — so the smoke test measures the drawn bar against two
survey points of known separation and fails if the two disagree by more than
2%. `chooseScale` rounds *out* to the next standard scale, so a plan is never
drawn larger than its sheet.

**Formatting is presentation and nothing else.** `set-text-style` and
`set-line-style` are the only way to change appearance, and neither reducer
case can reach a coordinate, a calculated value or a provenance tag. A bold
dimension is the same dimension.

The assistant offers the heading once, when a boundary first validates, and the
typed command and the card's buttons go through **one shared handler** — so
they cannot drift apart. The assistant still only ever offers; the reducer is
the only thing that writes.

Related: a plan may state an area that disagrees with the computed one, which
raises `area-mismatch` as a *question* about which figure the plan should
state, not as a correction. The engine does not know which is right.

## Working offline

A survey happens where the survey is, and that is regularly somewhere with no
signal. So the app is built to open and work with the radio off, and to catch
up by itself afterwards.

**It opens.** A service worker (`apps/web/src/offline/sw.js`, precache list
filled in at build time by `apps/web/scripts/sw-plugin.mjs`) keeps the app
shell on the device. Without it none of the rest matters: the engines, the
canvas and the rule planner are all already in the browser, but a failed
request for `index.html` means a blank page. Requests under `/api/` are never
cached — a stale answer about who is signed in, or a model reply served from
cache an hour late, is worse than no answer.

**The assistant answers.** With no network it does not attempt one. That is the
difference between an answer now and twenty seconds of spinner before the same
answer, because a request with no route sits until it times out. The reply
comes from the rule planner, is labelled as an offline answer rather than
passed off as the full one, and offers to ask again once there is signal. The
figures are identical either way — every survey value comes from the engines,
and the model only ever chose which question was being asked.

**Photographs are kept.** Reading handwriting off a photo is the one thing here
that genuinely needs a server. Refusing it on site means the surveyor writes
the page out by hand or drives back, so instead the photo goes into a queue
(`apps/web/src/state/outbox.ts`) and is read when there is signal — even if
that is an hour later with the tab closed. The transcription then waits in the
queue until someone has actually confirmed it, and enters the survey through
the same offer-and-confirm card as one read a second after the shutter.
Provenance does not get weaker because the network was slow.

The queue holds to four rules, each of which is a test:

| Rule | Why |
|---|---|
| Nothing is dropped silently | A queue that discards work is worse than none, because the work looked safe |
| Nothing is retried forever | After five attempts an item is parked, still visible, no longer hammering a server that has said no |
| A refusal is not a retry | A photo with no coordinates on it will be refused identically every time |
| One drain at a time | Two drains racing is how one photograph gets transcribed — and charged for — twice |

Photos go to IndexedDB rather than local storage, which is where the projects
live. A page of levels is a few hundred kilobytes; queueing three of them in a
five-megabyte quota shared with someone's surveys means a queued photo can push
out a plan, and that is the wrong thing to lose.

The header shows a small pill when — and only when — the connection is gone or
something is waiting. An app that shows a green "online" badge at all times has
spent a permanent piece of a phone screen on the normal case and taught
everyone to ignore the one place that would have told them something was wrong.

**What this does not do.** Projects still do not follow you between devices.
The queue sends work *up* to the services the app already uses; it is not
account-backed project sync, which needs somewhere on the server to put them.
`STORAGE_NOTE` in `state/library.ts` says so in the UI too.

## Accounts and signing in

**A deployed build opens on the sign-in page.** `vercel.json` sets
`VITE_AUTH_ENDPOINT=/api/auth` at build time, so the front door of the
deployed app is the login screen and the workspace is behind it. There is no
way round it while the accounts service is answering — a "skip this" button
beside a working sign-in form is a front door with the key taped to it.

A local build with no `VITE_AUTH_ENDPOINT` still opens straight into the
drawing, which is what `npm run dev` should do.

The gate has exactly one escape, and it is on a different screen. When the
service cannot be reached at all — no signal, or not deployed — the app says
so and offers **Work without an account**, because signing in is impossible
there and telling someone to do it anyway sends them round a loop they cannot
leave, while the drawing tools need no network. That choice is not remembered
between visits: skipping sign-in is a decision about right now, and quietly
remembering it produces an account nobody ever uses again.

Every non-2xx from the endpoint is treated as *unreachable*, never as "signed
out". The difference is the whole behaviour: signed out means show a form, and
a form that submits into a 404 or a 503 can never succeed. A build pointed at
an endpoint that is not deployed used to present exactly that.

### Turning it on

The function needs somewhere to keep accounts, and refuses to run without one
rather than accepting registrations it will lose. Attach a Redis — **Vercel KV**
or **Upstash** from the marketplace — and that is the whole setup: both inject
`KV_REST_API_URL` and `KV_REST_API_TOKEN` (or the `UPSTASH_REDIS_REST_*`
equivalents), and `api/auth.js` picks either pair up on its own.

Redis over its REST interface rather than a database driver, for one reason: it
needs nothing but `fetch`. A Postgres adapter would mean a dependency and a
connection pool, and pools behave badly across serverless invocations.
Everything the store keeps is small, keyed, and has a natural expiry.

Until a store is attached the endpoint answers 503 and the app shows that
message with the offline escape, so a half-configured deployment explains
itself instead of presenting a login that cannot work.

None of the authority lives in the browser. `apps/web/src/auth` asks the server
who is signed in and shows the answer; the session is an HttpOnly cookie the
page cannot read, because a token JavaScript can read is a token any injected
script can steal. A login checked in the browser protects nothing.

The server side is in [`api/`](./api), dependency-free and built on
`node:crypto` alone:

| File | What it is |
|---|---|
| `api/_auth-core.mjs` | Hashing, sessions, roles, one-time links, lockout, cookies, the audit trail. No HTTP, no storage — the part worth testing hard |
| `api/_auth-store-file.mjs` | A JSON-file store for development and self-hosting. Its header carries the whole store interface and the equivalent SQL |
| `api/_auth-store-kv.mjs` | The same interface over Redis-and-HTTP, which is the one that works on serverless |
| `api/_auth-routes.mjs` | Every action, shared verbatim by the serverless function and the local server |
| `api/_mailer.mjs` | Verification and reset mail, as a webhook. No SMTP client and no mail dependency |
| `api/_telemetry.mjs` | What the app is allowed to report, as a whitelist applied on the server |
| `api/_admin-routes.mjs` | The console's read routes and the one route that writes |
| `api/auth.js`, `api/admin.js` | The Vercel functions |
| `apps/web/server/auth.mjs` | Both sets of routes over `node:http`, for local work |

What it does, and why:

- **scrypt** (N=32768, r=8, p=1, 64-byte key) with a per-account salt, the
  parameters stored alongside the hash so they can be raised later without
  invalidating anyone. Compared with `timingSafeEqual`.
- **Session tokens are hashed at rest.** Someone who reads the session table
  still cannot sign in as anybody.
- **An unknown address and a wrong password give the same answer**, and take
  the same time — an unregistered address is verified against a generated decoy
  hash, so the response time does not report whether you have an account here.
- **Lockout** after 8 failed attempts for 15 minutes, counted per address.
- **Origin checked** on every state-changing request, as a second lock behind
  `SameSite=Lax`.
- **Changing a password ends every session**, including the one that changed
  it, and requires the current password — a session left open on an unattended
  machine must not be enough to lock its owner out.

- **Sessions renew as they are used**, up to a ceiling. Opening the app pushes
  the expiry out and hands the browser the new lifetime on the way past, so
  nobody is signed out mid-task; a 90-day absolute cap is what keeps the
  sliding window bounded rather than "forever, as long as you open it". This is
  what a refresh token is for, in the shape a *server-side* session actually
  wants: a refresh token exists because a stateless token cannot be extended,
  and a session row can simply be given a later expiry. Two half-implemented
  mechanisms doing one job is the usual cause of being randomly logged out.

### Verification and password reset

Both work by putting a one-time link in somebody's inbox, and both rest
entirely on one property: **a token that was emailed never comes back over
HTTP.** If it did, anyone could confirm any address and reset any password, and
both steps would be ceremony. `smoke-verify.mjs` checks that directly — it
captures the mail with a real HTTP server and then greps every response for
every token that was sent.

Mail is a **webhook**, not an SMTP client: the server POSTs a small JSON body to
whatever `AUTH_MAIL_WEBHOOK` names, and that endpoint is somebody's
transactional provider, their own relay, or a queue. An auth path is a bad
place to take on a dependency, and every provider worth using accepts a POST.

With no webhook configured the link is written to the server log and the caller
is *told* delivery failed, rather than being shown "we sent you an email" that
was not sent. That is also why verification defaults to being required exactly
when mail can be delivered: switching it on with no mailer would make every new
account permanently unusable, and the person who did it would have no account
left to undo it with.

The rest of it:

- A reset **ends every session for that account**, including the attacker's —
  a reset is what somebody does when they think another person has their
  password, so leaving that person signed in makes it a formality.
- A reset also **marks the address confirmed**: they received mail at it and
  acted on it, which is the evidence verification asks for. Without this
  someone could reset their password and still be refused at sign-in, with no
  way out of the loop.
- A rejected new password **does not cost you the link** — a fresh one comes
  back with the error, so a typo is a retry rather than a trip to the inbox.
- Verification is checked **after** the password, so "verify your email" is
  never an answer to a wrong guess and can never be used to ask whether an
  address has an account here.
- `request-reset` and `resend-verification` answer **identically for every
  address**, existing or not. Signup is the one route that says plainly the
  address is taken, and only because it cannot do otherwise: signup cannot
  create a duplicate, so any wording at all reveals the same thing, and a vague
  one only costs a real person a refusal that does not say why.

### Roles

Two levels: `surveyor`, and `developer`/`admin` for the console.

**Nothing in a request can set a role.** Not that the value is validated and
rejected — `register` has no parameter to put one in, so no request body,
however shaped, has anywhere to land. Roles come from `AUTH_ADMIN_EMAILS`,
which is deployment configuration, or from an existing admin through the
console. A test tries six shapes of the attempt and asserts all six produce a
surveyor.

Losing a role **ends that account's sessions immediately**, rather than at
their own expiry — otherwise revocation is a request rather than a revocation.
The last admin cannot demote themselves, because a deployment with no admin has
no way back except editing the database by hand.

Two honest limits. The file store is for development and single-host
self-hosting; it is not safe on serverless, where instances do not share a
disk, which is why `api/auth.js` **refuses to start** (503) rather than
silently losing accounts when `AUTH_STORE` is not configured for a real
database. And the audit trail is capped at a window of recent activity rather
than kept forever — the console shows what is happening now, and anyone who
needs a permanent record should ship the events somewhere that keeps them.

Running it locally:

```bash
npm run auth --workspace @surveyor/web     # accounts on http://127.0.0.1:8788
VITE_AUTH_ENDPOINT=http://127.0.0.1:8788/api/auth npm run dev --workspace @surveyor/web
```

## The admin console

A **separate surface**, at `/admin/`, with its own HTML entry, its own bundle
and its own stylesheet. It shares no navigation, no state and no design system
with the app, and it registers no service worker.

That separation is not tidiness. Two things follow from it:

- **Security.** Provenance trails and error traces across every project on a
  deployment must never be reachable from a surveyor's account, even by
  guessing the URL. Every route re-reads the role the *server* has stored for
  the session; the browser is never asked. A signed-in surveyor gets a **404**,
  not a 403 — somebody who guessed the URL should learn there is nothing at it
  rather than that there is something worth trying harder to reach.
- **Clarity.** The app is deliberately calm and non-technical. A monitoring
  console is the opposite: dense tables, fixed-width numbers, timestamps. These
  should never share screens, and a shared stylesheet is how two surfaces with
  opposite jobs slowly become one that suits neither.

It is **read-mostly**. Exactly one control changes anything — granting a role —
and it writes an audit event naming who did it, to whom, and when. There is no
route that edits a plan; not "no button", no route. An admin who could quietly
alter a confirmed bearing would make every plan in the system arguable, and the
whole provenance model rests on confirmation happening in the surveyor's hands.

Views: **Overview** (pipeline health, error rates, activity), **Projects** with
a full per-project trace, **AI suggestions** (what was offered against what was
kept), **Errors**, **Usage** (stage timings and load), **Jurisdictions**,
**Accounts** and **Audit**.

**Jurisdiction templates are read-only, and that is a real limitation rather
than an unfinished screen.** They are compiled into the engine, which is what
lets a plan be traced to a reviewed version of the rules; a template editable at
runtime would change the rules governing legal compliance under plans already
being drawn, with no review and no version to point at. Changing one is a code
change and a deploy, deliberately. The console reads them from the same module
the composer draws with, so it cannot report a rule the app is not using.

### What the app reports, and what it never reports

The console can only show what the app tells it, and the architecture is
explicit that reporting has to happen *where the thing happens* rather than be
reconstructed later — reconstruction is guessing, and an audit trail that is a
guess is worse than none because it looks like evidence. So the app posts small
events at the moment a suggestion is offered, accepted or refused.

**An event carries shapes, never contents.** A kind, a suggestion type, a
validation code, a count, a duration, an opaque project id — and no coordinate,
no bearing, no name, no address, and no note anybody typed. The reason is the
console's audience: whoever can read it can read every deployment's plans at
once, so one field that leaks a client's parcel into it leaks all of them.

That is enforced twice. `state/report.ts` types the payload so adding a field at
a call site is a compile error, and `api/_telemetry.mjs` re-checks it on the
server as a **whitelist** — a stored event is built field by field into a fresh
object, so a property invented by a modified client has nowhere to land rather
than needing to be recognised and removed. A field that fails its check is
dropped and the event still stored, because the event is evidence something
happened and that is the part nothing can reconstruct later.

Reporting never costs the app anything: batched, sent with `sendBeacon`, never
awaited, never retried, and dropped entirely in a build with no
`VITE_ADMIN_ENDPOINT`. A surveyor with no signal must not notice it exists.

Running it locally — the same server serves both:

```bash
AUTH_ADMIN_EMAILS=you@example.com npm run auth --workspace @surveyor/web
VITE_AUTH_ENDPOINT=http://127.0.0.1:8788/api/auth \
  VITE_ADMIN_ENDPOINT=http://127.0.0.1:8788/api/admin \
  npm run dev --workspace @surveyor/web
```

Register with that address and the console is at `/admin/`.

## Testing

```bash
npm test                                    # 404 tests across contracts, engine, web and the API
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

Working offline needs a browser and cannot be faked in one: whether a service
worker installed, whether the app opens with the network genuinely cut, and
whether a queued photograph survives a reload are all claims about the browser
rather than about this code. The unit tests cover the decisions; this covers
whether the browser does what those decisions assume.

```bash
cd apps/web
VITE_EXTRACT_ENDPOINT=/__extract npx vite build --outDir dist-offline
npx vite preview --port 4176 --outDir dist-offline &
SMOKE_URL=http://127.0.0.1:4176/ npm run smoke:offline
```

It uses `context.setOffline`, which fails requests the way a dead radio does
rather than merely aborting them, and drives the whole round trip: the app
opens with no network, the assistant answers without waiting on one, a
photograph taken offline is kept, survives a reload, is transcribed exactly
once when signal returns, and arrives as something to confirm.

Sign-in needs its own pass for the same reason, and against a real server
rather than a stub — almost everything that goes wrong with sessions goes wrong
between the browser and the server rather than inside either one:

```bash
cd apps/web
VITE_AUTH_ENDPOINT=http://127.0.0.1:8788/api/auth npx vite build --outDir dist-auth
npx vite preview --port 4174 --outDir dist-auth &
SMOKE_AUTH_URL=http://127.0.0.1:4174/ npm run smoke:auth
```

It starts the auth server itself on a throwaway store, so each run begins with
nobody registered, and then drives the whole thing in a real browser: a build
with accounts asks before it opens, a short password is refused out loud,
creating an account signs you in, a reload does not sign you out, the session
cookie is unreadable from JavaScript, logging out returns to the form, a wrong
password and an unknown address give the *same* message, the same address
cannot be registered twice, "work without an account" opens the drawing and is
not remembered across a reload, and a server that is down says so with a way
past it.

Verification and password reset get their own pass, because every step of them
crosses a boundary — the server mints a token, a mail provider carries it, a
browser arrives on a link, and a second request spends it. Unit tests can check
each hop; only this can check they join up. It starts a **real mail server** and
reads the link out of what was sent, which is the only honest way to get one:

```bash
cd apps/web
VITE_AUTH_ENDPOINT=http://127.0.0.1:8790/api/auth npx vite build --outDir dist-verify
npx vite preview --port 4180 --outDir dist-verify &
npm run smoke:verify
```

It drives the whole round trip: registering does not sign you in, signing in
before confirming is refused with a resend button while a *wrong password* is
refused without one, the emailed link confirms the address and is stripped from
the URL, the forgotten-password flow sends a link that opens a new-password
screen, a rejected password does not cost you the link, and afterwards the old
password is dead and the new one works. Then it re-checks the property all of
it rests on: every token that was emailed is grepped for in every API response,
and must appear in none of them.

The admin console gets its own too, because access control is the reason it
exists as a separate surface and access control cannot be tested without a real
server, a real cookie jar and a real browser:

```bash
cd apps/web
VITE_AUTH_ENDPOINT=http://127.0.0.1:8789/api/auth \
  VITE_ADMIN_ENDPOINT=http://127.0.0.1:8789/api/admin \
  npx vite build --outDir dist-admin
npx vite preview --port 4179 --outDir dist-admin &
npm run smoke:admin
```

A signed-out visitor gets nothing; a signed-in surveyor is told there is
nothing here rather than that there is something they may not see; an admin
gets the console, with the two sign-ups already in its audit trail and not one
password hash anywhere in the page source; a promotion takes effect and a
developer trying to grant a role is refused out loud rather than silently.

## Deploying

[`vercel.json`](./vercel.json) configures the monorepo: Vercel installs at the
repository root, runs `npm run build` — which builds `contracts`, then `engine`,
then the app — and serves `apps/web/dist`. Import the repository in Vercel with
the root directory left as `./` and no further settings are needed.

The app runs entirely in the browser, so a default deployment needs no
environment variables and no server. The rest are optional:

| Variable | Where | Effect |
|---|---|---|
| `VITE_ASSISTANT_ENDPOINT` | Build | Set to `/api/assistant` to route the assistant through the model. Unset, the app uses its rule planner. |
| `VITE_EXTRACT_ENDPOINT` | Build | Set to `/api/extract` to enable reading photographed notes. Unset, the camera button says so and points at pasting. |
| `ANTHROPIC_API_KEY` | Runtime | Read by both model functions. Unset, they reply 503 and the app falls back to what it can do without them. |
| `VITE_AUTH_ENDPOINT` | Build | **Set to `/api/auth` by `vercel.json`**, so a deployment opens on the sign-in page. Unset — a local build — opens straight into the drawing. |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | Runtime | Injected by Vercel KV or Upstash. This is the whole account-store setup; `UPSTASH_REDIS_REST_*` works too. |
| `AUTH_STORE` | Runtime | `kv`, or `file` for a single-host self-install. Unset, an attached Redis is used and the endpoint replies 503 if there is none. |
| `AUTH_STORE_PATH` | Runtime | Where the file store writes, when `AUTH_STORE=file`. Single-host only. |
| `AUTH_ORIGINS` | Runtime | Comma-separated origins allowed to sign in. Unset, same-origin only, which is what a normal deployment wants. |
| `AUTH_ADMIN_EMAILS` | Runtime | Comma-separated addresses granted `admin` **when they register**. This is how the first administrator comes to exist; after that, admins grant roles from the console. Nothing in a request body can ever set a role. |
| `AUTH_MAIL_WEBHOOK` | Runtime | Where verification and reset mail is POSTed as JSON. Unset, links are written to the server log and nothing is delivered — a real mode for a local run, and said out loud rather than pretended. |
| `AUTH_MAIL_TOKEN` / `AUTH_MAIL_FROM` | Runtime | Bearer token for that endpoint, and the From address to ask for. |
| `APP_URL` | Runtime | The origin emailed links point at. Without it, links cannot be built. |
| `AUTH_REQUIRE_VERIFICATION` | Runtime | `1` or `0`. Unset, verification is required exactly when mail can be delivered — the only default that cannot lock everybody out of a deployment with no mailer. |
| `VITE_ADMIN_ENDPOINT` | Build | Set to `/api/admin` to turn on reporting *and* point the console at its API. Unset, the app reports nothing at all and the console has nothing to show. |
| `VITE_MAP_TILES` | Build | Replaces the **Streets** layer's tile URL, e.g. `https://.../{z}/{x}/{y}.png`. Unset, OpenStreetMap. |
| `VITE_MAP_ATTRIBUTION` | Build | The credit for it. Set it whenever `VITE_MAP_TILES` is — a licence condition, not decoration. |
| `VITE_MAP_SATELLITE_TILES` | Build | The same for the **Satellite** layer. Unset, Esri World Imagery. |
| `VITE_MAP_SATELLITE_ATTRIBUTION` | Build | The credit for that one. |

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
