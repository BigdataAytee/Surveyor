# `LabelSpecification` — The AI ↔ Placement Engine Contract

**Version:** 1.0
**Status:** Proposed — resolves the Open Design Question in [`../ARCHITECTURE.md`](../ARCHITECTURE.md)
**Types:** [`packages/contracts/src/label-specification.ts`](../../packages/contracts/src/label-specification.ts)

---

## 1. What this object is for

`LabelSpecification` is the single object that crosses the boundary between the two halves of the Labeling Engine (A.3):

```
Semantic Labeling (AI-assisted)          Geometric Placement (deterministic)
"this segment deserves a               →   "…and it goes here, at this angle,
 bearing/distance label"                    without colliding with anything"
       emits LabelSpecification[]                consumes them, emits PlacedLabel[]
```

It is load-bearing in three places at once, which is why its shape has to be settled before either team builds:

| Consumer | What it needs from the object |
|---|---|
| Label Placement Engine (A.3) | Priority, anchoring preferences, resolved geometry, text metrics |
| Plan Composer (A.3) | Style tokens resolved against the jurisdiction template |
| `DrawingCanvas` (B.13) | A stable id to highlight, and provenance to style by |

## 2. The three invariants it has to enforce

The object is designed backwards from three of Part A's principles. Every field below exists to make one of these structurally impossible to violate — not merely discouraged by convention.

**I1 — The AI cannot author a position (A.1 §1).**
There is no coordinate field anywhere in `LabelSpecification`. The AI names a *subject* by reference (`{ kind: "segment", from: "PT1", to: "PT2" }`) and expresses *preferences* about placement. Coordinates enter only when the placement engine resolves that reference against the validated Survey Data Model. A malformed or hallucinated reference fails resolution loudly; it cannot degrade into a plausible-looking wrong position.

**I2 — The AI cannot author a survey value (A.1 §2).**
Label text is *derived by default*, not written. The AI supplies a `template` id and *bindings that are themselves references*; the engine renders the string from the model plus the jurisdiction's formatting rules. The AI never types `"134.22 m"`, so it can never mistype it. Literal text is a separate, gated variant (§5).

**I3 — Nothing reaches the page unexplained (A.1 §3, Part C rule of thumb).**
Provenance is required at construction, and the export gate refuses any label still tagged `ai-suggested`. The same field drives the canvas styling in B.13, so the trust mechanism and the render path read from one source rather than two that can drift.

## 3. Shape

```ts
LabelSpecification {
  id           LabelId              // stable; the join key for B.13 highlighting
  subject      LabelSubject         // a REFERENCE into the Survey Data Model — never coordinates
  role         LabelRole            // what kind of label this is
  content      LabelContent         // derived (default) | literal (gated)
  anchor       AnchorSpec           // declarative preferences, not positions
  priority     LabelPriority        // 1 | 2 | 3, per A.3 ranking
  visibility   VisibilityPolicy     // what happens under collision pressure
  style        StyleRef             // token into the jurisdiction template, not raw px
  provenance   Provenance           // measured | calculated | user-confirmed | ai-suggested
}
```

### 3.1 `subject` — reference, not geometry

```ts
type LabelSubject =
  | { kind: "point";   pointId: PointId }
  | { kind: "segment"; from: PointId; to: PointId }
  | { kind: "ring";    ringId: RingId }         // closed boundary — area/name labels
  | { kind: "feature"; featureId: FeatureId }   // building, road, fence, access
  | { kind: "sheet" }                           // notes, legend text — page-anchored
```

This is the enforcement point for **I1**. Resolution happens in the placement engine and has exactly two outcomes: a real geometry, or a `subject-unresolved` error surfaced in `ValidationSheet`. There is no third path where an unresolved subject gets a default position.

### 3.2 `role` and `priority`

`role` carries the semantic meaning; `priority` carries the placement precedence from A.3. They are separate fields because the jurisdiction template is allowed to re-rank roles — a jurisdiction that requires coordinates in the margin will promote `coordinate` out of tier 3.

| Tier | Roles |
|---|---|
| 1 | `point-id`, `dimension`, `bearing` |
| 2 | `road-name`, `access`, `feature-name` |
| 3 | `coordinate`, `area`, `note` |

The AI proposes a priority; the Plan Composer's jurisdiction template may override it. The override is recorded so the UI can explain why a label moved.

### 3.3 `anchor` — preferences, not positions

```ts
AnchorSpec {
  relation        "along" | "offset" | "inside" | "near" | "leader"
  side?           "left" | "right" | "above" | "below" | "auto"
  preferredOrder? Placement[]   // ranked fallbacks the engine tries in turn
  keepUpright?    boolean       // default true — text never renders upside-down
  offsetSteps?    number        // in style-token units, NOT millimetres or pixels
}
```

`offsetSteps` is deliberately unitless-relative. A label that "sits just off the line" must mean the same thing at 1:200 and 1:1000, and only the Plan Composer knows the scale. Letting the AI say `offsetMm: 2.5` would leak layout authority back across the boundary.

### 3.4 `visibility` — and why dropped labels are reported

```ts
type VisibilityPolicy = "required" | "preferred" | "optional"
```

- `required` — must be placed. If collision resolution cannot place it, that is a **validation error**, not a silent omission. Boundary dimensions and point IDs are typically required.
- `preferred` — place it; a leader line is acceptable if the natural position is occupied.
- `optional` — may be dropped under pressure.

Every drop is reported in the placement result. A label silently vanishing off a survey plan is a correctness failure wearing a layout failure's clothes — A.1 §4 applies to the labelling stage exactly as it applies to closure.

## 4. Output side: `PlacedLabel`

The placement engine returns the specification it was given plus what it did with it. The spec is carried, not copied-and-mutated, so the UI can always show intent alongside outcome.

```ts
PlacedLabel {
  spec        LabelSpecification
  text        string          // final rendered string
  position    PlanPoint       // plan coordinates, engine-authored
  rotation    number          // degrees
  bounds      BoundingBox     // for hit-testing and B.13 highlighting
  outcome     "placed" | "placed-with-leader" | "displaced" | "dropped"
  leader?     LeaderLine
  reason?     string          // required when outcome ≠ "placed"
}
```

`outcome` is what lets the UI be honest without being noisy: `displaced` and `placed-with-leader` are normal drafting outcomes and need no user attention; `dropped` on an `optional` label is a quiet note; `dropped` on a `required` label is a `ValidationIssue`.

## 5. Content: derived by default, literal by exception

This is the most important single decision in the contract, so it is a discriminated union rather than a nullable string.

```ts
type LabelContent =
  | { mode: "derived"; template: TemplateId; bindings: Record<string, ValueRef> }
  | { mode: "literal"; text: string }
```

**Derived** is the default and covers every survey value. The AI chooses `template: "segment.bearingDistance"` and binds `{ segment: <ref> }`; the engine reads the model, applies the jurisdiction's bearing format and precision, and renders. The AI's output contains no numbers at all, so **I2** holds by construction rather than by review.

**Literal** exists because some labels legitimately have no derivation — a note the user typed, a street name read off a deed, a feature name. It is gated two ways:

1. Allowed only for roles in the free-text allowlist (`note`, `feature-name`, `road-name`, `access`).
2. A `literal` label whose provenance is `ai-suggested` cannot be exported. It must pass the B.7 trust loop to become `user-confirmed` first.

Combined, these mean the only free text that reaches a finished plan is text a human either wrote or explicitly approved.

### 5.1 Rejecting a plausible shortcut

An earlier shape allowed `{ template, bindings, text }` — the AI pre-renders the text and the engine verifies it matches. It should be rejected. Verification means implementing the renderer twice and keeping two implementations in agreement forever, and the failure mode is a mismatch error the user can do nothing useful with. If the engine can render the string, the AI's copy is redundant; if it can't, the AI's copy is unverifiable. Derive it once.

## 6. Provenance and the export gate

```ts
Provenance {
  source      "measured" | "calculated" | "user-confirmed" | "ai-suggested"
  confidence? number        // 0–1, present when it came from Document AI
  confirmedBy?  ActorRef    // set on the ai-suggested → user-confirmed transition
  confirmedAt?  IsoTimestamp
}
```

Only one transition is legal: `ai-suggested → user-confirmed`, via the B.7 Accept action. `measured` and `calculated` are engine-authored and immutable. There is no path that promotes a label without a human action, which is what makes the export gate meaningful:

> **Export gate.** `composePlan()` refuses to emit PDF/DXF/SVG/PNG while any label in the set carries `source: "ai-suggested"`. The refusal names the offending labels so `ExportDialog` can route the user straight to the trust loop instead of showing a dead end.

This is the one place where a Part A engine hard-blocks on a Part B interaction, and it is deliberate: it is the mechanism behind "No AI-suggested object reaches the final export in that state" (B.7).

## 7. Worked example

The AI decides a boundary segment should carry its bearing and distance:

```json
{
  "id": "lbl_seg_pt1_pt2_bearing",
  "subject": { "kind": "segment", "from": "PT1", "to": "PT2" },
  "role": "bearing",
  "content": {
    "mode": "derived",
    "template": "segment.bearingDistance",
    "bindings": { "segment": { "ref": "boundary.segments[0]" } }
  },
  "anchor": { "relation": "along", "side": "auto", "keepUpright": true, "offsetSteps": 1 },
  "priority": 1,
  "visibility": "required",
  "style": { "token": "label.dimension" },
  "provenance": { "source": "calculated" }
}
```

Note what is absent: no coordinates, no `"87°14'32\" E  81.42m"` string, no font size, no millimetres. The AI has expressed a complete intent while holding zero geometric or numeric authority. The engine returns:

```json
{
  "spec": { "id": "lbl_seg_pt1_pt2_bearing", "...": "..." },
  "text": "N 87°14'32\" E   81.42 m",
  "position": { "x": 534861.99, "y": 182924.75 },
  "rotation": -13.2,
  "bounds": { "...": "..." },
  "outcome": "placed"
}
```

## 8. Open sub-questions

These do not block building against the contract, but should be settled before the Label Placement Engine is considered done:

1. **Multi-line and stacked labels.** Does a bearing-over-distance stack render as one specification with a two-line template, or two specifications with a grouping constraint? A grouping constraint is more flexible but complicates collision detection. Leaning toward one specification, since the pair must move together.
2. **Curve labelling.** Arc segments need chord/arc/radius/delta, which may exceed what one `along` anchor can carry legibly. Probably a distinct `role: "curve-data"` that the composer can route to a curve table instead of the drawing face.
3. **Template registry ownership.** `TemplateId` values are jurisdiction-scoped. Whether the registry lives in the Knowledge Base or the Plan Composer determines whether the AI can discover available templates at planning time — it should be the Knowledge Base, so the AI can only reference templates that exist.
