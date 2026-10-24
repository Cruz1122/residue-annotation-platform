import assert from 'node:assert/strict';
import test from 'node:test';
import { Cell } from 'molstar/lib/mol-math/geometry/spacegroup/cell.js';
import { Vec3 } from 'molstar/lib/mol-math/linear-algebra.js';
import { repairUnboxedBioEmuCoordinates } from './bioemu-trajectory.js';

function coordinateFrame(x, y, z, cell = Cell.empty()) {
  return { x: Float32Array.from(x), y: Float32Array.from(y), z: Float32Array.from(z), cell };
}

test('assigns finite viewer cells to BioEmu XTC frames with zero boxes without changing coordinates', () => {
  const frames = [
    coordinateFrame([-2, 3], [4, -1], [0, 7]),
    coordinateFrame([-4, 2], [3, 5], [1, 8]),
  ];
  const originalCoordinates = frames.map((frame) => [frame.x.slice(), frame.y.slice(), frame.z.slice()]);

  const repairedFrames = repairUnboxedBioEmuCoordinates({ frames });

  assert.equal(repairedFrames, 2);
  for (const [index, frame] of frames.entries()) {
    assert.ok(Number.isFinite(frame.cell.volume) && frame.cell.volume > 0);
    assert.ok(Array.from(frame.cell.toFractional).every(Number.isFinite));
    assert.deepEqual(frame.x, originalCoordinates[index][0]);
    assert.deepEqual(frame.y, originalCoordinates[index][1]);
    assert.deepEqual(frame.z, originalCoordinates[index][2]);
  }
  assert.equal(frames[0].cell, frames[1].cell);
});

test('preserves published periodic cells and their coordinates', () => {
  const publishedCell = Cell.create(Vec3.create(10, 12, 14), Vec3.create(Math.PI / 2, Math.PI / 2, Math.PI / 2));
  const frame = coordinateFrame([1, 2], [3, 4], [5, 6], publishedCell);

  assert.equal(repairUnboxedBioEmuCoordinates({ frames: [frame] }), 0);
  assert.equal(frame.cell, publishedCell);
  assert.deepEqual([...frame.x], [1, 2]);
});

test('rejects unboxed frames with malformed or non-finite coordinates', () => {
  assert.throws(
    () => repairUnboxedBioEmuCoordinates({ frames: [coordinateFrame([1], [2, 3], [4])] }),
    /ejes de coordenadas incompatibles/,
  );
  assert.throws(
    () => repairUnboxedBioEmuCoordinates({ frames: [coordinateFrame([Number.NaN], [2], [4])] }),
    /coordenadas no finitas/,
  );
  assert.throws(() => repairUnboxedBioEmuCoordinates({ frames: [] }), /no devolvió coordenadas/);
});
