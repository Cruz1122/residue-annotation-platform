export const BIOEMU_MAX_INTERPOLATION_SUBSTEPS = 60;
const INTERPOLATED_MODEL_CACHE_SIZE = 4;

function getCoordinates(model) {
  const coordinates = model?.atomicConformation;
  const { x, y, z } = coordinates ?? {};
  if (!x || !y || !z || x.length !== y.length || x.length !== z.length) {
    throw new Error('Las coordenadas del XTC no coinciden con los átomos de la topología PDB.');
  }
  return { x, y, z };
}
function blendCoordinates(start, end, progress) {
  const result = new Float32Array(start.length);
  const remainder = 1 - progress;
  for (let index = 0; index < start.length; index += 1) {
    result[index] = start[index] * remainder + end[index] * progress;
  }
  return result;
}

function normalizeVector(x, y, z) {
  const length = Math.hypot(x, y, z);
  if (length <= 1e-8) return null;
  return [x / length, y / length, z / length];
}

function perpendicularTo(vector) {
  const [x, y, z] = vector;
  const reference = Math.abs(x) < Math.abs(y)
    ? (Math.abs(x) < Math.abs(z) ? [1, 0, 0] : [0, 0, 1])
    : (Math.abs(y) < Math.abs(z) ? [0, 1, 0] : [0, 0, 1]);
  return normalizeVector(
    y * reference[2] - z * reference[1],
    z * reference[0] - x * reference[2],
    x * reference[1] - y * reference[0],
  );
}

function interpolateBondVector(start, end, progress) {
  const startLength = Math.hypot(...start);
  const endLength = Math.hypot(...end);
  const length = startLength + (endLength - startLength) * progress;
  if (progress <= 0) return start;
  if (progress >= 1) return end;
  if (length <= 1e-8) return [0, 0, 0];

  const startDirection = normalizeVector(...start);
  const endDirection = normalizeVector(...end);
  if (!startDirection && !endDirection) return [0, 0, 0];
  if (!startDirection) return endDirection.map((component) => component * length);
  if (!endDirection) return startDirection.map((component) => component * length);

  const cosine = Math.max(-1, Math.min(1,
    startDirection[0] * endDirection[0]
      + startDirection[1] * endDirection[1]
      + startDirection[2] * endDirection[2],
  ));
  let direction;

  if (cosine < -0.9995) {
    const perpendicular = perpendicularTo(startDirection);
    const angle = Math.PI * progress;
    direction = startDirection.map((component, index) => (
      component * Math.cos(angle) + perpendicular[index] * Math.sin(angle)
    ));
  } else if (cosine > 0.9995) {
    direction = normalizeVector(
      startDirection[0] + (endDirection[0] - startDirection[0]) * progress,
      startDirection[1] + (endDirection[1] - startDirection[1]) * progress,
      startDirection[2] + (endDirection[2] - startDirection[2]) * progress,
    ) ?? startDirection;
  } else {
    const angle = Math.acos(cosine);
    const sine = Math.sin(angle);
    const startWeight = Math.sin((1 - progress) * angle) / sine;
    const endWeight = Math.sin(progress * angle) / sine;
    direction = [
      startDirection[0] * startWeight + endDirection[0] * endWeight,
      startDirection[1] * startWeight + endDirection[1] * endWeight,
      startDirection[2] * startWeight + endDirection[2] * endWeight,
    ];
  }

  return direction.map((component) => component * length);
}

function traceSegments(model, atomCount) {
  const hierarchy = model?.atomicHierarchy;
  const traceIndices = hierarchy?.derived?.residue?.traceElementIndex;
  const directionFromIndices = hierarchy?.derived?.residue?.directionFromElementIndex;
  const directionToIndices = hierarchy?.derived?.residue?.directionToElementIndex;
  const residueOffsets = hierarchy?.residueAtomSegments?.offsets;
  const chainIndices = hierarchy?.chainAtomSegments?.index;
  if (!traceIndices || !residueOffsets || !chainIndices) return [];

  const segments = [];
  let current = [];
  let currentChain = -1;
  const flush = () => {
    if (current.length > 1) segments.push(current);
    current = [];
    currentChain = -1;
  };

  for (let residueIndex = 0; residueIndex < traceIndices.length; residueIndex += 1) {
    const atomStart = residueOffsets[residueIndex];
    const atomEnd = residueOffsets[residueIndex + 1];
    const traceIndex = traceIndices[residueIndex];
    const chainIndex = atomStart < atomCount ? chainIndices[atomStart] : -1;
    if (traceIndex < 0 || traceIndex >= atomCount || atomStart >= atomEnd || chainIndex < 0) {
      flush();
      continue;
    }
    if (current.length && currentChain !== chainIndex) flush();
    currentChain = chainIndex;
    current.push({
      residueIndex,
      traceIndex,
      directionFromIndex: directionFromIndices?.[residueIndex] ?? -1,
      directionToIndex: directionToIndices?.[residueIndex] ?? -1,
      atomStart,
      atomEnd,
    });
  }
  flush();
  return segments;
}

function stabilizeTraceGeometry(coordinates, fromCoordinates, toCoordinates, segments, progress) {
  if (!segments.length) return;
  for (const segment of segments) {
    for (const residue of segment) {
      const { directionFromIndex, directionToIndex } = residue;
      if (
        directionFromIndex < residue.atomStart
        || directionFromIndex >= residue.atomEnd
        || directionToIndex < residue.atomStart
        || directionToIndex >= residue.atomEnd
        || directionFromIndex === directionToIndex
      ) continue;

      const startBond = [
        fromCoordinates.x[directionToIndex] - fromCoordinates.x[directionFromIndex],
        fromCoordinates.y[directionToIndex] - fromCoordinates.y[directionFromIndex],
        fromCoordinates.z[directionToIndex] - fromCoordinates.z[directionFromIndex],
      ];
      const endBond = [
        toCoordinates.x[directionToIndex] - toCoordinates.x[directionFromIndex],
        toCoordinates.y[directionToIndex] - toCoordinates.y[directionFromIndex],
        toCoordinates.z[directionToIndex] - toCoordinates.z[directionFromIndex],
      ];
      const bond = interpolateBondVector(startBond, endBond, progress);
      const midpointX = (coordinates.x[directionFromIndex] + coordinates.x[directionToIndex]) / 2;
      const midpointY = (coordinates.y[directionFromIndex] + coordinates.y[directionToIndex]) / 2;
      const midpointZ = (coordinates.z[directionFromIndex] + coordinates.z[directionToIndex]) / 2;
      coordinates.x[directionFromIndex] = midpointX - bond[0] / 2;
      coordinates.y[directionFromIndex] = midpointY - bond[1] / 2;
      coordinates.z[directionFromIndex] = midpointZ - bond[2] / 2;
      coordinates.x[directionToIndex] = midpointX + bond[0] / 2;
      coordinates.y[directionToIndex] = midpointY + bond[1] / 2;
      coordinates.z[directionToIndex] = midpointZ + bond[2] / 2;
    }

    const first = segment[0];
    let targetX = coordinates.x[first.traceIndex];
    let targetY = coordinates.y[first.traceIndex];
    let targetZ = coordinates.z[first.traceIndex];

    for (let index = 0; index < segment.length; index += 1) {
      const residue = segment[index];
      const traceIndex = residue.traceIndex;
      if (index > 0) {
        const previous = segment[index - 1];
        const startBond = [
          fromCoordinates.x[traceIndex] - fromCoordinates.x[previous.traceIndex],
          fromCoordinates.y[traceIndex] - fromCoordinates.y[previous.traceIndex],
          fromCoordinates.z[traceIndex] - fromCoordinates.z[previous.traceIndex],
        ];
        const endBond = [
          toCoordinates.x[traceIndex] - toCoordinates.x[previous.traceIndex],
          toCoordinates.y[traceIndex] - toCoordinates.y[previous.traceIndex],
          toCoordinates.z[traceIndex] - toCoordinates.z[previous.traceIndex],
        ];
        const bond = interpolateBondVector(startBond, endBond, progress);
        targetX += bond[0];
        targetY += bond[1];
        targetZ += bond[2];
      }

      const translationX = targetX - coordinates.x[traceIndex];
      const translationY = targetY - coordinates.y[traceIndex];
      const translationZ = targetZ - coordinates.z[traceIndex];
      for (let atomIndex = residue.atomStart; atomIndex < residue.atomEnd; atomIndex += 1) {
        coordinates.x[atomIndex] += translationX;
        coordinates.y[atomIndex] += translationY;
        coordinates.z[atomIndex] += translationZ;
      }
    }
  }
}

function normalizeIndex(index, frameCount) {
  const rounded = Math.round(Number(index) || 0);
  return ((rounded % frameCount) + frameCount) % frameCount;
}

/**
 * Build a lazy visual trajectory that blends atom coordinates between BioEmu samples.
 * The generated intermediate coordinates are for display only and are not BioEmu samples.
 */
export function createInterpolatedBioEmuTrajectory(sourceTrajectory, {
  maxSubsteps = BIOEMU_MAX_INTERPOLATION_SUBSTEPS,
  modelApi,
  cacheSize = INTERPOLATED_MODEL_CACHE_SIZE,
} = {}) {
  const sourceFrames = sourceTrajectory?.frames;
  const sourceFrameCount = sourceTrajectory?.frameCount;
  const steps = Math.max(1, Math.trunc(Number(maxSubsteps) || BIOEMU_MAX_INTERPOLATION_SUBSTEPS));

  if (!Array.isArray(sourceFrames) || !Number.isInteger(sourceFrameCount) || sourceFrameCount < 1 || sourceFrames.length !== sourceFrameCount) {
    throw new Error('Mol* no expuso los frames de coordenadas necesarios para interpolar los conformeros.');
  }

  const coordinateFrames = sourceFrames.map(getCoordinates);
  const atomCount = coordinateFrames[0].x.length;
  if (coordinateFrames.some(({ x, y, z }) => x.length !== atomCount || y.length !== atomCount || z.length !== atomCount)) {
    throw new Error('Los frames del XTC no contienen el mismo número de coordenadas por átomo.');
  }
  const residueTraceSegments = traceSegments(sourceFrames[0], atomCount);

  const virtualFrameCount = sourceFrameCount < 2 ? sourceFrameCount : sourceFrameCount * steps;
  const recentModels = new Map();
  const maxCachedModels = Math.max(1, Math.trunc(Number(cacheSize) || INTERPOLATED_MODEL_CACHE_SIZE));

  const getInterpolatedModel = (virtualIndex, fromIndex, toIndex, progress) => {
    const cached = recentModels.get(virtualIndex);
    if (cached) {
      recentModels.delete(virtualIndex);
      recentModels.set(virtualIndex, cached);
      return cached;
    }

    const fromModel = sourceFrames[fromIndex];
    const fromCoordinates = coordinateFrames[fromIndex];
    const toCoordinates = coordinateFrames[toIndex];
    const coordinates = {
      x: blendCoordinates(fromCoordinates.x, toCoordinates.x, progress),
      y: blendCoordinates(fromCoordinates.y, toCoordinates.y, progress),
      z: blendCoordinates(fromCoordinates.z, toCoordinates.z, progress),
    };
    stabilizeTraceGeometry(coordinates, fromCoordinates, toCoordinates, residueTraceSegments, progress);

    const model = {
      ...fromModel,
      id: `${fromModel.id ?? 'bioemu'}-visual-${virtualIndex}`,
      modelNum: fromIndex,
      atomicConformation: {
        ...fromModel.atomicConformation,
        // Mol* caches structure transforms by conformation id; each interpolated
        // coordinate set must therefore have its own identity.
        id: `${fromModel.atomicConformation.id ?? fromModel.id ?? 'bioemu'}-visual-${virtualIndex}`,
        ...coordinates,
      },
      _dynamicPropertyData: Object.create(null),
    };
    modelApi?.TrajectoryInfo?.set?.(model, { index: fromIndex, size: sourceFrameCount });

    recentModels.set(virtualIndex, model);
    while (recentModels.size > maxCachedModels) {
      recentModels.delete(recentModels.keys().next().value);
    }
    return model;
  };

  const trajectory = {
    frameCount: virtualFrameCount,
    duration: virtualFrameCount,
    representative: sourceTrajectory.representative ?? sourceFrames[0],
    getFrameAtIndex(index) {
      const virtualIndex = normalizeIndex(index, virtualFrameCount);
      if (sourceFrameCount < 2) return sourceFrames[0];

      const fromIndex = Math.floor(virtualIndex / steps);
      const substep = virtualIndex % steps;
      if (substep === 0) return sourceFrames[fromIndex];

      const toIndex = (fromIndex + 1) % sourceFrameCount;
      return getInterpolatedModel(virtualIndex, fromIndex, toIndex, substep / steps);
    },
  };

  return {
    trajectory,
    sourceFrameCount,
    virtualFrameCount,
    maxSubsteps: sourceFrameCount < 2 ? 1 : steps,
  };
}

export function interpolatedBioEmuFrameIndex(frameIndex, progress, frameCount, maxSubsteps = BIOEMU_MAX_INTERPOLATION_SUBSTEPS) {
  if (!Number.isInteger(frameCount) || frameCount < 1) return null;
  const steps = Math.max(1, Math.trunc(Number(maxSubsteps) || BIOEMU_MAX_INTERPOLATION_SUBSTEPS));
  if (frameCount === 1) return 0;

  const sourceIndex = Math.min(frameCount - 1, Math.max(0, Math.trunc(Number(frameIndex) || 0)));
  const fraction = Math.min(1, Math.max(0, Number(progress) || 0));
  return normalizeIndex(Math.round((sourceIndex + fraction) * steps), frameCount * steps);
}
