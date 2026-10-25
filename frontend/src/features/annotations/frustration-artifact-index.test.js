import assert from 'node:assert/strict';
import test from 'node:test';
import {
  frustrationRecordsAtPosition,
  indexFrustrationArtifactDetails,
} from './frustration-artifact-index.js';

test('indexes published artifact rows by canonical residue without changing source order', () => {
  const first = { aa_position: '2', frustraiseq_index: '-1.2' };
  const second = { position: 2, frustraiseq_class: 'highly_frustrated' };
  const details = indexFrustrationArtifactDetails({
    frustraiseq_per_residue: [first, { aa_position: 'NA' }, second],
    frustration_per_residue: [{ residue_number: 2, value: '0.4' }],
    ignored_artifact: [{ aa_position: 2, value: 'not indexed' }],
  });

  assert.deepEqual(frustrationRecordsAtPosition(details, 'frustraiseq_per_residue', 2), [first, second]);
  assert.deepEqual(frustrationRecordsAtPosition(details, 'frustration_per_residue', 2), [{ residue_number: 2, value: '0.4' }]);
  assert.deepEqual(frustrationRecordsAtPosition(details, 'frustraiseq_per_residue', 99), []);
  assert.equal(details.has('ignored_artifact'), false);
});

test('ignores malformed records and accepts only positive integer positions', () => {
  const details = indexFrustrationArtifactDetails({
    frustratometer_per_residue: [
      null,
      { aa_position: 0 },
      { aa_position: -1 },
      { aa_position: 1.2 },
      { aa_position: '3', value: 2 },
    ],
  });
  assert.deepEqual(frustrationRecordsAtPosition(details, 'frustratometer_per_residue', 3), [{ aa_position: '3', value: 2 }]);
  assert.equal(details.get('frustratometer_per_residue').size, 1);
});
