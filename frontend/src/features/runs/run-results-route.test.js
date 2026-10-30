import test from 'node:test';
import assert from 'node:assert/strict';
import { runResultsRoute } from './run-results-route.js';

test('opens DDG runs in the variant evaluation view', () => {
  assert.equal(runResultsRoute({ external_tracking: { run_type: 'ddg' } }), 'variant-ddg');
});

test('opens mutant and base runs in the structure information view', () => {
  assert.equal(runResultsRoute({ external_tracking: { run_type: 'mutant' } }), 'info');
  assert.equal(runResultsRoute({ external_tracking: { run_type: 'base' } }), 'info');
});

test('keeps the existing topology destination for ordinary runs', () => {
  assert.equal(runResultsRoute({}), 'topology');
  assert.equal(runResultsRoute({ external_tracking: null }), 'topology');
});
