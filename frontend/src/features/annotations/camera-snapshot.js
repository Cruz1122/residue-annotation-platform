function sameJsonValue(left, right) {
  const leftIsNull = left === null || left === undefined || (typeof left === 'number' && !Number.isFinite(left));
  const rightIsNull = right === null || right === undefined || (typeof right === 'number' && !Number.isFinite(right));
  return left === right || (leftIsNull && rightIsNull);
}

// Mol* camera snapshots expose Vec3 values; copy three scalars instead of
// allocating/spreading vectors and serializing a JSON string on every sync.
function vectorMatches(snapshotVector, signature, prefix) {
  const length = snapshotVector?.length ?? 0;
  if (length !== signature[`${prefix}Length`]) return false;
  return length === 0
    || (sameJsonValue(snapshotVector[0], signature[`${prefix}X`])
      && sameJsonValue(snapshotVector[1], signature[`${prefix}Y`])
      && sameJsonValue(snapshotVector[2], signature[`${prefix}Z`]));
}

export function sameCameraSnapshot(snapshot, signature) {
  if (!snapshot || !signature) return snapshot === signature;
  return sameJsonValue(snapshot.mode, signature.mode)
    && sameJsonValue(snapshot.fov, signature.fov)
    && sameJsonValue(snapshot.radius, signature.radius)
    && sameJsonValue(snapshot.radiusMax, signature.radiusMax)
    && vectorMatches(snapshot.position, signature, 'position')
    && vectorMatches(snapshot.target, signature, 'target')
    && vectorMatches(snapshot.up, signature, 'up');
}

function snapshotVector(vector) {
  const length = vector?.length ?? 0;
  return {
    length,
    x: length > 0 ? vector[0] : undefined,
    y: length > 1 ? vector[1] : undefined,
    z: length > 2 ? vector[2] : undefined,
  };
}

export function captureCameraSnapshot(snapshot) {
  if (!snapshot) return null;
  const position = snapshotVector(snapshot.position);
  const target = snapshotVector(snapshot.target);
  const up = snapshotVector(snapshot.up);
  return {
    mode: snapshot.mode,
    fov: snapshot.fov,
    radius: snapshot.radius,
    radiusMax: snapshot.radiusMax,
    positionLength: position.length,
    positionX: position.x,
    positionY: position.y,
    positionZ: position.z,
    targetLength: target.length,
    targetX: target.x,
    targetY: target.y,
    targetZ: target.z,
    upLength: up.length,
    upX: up.x,
    upY: up.y,
    upZ: up.z,
  };
}
