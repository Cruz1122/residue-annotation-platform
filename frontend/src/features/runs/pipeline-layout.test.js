import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildEdges, PIPELINE_NODE, PIPELINE_WORLD, PIPELINE_WORLD_NO_AF3, stageLayout, stagesForPipelineLayout,
} from './pipeline-layout.js';

const stages = [
  { id: 'protein_identity', dependencies: [] },
  { id: 'variant_predictors', dependencies: ['protein_identity'] },
  { id: 'pharmacogenomics', dependencies: ['protein_identity'] },
  { id: 'uniprot_features', dependencies: ['protein_identity'] },
  { id: 'sequence_frustration', dependencies: ['protein_identity'] },
  { id: 'evolutionary_conservation', dependencies: ['uniprot_features'] },
  { id: 'functional_region_evidence', dependencies: ['uniprot_features'] },
  { id: 'experimental_variant_evidence', dependencies: ['uniprot_features'] },
  { id: 'membrane_topology', dependencies: ['uniprot_features'] },
  { id: 'structure_modeling', dependencies: ['membrane_topology'] },
  { id: 'conformational_ensemble', dependencies: ['protein_identity', 'structure_modeling'] },
  { id: 'structural_regime', dependencies: ['structure_modeling'] },
  { id: 'ensemble_frustration', dependencies: ['conformational_ensemble'] },
  { id: 'protein_relaxation_energy', dependencies: ['structural_regime'] },
  { id: 'physicochemical_context', dependencies: ['protein_relaxation_energy'] },
  { id: 'variant_ddg', dependencies: ['protein_identity', 'membrane_topology', 'protein_relaxation_energy'] },
  { id: 'structural_frustration', dependencies: ['protein_relaxation_energy'] },
  { id: 'structural_contacts', dependencies: ['protein_relaxation_energy'] },
];

test('uses fixed scientific coordinates independent of API stage ordering', () => {
  const layout = stageLayout(stages);
  const reversed = stageLayout([...stages].reverse());

  for (const stage of stages) {
    assert.deepEqual(layout.positions.get(stage.id), reversed.positions.get(stage.id));
  }
  assert.deepEqual(layout.positions.get('protein_identity'), { x: 168, y: 495 });
  assert.deepEqual(layout.positions.get('protein_relaxation_energy'), { x: 1856, y: 685 });
  assert.deepEqual(layout.positions.get('structural_contacts'), { x: 2198, y: 840 });
  assert.deepEqual({ width: layout.width, height: layout.height }, PIPELINE_WORLD);

  for (const stage of stages) {
    const position = layout.positions.get(stage.id);
    assert.ok(position.x >= PIPELINE_NODE.width / 2);
    assert.ok(position.y >= PIPELINE_NODE.height / 2);
    assert.ok(position.x <= layout.width - PIPELINE_NODE.width / 2);
    assert.ok(position.y <= layout.height - PIPELINE_NODE.height / 2);
    for (const dependency of stage.dependencies) {
      assert.ok(position.x > layout.positions.get(dependency).x, `${dependency} -> ${stage.id}`);
    }
  }
  for (let index = 0; index < stages.length; index += 1) {
    for (const other of stages.slice(index + 1)) {
      const a = layout.positions.get(stages[index].id);
      const b = layout.positions.get(other.id);
      assert.ok(Math.abs(a.x - b.x) >= PIPELINE_NODE.width || Math.abs(a.y - b.y) >= PIPELINE_NODE.height);
    }
  }
});

test('uses a second fixed layout without AF3 and routes P06 from P01', () => {
  assert.deepEqual(
    stagesForPipelineLayout(stages, true).find((stage) => stage.id === 'protein_relaxation_energy').dependencies,
    ['structural_regime'],
  );
  const noAf3Stages = stages.map((stage) => stage.id === 'structure_modeling'
    ? { ...stage, status: 'skipped', dependencies: ['protein_identity'] }
    : stage);
  const graphStages = stagesForPipelineLayout(noAf3Stages, false);
  const layout = stageLayout(graphStages, false);
  const reversed = stageLayout([...graphStages].reverse(), false);
  const edges = buildEdges(graphStages, layout.positions);

  assert.deepEqual(layout.positions.get('protein_relaxation_energy'), { x: 492, y: 720 });
  assert.deepEqual(layout.positions.get('physicochemical_context'), { x: 1172, y: 80 });
  assert.deepEqual(layout.positions.get('structure_modeling'), { x: 492, y: 880 });
  assert.deepEqual({ width: layout.width, height: layout.height }, PIPELINE_WORLD_NO_AF3);
  assert.deepEqual(graphStages.find((stage) => stage.id === 'protein_relaxation_energy').dependencies, ['protein_identity']);
  assert.deepEqual(stages.find((stage) => stage.id === 'protein_relaxation_energy').dependencies, ['structural_regime']);
  assert.ok(edges.some((edge) => edge.from === 'protein_identity' && edge.to === 'protein_relaxation_energy'));
  assert.ok(edges.every((edge) => layout.positions.get(edge.from).x < layout.positions.get(edge.to).x));
  for (const stage of graphStages) {
    assert.deepEqual(layout.positions.get(stage.id), reversed.positions.get(stage.id));
  }
  for (let index = 0; index < graphStages.length; index += 1) {
    for (const other of graphStages.slice(index + 1)) {
      const a = layout.positions.get(graphStages[index].id);
      const b = layout.positions.get(other.id);
      assert.ok(Math.abs(a.x - b.x) >= PIPELINE_NODE.width || Math.abs(a.y - b.y) >= PIPELINE_NODE.height);
    }
  }
});

test('draws every backend dependency between card boundaries with ordered sibling ports', () => {
  const { positions } = stageLayout(stages);
  const edges = buildEdges(stages, positions);
  const identityEdges = edges.filter((edge) => edge.from === 'protein_identity');
  const sourcePorts = identityEdges.map((edge) => Number(edge.d.match(/^M \S+ ([\d.-]+)/)?.[1]));
  const targetsByPort = identityEdges
    .map((edge, index) => ({ port: sourcePorts[index], target: positions.get(edge.to) }))
    .sort((a, b) => a.port - b.port);

  assert.equal(edges.length, 20);
  assert.deepEqual(targetsByPort.map(({ target }) => [target.y, target.x]), [
    [125, 492], [125, 1514], [305, 492], [430, 2198], [495, 492], [865, 492],
  ]);
  assert.ok(edges.every((edge) => edge.d.startsWith('M ') && !edge.d.includes('NaN')));
  assert.ok(edges.some((edge) => edge.from === 'structure_modeling' && edge.to === 'conformational_ensemble'));
  assert.ok(edges.some((edge) => edge.from === 'protein_identity' && edge.to === 'variant_ddg'));
});
