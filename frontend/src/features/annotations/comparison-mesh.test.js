import assert from 'node:assert/strict';
import test from 'node:test';
import { Mesh } from 'molstar/lib/mol-geo/geometry/mesh/mesh.js';
import {
  buildComparisonRibbon,
  comparisonLaneBoundaryError,
  countMixedComparisonTriangles,
  createComparisonMeshGeometry,
} from './comparison-mesh.js';

function makeResidues(count = 4) {
  return Array.from({ length: count }, (_, index) => ({
    canonicalPosition: index + 1,
    structureOrder: index,
    chain: 'A',
    seq: index + 1,
    aa: 'A',
    ca: [index * 3.8, Math.sin(index * 0.55) * 1.3, Math.cos(index * 0.55) * 0.8],
  }));
}

function firstVertexByGroup(mesh) {
  const first = new Map();
  mesh.groups.forEach((group, vertexIndex) => {
    if (!first.has(group)) first.set(group, vertexIndex);
  });
  return first;
}

function vertexPoint(mesh, vertexIndex) {
  return Array.from(mesh.vertices.slice(vertexIndex * 3, vertexIndex * 3 + 3));
}

function distance(left, right) {
  return Math.hypot(...left.map((value, axis) => value - right[axis]));
}

function frontRingEdges(mesh, first, residueIndex, channelIndex, step) {
  const group = residueIndex * mesh.groupStride + channelIndex;
  const groupFirst = first.get(group);
  const stepOffset = step < mesh.steps ? step * 8 : (mesh.steps - 1) * 8;
  const leftOffset = step < mesh.steps ? 0 : 2;
  const rightOffset = step < mesh.steps ? 1 : 3;
  return {
    left: vertexPoint(mesh, groupFirst + stepOffset + leftOffset),
    right: vertexPoint(mesh, groupFirst + stepOffset + rightOffset),
  };
}

test('keeps each residue/channel as an exclusive native mesh group for 0 to 5 channels', () => {
  const chain = makeResidues();
  for (let activeCount = 0; activeCount <= 5; activeCount += 1) {
    const mesh = buildComparisonRibbon(chain, activeCount);
    assert.equal(mesh.activeCount, activeCount);
    assert.equal(mesh.slots, Math.max(1, activeCount));
    assert.equal(countMixedComparisonTriangles(mesh), 0);
    assert.equal(mesh.groupMeta.length, chain.length * mesh.groupStride);
    if (activeCount) {
      for (let residueIndex = 0; residueIndex < chain.length; residueIndex += 1) {
        for (let channelIndex = 0; channelIndex < activeCount; channelIndex += 1) {
          const group = residueIndex * mesh.groupStride + channelIndex;
          assert.equal(mesh.groupMeta[group].residueIndex, residueIndex);
          assert.equal(mesh.groupMeta[group].canonicalPosition, residueIndex + 1);
          assert.equal(mesh.groupMeta[group].channelIndex, channelIndex);
          assert.equal(mesh.groupMeta[group].face, 'front');
        }
      }
      assert.ok(comparisonLaneBoundaryError(mesh) <= 1e-6);
    }
  }
});

test('updates Mol* mesh buffers in place when an analysis is unchecked', () => {
  const chain = makeResidues(8);
  const fourChannelData = buildComparisonRibbon(chain, 4);
  const geometry = createComparisonMeshGeometry(fourChannelData, Mesh);
  const vertexBuffer = geometry.vertexBuffer;
  const indexBuffer = geometry.indexBuffer;
  const groupBuffer = geometry.groupBuffer;
  const threeChannelData = buildComparisonRibbon(chain, 3);

  const updatedGeometry = createComparisonMeshGeometry(threeChannelData, Mesh, geometry);

  assert.strictEqual(updatedGeometry, geometry);
  assert.strictEqual(updatedGeometry.vertexBuffer, vertexBuffer);
  assert.strictEqual(updatedGeometry.indexBuffer, indexBuffer);
  assert.strictEqual(updatedGeometry.groupBuffer, groupBuffer);
  assert.strictEqual(updatedGeometry.vertexBuffer.ref.value, threeChannelData.vertices);
  assert.strictEqual(updatedGeometry.indexBuffer.ref.value, threeChannelData.indices);
  assert.strictEqual(updatedGeometry.groupBuffer.ref.value, threeChannelData.groups);
  assert.equal(updatedGeometry.vertexCount, threeChannelData.vertices.length / 3);
  assert.equal(updatedGeometry.triangleCount, threeChannelData.indices.length / 3);
  assert.equal(updatedGeometry.groupMapping.indices.length, threeChannelData.vertices.length / 3);
});

test('preserves structural gaps and chain boundaries instead of joining unrelated Cα atoms', () => {
  const chain = makeResidues(4);
  chain[2] = { ...chain[2], structureOrder: 4 };
  chain[3] = { ...chain[3], chain: 'B', structureOrder: 5 };
  const mesh = buildComparisonRibbon(chain, 2);
  assert.equal(countMixedComparisonTriangles(mesh), 0);
  assert.equal(mesh.groupMeta[2 * mesh.groupStride].residueIndex, 2);
  assert.equal(mesh.groupMeta[2 * mesh.groupStride].canonicalPosition, 3);
  assert.equal(mesh.groupMeta[2 * mesh.groupStride].chain, 'A');
  assert.equal(mesh.groupMeta[3 * mesh.groupStride].residueIndex, 3);
  assert.equal(mesh.groupMeta[3 * mesh.groupStride].canonicalPosition, 4);
  assert.equal(mesh.groupMeta[3 * mesh.groupStride].chain, 'B');
});

test('tracks each Cα anchor and closes continuous residue boundaries at the default resolution', () => {
  const chain = makeResidues();
  const mesh = buildComparisonRibbon(chain, 4, { width: 1e-5, thickness: 1e-5 });
  const first = firstVertexByGroup(mesh);
  assert.equal(mesh.steps, 12);

  for (let residueIndex = 0; residueIndex < chain.length; residueIndex += 1) {
    const anchorStep = residueIndex === 0 ? 0 : residueIndex === chain.length - 1 ? mesh.steps : mesh.steps / 2;
    const left = frontRingEdges(mesh, first, residueIndex, 0, anchorStep).left;
    const right = frontRingEdges(mesh, first, residueIndex, mesh.slots - 1, anchorStep).right;
    const centerline = left.map((value, axis) => (value + right[axis]) / 2);
    assert.ok(distance(centerline, chain[residueIndex].ca) < 1e-4);

    if (residueIndex === chain.length - 1) continue;
    for (let channelIndex = 0; channelIndex < mesh.slots; channelIndex += 1) {
      const previousEnd = frontRingEdges(mesh, first, residueIndex, channelIndex, mesh.steps);
      const nextStart = frontRingEdges(mesh, first, residueIndex + 1, channelIndex, 0);
      assert.ok(distance(previousEnd.left, nextStart.left) < 1e-6);
      assert.ok(distance(previousEnd.right, nextStart.right) < 1e-6);
    }
  }
});

test('keeps unmapped residues in the geometry without inventing a canonical position', () => {
  const chain = makeResidues(2);
  chain[1] = { ...chain[1], canonicalPosition: null };
  const mesh = buildComparisonRibbon(chain, 3);
  assert.equal(mesh.groupMeta[0].canonicalPosition, 1);
  const unmappedBackGroup = mesh.groupStride + mesh.slots;
  assert.equal(mesh.groupMeta[unmappedBackGroup].canonicalPosition, null);
  assert.equal(mesh.groupMeta[unmappedBackGroup].channelIndex, 0);
  assert.equal(mesh.groupMeta[unmappedBackGroup].face, 'back');
});

test('rejects malformed channel counts and non-finite coordinates', () => {
  assert.throws(() => buildComparisonRibbon(makeResidues(), 6), /between 0 and 5/);
  assert.throws(() => buildComparisonRibbon([{ ...makeResidues(1)[0], ca: [0, Number.NaN, 1] }]), /Cα coordinate/);
});
