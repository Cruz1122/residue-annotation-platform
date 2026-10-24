const EPSILON = 1e-9;
const MAX_CHANNELS = 5;

const subtract = (left, right) => left.map((value, index) => value - right[index]);
const add = (left, right) => left.map((value, index) => value + right[index]);
const multiply = (vector, scalar) => vector.map((value) => value * scalar);
const dot = (left, right) => left.reduce((sum, value, index) => sum + value * right[index], 0);
const cross = (left, right) => [
  left[1] * right[2] - left[2] * right[1],
  left[2] * right[0] - left[0] * right[2],
  left[0] * right[1] - left[1] * right[0],
];
const length = (vector) => Math.hypot(...vector);
const normalize = (vector) => {
  const magnitude = length(vector);
  return magnitude > EPSILON ? multiply(vector, 1 / magnitude) : [1, 0, 0];
};

function catmullRom(p0, p1, p2, p3, amount) {
  const amountSquared = amount * amount;
  const amountCubed = amountSquared * amount;
  return p1.map((value, axis) => 0.5 * (
    2 * value
    + (-p0[axis] + p2[axis]) * amount
    + (2 * p0[axis] - 5 * value + 4 * p2[axis] - p3[axis]) * amountSquared
    + (-p0[axis] + 3 * value - 3 * p2[axis] + p3[axis]) * amountCubed
  ));
}

function catmullRomTangent(p0, p1, p2, p3, amount) {
  const amountSquared = amount * amount;
  return p1.map((value, axis) => 0.5 * (
    -p0[axis] + p2[axis]
    + 2 * (2 * p0[axis] - 5 * value + 4 * p2[axis] - p3[axis]) * amount
    + 3 * (-p0[axis] + 3 * value - 3 * p2[axis] + p3[axis]) * amountSquared
  ));
}

function consecutive(left, right) {
  if (!left || !right || left.chain !== right.chain) return false;
  if (left.structureSegment !== undefined && right.structureSegment !== undefined && left.structureSegment !== right.structureSegment) return false;
  const orderIsPresent = Number.isInteger(left.structureOrder) && Number.isInteger(right.structureOrder);
  const followsInStructure = orderIsPresent
    ? right.structureOrder === left.structureOrder + 1
    : Number.isFinite(left.seq) && Number.isFinite(right.seq) && right.seq === left.seq + 1;
  return followsInStructure && length(subtract(right.ca, left.ca)) < 4.9;
}

function validateResidues(residues) {
  for (const [index, residue] of residues.entries()) {
    if (!Array.isArray(residue.ca) || residue.ca.length !== 3 || residue.ca.some((value) => !Number.isFinite(value))) {
      throw new TypeError(`Invalid Cα coordinate for residue ${index + 1}.`);
    }
  }
}

/**
 * Build one Cα-derived ribbon with up to five independent longitudinal channels.
 * Front- and back-face triangles have exactly one group per residue/channel;
 * duplicated vertices at lane borders prevent interpolation between channels.
 * The neutral edges are part of that same continuous mesh.
 */
export function buildComparisonRibbon(residues, activeCount = 0, {
  width = 2.25,
  thickness = 0.26,
  steps = 12,
} = {}) {
  if (!Array.isArray(residues)) throw new TypeError('Residues must be an array.');
  if (!Number.isInteger(activeCount) || activeCount < 0 || activeCount > MAX_CHANNELS) {
    throw new RangeError(`Channel count must be between 0 and ${MAX_CHANNELS}.`);
  }
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(thickness) || thickness <= 0) {
    throw new RangeError('Ribbon dimensions must be positive.');
  }
  if (!Number.isInteger(steps) || steps < 1) throw new RangeError('Subdivision steps must be a positive integer.');
  validateResidues(residues);

  const slots = Math.max(1, activeCount);
  const groupStride = slots * 2 + 1;
  const vertices = [];
  const normals = [];
  const groups = [];
  const indices = [];
  const groupMeta = [];
  let previousNormal = null;

  const addVertex = (point, normal, group) => {
    const index = vertices.length / 3;
    vertices.push(...point);
    normals.push(...normal);
    groups.push(group);
    return index;
  };
  const addQuad = (p0, p1, p2, p3, normal, group) => {
    const a = addVertex(p0, normal, group);
    const b = addVertex(p1, normal, group);
    const c = addVertex(p2, normal, group);
    const d = addVertex(p3, normal, group);
    indices.push(a, b, c, b, d, c);
  };
  const facePoint = (ring, lanePosition, depth) => add(
    add(ring.position, multiply(ring.binormal, (lanePosition - 0.5) * width)),
    multiply(ring.normal, depth * thickness),
  );

  for (let residueIndex = 0; residueIndex < residues.length; residueIndex += 1) {
    const residue = residues[residueIndex];
    const hasPrevious = consecutive(residues[residueIndex - 1], residue);
    const hasNext = consecutive(residue, residues[residueIndex + 1]);
    if (!hasPrevious) {
      previousNormal = null;
    }

    const start = hasPrevious ? 0 : 0.5;
    const end = hasNext ? 1 : 0.5;
    const rings = [];
    for (let step = 0; step <= steps; step += 1) {
      const amount = start + (end - start) * (step / steps);
      const previousPoint = hasPrevious ? residues[residueIndex - 1].ca : residue.ca;
      const nextPoint = hasNext ? residues[residueIndex + 1].ca : residue.ca;
      let position;
      let tangent;
      if (amount <= 0.5) {
        const control = consecutive(residues[residueIndex - 2], residues[residueIndex - 1])
          ? residues[residueIndex - 2].ca
          : previousPoint;
        const curveAmount = 0.5 + amount;
        position = catmullRom(control, previousPoint, residue.ca, nextPoint, curveAmount);
        tangent = normalize(catmullRomTangent(control, previousPoint, residue.ca, nextPoint, curveAmount));
      } else {
        const control = consecutive(residues[residueIndex + 1], residues[residueIndex + 2])
          ? residues[residueIndex + 2].ca
          : nextPoint;
        const curveAmount = amount - 0.5;
        position = catmullRom(previousPoint, residue.ca, nextPoint, control, curveAmount);
        tangent = normalize(catmullRomTangent(previousPoint, residue.ca, nextPoint, control, curveAmount));
      }

      let normal = null;
      if (previousNormal) {
        const transported = subtract(previousNormal, multiply(tangent, dot(previousNormal, tangent)));
        if (length(transported) > 0.001) normal = normalize(transported);
      }
      if (!normal) {
        const seed = Math.abs(tangent[2]) < 0.86 ? [0, 0, 1] : [0, 1, 0];
        normal = normalize(subtract(seed, multiply(tangent, dot(seed, tangent))));
      }
      const binormal = normalize(cross(tangent, normal));
      previousNormal = normal;
      rings.push({ position, normal, binormal });
    }

    for (let channelIndex = 0; channelIndex < slots; channelIndex += 1) {
      const group = residueIndex * groupStride + channelIndex;
      groupMeta[group] = {
        residueIndex,
        canonicalPosition: Number.isInteger(residue.canonicalPosition) ? residue.canonicalPosition : null,
        channelIndex: activeCount ? channelIndex : -1,
        face: 'front',
        chain: residue.chain,
        seq: residue.seq,
        insertionCode: residue.insertionCode ?? '',
        aa: residue.aa,
      };
      for (let step = 0; step < steps; step += 1) {
        const left = rings[step];
        const right = rings[step + 1];
        const laneStart = channelIndex / slots;
        const laneEnd = (channelIndex + 1) / slots;
        const frontNormal = normalize(add(left.normal, right.normal));
        addQuad(facePoint(left, laneStart, 1), facePoint(left, laneEnd, 1), facePoint(right, laneStart, 1), facePoint(right, laneEnd, 1), frontNormal, group);

        const backGroup = residueIndex * groupStride + slots + channelIndex;
        groupMeta[backGroup] = { ...groupMeta[group], channelIndex, face: 'back' };
        addQuad(facePoint(left, laneEnd, -1), facePoint(left, laneStart, -1), facePoint(right, laneEnd, -1), facePoint(right, laneStart, -1), multiply(frontNormal, -1), backGroup);
      }
    }

    const edgeGroup = residueIndex * groupStride + slots * 2;
    groupMeta[edgeGroup] = {
      residueIndex,
      canonicalPosition: Number.isInteger(residue.canonicalPosition) ? residue.canonicalPosition : null,
      channelIndex: -1,
      face: 'edge',
      chain: residue.chain,
      seq: residue.seq,
      insertionCode: residue.insertionCode ?? '',
      aa: residue.aa,
    };
    for (let step = 0; step < steps; step += 1) {
      const left = rings[step];
      const right = rings[step + 1];
      const edgeNormal = normalize(add(left.binormal, right.binormal));
      addQuad(facePoint(left, 0, -1), facePoint(left, 0, 1), facePoint(right, 0, -1), facePoint(right, 0, 1), multiply(edgeNormal, -1), edgeGroup);
      addQuad(facePoint(left, 1, 1), facePoint(left, 1, -1), facePoint(right, 1, 1), facePoint(right, 1, -1), edgeNormal, edgeGroup);
    }
  }

  if (vertices.some((value) => !Number.isFinite(value))) throw new Error('Geometry contains non-finite coordinates.');
  return {
    vertices: new Float32Array(vertices),
    normals: new Float32Array(normals),
    groups: new Float32Array(groups),
    indices: new Uint32Array(indices),
    groupMeta,
    residueCount: residues.length,
    slots,
    activeCount,
    groupStride,
    steps,
  };
}

/**
 * Update the Mesh buffers in place when channel count changes. Mol*'s shape
 * representation keeps references to these ValueCells, so replacing the Mesh
 * object leaves its render buffers attached to the previous geometry.
 */
export function createComparisonMeshGeometry(meshData, Mesh, previousGeometry = null) {
  return Mesh.create(
    meshData.vertices,
    meshData.indices,
    meshData.normals,
    meshData.groups,
    meshData.vertices.length / 3,
    meshData.indices.length / 3,
    previousGeometry ?? undefined,
  );
}

export function countMixedComparisonTriangles(mesh) {
  let mixed = 0;
  for (let index = 0; index < mesh.indices.length; index += 3) {
    const group = mesh.groups[mesh.indices[index]];
    if (group !== mesh.groups[mesh.indices[index + 1]] || group !== mesh.groups[mesh.indices[index + 2]]) mixed += 1;
  }
  return mixed;
}

export function comparisonLaneBoundaryError(mesh) {
  let worst = 0;
  const firstVertexByGroup = new Map();
  mesh.groups.forEach((group, index) => {
    if (!firstVertexByGroup.has(group)) firstVertexByGroup.set(group, index);
  });
  for (let residueIndex = 0; residueIndex < mesh.residueCount; residueIndex += 1) {
    for (let channelIndex = 0; channelIndex < mesh.slots - 1; channelIndex += 1) {
      const leftGroup = residueIndex * mesh.groupStride + channelIndex;
      const rightGroup = leftGroup + 1;
      for (const [leftOffset, rightOffset] of [[1, 0], [3, 2]]) {
        const left = (firstVertexByGroup.get(leftGroup) + leftOffset) * 3;
        const right = (firstVertexByGroup.get(rightGroup) + rightOffset) * 3;
        worst = Math.max(worst, Math.hypot(
          mesh.vertices[left] - mesh.vertices[right],
          mesh.vertices[left + 1] - mesh.vertices[right + 1],
          mesh.vertices[left + 2] - mesh.vertices[right + 2],
        ));
      }
    }
  }
  return worst;
}
