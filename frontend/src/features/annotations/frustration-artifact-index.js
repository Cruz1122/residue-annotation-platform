export const FRUSTRATION_ARTIFACT_TYPES = Object.freeze({
  sequence: 'frustraiseq_per_residue',
  structural: 'frustration_per_residue',
  primary: 'frustratometer_per_residue',
});

const INDEXED_ARTIFACT_TYPES = Object.values(FRUSTRATION_ARTIFACT_TYPES);
const RESIDUE_POSITION_FIELDS = ['aa_position', 'canonical_position', 'position', 'residue_position', 'residue_number'];

function recordPosition(record) {
  for (const key of RESIDUE_POSITION_FIELDS) {
    const position = Number(record?.[key]);
    if (Number.isInteger(position) && position > 0) return position;
  }
  return null;
}

function recordAminoAcid(record) {
  const aminoAcid = String(record?.aa_ref ?? record?.aa ?? '').trim().toUpperCase();
  return /^[A-Z]$/.test(aminoAcid) ? aminoAcid : null;
}

function residueSequenceFromRows(rows) {
  const residues = new Map();
  for (const row of rows ?? []) {
    const position = recordPosition(row);
    const aminoAcid = recordAminoAcid(row);
    if (position === null || aminoAcid === null) continue;
    const previous = residues.get(position);
    if (previous && previous !== aminoAcid) return null;
    residues.set(position, aminoAcid);
  }
  if (!residues.size) return null;
  const length = [...residues.keys()].reduce((max, position) => Math.max(max, position), 0);
  if (length > 100_000 || residues.size !== length) return null;
  return Array.from({ length }, (_, index) => residues.get(index + 1)).join('');
}

function uniqueSequenceIndex(sequence, candidate) {
  if (!candidate) return null;
  const index = sequence.indexOf(candidate);
  if (index < 0 || sequence.indexOf(candidate, index + 1) >= 0) return null;
  return index;
}

function identityPositionMap(length) {
  return new Map(Array.from({ length }, (_, index) => [index + 1, index + 1]));
}

/** Map source artifact coordinates onto the sequence shown by this run, only when the residue sequence supports it. */
export function frustrationPositionMap(sequence, referenceRows) {
  const targetSequence = String(sequence ?? '').replace(/\s+/g, '').toUpperCase();
  const sourceSequence = residueSequenceFromRows(referenceRows);
  if (!targetSequence || !sourceSequence) return null;
  if (sourceSequence === targetSequence) return identityPositionMap(targetSequence.length);

  const targetStartInSource = uniqueSequenceIndex(sourceSequence, targetSequence);
  if (targetStartInSource !== null) {
    return new Map(Array.from(targetSequence, (_, index) => [targetStartInSource + index + 1, index + 1]));
  }

  const sourceStartInTarget = uniqueSequenceIndex(targetSequence, sourceSequence);
  if (sourceStartInTarget !== null) {
    return new Map(Array.from(sourceSequence, (_, index) => [index + 1, sourceStartInTarget + index + 1]));
  }

  if (sourceSequence.length === targetSequence.length) {
    const matches = Array.from(sourceSequence).reduce(
      (count, aminoAcid, index) => count + Number(aminoAcid === targetSequence[index]),
      0,
    );
    if (matches / sourceSequence.length >= 0.95) return identityPositionMap(targetSequence.length);
  }
  return new Map();
}

function remapRowsToSequence(rows, targetSequence, sourceToTarget) {
  const normalizedSequence = String(targetSequence ?? '').replace(/\s+/g, '').toUpperCase();
  if (!(sourceToTarget instanceof Map)) return rows;
  return (rows ?? []).flatMap((row) => {
    const sourcePosition = recordPosition(row);
    if (sourcePosition === null) return [];
    const targetPosition = sourceToTarget.get(sourcePosition);
    if (!Number.isInteger(targetPosition)) return [];
    const aminoAcid = recordAminoAcid(row);
    if (aminoAcid && normalizedSequence[targetPosition - 1] !== aminoAcid) return [];
    return [{ ...row, source_aa_position: sourcePosition, aa_position: targetPosition }];
  });
}

/** Rebase frustration value artifacts to the run sequence while preserving their original source position. */
export function remapFrustrationArtifactDetails(artifactDetails = {}, targetSequence) {
  const mappedDetails = { ...artifactDetails };
  for (const artifactType of INDEXED_ARTIFACT_TYPES) {
    const rows = artifactDetails[artifactType];
    if (!Array.isArray(rows) || !rows.length) continue;
    const sourceToTarget = frustrationPositionMap(targetSequence, rows);
    if (sourceToTarget) mappedDetails[artifactType] = remapRowsToSequence(rows, targetSequence, sourceToTarget);
  }
  return mappedDetails;
}

/** Keep already run-relative annotations, and project source-relative rows only when their amino acid confirms the match. */
export function remapFrustrationAnnotations(rows, targetSequence, sourceToTarget) {
  const normalizedSequence = String(targetSequence ?? '').replace(/\s+/g, '').toUpperCase();
  return (rows ?? []).flatMap((row) => {
    const position = recordPosition(row);
    if (position === null) return [row];
    const aminoAcid = recordAminoAcid(row);
    if (position <= normalizedSequence.length && (!aminoAcid || normalizedSequence[position - 1] === aminoAcid)) {
      return [row];
    }
    const targetPosition = sourceToTarget?.get(position);
    if (!Number.isInteger(targetPosition) || (aminoAcid && normalizedSequence[targetPosition - 1] !== aminoAcid)) return [];
    return [{ ...row, source_aa_position: position, aa_position: targetPosition }];
  });
}

/** Rebase source structure coordinates so Mol* picks map back to run-relative residue positions. */
export function remapFrustrationStructureMaps(maps, sourceToTarget) {
  if (!(sourceToTarget instanceof Map)) return maps;
  const byCanonical = new Map();
  const byStructure = new Map();
  for (const [sourcePosition, key] of maps?.byCanonical ?? []) {
    const targetPosition = sourceToTarget.get(sourcePosition);
    if (!Number.isInteger(targetPosition) || byCanonical.has(targetPosition) || byStructure.has(key)) continue;
    byCanonical.set(targetPosition, key);
    byStructure.set(key, targetPosition);
  }
  return { byCanonical, byStructure };
}

/** Group structure residue keys so Mol* can draw only the residues mapped to this run. */
export function frustrationStructureResidueGroups(byStructure) {
  if (!(byStructure instanceof Map)) return [];
  const groups = new Map();
  for (const key of byStructure.keys()) {
    const [chain, rawResidueNumber, insertionCode = ''] = String(key).split('|');
    const residueNumber = Number(rawResidueNumber);
    if (!chain || !Number.isInteger(residueNumber)) continue;
    const normalizedInsertionCode = ['.', '?', 'NA'].includes(insertionCode.trim().toUpperCase()) ? '' : insertionCode.trim();
    const groupKey = `${chain}|${normalizedInsertionCode}`;
    let group = groups.get(groupKey);
    if (!group) {
      group = { chain, insertionCode: normalizedInsertionCode, residueNumbers: new Set() };
      groups.set(groupKey, group);
    }
    group.residueNumbers.add(residueNumber);
  }
  return [...groups.values()]
    .sort((left, right) => left.chain.localeCompare(right.chain)
      || left.insertionCode.localeCompare(right.insertionCode))
    .map((group) => ({
      chain: group.chain,
      insertionCode: group.insertionCode,
      residueNumbers: [...group.residueNumbers].sort((left, right) => left - right),
    }));
}

/** Build a deterministic mapped-residue selection only when coverage is sufficient. */
export function frustrationStructureSelection(byStructure, sequenceLength) {
  const sequenceSize = Number(sequenceLength);
  const groups = frustrationStructureResidueGroups(byStructure);
  const mappedResidueCount = groups.reduce((count, group) => count + group.residueNumbers.length, 0);
  const coverage = Number.isInteger(sequenceSize) && sequenceSize > 0
    ? mappedResidueCount / sequenceSize
    : 0;
  if (!groups.length || coverage < 0.5) return { groups: [], signature: '', coverage };
  return { groups, signature: JSON.stringify(groups), coverage };
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
