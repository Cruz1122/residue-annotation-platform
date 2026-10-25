export const FRUSTRATION_ARTIFACT_TYPES = Object.freeze({
  sequence: 'frustraiseq_per_residue',
  structural: 'frustration_per_residue',
  primary: 'frustratometer_per_residue',
});

const INDEXED_ARTIFACT_TYPES = Object.values(FRUSTRATION_ARTIFACT_TYPES);

function recordPosition(record) {
  for (const key of ['aa_position', 'position', 'residue_position', 'canonical_position', 'residue_number']) {
    const position = Number(record?.[key]);
    if (Number.isInteger(position) && position > 0) return position;
  }
  return null;
}

/** Build per-artifact residue indexes so repeated UI lookups stay O(1). */
export function indexFrustrationArtifactDetails(artifactDetails = {}) {
  const byArtifact = new Map();
  for (const artifactType of INDEXED_ARTIFACT_TYPES) {
    const records = artifactDetails[artifactType];
    if (!Array.isArray(records) || records.length === 0) continue;
    const byPosition = new Map();
    for (const record of records) {
      const position = recordPosition(record);
      if (position === null) continue;
      let rows = byPosition.get(position);
      if (!rows) {
        rows = [];
        byPosition.set(position, rows);
      }
      rows.push(record);
    }
    byArtifact.set(artifactType, byPosition);
  }
  return byArtifact;
}

export function frustrationRecordsAtPosition(indexedArtifacts, artifactType, position) {
  return indexedArtifacts?.get(artifactType)?.get(position) ?? [];
}
