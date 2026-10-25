import assert from 'node:assert/strict';
import test from 'node:test';
import { buildEdges, compactStageLayout, PIPELINE_NODE } from './pipeline-layout.js';
import { presentRunStages } from './stage-visibility.js';
import { stageHref, STAGE_ANALYSIS_ROUTES } from './stage-routes.js';

// Mirrors the registered stage contracts inspected in the current MN5 checkout.
const stages = [
  { id: 'protein_identity', dependencies: [] },
  { id: 'clinvar', dependencies: ['protein_identity'] },
  { id: 'variant_predictors', dependencies: ['protein_identity'] },
  { id: 'pharmacogenomics', dependencies: ['protein_identity'] },
  { id: 'conformational_ensemble', dependencies: ['protein_identity', 'structure_modeling'] },
  { id: 'ensemble_frustration', dependencies: ['conformational_ensemble'] },
  { id: 'sequence_frustration', dependencies: ['protein_identity'] },
  { id: 'uniprot_features', dependencies: ['protein_identity'] },
  { id: 'evolutionary_conservation', dependencies: ['uniprot_features'] },
  { id: 'functional_region_evidence', dependencies: ['uniprot_features'] },
  { id: 'experimental_variant_evidence', dependencies: ['uniprot_features'] },
  { id: 'membrane_topology', dependencies: ['uniprot_features'] },
  { id: 'structure_modeling', dependencies: ['membrane_topology'] },
  { id: 'structural_regime', dependencies: ['structure_modeling'] },
  { id: 'protein_relaxation_energy', dependencies: ['structural_regime'] },
  { id: 'physicochemical_context', dependencies: ['protein_relaxation_energy'] },
  { id: 'variant_ddg', dependencies: ['protein_identity', 'membrane_topology', 'protein_relaxation_energy'] },
  { id: 'structural_frustration', dependencies: ['protein_relaxation_energy'] },
  { id: 'structural_contacts', dependencies: ['protein_relaxation_energy'] },
];

const expectedVisibleEdges = new Set([
  'protein_identity->clinvar',
  'protein_identity->variant_predictors',
  'protein_identity->pharmacogenomics',
  'protein_identity->sequence_frustration',
  'protein_identity->uniprot_features',
  'uniprot_features->evolutionary_conservation',
  'uniprot_features->functional_region_evidence',
  'uniprot_features->experimental_variant_evidence',
  'uniprot_features->membrane_topology',
  'membrane_topology->structure_modeling',
  'structure_modeling->conformational_ensemble',
  'structure_modeling->structural_regime',
  'conformational_ensemble->ensemble_frustration',
  'structural_regime->protein_relaxation_energy',
  'protein_relaxation_energy->physicochemical_context',
  'protein_relaxation_energy->variant_ddg',
  'protein_relaxation_energy->structural_frustration',
  'protein_relaxation_energy->structural_contacts',
]);

const expectedStageRoutes = {
  protein_identity: 'info',
  clinvar: 'scientific-evidence',
  variant_predictors: 'scientific-evidence',
  pharmacogenomics: 'scientific-evidence',
  uniprot_features: 'scientific-evidence',
  conformational_ensemble: 'bioemu',
  sequence_frustration: 'frustration',
  evolutionary_conservation: 'conservation',
  functional_region_evidence: 'scientific-evidence',
  experimental_variant_evidence: 'scientific-evidence',
  membrane_topology: 'topology',
  ensemble_frustration: 'frustration',
  structure_modeling: 'info',
  structural_regime: 'info',
  protein_relaxation_energy: 'variant-ddg',
  physicochemical_context: 'frustration',
  variant_ddg: 'variant-ddg',
  structural_frustration: 'frustration',
  structural_contacts: 'arpeggio',
};

test('lays out dependencies consistently regardless of API stage ordering', () => {
  const layout = compactStageLayout(stages);
  const reversed = compactStageLayout([...stages].reverse());

  for (const stage of stages) {
    assert.deepEqual(layout.positions.get(stage.id), reversed.positions.get(stage.id));
    const position = layout.positions.get(stage.id);
    assert.ok(position.x >= PIPELINE_NODE.width / 2);
    assert.ok(position.y >= PIPELINE_NODE.height / 2);
    for (const dependency of stage.dependencies) {
      assert.ok(position.x > layout.positions.get(dependency).x, `${dependency} -> ${stage.id}`);
    }
  }

  for (let index = 0; index < stages.length; index += 1) {
    for (const other of stages.slice(index + 1)) {
      const left = layout.positions.get(stages[index].id);
      const right = layout.positions.get(other.id);
      assert.ok(
        Math.abs(left.x - right.x) >= PIPELINE_NODE.width
          || Math.abs(left.y - right.y) >= PIPELINE_NODE.height,
      );
    }
  }
});

test('shows the transitive reduction of the current registered pipeline as curved edges', () => {
  const originalDependencies = stages.map(({ id, dependencies }) => [id, [...dependencies]]);
  const { positions } = compactStageLayout(stages);
  const edges = buildEdges(stages, positions);

  assert.deepEqual(new Set(edges.map((edge) => edge.id)), expectedVisibleEdges);
  assert.equal(edges.length, 18);
  assert.ok(edges.every((edge) => edge.mode === 'curved'));
  assert.ok(edges.every((edge) => /^M [-\d.]+ [-\d.]+ C [-\d.]+ [-\d.]+ [-\d.]+ [-\d.]+ [-\d.]+ [-\d.]+$/.test(edge.d)));
  assert.ok(edges.every((edge) => !edge.d.includes('NaN')));

  assert.ok(!edges.some((edge) => edge.id === 'protein_identity->variant_ddg'));
  assert.ok(!edges.some((edge) => edge.id === 'membrane_topology->variant_ddg'));
  assert.ok(!edges.some((edge) => edge.id === 'protein_identity->conformational_ensemble'));
  assert.deepEqual(stages.map(({ id, dependencies }) => [id, [...dependencies]]), originalDependencies);
});

test('keeps a declared edge when its alternate dependency path is outside the visible run', () => {
  const visible = [
    { id: 'protein_identity', dependencies: [] },
    { id: 'protein_relaxation_energy', dependencies: ['structural_regime'] },
    { id: 'variant_ddg', dependencies: ['protein_identity', 'protein_relaxation_energy'] },
  ];
  const { positions } = compactStageLayout(visible);
  const edges = buildEdges(visible, positions);

  assert.deepEqual(new Set(edges.map((edge) => edge.id)), new Set([
    'protein_identity->variant_ddg',
    'protein_relaxation_energy->variant_ddg',
  ]));
  assert.ok(edges.every((edge) => edge.d.includes(' C ')));
});

test('keeps protein relaxation behind structural regime when a provided PDB omits AF3', () => {
  const visible = presentRunStages(stages.filter((stage) => ![
    'structure_modeling',
    'conformational_ensemble',
  ].includes(stage.id)));
  const byId = new Map(visible.map((stage) => [stage.id, stage]));
  const { positions } = compactStageLayout(visible);
  const edges = buildEdges(visible, positions);
  const edgeIds = new Set(edges.map((edge) => edge.id));

  assert.deepEqual(byId.get('structural_regime').dependencies, ['protein_identity']);
  assert.deepEqual(byId.get('protein_relaxation_energy').dependencies, ['structural_regime']);
  assert.ok(edgeIds.has('protein_identity->structural_regime'));
  assert.ok(edgeIds.has('structural_regime->protein_relaxation_energy'));
  assert.ok(edgeIds.has('protein_relaxation_energy->variant_ddg'));
  assert.ok(!edgeIds.has('protein_identity->protein_relaxation_energy'));
  assert.ok(!edgeIds.has('protein_identity->variant_ddg'));
});

test('routes every registered pipeline stage to its corresponding analysis view', () => {
  assert.deepEqual(STAGE_ANALYSIS_ROUTES, expectedStageRoutes);
  assert.deepEqual(new Set(Object.keys(STAGE_ANALYSIS_ROUTES)), new Set(stages.map(({ id }) => id)));
  assert.equal(stageHref('protein/with spaces', 'run/123', 'clinvar'), '/proteins/protein%2Fwith%20spaces/scientific-evidence/?run=run%2F123');
  assert.equal(stageHref('protein-1', 'run-1', 'protein_identity'), '/proteins/protein-1/info/?run=run-1');
});
