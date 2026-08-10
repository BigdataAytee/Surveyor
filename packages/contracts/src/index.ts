/**
 * @surveyor/contracts — the shared boundary between the Data & Geometry Layer
 * (Part A) and the Experience Layer (Part B).
 *
 * These are types and structural guards only: no geometry math, no rendering,
 * no I/O. Both teams build against this package so the Part C cross-cutting
 * contract stays enforced rather than aspirational.
 */

export * from './provenance.js';
export * from './survey-data-model.js';
export * from './label-specification.js';
export * from './placement.js';
export * from './validation.js';
export * from './pipeline.js';
