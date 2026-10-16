const MAX_INLINE_ARTIFACT_BYTES = 2 * 1024 * 1024;

export const ANALYSIS_DETAIL_ARTIFACTS = {
  topology: ['tmbed_per_residue', 'tm_segments', 'span_metadata'],
  frustration: ['frustratometer_conformers', 'frustratometer_per_residue', 'frustration_per_residue', 'frustraiseq_per_residue', 'metadata', 'closure'],
  conservation: ['evolution_per_residue', 'metadata'],
  functional: ['ldlc_statin_evidence', 'functional_features_long', 'summary'],
  ddg: ['variant_annotations', 'provenance', 'rosetta_metadata'],
  contacts: ['contact_residue_summary', 'contacts_long'],
};

function parseDelimitedLine(line, delimiter) {
  const cells = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === delimiter && !quoted) {
      cells.push(value);
      value = '';
    } else {
      value += character;
    }
  }
  cells.push(value);
  return cells;
}

function rowsFromObject(value) {
  if (Array.isArray(value)) return value.filter((row) => row && typeof row === 'object' && !Array.isArray(row));
  if (!value || typeof value !== 'object') return [];
  for (const key of ['rows', 'records', 'results', 'data', 'items', 'variants', 'residues']) {
    if (Array.isArray(value[key])) return rowsFromObject(value[key]);
  }
  return [value];
}

export function parseAnalysisArtifact(text, mediaType = '') {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return [];
  if (String(mediaType).includes('json') || trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return rowsFromObject(JSON.parse(trimmed));
    } catch {
      return [];
    }
  }
  const lines = trimmed.split(/\r?\n/).filter((line) => line.trim() && !line.trimStart().startsWith('#'));
  if (lines.length < 2) return [];
  const delimiter = lines[0].includes('\t') ? '\t' : ',';
  const headers = parseDelimitedLine(lines[0], delimiter).map((header) => header.trim());
  if (!headers.length || headers.some((header) => !header)) return [];
  return lines.slice(1).map((line) => {
    const cells = parseDelimitedLine(line, delimiter);
    return Object.fromEntries(headers.map((header, index) => [header, cells[index]?.trim() ?? '']));
  });
}

export async function loadAnalysisArtifactDetails(run, analysis, getBlob) {
  const wanted = new Set(ANALYSIS_DETAIL_ARTIFACTS[analysis] ?? []);
  const artifacts = (run?.stages ?? [])
    .flatMap((stage) => stage.artifacts ?? [])
    .filter((artifact) => wanted.has(artifact.artifact_type) && artifact.size <= MAX_INLINE_ARTIFACT_BYTES);
  const settled = await Promise.allSettled(artifacts.map(async (artifact) => {
    const blob = await getBlob(artifact.id);
    return [artifact.artifact_type, parseAnalysisArtifact(await blob.text(), artifact.media_type)];
  }));
  const details = {};
  for (const result of settled) {
    if (result.status !== 'fulfilled') continue;
    const [type, rows] = result.value;
    details[type] = rows;
  }
  return details;
}

function positionFromRecord(record) {
  for (const key of ['aa_position', 'position', 'residue_position', 'canonical_position', 'residue_number']) {
    const number = Number(record?.[key]);
    if (Number.isInteger(number) && number > 0) return number;
  }
  const variant = String(record?.variant_id ?? record?.variant ?? '');
  const match = variant.match(/^[A-Z]?(\d+)[A-Z]?$/i);
  return match ? Number(match[1]) : null;
}

function unitFromRecord(record) {
  for (const key of ['ddg_unit', 'unit']) {
    const value = record?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  const units = record?.units;
  if (typeof units === 'string' && units.trim()) return units.trim();
  if (units && typeof units === 'object') {
    for (const key of ['ddg_value', 'ddg', 'energy']) {
      const value = units[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
  }
  return null;
}

function referenceFromRecord(record) {
  const explicit = String(record?.aa_ref ?? '').trim().toUpperCase();
  if (/^[A-Z]$/.test(explicit)) return explicit;
  const variant = String(record?.variant_id ?? record?.variant ?? '').trim().toUpperCase();
  const match = variant.match(/^([A-Z])\d+[A-Z]$/);
  return match?.[1] ?? undefined;
}

function normalizedFeatureType(record) {
  return String(record?.feature_type ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

export function functionalFeatureClass(record) {
  const featureType = normalizedFeatureType(record);
  if (!featureType) return 'unknown';

  if (['signal', 'transit peptide', 'propeptide', 'peptide'].some((value) => featureType.includes(value))) {
    return 'highlighted_segment';
  }
  if ([
    'binding site', 'active site', 'site', 'glycosylation', 'modified residue',
    'natural variant', 'mutagenesis', 'lipidation', 'cross-link',
  ].some((value) => featureType.includes(value))) {
    return 'functional_interest';
  }
  if (['family', 'region', 'domain', 'chain', 'repeat', 'coiled-coil'].some((value) => featureType.includes(value))) {
    return 'curated_region';
  }
  return 'annotation';
}

export function recordsForPosition(details, artifactType, position) {
  if (!Number.isInteger(position)) return [];
  return (details?.[artifactType] ?? []).filter((record) => positionFromRecord(record) === position);
}

export function presentationRowsFromArtifacts(details, analysis) {
  if (analysis === 'functional') {
    const grouped = new Map();
    for (const record of details?.functional_features_long ?? []) {
      const aaPosition = positionFromRecord(record);
      if (!aaPosition) continue;
      const current = grouped.get(aaPosition) ?? {
        aa_position: aaPosition,
        aa_ref: String(record?.aa_ref ?? '').trim().toUpperCase() || undefined,
        types: new Set(),
        names: new Set(),
        classes: new Set(),
        mappingStatuses: new Set(),
      };
      const featureType = String(record?.feature_type ?? '').trim();
      const featureName = String(record?.feature_name ?? '').trim();
      const mappingStatus = String(record?.mapping_status ?? '').trim();
      if (featureType) current.types.add(featureType);
      if (featureName) current.names.add(featureName);
      if (mappingStatus) current.mappingStatuses.add(mappingStatus);
      current.classes.add(functionalFeatureClass(record));
      grouped.set(aaPosition, current);
    }
    return [...grouped.values()].map((record) => ({
      aa_position: record.aa_position,
      aa_ref: record.aa_ref,
      stage_id: 'uniprot_features_artifact',
      values: {
        functional_feature_class: [...record.classes].sort().join('|'),
        functional_feature_type: [...record.types].sort().join(' · '),
        functional_feature_name: [...record.names].sort().join(' · '),
        functional_feature_mapping_status: [...record.mappingStatuses].sort().join(' · '),
      },
      units: {},
    }));
  }
  if (analysis !== 'ddg') return [];
  const provenanceRecords = [
    ...(details?.provenance ?? []),
    ...(details?.rosetta_metadata ?? []),
  ];
  const provenanceUnit = provenanceRecords.map(unitFromRecord).find(Boolean) ?? null;
  return (details?.variant_annotations ?? []).flatMap((record) => {
    const aaPosition = positionFromRecord(record);
    const value = firstDetailValue(record, ['ddg_value']);
    const number = Number(value);
    if (!aaPosition || value === null || !Number.isFinite(number)) return [];
    const unit = unitFromRecord(record) ?? provenanceUnit;
    return [{
      aa_position: aaPosition,
      aa_ref: referenceFromRecord(record),
      stage_id: 'variant_ddg_artifact',
      values: { ddg_value: number },
      units: unit ? { ddg_value: unit } : {},
    }];
  });
}

export function summarizeArtifactRecord(record) {
  if (!record) return 'Sin dato';
  const bounded = (value) => {
    const text = String(value);
    return text.length > 320 ? `${text.slice(0, 317)}…` : text;
  };
  const preferred = firstDetailValue(record, ['summary', 'message', 'description', 'result', 'status']);
  if (preferred !== null && typeof preferred !== 'object') return bounded(preferred);
  const fields = Object.entries(record)
    .filter(([, value]) => value !== null && value !== undefined && value !== '' && typeof value !== 'object')
    .slice(0, 3)
    .map(([key, value]) => `${key}: ${bounded(value)}`);
  return fields.length ? fields.join(' · ') : 'Sin dato';
}

export function firstDetailValue(record, keys) {
  for (const key of keys) {
    const value = record?.[key];
    if (value !== null && value !== undefined && value !== '' && value !== 'NA') return value;
  }
  return null;
}
