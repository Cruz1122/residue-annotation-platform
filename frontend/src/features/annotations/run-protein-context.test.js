import assert from 'node:assert/strict';
import test from 'node:test';
import { runBelongsToProtein } from './run-protein-context.js';

test('accepts a run linked directly to the protein', () => {
  assert.equal(runBelongsToProtein({ protein_id: 'base-protein' }, 'base-protein'), true);
});

test('accepts a distinct sequence linked to its base protein', () => {
  const run = {
    protein_id: 'mature-sequence',
    external_tracking: { base_protein_id: 'base-protein', accession: 'P22309', run_type: 'base' },
  };
  assert.equal(runBelongsToProtein(run, 'base-protein'), true);
  assert.equal(runBelongsToProtein(run, 'other-protein'), false);
});

test('rejects an unrelated run', () => {
  assert.equal(runBelongsToProtein({ protein_id: 'unrelated' }, 'base-protein'), false);
});
