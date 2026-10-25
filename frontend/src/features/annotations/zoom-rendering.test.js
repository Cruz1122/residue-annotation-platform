import assert from 'node:assert/strict';
import test from 'node:test';
import { getZoomOptimizedCanvas3dProps } from './zoom-rendering.js';

test('disables temporal multisample accumulation without overriding other render quality settings', () => {
  assert.deepEqual(getZoomOptimizedCanvas3dProps(), { multiSample: { mode: 'off' } });
});

test('returns fresh Mol* props for each viewer instance', () => {
  const first = getZoomOptimizedCanvas3dProps();
  const second = getZoomOptimizedCanvas3dProps();
  first.multiSample.mode = 'temporal';
  assert.equal(second.multiSample.mode, 'off');
});
