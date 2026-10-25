import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assignCanonicalPositions,
  annotationForResidue,
  canonicalChain,
  clinvarStatusLabel,
  colorForValues,
  colorOnScale,
  fixedDomainForMode,
  mergeAnnotationRows,
  measurementForMode,
  normalizeValue,
  normalizeUniprotFeatureLabel,
  publishedModeValue,
  relativeDomain,
  readableValue,
  residueDisplayColor,
  topologyClass,
  VISUALIZATION_MODES,
  viewerModeAvailability,
} from './viewer-presentation.js';

test('NA is not a number and is not treated as zero', () => {
  assert.equal(normalizeValue('NA', 0, 10), null);
  assert.equal(normalizeValue(null, 0, 10), null);
  assert.equal(normalizeValue('', 0, 10), null);
  assert.equal(normalizeValue(0, 0, 10), 0);
});

test('continuous color uses the visual midpoint, not a neighbor blend', () => {
  const colors = VISUALIZATION_MODES.frustration.colors;
  assert.equal(colorOnScale(0, colors), colors[0]);
  assert.equal(colorOnScale(0.5, colors), colors[Math.floor(colors.length / 2)]);
  assert.equal(colorOnScale(1, colors), colors.at(-1));
  assert.equal(colorOnScale(null, colors), null);
});

test('ConSurf uses its native fixed 1-to-9 scale', () => {
  const domain = fixedDomainForMode('conservation');
  const low = colorForValues('conservation', { consurf_grade: 1 }, domain);
  const high = colorForValues('conservation', { consurf_grade: 9 }, domain);
  assert.equal(low, VISUALIZATION_MODES.conservation.colors[0]);
  assert.equal(high, VISUALIZATION_MODES.conservation.colors.at(-1));
  assert.equal(colorForValues('conservation', { consurf_grade: 'NA' }, domain), null);
  assert.equal(colorForValues('conservation', { consurf_grade: 0 }, domain), null);
  assert.equal(colorForValues('conservation', { consurf_grade: 10 }, domain), null);
  assert.equal(colorForValues('conservation', { consurf_grade: 5.5 }, domain), null);
});

test('fixed numeric domains do not depend on the values in the current run', () => {
  assert.deepEqual(fixedDomainForMode('frustration'), { min: -2, max: 2, source: 'frustratometer_reference', relative: false });
  assert.deepEqual(fixedDomainForMode('contacts'), { min: 0, max: 50, source: 'absolute_contact_count_reference', relative: false });
  assert.deepEqual(fixedDomainForMode('ddg'), { min: -5, max: 5, source: 'fixed_native_unit_reference', relative: false });
  assert.equal(colorForValues('contacts', { structural_contacts_n_contacts: 2 }, fixedDomainForMode('contacts')), colorForValues('contacts', { structural_contacts_n_contacts: 2 }, fixedDomainForMode('contacts')));
  assert.notEqual(colorForValues('contacts', { structural_contacts_n_contacts: 2 }, fixedDomainForMode('contacts')), VISUALIZATION_MODES.contacts.colors.at(-1));
});

test('regime stays categorical', () => {
  assert.equal(colorForValues('regime', { structural_regime: 'membrane' }, null), '#269b65');
  assert.equal(colorForValues('regime', { structural_regime: 'NA' }, null), null);
  assert.equal(residueDisplayColor('regime', {}, null, null), '#b8bec5');
});

test('categorical modes expose published values to the shared viewer shell', () => {
  assert.deepEqual(publishedModeValue('topology', { tmbed_topology: 'signal_peptide' }), {
    field: 'tmbed_topology',
    value: 'signal_peptide',
  });
  assert.deepEqual(publishedModeValue('functional', { functional_feature_class: 'curated_region' }), {
    field: 'functional_feature_class',
    value: 'curated_region',
  });
  assert.equal(publishedModeValue('topology', { tmbed_topology: 'NA' }), null);
});

test('scientific evidence values do not expose backend agreement tokens', () => {
  assert.equal(readableValue('topology_agreement', 'tmbed_only'), 'Solo TMbed');
  assert.equal(readableValue('topology_agreement', 'uniprot_only'), 'Solo UniProt');
  assert.equal(readableValue('topology_agreement', 'concordant'), 'Concordante');
});

test('scientific evidence normalizes UniProt feature vocabulary and shared annotation terms', () => {
  assert.equal(normalizeUniprotFeatureLabel('Signal'), 'Péptido señal');
  assert.equal(normalizeUniprotFeatureLabel('family'), 'Familia proteica');
  assert.equal(normalizeUniprotFeatureLabel('Apolipoprotein A1/A4/E'), 'Apolipoproteína A1/A4/E');
  assert.equal(normalizeUniprotFeatureLabel('Transmembrane helix'), 'Hélice transmembrana');
  assert.equal(normalizeUniprotFeatureLabel('DNA_binding'), 'Unión a ADN');
  assert.equal(normalizeUniprotFeatureLabel('C-terminal region'), 'Región C-terminal');
  assert.equal(normalizeUniprotFeatureLabel('LDL-receptor class A'), 'Receptor LDL clase A');
  assert.equal(normalizeUniprotFeatureLabel('Signal · family'), 'Péptido señal · Familia proteica');
  assert.equal(normalizeUniprotFeatureLabel('natural variant'), 'Variante natural');
  assert.equal(normalizeUniprotFeatureLabel('Non-standard residue'), 'Residuo no canónico');
  assert.equal(normalizeUniprotFeatureLabel('Non-terminal residue'), 'Residuo no terminal');
  assert.equal(normalizeUniprotFeatureLabel('Alternative sequence'), 'Secuencia alternativa');
  assert.equal(normalizeUniprotFeatureLabel('Coiled coil'), 'Hélice superenrollada');
  assert.equal(normalizeUniprotFeatureLabel('Nucleotide phosphate-binding'), 'Unión a nucleótido fosfato');
  assert.equal(normalizeUniprotFeatureLabel('beta-propeller'), 'Propela β');
  assert.equal(normalizeUniprotFeatureLabel('InterPro entry'), 'InterPro entry');
  assert.equal(readableValue('uniprot_domain', 'EGF-like'), 'Tipo EGF');
  assert.equal(readableValue('uniprot_domain', 'LDL receptor class A'), 'Receptor LDL clase A');
});

test('scientific evidence hides unknown ClinVar statuses', () => {
  assert.equal(clinvarStatusLabel('no_matching_snv_in_local_vcf'), 'Sin variantes coincidentes');
  assert.equal(clinvarStatusLabel('unknown_pipeline_status'), null);
});

test('functional colors come from published UniProt feature classes', () => {
  assert.equal(colorForValues('functional', { functional_feature_class: 'highlighted_segment' }, null), '#ee805b');
  assert.equal(colorForValues('functional', { functional_feature_class: 'functional_interest|curated_region' }, null), '#27a8b5');
  assert.equal(colorForValues('functional', { variant_in_statin_ldlc_region: false }, null), '#c3c7cb');
});

test('relative domain ignores missing values', () => {
  const domain = relativeDomain('contacts', [
    { values: { structural_contacts_n_contacts: 'NA' } },
    { values: { structural_contacts_n_contacts: 2 } },
    { values: { structural_contacts_n_contacts: 8 } },
  ]);
  assert.deepEqual(domain, { min: 2, max: 8, relative: true });
});

test('frustration uses the first published numeric source without relabeling it', () => {
  assert.deepEqual(measurementForMode('frustration', {
    frustratometer_mean: 'NA',
    structural_frustration_fi_singleresidue: '-1.956',
    frustraiseq_index: 0.04,
  }), { field: 'structural_frustration_fi_singleresidue', value: -1.956 });
  assert.deepEqual(measurementForMode('frustration', {
    frustratometer_mean: 'NA',
    structural_frustration_fi_singleresidue: 'NA',
    frustraiseq_index: 0.04,
  }), { field: 'frustraiseq_index', value: 0.04 });
  assert.equal(relativeDomain('frustration', [
    { values: { frustratometer_mean: 'NA', structural_frustration_fi_singleresidue: -2 } },
    { values: { frustratometer_mean: 'NA', structural_frustration_fi_singleresidue: 1 } },
  ]).min, -2);
});

test('ddg uses a continuous numeric scale and keeps unevaluated residues missing', () => {
  const rows = [
    { values: { ddg_value: -0.4 } },
    { values: { ddg_value: 1.84 } },
    { values: { ddg_variant_evaluated: false } },
  ];
  const domain = relativeDomain('ddg', rows);
  assert.deepEqual(domain, { min: -0.4, max: 1.84, relative: true });
  assert.equal(colorForValues('ddg', { ddg_value: -0.4 }, domain), VISUALIZATION_MODES.ddg.colors[0]);
  assert.equal(colorForValues('ddg', { ddg_value: 1.84 }, domain), VISUALIZATION_MODES.ddg.colors.at(-1));
  assert.equal(colorForValues('ddg', { ddg_variant_evaluated: false }, domain), null);
  assert.equal(viewerModeAvailability([
    { aa_position: 4, values: { ddg_value: 'not-a-number' } },
  ], { structureAvailable: true, mappingValid: true }).ddg, false);
});

test('viewer modes stay pending until structure mapping and published fields exist', () => {
  const rows = [{ aa_position: 1, aa_ref: 'A', values: { structural_regime: 'membrane' } }];
  assert.deepEqual(viewerModeAvailability(rows, { structureAvailable: true, mappingValid: false }), {
    topology: false,
    regime: false,
    frustration: false,
    contacts: false,
    conservation: false,
    functional: false,
    'evidence-curated': false,
    'evidence-experimental': false,
    'evidence-computational': false,
    'evidence-pgx': false,
    'evidence-clinvar': false,
    ddg: false,
  });
  assert.deepEqual(viewerModeAvailability(rows, { structureAvailable: true, mappingValid: true }), {
    topology: false,
    regime: true,
    frustration: false,
    contacts: false,
    conservation: false,
    functional: false,
    'evidence-curated': false,
    'evidence-experimental': false,
    'evidence-computational': false,
    'evidence-pgx': false,
    'evidence-clinvar': false,
    ddg: false,
  });
});

test('scientific evidence remains available by sequence without a structure mapping', () => {
  const availability = viewerModeAvailability([
    { aa_position: 1, values: { functional_feature_class: 'curated_region', curated_evidence_status: 'present' } },
  ], { allowSequenceOnly: true });
  assert.equal(availability.functional, true);
  assert.equal(availability['evidence-curated'], true);
  assert.equal(availability.topology, false);
});

test('scientific evidence modes apply their selected residue colours', () => {
  assert.equal(
    colorForValues('evidence-curated', { curated_evidence_status: 'present' }, null),
    VISUALIZATION_MODES['evidence-curated'].colors.present,
  );
  assert.equal(
    colorForValues('evidence-clinvar', { clinvar_evidence_status: 'present' }, null),
    VISUALIZATION_MODES['evidence-clinvar'].colors.present,
  );
  assert.equal(colorForValues('evidence-curated', { curated_evidence_status: 'not_evaluated' }, null), VISUALIZATION_MODES['evidence-curated'].colors.not_evaluated);
});

test('topology maps native TMbed labels into the four display classes', () => {
  assert.equal(topologyClass('inside'), 'aqueous');
  assert.equal(topologyClass('outside'), 'aqueous');
  assert.equal(topologyClass('tm_alpha'), 'transmembrane');
  assert.equal(topologyClass('tm_beta'), 'transmembrane');
  assert.equal(topologyClass('signal_peptide'), 'signal_peptide');
  assert.equal(topologyClass('NA'), 'unknown');
});

test('annotation rows from several stages are merged without dropping provenance', () => {
  const merged = mergeAnnotationRows([
    { stage_id: 'uniprot_features', aa_position: 4, aa_ref: 'E', values: { uniprot_domain: 'Domain A' }, units: {}, qc_status: 'verified' },
    { stage_id: 'evolutionary_conservation', aa_position: 4, aa_ref: 'E', values: { rate4site_score: -1.2 }, units: { rate4site_score: 'score' }, qc_status: 'verified' },
  ]).get(4);
  assert.deepEqual(merged.values, { uniprot_domain: 'Domain A', rate4site_score: -1.2 });
  assert.deepEqual(merged.units, { rate4site_score: 'score' });
  assert.deepEqual(merged.stages, ['uniprot_features', 'evolutionary_conservation']);
  assert.equal(merged.qcByStage.evolutionary_conservation, 'verified');
});

test('canonical position follows sequence identity, not PDB numbering', () => {
  const chains = assignCanonicalPositions([
    {
      id: 'A',
      residues: [
        { chain: 'A', authSeqId: 50, insCode: '', one: 'M' },
        { chain: 'A', authSeqId: 51, insCode: '', one: 'A' },
      ],
    },
  ], 'MA', {
    canonical_to_structure: [
      { canonical_position: 1, chain: 'A', residue_number: '50', insertion_code: '', aa: 'M' },
      { canonical_position: 2, chain: 'A', residue_number: '51', insertion_code: '', aa: 'A' },
    ],
  });
  assert.deepEqual(chains[0].residues.map((residue) => residue.aaPosition), [1, 2]);

  const mismatched = assignCanonicalPositions([
    { id: 'A', residues: [{ chain: 'A', authSeqId: 1, insCode: '', one: 'M' }] },
  ], 'MA');
  assert.equal(mismatched[0].residues[0].aaPosition, null);
});

test('canonical position stays absent when the backend did not publish a mapping', () => {
  const unmapped = assignCanonicalPositions([
    {
      id: 'A',
      residues: [
        { chain: 'A', authSeqId: 50, insCode: '', one: 'M' },
        { chain: 'A', authSeqId: 51, insCode: '', one: 'A' },
      ],
    },
  ], 'MA');
  assert.deepEqual(unmapped[0].residues.map((residue) => residue.aaPosition), [null, null]);
  assert.deepEqual(canonicalChain('MA')[0].residues.map((residue) => residue.aaPosition), [null, null]);
  assert.deepEqual(canonicalChain('MA')[0].residues.map((residue) => residue.canonicalPosition), [1, 2]);
});

test('canonical sequence fallback can resolve annotations without claiming a structure mapping', () => {
  const residue = canonicalChain('MA')[0].residues[1];
  const row = { aa_position: 2, aa_ref: 'A', values: { rate4site_score: -1.1 } };
  const byPosition = new Map([[2, row]]);
  assert.equal(residue.aaPosition, null);
  assert.equal(annotationForResidue(residue, byPosition), row);
});

test('canonical position follows the persisted backend mapping when structure coverage has gaps', () => {
  const mapped = assignCanonicalPositions([
    {
      id: 'A',
      residues: [
        { chain: 'A', authSeqId: 101, insCode: '', one: 'A' },
        { chain: 'A', authSeqId: 102, insCode: '', one: 'C' },
        { chain: 'A', authSeqId: 104, insCode: '', one: 'E' },
      ],
    },
  ], 'ACDE', {
    canonical_to_structure: [
      { canonical_position: 1, chain: 'A', residue_number: '101', insertion_code: '', aa: 'A' },
      { canonical_position: 2, chain: 'A', residue_number: '102', insertion_code: '', aa: 'C' },
      { canonical_position: 4, chain: 'A', residue_number: '104', insertion_code: '', aa: 'E' },
    ],
  });
  assert.deepEqual(mapped[0].residues.map((residue) => residue.aaPosition), [1, 2, 4]);
});
