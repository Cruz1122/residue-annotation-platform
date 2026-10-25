import assert from 'node:assert/strict';
import test from 'node:test';
import { annotationResultSignature } from './annotation-result-signature.js';

test('signatures are stable across stage ordering and status-only snapshots', () => {
  const initial = {
    stages: [
      { id: 'frustraiseq', status: 'running', stage_result_id: null, artifacts: [] },
      { id: 'frustratometer', status: 'success', stage_result_id: 'result-1', artifacts: [{ id: 'artifact-1', artifact_type: 'frustration_per_residue', sha256: 'abc' }] },
    ],
  };
  const next = {
    stages: [
      { ...initial.stages[1], status: 'reused' },
      { ...initial.stages[0], status: 'success' },
    ],
  };
  assert.equal(annotationResultSignature(initial), annotationResultSignature(next));
});

test('changes when a stage result or published artifact content changes', () => {
  const run = { stages: [{ id: 'frustratometer', stage_result_id: 'result-1', artifacts: [{ id: 'artifact-1', artifact_type: 'frustration_per_residue', sha256: 'abc' }] }] };
  const signature = annotationResultSignature(run);
  assert.notEqual(annotationResultSignature({ stages: [{ ...run.stages[0], stage_result_id: 'result-2' }] }), signature);
  assert.notEqual(annotationResultSignature({ stages: [{ ...run.stages[0], artifacts: [{ ...run.stages[0].artifacts[0], sha256: 'def' }] }] }), signature);
});

test('an absent run has an empty result signature', () => {
  assert.equal(annotationResultSignature(null), '');
  assert.equal(annotationResultSignature({ stages: [] }), '');
});

test('malformed optional stage artifact lists do not break live snapshot comparison', () => {
  assert.doesNotThrow(() => annotationResultSignature({ stages: [null, { id: 'fixture', artifacts: 'invalid' }] }));
});
