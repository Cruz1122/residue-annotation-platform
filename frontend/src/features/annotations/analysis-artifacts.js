import { conservationRowsFromArtifact } from './conservation-presentation.js';

const MAX_INLINE_ARTIFACT_BYTES = 2 * 1024 * 1024;
const MAX_DECOMPRESSED_ARTIFACT_BYTES = 32 * 1024 * 1024;

export const ANALYSIS_DETAIL_ARTIFACTS = {
  topology: ['tmbed_per_residue', 'tm_segments', 'span_metadata'],
  frustration: ['frustratometer_conformers', 'frustratometer_per_residue', 'frustration_per_residue', 'frustraiseq_per_residue', 'metadata', 'closure', 'frames_index'],
  conservation: ['evolution_per_residue', 'metadata'],
  'scientific-evidence': ['ldlc_statin_evidence', 'functional_features_long', 'mavedb_details', 'pgx_per_position', 'pgx_alleles', 'predictor_per_position', 'predictor_substitutions', 'clinvar_per_position', 'clinvar_variants'],
  ddg: ['variant_annotations', 'ddg_replicates', 'provenance', 'rosetta_metadata', 'variant_set'],
  contacts: ['contact_residue_summary', 'contacts_long', 'provenance'],
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

function isGzipArtifact(artifact) {
  const mediaType = String(artifact?.media_type ?? '').toLowerCase();
  const filename = String(artifact?.download_filename ?? '').toLowerCase();
  return mediaType.includes('gzip') || filename.endsWith('.gz');
}

async function readBoundedStream(stream, maxBytes) {
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch { /* stream is already closed */ }
        throw new Error('decompressed artifact exceeds the inline limit');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(buffer);
}

async function readArtifactText(blob, artifact) {
  if (!isGzipArtifact(artifact)) return blob.text();
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('gzip decompression is not available in this browser');
  }
  const source = blob.stream ? blob.stream() : new Response(blob).body;
  if (!source) throw new Error('artifact stream is unavailable');
  const decompressed = source.pipeThrough(new DecompressionStream('gzip'));
  return readBoundedStream(decompressed, MAX_DECOMPRESSED_ARTIFACT_BYTES);
}

export async function loadAnalysisArtifactDetails(run, analysis, getBlob) {
  const wanted = new Set(ANALYSIS_DETAIL_ARTIFACTS[analysis] ?? []);
  const artifacts = (run?.stages ?? [])
    .flatMap((stage) => (stage.artifacts ?? []).map((artifact) => ({ stage, artifact })))
    .filter(({ stage, artifact }) => {
      const isConformationalEvidence = analysis === 'frustration'
        && stage.id === 'conformational_ensemble'
        && ['metadata', 'frames_index'].includes(artifact.artifact_type);
      // A normal run contains provenance artifacts from several stages. The
      // contacts view must use the provenance that belongs to the Arpeggio
      // stage, otherwise an unrelated stage can overwrite its parameters.
      const isContactsEvidence = analysis === 'contacts'
        && ['contact_residue_summary', 'contacts_long', 'provenance'].includes(artifact.artifact_type);
      if (isContactsEvidence && stage.id !== 'structural_contacts') return false;
      const evidenceArtifactStages = {
        ldlc_statin_evidence: ['functional_region_evidence'],
        functional_features_long: ['uniprot_features'],
        mavedb_details: ['experimental_variant_evidence'],
        pgx_per_position: ['pharmacogenomics'],
        pgx_alleles: ['pharmacogenomics'],
        predictor_per_position: ['variant_predictors'],
        predictor_substitutions: ['variant_predictors'],
        clinvar_per_position: ['clinvar'],
        clinvar_variants: ['clinvar'],
      };
      if (analysis === 'scientific-evidence' && !evidenceArtifactStages[artifact.artifact_type]?.includes(stage.id)) return false;
      // ``metadata`` is a shared artifact name across stages. Conservation
      // must read the metadata published by its own stage, otherwise a later
      // predictor/feature metadata file can silently replace its method and
      // provenance in the panel.
      const isForeignConservationMetadata = analysis === 'conservation'
        && artifact.artifact_type === 'metadata'
        && stage.id
        && stage.id !== 'evolutionary_conservation';
      if (isForeignConservationMetadata) return false;
      return (wanted.has(artifact.artifact_type) || isConformationalEvidence)
        && artifact.size <= MAX_INLINE_ARTIFACT_BYTES;
    });
  const settled = await Promise.allSettled(artifacts.map(async ({ stage, artifact }) => {
    const blob = await getBlob(artifact.id);
    const type = analysis === 'frustration' && stage.id === 'conformational_ensemble'
      ? `conformational_ensemble_${artifact.artifact_type}`
      : artifact.artifact_type;
    return [type, parseAnalysisArtifact(await readArtifactText(blob, artifact), artifact.media_type)];
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
  if (analysis === 'conservation') {
    return conservationRowsFromArtifact(details?.evolution_per_residue);
  }
  if (analysis === 'scientific-evidence') {
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
