/**
 * @surveyor/engine — the deterministic half of the system (Architecture Part A).
 *
 * Everything exported here is pure with respect to survey data: given the same
 * Survey Data Model it produces the same plan. The AI layer sits outside this
 * package and talks to it through @surveyor/contracts.
 */

export * from './crs.js';
export * from './cogo.js';
export * from './validation.js';
export * from './drawing.js';
export * from './input.js';
export * from './document.js';
export * from './labeling/templates.js';
export * from './labeling/semantic.js';
export * from './labeling/placement.js';
export * from './compose/jurisdiction.js';
export * from './compose/composer.js';
export * from './export/svg.js';
export * from './export/dxf.js';
export * from './export/pdf.js';
export * from './pipeline.js';
