/**
 * Verifies the structural invariants from docs/contracts/LABEL_SPECIFICATION.md.
 *
 * These are the rules that stop the AI layer overstepping its authority, so
 * they are worth testing rather than trusting to review.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  checkSpecification,
  confirm,
  DEFAULT_PRIORITY,
  labelsBlockingExport,
  statusFor,
  type LabelSpecification,
  type ValidationIssue,
} from '../src/index.js';

function spec(overrides: Partial<LabelSpecification> = {}): LabelSpecification {
  const base: LabelSpecification = {
    id: 'lbl_seg_pt1_pt2_bearing',
    subject: { kind: 'segment', from: 'PT1', to: 'PT2' },
    role: 'bearing',
    content: {
      mode: 'derived',
      template: 'segment.bearingDistance',
      bindings: { segment: { ref: 'boundary[0].segments[0]' } },
    },
    anchor: { relation: 'along', side: 'auto', keepUpright: true, offsetSteps: 1 },
    priority: 1,
    visibility: 'required',
    style: { token: 'label.dimension' },
    provenance: { source: 'calculated' },
  };
  return { ...base, ...overrides };
}

test('a well-formed derived specification passes', () => {
  assert.deepEqual(checkSpecification(spec()), []);
});

test('literal text is rejected for roles that carry survey values', () => {
  const violations = checkSpecification(
    spec({ role: 'bearing', content: { mode: 'literal', text: 'N 87°14\' E' } }),
  );
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.rule, 'literal-text-role');
});

test('literal text is allowed for genuinely free-text roles', () => {
  const violations = checkSpecification(
    spec({ role: 'note', content: { mode: 'literal', text: 'Subject to easement.' } }),
  );
  assert.deepEqual(violations, []);
});

test('derived content with no bindings is rejected as unrenderable', () => {
  const violations = checkSpecification(
    spec({ content: { mode: 'derived', template: 'segment.bearingDistance', bindings: {} } }),
  );
  assert.equal(violations[0]?.rule, 'empty-bindings');
});

test('the export gate names every ai-suggested label', () => {
  const blocked = labelsBlockingExport([
    spec({ id: 'a', provenance: { source: 'calculated' } }),
    spec({ id: 'b', provenance: { source: 'ai-suggested' } }),
    spec({ id: 'c', provenance: { source: 'user-confirmed' } }),
    spec({ id: 'd', provenance: { source: 'ai-suggested' } }),
  ]);
  assert.deepEqual(
    blocked.map((s) => s.id),
    ['b', 'd'],
  );
});

test('confirming an ai-suggested label clears the export gate', () => {
  const suggested = spec({ provenance: { source: 'ai-suggested' } });
  const confirmed = spec({
    provenance: confirm(
      suggested.provenance,
      { actorId: 'user_1' },
      '2026-08-10T14:03:22Z',
    ),
  });

  assert.equal(confirmed.provenance.source, 'user-confirmed');
  assert.equal(confirmed.provenance.confirmedBy?.actorId, 'user_1');
  assert.deepEqual(labelsBlockingExport([confirmed]), []);
});

test('engine-authored provenance cannot be confirmed away', () => {
  for (const source of ['measured', 'calculated', 'user-confirmed'] as const) {
    assert.throws(
      () => confirm({ source }, { actorId: 'user_1' }, '2026-08-10T14:03:22Z'),
      /Only ai-suggested provenance can be confirmed/,
    );
  }
});

test('validation status is driven by the worst issue present', () => {
  const warn: ValidationIssue = {
    code: 'low-confidence-extraction',
    severity: 'needs-review',
    message: 'Check the northing for PT3 — it was hard to read.',
    subjects: ['PT3'],
    options: ['confirm', 'adjust'],
  };
  const err: ValidationIssue = {
    code: 'closure-out-of-tolerance',
    severity: 'error',
    message: 'The boundary does not close within the allowed tolerance.',
    subjects: ['ring_1'],
    options: ['adjust', 'reject'],
  };

  assert.equal(statusFor([]), 'ready');
  assert.equal(statusFor([warn]), 'needs-review');
  assert.equal(statusFor([warn, err]), 'error');
});

test('every label role has a default priority tier', () => {
  for (const [role, tier] of Object.entries(DEFAULT_PRIORITY)) {
    assert.ok([1, 2, 3].includes(tier), `${role} has an out-of-range tier`);
  }
  assert.equal(DEFAULT_PRIORITY['point-id'], 1);
  assert.equal(DEFAULT_PRIORITY.note, 3);
});
