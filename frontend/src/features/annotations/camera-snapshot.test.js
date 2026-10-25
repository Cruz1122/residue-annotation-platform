import assert from 'node:assert/strict';
import test from 'node:test';
import { captureCameraSnapshot, sameCameraSnapshot } from './camera-snapshot.js';

function cameraSnapshot(overrides = {}) {
  return {
    mode: 'perspective',
    fov: 45,
    radius: 12,
    radiusMax: 100,
    position: new Float32Array([1, 2, 3]),
    target: new Float32Array([4, 5, 6]),
    up: new Float32Array([0, 1, 0]),
    ...overrides,
  };
}

test('compares equal snapshots without relying on vector identity', () => {
  assert.equal(sameCameraSnapshot(cameraSnapshot(), captureCameraSnapshot(cameraSnapshot())), true);
});

test('detects changes to camera scalars and each vector component', () => {
  const previous = captureCameraSnapshot(cameraSnapshot());
  for (const next of [
    cameraSnapshot({ mode: 'orthographic' }),
    cameraSnapshot({ fov: 46 }),
    cameraSnapshot({ radius: 13 }),
    cameraSnapshot({ radiusMax: 101 }),
    cameraSnapshot({ position: [1, 2, 4] }),
    cameraSnapshot({ target: [4, 6, 6] }),
    cameraSnapshot({ up: [1, 1, 0] }),
  ]) {
    assert.equal(sameCameraSnapshot(next, previous), false);
  }
});

test('captured signatures remain stable when Mol* reuses and mutates its vectors', () => {
  const snapshot = cameraSnapshot();
  const previous = captureCameraSnapshot(snapshot);
  snapshot.position[0] = 99;
  assert.equal(sameCameraSnapshot(snapshot, previous), false);
});

test('handles missing vectors as empty vectors', () => {
  const snapshot = cameraSnapshot({ position: undefined, target: null, up: [] });
  assert.equal(sameCameraSnapshot(snapshot, captureCameraSnapshot(snapshot)), true);
  assert.equal(sameCameraSnapshot(null, null), true);
  assert.equal(sameCameraSnapshot(cameraSnapshot(), null), false);
});

test('matches the previous JSON signature behavior for non-finite camera values', () => {
  const previous = captureCameraSnapshot(cameraSnapshot({ position: [Number.NaN, Number.POSITIVE_INFINITY, 0] }));
  const next = cameraSnapshot({ position: [null, undefined, 0] });
  assert.equal(sameCameraSnapshot(next, previous), true);
});
