import assert from 'node:assert/strict';
import test from 'node:test';
import { hasConfiguredVariants } from './run-capabilities.js';

test('detects variants from the immutable configuration or request snapshot', () => {
  assert.equal(hasConfiguredVariants({ configuration: { normalized_variants: [{ variant_id: 'R43C' }] } }), true);
  assert.equal(hasConfiguredVariants({ requested_variants: [{ variant_id: 'F402L' }] }), true);
  assert.equal(hasConfiguredVariants({ configuration: { normalized_variants: [] }, requested_variants: [] }), false);
  assert.equal(hasConfiguredVariants(null), false);
});
