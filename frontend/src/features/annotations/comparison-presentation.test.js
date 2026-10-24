import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FRUSTRAISEQ_ENTROPY_COLORS,
  FRUSTRAISEQ_SURPRISAL_COLORS,
} from './frustration-presentation.js';
import {
  COMPARISON_MISSING_COLOR,
  buildAvailableComparisonAnalyses,
  composeComparisonSignals,
  reorderActiveAnalyses,
  selectFrustrationMetric,
  selectedResidueSections,
  toggleActiveAnalysis,
} from './comparison-presentation.js';

const annotations = [
  { aa_position: 1, aa_ref: 'A', stage_id: 'evolutionary_conservation', values: { consurf_grade: 1 }, units: {} },
  { aa_position: 2, aa_ref: 'C', stage_id: 'evolutionary_conservation', values: { consurf_grade: 9 }, units: {} },
  { aa_position: 1, aa_ref: 'A', stage_id: 'membrane_topology', values: { tmbed_topology: 'outside' }, units: {} },
  { aa_position: 2, aa_ref: 'C', stage_id: 'membrane_topology', values: { tmbed_topology: 'tm_alpha' }, units: {} },
  { aa_position: 2, aa_ref: 'C', stage_id: 'structural_frustration', values: { structural_frustration_fi_singleresidue: -1.4 }, units: {} },
];

const details = {
  ddg: { variant_annotations: [{ variant_id: 'C2F', ddg_value: -2, ddg_unit: 'REU' }, { variant_id: 'D3A', ddg_value: 4, ddg_unit: 'REU' }] },
  contacts: { contact_residue_summary: [{ aa_position: 1, structural_contacts_n_contacts: 3, structural_contacts_n_partner_residues: 2 }] },
  frustration: {}, conservation: {}, topology: {},
};

test('composes independent ordered channels without mixing scales or provenance', () => {
  const analyses = buildAvailableComparisonAnalyses({ sequence: 'ACD', annotations, detailsByAnalysis: details });
  const composition = composeComparisonSignals({ sequence: 'ACD', analyses, activeIds: ['topology', 'conservation', 'ddg'] });
  assert.deepEqual(composition.active.map(({ id }) => id), ['topology', 'conservation', 'ddg']);
  assert.equal(composition.residues[1].channels.length, 3);
  assert.notEqual(composition.residues[1].channels[0].colors[0], composition.residues[1].channels[1].colors[0]);
  assert.equal(selectedResidueSections(composition, 2)[2].rows[0].value, '-2 REU');
});

test('keeps missing values absent and gives their visual channel a neutral marker', () => {
  const analyses = buildAvailableComparisonAnalyses({ sequence: 'ACD', annotations, detailsByAnalysis: details });
  const composition = composeComparisonSignals({ sequence: 'ACD', analyses, activeIds: ['conservation', 'ddg'] });
  const missingDdg = composition.residues[0].channels[1];
  assert.equal(missingDdg.hasData, false);
  assert.deepEqual(missingDdg.colors, [COMPARISON_MISSING_COLOR]);
  assert.equal(selectedResidueSections(composition, 1).some(({ analysisId }) => analysisId === 'ddg'), false);
});

test('keeps analysis channels in the same position across residues with missing values', () => {
  const analyses = buildAvailableComparisonAnalyses({ sequence: 'ACD', annotations, detailsByAnalysis: details });
  const activeIds = ['topology', 'conservation', 'ddg'];
  const composition = composeComparisonSignals({ sequence: 'ACD', analyses, activeIds });

  for (const residue of composition.residues) {
    assert.deepEqual(residue.channels.map(({ analysisId, channelIndex }) => [analysisId, channelIndex]), [
      ['topology', 0], ['conservation', 1], ['ddg', 2],
    ]);
  }
  assert.equal(composition.residues[2].channels[0].hasData, false);
  assert.equal(composition.residues[2].channels[0].colors[0], COMPARISON_MISSING_COLOR);
  assert.equal(composition.residues[0].channels[2].hasData, false);
  assert.equal(composition.residues[0].channels[2].colors[0], COMPARISON_MISSING_COLOR);
});

test('preserves native ConSurf 1–9 and centers the ΔΔG colour domain on zero', () => {
  const analyses = buildAvailableComparisonAnalyses({ sequence: 'ACD', annotations, detailsByAnalysis: details });
  const conservation = analyses.find(({ id }) => id === 'conservation');
  const ddg = analyses.find(({ id }) => id === 'ddg');
  assert.deepEqual(conservation.tracks[0].domain, { min: 1, max: 9, observedMin: 1, observedMax: 9 });
  assert.equal(ddg.tracks[0].domain.min, -4);
  assert.equal(ddg.tracks[0].domain.max, 4);
  assert.equal(ddg.tracks[0].domain.center, 0);
  assert.equal(ddg.legend.minLabel, '-4 REU');
  assert.equal(ddg.legend.maxLabel, '+4 REU');
  assert.equal(ddg.legend.centerLabel, '0 REU');
  assert.equal(ddg.legend.note, undefined);
});

test('keeps Rate4Site provenance linked to its original source name', () => {
  const analyses = buildAvailableComparisonAnalyses({
    sequence: 'AC',
    annotations: [
      { aa_position: 1, values: { rate4site_score: -0.8 }, units: {} },
      { aa_position: 2, values: { rate4site_score: 1.2 }, units: {} },
    ],
    detailsByAnalysis: {},
  });
  const conservation = analyses.find(({ id }) => id === 'conservation');
  assert.equal(conservation.legend.sourceLabel, 'Rate4Site');
  assert.equal(conservation.legend.sourceUrl, 'https://doi.org/10.1093/bioinformatics/18.suppl_1.S71');
  assert.equal(conservation.legend.minLabel, '-0.8 · Más conservado');
  assert.equal(conservation.legend.maxLabel, '1.2 · Más variable');
});

test('Frustratometer ensemble mean stays continuous and is not assigned a class', () => {
  const rows = [{ aa_position: 1, aa_ref: 'A', values: { frustratometer_mean: 0.2 }, units: {} }];
  const analyses = buildAvailableComparisonAnalyses({ sequence: 'A', annotations: rows, detailsByAnalysis: {} });
  const frustration = analyses.find(({ id }) => id === 'frustration');
  const meanTrack = frustration.tracks.find(({ id }) => id === 'frustratometer_mean');
  assert.equal(meanTrack.categorical, false);
  assert.deepEqual([meanTrack.domain.min, meanTrack.domain.max], [-2, 2]);
  assert.equal(meanTrack.scaleNote, null);

  const composition = composeComparisonSignals({ sequence: 'A', analyses, activeIds: ['frustration'] });
  assert.equal(composition.residues[0].channels[0].hasData, true);
  assert.notEqual(composition.residues[0].channels[0].colors[0], COMPARISON_MISSING_COLOR);
  assert.deepEqual(selectedResidueSections(composition, 1)[0].rows.map(({ label }) => label), ['Promedio del ensemble']);
});

test('FrustrAI-Seq comparison keeps the published fixed scales and palette', () => {
  const rows = [{
    aa_position: 1,
    values: { frustraiseq_index: 0.4, frustraiseq_entropy: 0.4, frustraiseq_surprisal: 1.1 },
    units: {},
  }];
  const analyses = buildAvailableComparisonAnalyses({ sequence: 'A', annotations: rows, detailsByAnalysis: {} });
  const tracks = analyses.find(({ id }) => id === 'frustration').tracks;
  const index = tracks.find(({ id }) => id === 'frustraiseq_index');
  const entropy = tracks.find(({ id }) => id === 'frustraiseq_entropy');
  const surprisal = tracks.find(({ id }) => id === 'frustraiseq_surprisal');

  assert.equal(index.categorical, true);
  assert.deepEqual(index.scaleSegments.map(({ key }) => key), ['highly_frustrated', 'neutral', 'minimally_frustrated']);
  assert.deepEqual(index.scaleSegments.map(({ color }) => color), index.colors);
  assert.deepEqual(index.scaleSegments.map(({ label }) => label), ['< -1', '-1–0.55', '> 0.55']);
  assert.equal(index.cutoffNote, null);
  assert.deepEqual([entropy.domain.min, entropy.domain.max], [0, 1]);
  assert.deepEqual(entropy.scaleTicks, ['0', '0.25', '0.50', '0.75', '1']);
  assert.deepEqual(entropy.colors, FRUSTRAISEQ_ENTROPY_COLORS);
  assert.deepEqual([surprisal.domain.min, surprisal.domain.max], [-3, 3]);
  assert.deepEqual(surprisal.scaleTicks, ['−3', '−2', '−1', '0', '+1', '+2', '+3']);
  assert.deepEqual(surprisal.colors, FRUSTRAISEQ_SURPRISAL_COLORS);
});

test('keeps published TMbed classes categorical and omits unavailable analyses', () => {
  const analyses = buildAvailableComparisonAnalyses({ sequence: 'ACD', annotations, detailsByAnalysis: details });
  const topology = analyses.find(({ id }) => id === 'topology');
  assert.deepEqual(topology.legend.categories.map(({ key }) => key), ['tm_alpha', 'outside']);
  assert.equal(topology.legend.sourceLabel, 'TMbed');
  assert.equal(analyses.find(({ id }) => id === 'conservation').legend.sourceLabel, 'ConSurf');
  const absent = buildAvailableComparisonAnalyses({ sequence: 'ACD', annotations: [], detailsByAnalysis: {} });
  assert.deepEqual(absent, []);
});

test('checklist operations preserve selection order and remove one active view cleanly', () => {
  assert.deepEqual(toggleActiveAnalysis(['topology'], 'ddg'), ['topology', 'ddg']);
  assert.deepEqual(toggleActiveAnalysis(['topology', 'ddg'], 'topology'), ['ddg']);
  assert.deepEqual(reorderActiveAnalyses(['topology', 'ddg', 'frustration'], 'frustration', 'up'), ['topology', 'frustration', 'ddg']);
});

test('multiple frustration metrics remain separate subtracks', () => {
  const rows = [
    { aa_position: 1, values: { structural_frustration_fi_singleresidue: -1.2, frustraiseq_entropy: 0.4, frustraiseq_surprisal: 1.1 }, units: {} },
  ];
  const analyses = buildAvailableComparisonAnalyses({ sequence: 'A', annotations: rows, detailsByAnalysis: {} });
  const frustration = analyses.find(({ id }) => id === 'frustration');
  assert.deepEqual(frustration.tracks.map(({ id }) => id), [
    'structural_frustration_fi_singleresidue', 'frustraiseq_entropy', 'frustraiseq_surprisal',
  ]);
  const composition = composeComparisonSignals({ sequence: 'A', analyses, activeIds: ['frustration'] });
  assert.equal(composition.residues[0].channels[0].colors.length, 3);
});

test('shows only categorical frustration classes present in published values', () => {
  const rows = [{ aa_position: 1, values: { structural_frustration_fi_singleresidue: -1.4 }, units: {} }];
  const analyses = buildAvailableComparisonAnalyses({ sequence: 'A', annotations: rows, detailsByAnalysis: {} });
  const track = analyses.find(({ id }) => id === 'frustration').tracks[0];
  assert.deepEqual(track.categories.map(({ key }) => key), ['highly_frustrated']);
  assert.deepEqual(track.scaleSegments.map(({ key }) => key), ['highly_frustrated', 'neutral', 'minimally_frustrated']);
  assert.deepEqual(track.scaleSegments.map(({ color }) => color), track.colors);
  assert.deepEqual(track.scaleSegments.map(({ label }) => label), ['< -1', '-1–0.55', '> 0.55']);
});

test('a selected frustration metric keeps its own value, source, and scale without mixing sibling metrics', () => {
  const rows = [
    { aa_position: 1, values: { structural_frustration_fi_singleresidue: -1.2, frustraiseq_entropy: 0.4, frustraiseq_surprisal: 1.1 }, units: {} },
  ];
  const analyses = buildAvailableComparisonAnalyses({ sequence: 'A', annotations: rows, detailsByAnalysis: {} });
  const frustration = analyses.find(({ id }) => id === 'frustration');
  const expectedRows = ['Residuo individual (SRFI)', 'Clase', 'Entropía', 'Surprisal'];
  for (const { id } of frustration.tracks) {
    const selected = selectFrustrationMetric(analyses, id);
    const composition = composeComparisonSignals({ sequence: 'A', analyses: selected, activeIds: ['frustration'] });
    assert.deepEqual(composition.active[0].tracks.map(({ id: selectedId }) => selectedId), [id]);
    assert.equal(composition.residues[0].channels[0].colors.length, 1);
    const [panelSection] = selectedResidueSections(composition, 1, analyses);
    assert.equal(panelSection.source, 'FrustratometeR / FrustrAI-Seq');
    assert.deepEqual(panelSection.rows.map(({ label }) => label), expectedRows);
    assert.deepEqual([...new Set(panelSection.rows.map(({ source }) => source))], ['FrustratometeR', 'FrustrAI-Seq']);
  }
});

test('residue panel includes other published frustration metrics when the selected metric has no value there', () => {
  const analyses = buildAvailableComparisonAnalyses({
    sequence: 'AC',
    annotations: [
      { aa_position: 1, values: { frustraiseq_entropy: 0.4 }, units: {} },
      { aa_position: 2, values: { structural_frustration_fi_singleresidue: -1.2 }, units: {} },
    ],
    detailsByAnalysis: {},
  });
  const selected = selectFrustrationMetric(analyses, 'structural_frustration_fi_singleresidue');
  const composition = composeComparisonSignals({ sequence: 'AC', analyses: selected, activeIds: ['frustration'] });
  assert.equal(composition.residues[0].channels[0].hasData, false);
  const [panelSection] = selectedResidueSections(composition, 1, analyses);
  assert.equal(panelSection.label, 'Frustración');
  assert.deepEqual(panelSection.rows.map(({ label }) => label), ['Entropía']);
  assert.equal(panelSection.rows[0].source, 'FrustrAI-Seq');
});
