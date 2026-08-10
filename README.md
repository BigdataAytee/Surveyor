# Surveyor

AI-powered survey plan drafting agent — turns raw survey data (points, bearings, distances) into professional, labelled site plans via a deterministic geometry/COGO pipeline with AI-assisted labelling, wrapped in a mobile-first CAD-grade UI.

## The central rule

> **The AI decides intent. The engines decide geometry. Every value on the page carries a provenance tag.**

No AI-authored coordinate or survey value reaches a finished plan. The UI's job is to make that visible, not to hide it.

## Repository map

| Path | What it is |
|---|---|
| [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) | Full system architecture — Part A (data & geometry engines), Part B (experience layer), Part C (cross-cutting contract) |
| [`docs/contracts/LABEL_SPECIFICATION.md`](./docs/contracts/LABEL_SPECIFICATION.md) | The AI ↔ Label Placement Engine contract, formalized |
| [`packages/contracts`](./packages/contracts) | Machine-readable types and structural guards for the Part A ↔ Part B boundary |

## Status

Design reference plus the shared contracts package. The engines (CRS/Datum, COGO,
Validation, Drawing, Label Placement, Plan Composer) and the UI are not yet built —
see the build orders in `ARCHITECTURE.md` §A.4 and §B.18.

## Working on the contracts package

```bash
cd packages/contracts
npm install
npm run typecheck
npm test
```

`packages/contracts` is types and structural guards only — no geometry math, no
rendering, no I/O. Both halves of the system build against it so the Part C
contract stays enforced rather than aspirational.
