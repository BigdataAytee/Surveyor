# AI Survey Plan Drafting Agent — Full System Architecture

**Version:** 2.0
**Status:** Design reference
**Purpose:** Defines the complete system — backend engines, data contracts, and the UI/UX layer — for an AI agent that turns raw survey input into a professional, labelled site/survey plan, delivered through a premium mobile-first application.

---

## 0. How This Document Is Organized

The system has two halves that must be designed together but built with a clean boundary between them:

- **Part A — Data & Geometry Layer.** Deterministic engines that own correctness: CRS, COGO, validation, drawing, label placement, plan composition. No AI-authored coordinates ever reach the page.
- **Part B — Experience Layer.** The mobile-first UI/UX that a novice or professional interacts with, including the AI assistant, canvas, guided workflow, and design system.

The contract between them: **the AI decides intent, the engines decide geometry, and every value on the page carries a provenance tag.** The UI's entire job is to make that contract visible and trustworthy to the user — never to hide it.

> **Companion document:** [`contracts/LABEL_SPECIFICATION.md`](./contracts/LABEL_SPECIFICATION.md) formalizes the
> `LabelSpecification` object named in the Open Design Question below. Machine-readable types for the
> contracts described here live in [`packages/contracts`](../packages/contracts).

---

# PART A — DATA & GEOMETRY LAYER

## A.1 Design Principles

1. **Separation of intent and geometry.** The AI decides *what* should appear on the plan. Deterministic engines decide *where* things go and *whether* the math is correct. The AI never outputs pixel/plan coordinates directly.
2. **No invented survey data.** No bearing, distance, boundary, or legal notation is ever fabricated. Every value traces back to measured/supplied data, a deterministic calculation, or an explicit user confirmation.
3. **Provenance is mandatory.** Every label and geometric value carries a source tag — this is also what powers the UI's "AI suggestion" highlighting (see B.7, B.13).
4. **Errors are surfaced, not hidden.** Closure errors, CRS mismatches, and validation failures are reported in plain language with accept/adjust/reject options — never silently corrected.
5. **Jurisdiction is a parameter, not an assumption.** Title block content, notations, symbol sets, and label sizing live in swappable templates.

## A.2 Pipeline

```
┌───────────────────────────────────────────────────────────┐
│                        AI AGENT                            │
│      Conversation · Planning · Explanation · Intent         │
└───────────────────────────┬───────────────────────────────┘
                            │
   ┌────────────────────────┼────────────────────────┐
   │                        │                        │
   ▼                        ▼                        ▼
INPUT ENGINE          DOCUMENT AI              KNOWLEDGE BASE
Forms                 OCR / Vision             Survey concepts
Coordinates           Image extraction         Jurisdiction rules
Bearings              Table extraction         Plan templates
Distances
   │                        │                        │
   └────────────────────────┼────────────────────────┘
                            ▼
                 ┌───────────────────────┐
                 │  SURVEY DATA MODEL    │
                 └───────────┬───────────┘
                             ▼
                 ┌───────────────────────┐
                 │  CRS / DATUM ENGINE   │
                 │  Units · projection   │
                 │  Grid ↔ ground        │
                 └───────────┬───────────┘
                             ▼
                 ┌───────────────────────┐
                 │     COGO ENGINE       │
                 │  Geometry · Area      │
                 │  Distance · Bearing   │
                 └───────────┬───────────┘
                             ▼
                 ┌───────────────────────┐
                 │  VALIDATION ENGINE    │
                 │  Closure error check  │
                 │  Tolerance flags      │
                 │  CRS consistency      │
                 └───────────┬───────────┘
                             ▼
                 ┌───────────────────────┐
                 │    DRAWING ENGINE     │
                 │  Boundary · Roads     │
                 │  Buildings · Symbols  │
                 └───────────┬───────────┘
                             ▼
                 ┌───────────────────────┐
                 │   LABELING ENGINE     │
                 │  Semantic labels      │
                 │  Placement + collision│
                 │  Provenance tagging   │
                 └───────────┬───────────┘
                             ▼
                 ┌───────────────────────┐
                 │    PLAN COMPOSER      │
                 │  Jurisdiction template│
                 │  Sheet · Scale        │
                 │  Legend · North arrow │
                 │  Title block · Notes  │
                 └───────────┬───────────┘
                             ▼
                    PDF / DXF / SVG / PNG
                             │
                             ▼
             ══════ EXPERIENCE LAYER (Part B) ══════
             DrawingCanvas · AISheet · ExportDialog
```

## A.3 Engine Specifications

**Input Engine** — normalizes structured entry (forms, tables) and unstructured entry (scanned field notes) into the Survey Data Model. Missing/ambiguous fields are flagged to the user, never guessed. This is also the backend behind the UI's `DataSheet` / `PointEditor` components (B.10).

**Document AI** — OCR/vision extraction with per-field confidence scores. Low-confidence fields route to user confirmation — surfaced in the UI as an `ai-suggested` state (B.13), not silently accepted.

**Knowledge Base** — survey terminology, jurisdiction rule sets (title block requirements, symbol libraries, minimum label sizes), and plan templates. Also feeds the UI's novice-guidance copy (B.10) — e.g. the plain-language explanation shown for "Coordinate system."

**Survey Data Model** — the canonical internal representation:

```
SurveyDataModel
├── metadata (job number, client, date, surveyor, jurisdiction)
├── crs
├── points[]         { id, coordinates, source, confidence }
├── boundary[]       { segments: [{ from, to, bearing, distance, source }] }
├── siteFeatures[]   { type, geometry, attributes, source }
└── notes[]
```

**CRS / Datum Engine** — normalizes units and projection before any COGO calculation runs. Converts grid ↔ ground distance where scale factors apply. If CRS/datum cannot be determined, the pipeline halts and asks the user rather than defaulting.

**COGO Engine** — geometry, area, distance, bearing computation. Pure/deterministic, no AI involvement in the math.

**Validation Engine** — runs after COGO, before drawing:

- Traverse closure check against a configurable tolerance. Within tolerance → proceeds (tagged `calculated`). Outside tolerance → **stops and flags the user**, surfaced via the `ValidationSheet` component (B.11), never auto-corrected.
- CRS consistency check.
- Geometric sanity checks (self-intersections, duplicate points, zero-length segments).

**Drawing Engine** — renders boundary, roads, buildings, fences, symbols from validated geometry. No labelling decisions here.

**Labeling Engine** — two responsibilities kept separate:

- *Semantic labelling (AI-assisted):* what should be labelled, and what the text says, built strictly from structured attributes.
- *Geometric placement (deterministic):*

```
LabelPlacementEngine
├── candidate position generation
├── orientation calculation
├── collision detection (text–text, text–line, text–point)
├── page boundary avoidance
├── priority ranking (1: point IDs/dimensions/bearings · 2: roads/access/buildings · 3: coordinates/notes)
└── final placement
```

- *Provenance tagging (every label):*

```
Label { text, position, priority, source: "measured" | "calculated" | "user-confirmed" | "ai-suggested" }
```

**Plan Composer** — applies the jurisdiction template (title block, notations, legend requirements, minimum label sizes) and assembles the final sheet. Template swaps never touch Drawing or Labeling engine code.

## A.4 Suggested Build Order (Data Layer)

1. Survey Data Model + CRS/Datum Engine
2. COGO Engine + Validation Engine (closure tolerance first — non-negotiable)
3. Label Placement Engine (rough/greedy collision algorithm is fine initially; adapt an existing approach rather than building from scratch)
4. Drawing Engine
5. Semantic Labeling (AI layer) + provenance tagging
6. Plan Composer with jurisdiction templating
7. Document AI / OCR ingestion (parallel-buildable once the schema is stable)

---

# PART B — EXPERIENCE LAYER (UI/UX)

## B.0 Product Positioning

The interface must feel: beautiful, polished, modern, calm, intelligent, professional, spatial, responsive, tactile, easy for a novice, and trustworthy for technical work. It is **not** a generic CRUD admin dashboard, and not a flashy AI demo. Target feeling:

> "This is an intelligent professional drawing tool that is helping me" — not "I am filling out a complicated engineering form."

Complexity is progressively revealed: a novice sees simple actions; advanced controls surface when needed.

## B.1 Visual Hierarchy

1. Drawing canvas
2. AI assistant
3. Current task/action
4. Validation state
5. Survey data
6. Advanced settings

Side panels never visually overpower the drawing. The plan is always the centre of the application.

## B.2 Platform Strategy

Mobile-first, designed for touch from the start — not a shrunk desktop layout:

```
390×844 · 393×852 · 412×915   →   768+   →   1024+   →   1440+
```

## B.3 Main Mobile Workspace

```
┌─────────────────────────────┐
│ ←  Site Plan       ✓   ⋮    │
├─────────────────────────────┤
│        DRAWING CANVAS       │
│       ┌────────────┐        │
│       │   HOUSE    │        │
│       └────────────┘        │
│    PT1────────────PT2       │
│    │                │       │
│    PT4────────────PT3       │
│                    N ↑      │
├─────────────────────────────┤
│ Select   Draw   Measure     │
├─────────────────────────────┤
│ 🤖  Ask AI...               │
└─────────────────────────────┘
```

## B.4 AI Assistant

Feels like an expert sitting beside the drawing — not a generic chatbot. Contextual, with action buttons tied directly to the Survey Data Model state:

```
┌─────────────────────────────┐
│ ✨ Site Plan Assistant      │
│ Your boundary is complete.  │
│ I've calculated the area as │
│ 613 m².                     │
│ What would you like to add? │
│ [ Building ] [ Access ]     │
│ [ Road ]     [ Review ]     │
└─────────────────────────────┘
```

Animation: fade in, slight upward movement, typing indicator only where warranted (not for every tiny response), contextual action buttons, progress indicators.

## B.5 Micro-Interactions

Every state change communicates, never decorates for its own sake: button hover/press, panel open/close, tab switching, AI responses, object selection/creation, label placement, validation updates, export progress, save confirmation, undo/redo, tool selection.

## B.6 Drawing & Selection Animation

Boundaries draw themselves onto the canvas rather than snapping into existence; buildings go ghost-outline → snap → final, with a subtle spring animation. Selection: highlight object, show handles, show contextual toolbar, animate the property panel — subtle feedback, no aggressive glow.

## B.7 AI-Generated Changes → Trust Loop

This is the UI expression of Part A's provenance system. When the AI proposes a change (e.g. "Add a garage behind the house"):

1. Show a temporary preview on canvas
2. Highlight the proposed object with a label: `AI suggestion — 6m × 4m`
3. Offer `[Undo] [Accept]`
4. On acceptance, the object's provenance flips from `ai-suggested` to `user-confirmed` and it renders as normal geometry

No AI-suggested object reaches the final export in that state — this loop is how it gets confirmed.

## B.8 Loading & Processing States

Never generic "Loading..." — always contextual: *Calculating boundary...*, *Finding the best label positions...*, *Preparing your plan...*, *Checking the drawing...*

Multi-step AI operations use a compact activity indicator mapped directly to pipeline stages (A.2):

```
✨ Preparing your site plan
✓ Reading survey information
✓ Calculating boundary
● Positioning labels
○ Preparing layout
○ Final review
```

Steps animate `● → ✓` as each engine stage completes — this is a direct, honest reflection of pipeline progress, not a fake progress bar.

## B.9 Drawing Canvas

Professional drafting-surface feel: subtle grid, clean whitespace, crisp geometry, smooth zoom/pan, snapping indicators, selection handles, measurement overlays. Geometry dominates; the grid stays extremely subtle. Zoom supports pinch, double-tap, controls, and fit-to-plan, always with smooth interpolation — never abrupt jumps.

## B.10 Data Entry Experience

Coordinate entry is a clean mobile-native list, not a spreadsheet:

```
Survey Points

PT1
Easting   534821.42
Northing  182934.18
──────────────
PT2
Easting   534902.57
Northing  182915.33

+ Add point
```

Converts to a proper table on larger screens. Every technical concept gets plain-language novice guidance pulled from the Knowledge Base (A.3), e.g. "Coordinate system — How your survey positions are referenced," with an inline `? Why do I need this?` expandable explanation.

## B.11 Empty, Success, and Validation States

- **Empty states** are never blank panels — they explain what's missing and offer next actions (`Add points` / `Upload survey` / `Ask AI`).
- **Success states** confirm briefly and factually (`✓ Boundary complete — 4 points connected — Area: 613 m²`), no confetti — this is professional software.
- **Validation UI** uses three clear states — `✓ Ready` / `⚠ Needs review` / `✕ Error` — animated between states, tapping opens a `ValidationSheet` with the specific issues (this is where Part A's closure-tolerance failures and CRS mismatches surface, per A.3).

## B.12 Export Experience

Mirrors the real pipeline stages so the user understands what's actually happening, not a fake spinner:

```
Preparing your plan
✓ Geometry checked
✓ Labels positioned
✓ Layout optimized
✓ North arrow added
✓ Scale selected
● Generating PDF
```

Then: `✓ Your plan is ready — Site Plan — 25 High Street — [View PDF] [Share]`

## B.13 AI + Canvas Integration (Key Differentiator)

The UI surface for Part A's provenance tagging. When the AI references an object, that object subtly pulses/highlights on the canvas. "Show me the building" pans/zooms to it. "Move the garage 3 metres east" highlights the object before and after the operation. `ai-suggested` labels/objects render visually distinct from `measured`/`user-confirmed` ones at all times — this is not optional polish, it's the trust mechanism from A.1 principle 3 made visible.

## B.14 Guided Workflow

Visual progress through the natural drafting sequence, without forcing it:

```
✓ Boundary
✓ Survey
● Buildings
○ Features
○ Labels
○ Review
○ Export
```

The AI guides; it does not restrict. Users can jump around if they choose to.

## B.15 Contextual UI

Controls adapt to selection state — nothing irrelevant is shown. Nothing selected → `Select / Draw / Measure / Add`. Building selected → `Move / Resize / Rotate / Properties / Delete`. Boundary selected → `Edit points / Dimensions / Bearings / Properties`.

## B.16 Design System

Centralized, not scattered: typography, spacing, radius, shadows, animation timing/transitions, icons, buttons, inputs, sheets, cards, status indicators.

- **Typography:** modern, highly readable sans-serif; hierarchy of Display / Heading / Subheading / Body / Caption / Technical; numeric values use a compact, easily-scannable technical style.
- **Colour:** restrained — neutral background, high-contrast text, one primary accent, semantic success/warning/error only. No rainbow interface. The drawing has its own technical visual language, separate from chrome.
- **Dark mode:** application UI can go dark; the drawing canvas can stay independently themed (typically a light drafting surface) if that improves technical readability.
- **Animation system:** reusable primitives (`FadeIn`, `SlideUp`, `ScaleIn`, `SpringIn`, `PageTransition`, `SheetTransition`, `ToastTransition`, `SelectionTransition`, `DrawingTransition`). Timing: micro 100–150ms, normal 180–250ms, large 300–450ms. Spring physics where appropriate; nothing sluggish.
- **Reduced motion:** `prefers-reduced-motion` removes unnecessary movement and shortens durations; state is never communicated by animation alone.
- **Performance:** target 60fps; avoid full-canvas re-render on single-object change via memoization, selective state subscriptions, canvas/SVG optimization, virtualization, throttled pointer movement, debounced persistence.
- **Touch:** minimum ~44×44px targets, generous spacing, larger invisible hit areas for small drawing objects.

## B.17 Required UI Components

```
AppShell, TopBar, BottomNavigation, DrawingCanvas, CanvasToolbar, ToolButton,
FloatingActionButton, AISheet, AIMessage, AIAction, AIProgress, DataSheet,
PointEditor, ObservationEditor, FeatureEditor, PropertiesSheet, LayerSheet,
ValidationSheet, ValidationIssue, ProgressStepper, StatusBadge, BottomSheet,
Dialog, Toast, ConfirmDialog, EmptyState, LoadingState, SuccessState,
ExportDialog, PlanPreview
```

## B.18 Implementation Sequence

Build primitives before screens:

1. Design system
2. Reusable UI primitives
3. Animation primitives
4. Mobile navigation system
5. Drawing workspace
6. AI assistant interface
7. Data-entry components
8. Review components
9. Assemble screens

## B.19 Design Quality Bar

Before UI is considered complete, verify: mobile portrait/landscape, tablet, desktop, dark/light mode, reduced motion, slow network, empty project, large project, long AI response, validation errors, export progress. No layout jumps, clipped text, overflowing buttons, inaccessible controls, awkward spacing, inconsistent animation, or generic placeholder UI.

## B.20 Final UI Principle

Every interaction should answer one of:

> What is happening? · What can I do? · What does the AI need from me? · Is my plan correct? · What happens next?

The user should never feel lost. The drawing stays understandable. The AI feels like a calm expert assistant.

---

# PART C — CROSS-CUTTING CONTRACT

This is the piece that keeps Parts A and B honest as two teams build them in parallel.

| Backend concept (Part A) | UI surface (Part B) |
|---|---|
| `Label.source = "ai-suggested"` | Visually distinct styling + `[Undo] [Accept]` (B.7, B.13) |
| Validation Engine closure failure | `ValidationSheet` with `✕ Error` / `⚠ Needs review` (B.11) |
| Pipeline stage completion events | `AIProgress` step list `● → ✓` (B.8) |
| CRS/Datum halt-and-ask | Novice-friendly prompt, not a raw error (B.10) |
| Jurisdiction template fields | Title block / legend content shown in `PlanPreview` / `ExportDialog` |
| Point/segment `confidence` from Document AI | Confirmation prompt in `DataSheet` / `PointEditor` |

**Rule of thumb for both teams:** if Part A can't explain in one sentence *why* a value is on the plan, Part B should not be able to render it as final without a confirmation step.

---

## Open Design Question — resolved in a companion document

The `LabelSpecification` object — the contract between the AI layer (Part A) and the Label Placement Engine, which is also what drives the AI-suggestion highlighting in the canvas (Part B, B.13) — is formalized in
[`contracts/LABEL_SPECIFICATION.md`](./contracts/LABEL_SPECIFICATION.md), with machine-readable types in
[`packages/contracts`](../packages/contracts).
