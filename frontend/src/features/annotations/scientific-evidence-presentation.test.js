import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SCIENTIFIC_EVIDENCE_MODE_CONFIG,
  SCIENTIFIC_EVIDENCE_MODE_OPTIONS,
  availableScientificEvidenceModes,
  scientificEvidenceRows,
} from './scientific-evidence-presentation.js';

const CORE_ARTIFACTS = [
  ['uniprot_features', 'functional_features_long'],
  ['functional_region_evidence', 'ldlc_statin_evidence'],
  ['experimental_variant_evidence', 'mavedb_details'],
  ['variant_predictors', 'predictor_per_position'],
];

function completeSourceSet(extra = []) {
  const sourceArtifacts = new Map();
  for (const [id, artifactType] of [...CORE_ARTIFACTS, ...extra]) {
    if (!sourceArtifacts.has(id)) sourceArtifacts.set(id, []);
    sourceArtifacts.get(id).push({ artifact_type: artifactType });
  }
  const stages = [...sourceArtifacts].map(([id, artifacts]) => ({ id, status: 'success', artifacts }));
  const details = Object.fromEntries([...CORE_ARTIFACTS, ...extra].map(([, artifactType]) => [artifactType, []]));
  return { stages, details };
}

const verifiedMaveCoverage = Array.from({ length: 317 }, (_, index) => ({
  stage_id: 'experimental_variant_evidence',
  aa_position: index + 1,
  qc_status: 'verified',
  values: {
    mavedb_position_assayed: 'false',
    mavedb_n_score_sets: '0',
    mavedb_n_substitutions_tested: '0',
  },
}));

function evidenceRows(details, stages, sequence, annotations = verifiedMaveCoverage) {
  return scientificEvidenceRows(details, stages, sequence, annotations);
}

test('scientific evidence offers source-specific modes without an internal aggregate scale or explanatory footnotes', () => {
  const { stages, details } = completeSourceSet();
  assert.equal(SCIENTIFIC_EVIDENCE_MODE_CONFIG['evidence-level'], undefined);
  assert.equal(SCIENTIFIC_EVIDENCE_MODE_OPTIONS.some(({ value }) => value === 'evidence-level'), false);
  assert.deepEqual(SCIENTIFIC_EVIDENCE_MODE_OPTIONS.map(({ value }) => value), [
    'evidence-curated',
    'evidence-experimental',
    'evidence-computational',
    'evidence-pgx',
    'evidence-clinvar',
  ]);
  assert.equal(Object.values(SCIENTIFIC_EVIDENCE_MODE_CONFIG).some(({ note }) => note), false);
  assert.equal(Object.hasOwn(evidenceRows(details, stages, 'A')[0].values, 'evidence_level'), false);
});

test('an empty MaveDB detail file is evaluated only when published per-position coverage confirms explicit zeroes', () => {
  const { stages, details } = completeSourceSet();
  const zeroCoverage = [verifiedMaveCoverage[0]];
  const row = evidenceRows(details, stages, 'A', zeroCoverage)[0];
  assert.equal(row.values.experimental_evidence_status, 'none');

  const unavailable = [{
    ...verifiedMaveCoverage[0],
    values: {
      mavedb_position_assayed: 'NA',
      mavedb_n_score_sets: 'NA',
      mavedb_n_substitutions_tested: 'NA',
    },
  }];
  const unavailableRow = evidenceRows(details, stages, 'A', unavailable)[0];
  assert.equal(unavailableRow.values.experimental_evidence_status, 'not_evaluated');
});

test('MaveDB coverage is position-specific; a missing position stays unevaluated', () => {
  const { stages, details } = completeSourceSet();
  const rows = evidenceRows(details, stages, 'AA', [verifiedMaveCoverage[0]]);
  assert.equal(rows[0].values.experimental_evidence_status, 'none');
  assert.equal(rows[1].values.experimental_evidence_status, 'not_evaluated');
});

test('MaveDB summary coverage requires verified QC and a matching reference residue', () => {
  const { stages, details } = completeSourceSet();
  const unverified = [{ ...verifiedMaveCoverage[0], qc_status: 'unverified' }];
  const mismatchedReference = [{ ...verifiedMaveCoverage[0], aa_ref: 'V' }];

  for (const annotationRows of [unverified, mismatchedReference]) {
    const row = evidenceRows(details, stages, 'A', annotationRows)[0];
    assert.equal(row.values.experimental_evidence_status, 'not_evaluated');
  }
});

test('MaveDB mode is available for explicit zero coverage and stays hidden when the source is unevaluable', () => {
  const { stages, details } = completeSourceSet();
  assert.equal(availableScientificEvidenceModes(stages, details, [verifiedMaveCoverage[0]])
    .some(({ value }) => value === 'evidence-experimental'), true);
  assert.equal(availableScientificEvidenceModes(stages, details, [])
    .some(({ value }) => value === 'evidence-experimental'), false);
});

test('residue annotations qualify, but broad family features and non-exact mappings do not', () => {
  const { stages, details } = completeSourceSet();
  details.functional_features_long = [
    {
      aa_position: '1',
      source_database: 'UniProtKB',
      source_accession: 'P12345',
      feature_type: 'Binding site',
      mapping_status: 'exact',
      evidence: '[{"evidenceCode":"ECO:0000269","id":"123456","source":"PubMed"}]',
    },
    {
      aa_position: '2',
      source_database: 'InterPro',
      feature_accession: 'IPR000001',
      feature_type: 'Family',
      source_start: '2',
      source_end: '100',
      mapping_status: 'exact',
    },
    {
      aa_position: '3',
      source_database: 'UniProtKB',
      source_accession: 'P12345',
      feature_type: 'Binding site',
      mapping_status: 'approximate',
      evidence: '[{"evidenceCode":"ECO:0000269","id":"123456","source":"PubMed"}]',
    },
  ];

  assert.deepEqual(evidenceRows(details, stages, 'AAA').map((row) => row.values.curated_evidence_status), ['present', 'none', 'none']);
});

test('broad domain and family annotations do not color every covered residue as E2', () => {
  const { stages, details } = completeSourceSet();
  details.functional_features_long = [{
    aa_position: '1',
    source_database: 'InterPro',
    feature_accession: 'IPR000001',
    feature_type: 'Family',
    source_start: '1',
    source_end: '250',
    mapping_status: 'exact',
  }];
  const row = evidenceRows(details, stages, 'A')[0];
  assert.equal(row.values.curated_evidence_status, 'none');
});

test('a directly scored MaveDB substitution appears in the experimental source mode', () => {
  const { stages, details } = completeSourceSet();
  details.mavedb_details = [
    { aa_position: '1', aa_alt: 'V', score: '0.84', score_set_urn: 'urn:mavedb:00000001-a-1' },
    { aa_position: '1', aa_alt: 'L', score: '0.81', score_set_urn: 'urn:mavedb:00000001-a-2' },
  ];
  assert.equal(evidenceRows(details, stages, 'A')[0].values.experimental_evidence_status, 'present');
});

test('computational predictions, ClinVar variants, and pharmacogenomic alleles remain distinct', () => {
  const { stages, details } = completeSourceSet([
    ['clinvar', 'clinvar_per_position'],
    ['clinvar', 'clinvar_variants'],
    ['pharmacogenomics', 'pgx_per_position'],
  ]);
  details.predictor_per_position = [{ aa_position: '1', cadd_phred_mean: '22.1' }];
  details.clinvar_variants = [{ aa_position: '1', aa_ref: 'A', aa_alt: 'V', clnsig: 'Pathogenic' }];
  details.pgx_per_position = [{ aa_position: '1', pgx_star_alleles: '*2', pgx_allele_function: 'decreased function' }];

  const row = evidenceRows(details, stages, 'A')[0];
  assert.equal(row.values.experimental_evidence_status, 'none');
  assert.equal(row.values.computational_evidence_status, 'present');
  assert.equal(row.values.clinvar_evidence_status, 'present');
  assert.equal(row.values.pharmacogenomic_evidence_status, 'present');
});

test('ClinVar absence is shown only as no match in an evaluated source, not as unavailable data', () => {
  const { stages, details } = completeSourceSet([
    ['clinvar', 'clinvar_per_position'],
    ['clinvar', 'clinvar_variants'],
  ]);
  details.clinvar_per_position = [{ aa_position: '1', clinvar_status: 'no_matching_snv_in_local_vcf' }];
  const row = evidenceRows(details, stages, 'A')[0];
  assert.equal(row.values.clinvar_evidence_status, 'none');

  const withoutClinVar = stages.filter((stage) => stage.id !== 'clinvar');
  const detailsWithoutClinVar = Object.fromEntries(Object.entries(details).filter(([type]) => !type.startsWith('clinvar_')));
  assert.equal(evidenceRows(detailsWithoutClinVar, withoutClinVar, 'A')[0].values.clinvar_evidence_status, 'not_evaluated');
});

test('unsupported pharmacogenomic scope is not presented as a negative finding', () => {
  const { stages, details } = completeSourceSet([['pharmacogenomics', 'pgx_per_position']]);
  details.pgx_per_position = [
    { aa_position: '1', pgx_star_alleles: 'NA', pgx_allele_function: 'NA', na_reason: 'gene_not_in_pharmcat' },
  ];

  assert.equal(availableScientificEvidenceModes(stages, details).some(({ value }) => value === 'evidence-pgx'), false);
  assert.equal(evidenceRows(details, stages, 'A')[0].values.pharmacogenomic_evidence_status, 'not_evaluated');
});

test('curated LDL-C evidence requires exact mapping and a traceable reference', () => {
  const { stages, details } = completeSourceSet();
  details.ldlc_statin_evidence = [
    { aa_position: '1', mapping_status: 'exact', evidence_id: 'LDL-1', reference_keys: 'PMID:1' },
    { aa_position: '2', mapping_status: 'approximate', evidence_id: 'LDL-2', reference_keys: 'PMID:2' },
  ];
  assert.deepEqual(evidenceRows(details, stages, 'AA').map((row) => row.values.curated_evidence_status), ['present', 'none']);
});
