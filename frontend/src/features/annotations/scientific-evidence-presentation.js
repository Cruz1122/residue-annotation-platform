const NO_EVIDENCE_COLOR = '#e6e9ed';
const NOT_EVALUATED_COLOR = '#aab1ba';
const LOCALIZED_FEATURE_TYPES = new Set([
  'active site', 'binding site', 'site', 'metal ion binding site', 'metal binding site',
  'nucleotide binding site', 'dna binding site', 'rna binding site', 'glycosylation site',
  'modified residue', 'disulfide bond', 'cross link', 'natural variant', 'mutagenesis',
  'mutagenesis site', 'lipidation',
]);

const SOURCE_LEGEND = (presentColor) => [
  ['Registro localizado', presentColor],
  ['Sin registro en la fuente', NO_EVIDENCE_COLOR],
  ['No evaluable', NOT_EVALUATED_COLOR],
];

export const SCIENTIFIC_EVIDENCE_MODE_CONFIG = {
  'evidence-curated': {
    kind: 'categorical',
    field: 'curated_evidence_status',
    title: 'Anotación localizada',
    icon: 'book-open-check',
    colors: { present: '#27a782', none: NO_EVIDENCE_COLOR, not_evaluated: NOT_EVALUATED_COLOR },
    legend: SOURCE_LEGEND('#27a782'),
  },
  'evidence-experimental': {
    kind: 'categorical',
    field: 'experimental_evidence_status',
    title: 'Ensayos funcionales · MaveDB',
    icon: 'flask-conical',
    colors: { present: '#e88942', none: NO_EVIDENCE_COLOR, not_evaluated: NOT_EVALUATED_COLOR },
    legend: SOURCE_LEGEND('#e88942'),
  },
  'evidence-computational': {
    kind: 'categorical',
    field: 'computational_evidence_status',
    title: 'Predicciones de variantes',
    icon: 'cpu',
    colors: { present: '#5384c5', none: NO_EVIDENCE_COLOR, not_evaluated: NOT_EVALUATED_COLOR },
    legend: SOURCE_LEGEND('#5384c5'),
  },
  'evidence-pgx': {
    kind: 'categorical',
    field: 'pharmacogenomic_evidence_status',
    title: 'Farmacogenómica · alelos',
    icon: 'pill',
    colors: { present: '#8057b7', none: NO_EVIDENCE_COLOR, not_evaluated: NOT_EVALUATED_COLOR },
    legend: SOURCE_LEGEND('#8057b7'),
  },
  'evidence-clinvar': {
    kind: 'categorical',
    field: 'clinvar_evidence_status',
    title: 'ClinVar · variantes exactas',
    icon: 'badge-info',
    colors: { present: '#bd596a', none: NO_EVIDENCE_COLOR, not_evaluated: NOT_EVALUATED_COLOR },
    legend: SOURCE_LEGEND('#bd596a'),
  },
};

export const SCIENTIFIC_EVIDENCE_MODE_OPTIONS = Object.entries(SCIENTIFIC_EVIDENCE_MODE_CONFIG).map(([value, config]) => ({
  value,
  label: config.title,
}));

const MODE_ARTIFACT_REQUIREMENTS = {
  'evidence-curated': [
    ['uniprot_features', 'functional_features_long'],
    ['functional_region_evidence', 'ldlc_statin_evidence'],
  ],
  'evidence-experimental': [['experimental_variant_evidence', 'mavedb_details']],
  'evidence-computational': [['variant_predictors', 'predictor_per_position']],
  'evidence-pgx': [['pharmacogenomics', 'pgx_per_position']],
  'evidence-clinvar': [
    ['clinvar', 'clinvar_per_position'],
    ['clinvar', 'clinvar_variants'],
  ],
};

function stageArtifactWasRead(stages, details, [stageId, artifactType]) {
  const stage = (stages ?? []).find((item) => item.id === stageId);
  if (!['success', 'reused'].includes(stage?.status)) return false;
  if (!(stage.artifacts ?? []).some((artifact) => artifact.artifact_type === artifactType)) return false;
  return Object.hasOwn(details ?? {}, artifactType) && Array.isArray(details[artifactType]);
}

function stageArtifactsWereRead(stages, details, requirements, requireAll = true) {
  const wasRead = requirements.map((requirement) => stageArtifactWasRead(stages, details, requirement));
  return requireAll ? wasRead.every(Boolean) : wasRead.some(Boolean);
}

function stageHasPublishedArtifact(stages, [stageId, artifactType]) {
  const stage = (stages ?? []).find((item) => item.id === stageId);
  return ['success', 'reused'].includes(stage?.status)
    && (stage.artifacts ?? []).some((artifact) => artifact.artifact_type === artifactType);
}

function annotationValue(record, key) {
  return record?.values?.[key] ?? record?.[key];
}

function matchesReference(record, expectedAA) {
  const reference = String(record?.aa_ref ?? record?.ref_aa ?? '').trim().toUpperCase();
  return !reference || !expectedAA || reference === String(expectedAA).trim().toUpperCase();
}

function hasVerifiedMavedbCoverage(record, expectedAA = null) {
  if (record?.stage_id !== 'experimental_variant_evidence' || record?.qc_status !== 'verified') return false;
  if (positionOf(record) === null) return false;
  if (!matchesReference(record, expectedAA)) return false;
  const assayed = String(annotationValue(record, 'mavedb_position_assayed') ?? '').trim().toLowerCase();
  const scoreSets = finiteValue(annotationValue(record, 'mavedb_n_score_sets'));
  const substitutions = finiteValue(annotationValue(record, 'mavedb_n_substitutions_tested'));
  return ['true', 'false'].includes(assayed)
    && Number.isInteger(scoreSets) && scoreSets >= 0
    && Number.isInteger(substitutions) && substitutions >= 0;
}

export function availableScientificEvidenceModes(stages, details, annotationRows = []) {
  return SCIENTIFIC_EVIDENCE_MODE_OPTIONS.filter(({ value }) => {
    if (value === 'evidence-experimental') {
      const requirement = MODE_ARTIFACT_REQUIREMENTS[value][0];
      if (!stageHasPublishedArtifact(stages, requirement)) return false;
      return (details?.mavedb_details ?? []).some(hasExperimentalMeasurement)
        || (annotationRows ?? []).some((record) => hasVerifiedMavedbCoverage(record));
    }
    const requirements = MODE_ARTIFACT_REQUIREMENTS[value] ?? [];
    const allCuratedSources = value !== 'evidence-curated';
    if (!requirements.length || !stageArtifactsWereRead(stages, details, requirements, allCuratedSources)) return false;
    if (value === 'evidence-pgx') {
      return (details.pgx_per_position ?? []).some((record) => hasPharmacogenomicEvidence(record) || !hasUnavailableReason(record?.na_reason));
    }
    return true;
  });
}

function isMissing(value) {
  return value === null || value === undefined || value === '' || String(value).trim().toUpperCase() === 'NA';
}

function finiteValue(value) {
  if (isMissing(value)) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positionOf(record) {
  for (const field of ['aa_position', 'position', 'residue_position', 'canonical_position', 'residue_number']) {
    const value = Number(record?.[field]);
    if (Number.isInteger(value) && value > 0) return value;
  }
  return null;
}

function indexByPosition(records) {
  const index = new Map();
  for (const record of records ?? []) {
    const position = positionOf(record);
    if (!position) continue;
    if (!index.has(position)) index.set(position, []);
    index.get(position).push(record);
  }
  return index;
}

function hasCuratedAnnotation(record) {
  if (String(record?.mapping_status ?? '').trim().toLowerCase() !== 'exact') return false;
  if (!isResidueLocalizedFeature(record)) return false;
  const database = String(record?.source_database ?? '').trim().toLowerCase();
  return ['uniprotkb', 'interpro'].includes(database)
    && (!isMissing(record?.feature_type) || !isMissing(record?.feature_name));
}

function isResidueLocalizedFeature(record) {
  const featureType = String(record?.feature_type ?? '').trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
  if (LOCALIZED_FEATURE_TYPES.has(featureType)) return true;
  const start = Number(record?.source_start);
  const end = Number(record?.source_end);
  return Number.isInteger(start) && Number.isInteger(end) && start > 0 && start === end;
}

function hasLdlEvidence(record) {
  return String(record?.mapping_status ?? '').trim().toLowerCase() === 'exact'
    && !isMissing(record?.evidence_id)
    && !isMissing(record?.reference_keys);
}

function hasExperimentalMeasurement(record, expectedAA = null) {
  return positionOf(record) !== null
    && matchesReference(record, expectedAA)
    && !isMissing(record?.aa_alt)
    && finiteValue(record?.score) !== null
    && !isMissing(record?.score_set_urn);
}

function hasPharmacogenomicEvidence(record) {
  return ['pgx_star_alleles', 'pgx_allele_function', 'pgx_aa_changes', 'pgx_gene_evidence_level']
    .some((field) => !isMissing(record?.[field]));
}

function hasUnavailableReason(value) {
  return !isMissing(value) && String(value).trim().toLowerCase() !== 'none';
}

function hasComputationalPrediction(record) {
  return ['alphamissense_mean', 'alphamissense_max', 'cadd_phred_mean', 'revel_mean']
    .some((field) => finiteValue(record?.[field]) !== null);
}

function recordPresence(records, predicate, evaluable) {
  if (!evaluable) return 'not_evaluated';
  return (records ?? []).some(predicate) ? 'present' : 'none';
}

export function scientificEvidenceRows(details, stages, sequence, annotationRows = []) {
  const indexes = {
    curated: indexByPosition(details?.functional_features_long),
    ldl: indexByPosition(details?.ldlc_statin_evidence),
    experimental: indexByPosition(details?.mavedb_details),
    mavedbCoverage: indexByPosition((annotationRows ?? []).filter((record) => record?.stage_id === 'experimental_variant_evidence')),
    predictors: indexByPosition(details?.predictor_per_position),
    pharmacogenomics: indexByPosition(details?.pgx_per_position),
    clinvar: indexByPosition(details?.clinvar_variants),
  };
  const evaluable = Object.fromEntries(Object.entries(MODE_ARTIFACT_REQUIREMENTS).map(([mode, requirements]) => [
    mode,
    stageArtifactsWereRead(stages, details, requirements, mode !== 'evidence-curated'),
  ]));
  const maveRequirement = MODE_ARTIFACT_REQUIREMENTS['evidence-experimental'][0];
  const maveSourcePublished = stageHasPublishedArtifact(stages, maveRequirement);

  return [...String(sequence ?? '')].map((aa, index) => {
    const position = index + 1;
    const curatedRecords = indexes.curated.get(position) ?? [];
    const ldlRecords = indexes.ldl.get(position) ?? [];
    const experimentalRecords = indexes.experimental.get(position) ?? [];
    const maveCoverageRecords = indexes.mavedbCoverage.get(position) ?? [];
    const predictorRecords = indexes.predictors.get(position) ?? [];
    const pgxRecords = indexes.pharmacogenomics.get(position) ?? [];
    const clinvarRecords = indexes.clinvar.get(position) ?? [];
    const maveCoverage = maveCoverageRecords.find((record) => hasVerifiedMavedbCoverage(record, aa));
    const summaryAssayed = String(annotationValue(maveCoverage, 'mavedb_position_assayed') ?? '').toLowerCase() === 'true'
      && Number(annotationValue(maveCoverage, 'mavedb_n_substitutions_tested')) > 0;
    const measured = experimentalRecords.some((record) => hasExperimentalMeasurement(record, aa)) || summaryAssayed;
    const maveEvaluated = maveSourcePublished && (Boolean(maveCoverage) || experimentalRecords.some((record) => hasExperimentalMeasurement(record, aa)));
    const pgxRecord = pgxRecords[0];
    const pgxAvailable = evaluable['evidence-pgx'] && !hasUnavailableReason(pgxRecord?.na_reason);

    return {
      aa_position: position,
      aa_ref: aa,
      stage_id: 'scientific_evidence_visualization',
      values: {
        curated_evidence_status: recordPresence(
          [...curatedRecords, ...ldlRecords],
          (record) => hasCuratedAnnotation(record) || hasLdlEvidence(record),
          evaluable['evidence-curated'],
        ),
        experimental_evidence_status: !maveEvaluated ? 'not_evaluated' : measured ? 'present' : 'none',
        computational_evidence_status: recordPresence(predictorRecords, hasComputationalPrediction, evaluable['evidence-computational']),
        pharmacogenomic_evidence_status: recordPresence(pgxRecords, hasPharmacogenomicEvidence, pgxAvailable),
        clinvar_evidence_status: recordPresence(clinvarRecords, () => true, evaluable['evidence-clinvar']),
      },
      units: {},
    };
  });
}
