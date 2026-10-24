import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BIOEMU_MAX_INTERPOLATION_SUBSTEPS,
  createInterpolatedBioEmuTrajectory,
  interpolatedBioEmuFrameIndex,
} from './bioemu-coordinate-interpolation.js';

function model(id, x, y = x, z = x, atomicHierarchy = undefined) {
  return {
    id,
    modelNum: id,
    atomicHierarchy,
    atomicConformation: {
      x: Float32Array.from(x),
      y: Float32Array.from(y),
      z: Float32Array.from(z),
      atomId: new Int32Array(x.length),
    },
    _dynamicPropertyData: Object.create(null),
  };
}

function trajectory(frames) {
  return {
    frames,
    frameCount: frames.length,
    duration: frames.length,
    representative: frames[0],
    getFrameAtIndex(index) { return frames[index]; },
  };
}

test('the visual trajectory keeps actual samples at endpoints and lazily interpolates atom coordinates between them', () => {
  const first = model('first', [0, 10], [4, 8], [-2, 2]);
  const second = model('second', [10, 20], [8, 12], [2, 6]);
  const source = trajectory([first, second]);
  const visual = createInterpolatedBioEmuTrajectory(source, { maxSubsteps: 4 });

  assert.equal(visual.sourceFrameCount, 2);
  assert.equal(visual.virtualFrameCount, 8);
  assert.equal(visual.trajectory.frameCount, 8);
  assert.equal(visual.trajectory.getFrameAtIndex(0), first);
  assert.equal(visual.trajectory.getFrameAtIndex(4), second);
  const halfway = visual.trajectory.getFrameAtIndex(2);
  assert.deepEqual(Array.from(halfway.atomicConformation.x), [5, 15]);
  assert.deepEqual(Array.from(halfway.atomicConformation.y), [6, 10]);
  assert.deepEqual(Array.from(halfway.atomicConformation.z), [0, 4]);
  assert.notEqual(halfway.atomicConformation.id, first.atomicConformation.id, 'Mol* must see each interpolated conformation as new');
  assert.notEqual(visual.trajectory.getFrameAtIndex(3).atomicConformation.id, halfway.atomicConformation.id);
  assert.deepEqual(Array.from(first.atomicConformation.x), [0, 10], 'source BioEmu coordinates are not mutated');
  assert.deepEqual(Array.from(second.atomicConformation.x), [10, 20], 'source BioEmu coordinates are not mutated');
});

test('the final visual interval can blend the last sample back to the first for looping playback', () => {
  const first = model('first', [0]);
  const middle = model('middle', [10]);
  const last = model('last', [20]);
  const visual = createInterpolatedBioEmuTrajectory(trajectory([first, middle, last]), { maxSubsteps: 4 });

  assert.equal(visual.trajectory.getFrameAtIndex(8), last);
  assert.deepEqual(Array.from(visual.trajectory.getFrameAtIndex(10).atomicConformation.x), [10]);
  assert.deepEqual(Array.from(visual.trajectory.getFrameAtIndex(11).atomicConformation.x), [5]);
  assert.equal(visual.trajectory.getFrameAtIndex(12), first);
});

test('interpolation frame mapping preserves human BioEmu indices, including the loop segment', () => {
  assert.equal(interpolatedBioEmuFrameIndex(4, 0, 10, 60), 240);
  assert.equal(interpolatedBioEmuFrameIndex(4, 0.5, 10, 60), 270);
  assert.equal(interpolatedBioEmuFrameIndex(9, 1, 10, 60), 0);
  assert.equal(interpolatedBioEmuFrameIndex(0, 0, 1, 60), 0);
  assert.equal(interpolatedBioEmuFrameIndex(0, 0, 0, 60), null);
});

test('the visual trajectory provides up to 60 interpolation positions per sampled conformer', () => {
  const source = trajectory([model('first', [0]), model('second', [10])]);
  const visual = createInterpolatedBioEmuTrajectory(source);
  assert.equal(visual.maxSubsteps, BIOEMU_MAX_INTERPOLATION_SUBSTEPS);
  assert.equal(visual.virtualFrameCount, source.frameCount * BIOEMU_MAX_INTERPOLATION_SUBSTEPS);
  assert.ok(Math.abs(
    visual.trajectory.getFrameAtIndex(1).atomicConformation.x[0] - 10 / BIOEMU_MAX_INTERPOLATION_SUBSTEPS,
  ) < 0.000001);
});

test('visual intermediates keep adjacent trace atoms connected when sample bond directions are opposite', () => {
  const hierarchy = {
    derived: {
      residue: {
        traceElementIndex: Int32Array.from([1, 4, 7]),
        directionFromElementIndex: Int32Array.from([0, 3, 6]),
        directionToElementIndex: Int32Array.from([2, 5, 8]),
      },
    },
    residueAtomSegments: { offsets: Int32Array.from([0, 3, 6, 9]) },
    chainAtomSegments: { index: Int32Array.from([0, 0, 0, 0, 0, 0, 0, 0, 0]) },
  };
  const first = model(
    'first',
    [0, 0, 0, 3.8, 3.8, 3.8, 7.6, 7.6, 7.6],
    [-1, 0, 1, -1, 0, 1, -1, 0, 1],
    [0, 0, 0, 0, 0, 0, 0, 0, 0],
    hierarchy,
  );
  const second = model(
    'second',
    [0, 0, 0, -3.8, -3.8, -3.8, -7.6, -7.6, -7.6],
    [1, 0, -1, 1, 0, -1, 1, 0, -1],
    [0, 0, 0, 0, 0, 0, 0, 0, 0],
    hierarchy,
  );
  const visual = createInterpolatedBioEmuTrajectory(trajectory([first, second]), { maxSubsteps: 4 });
  const halfway = visual.trajectory.getFrameAtIndex(2).atomicConformation;

  for (const [left, right] of [[1, 4], [4, 7]]) {
    const distance = Math.hypot(
      halfway.x[right] - halfway.x[left],
      halfway.y[right] - halfway.y[left],
      halfway.z[right] - halfway.z[left],
    );
    assert.ok(distance > 3.7 && distance < 3.9, `intermediate trace distance should remain near 3.8 Å, got ${distance}`);
  }
  for (const [from, to] of [[0, 2], [3, 5], [6, 8]]) {
    const distance = Math.hypot(
      halfway.x[to] - halfway.x[from],
      halfway.y[to] - halfway.y[from],
      halfway.z[to] - halfway.z[from],
    );
    assert.ok(distance > 1.9 && distance < 2.1, `intermediate backbone direction atoms should stay separated, got ${distance}`);
  }
  assert.deepEqual(Array.from(first.atomicConformation.x), Array.from(Float32Array.from([0, 0, 0, 3.8, 3.8, 3.8, 7.6, 7.6, 7.6])));
  assert.deepEqual(Array.from(second.atomicConformation.x), Array.from(Float32Array.from([0, 0, 0, -3.8, -3.8, -3.8, -7.6, -7.6, -7.6])));
});

test('incompatible coordinate arrays are rejected before visual interpolation starts', () => {
  const first = model('first', [0, 1]);
  const second = model('second', [2]);
  assert.throws(
    () => createInterpolatedBioEmuTrajectory(trajectory([first, second]), { maxSubsteps: 4 }),
    /mismo número de coordenadas/,
  );
});
