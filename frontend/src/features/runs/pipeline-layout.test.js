import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildEdges, compactStageLayout, PIPELINE_NODE, PIPELINE_WORLD, PIPELINE_WORLD_NO_AF3, stageLayout, stagesForPipelineLayout,
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

test('uses a second fixed layout without AF3 and routes relaxation after protein identity', () => {
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

test('keeps the optional ClinVar stage visible without disturbing the reference canvas', () => {
  const withClinvar = [...stages, { id: 'clinvar', dependencies: ['protein_identity'] }];
  const layout = stageLayout(withClinvar);
  const edges = buildEdges(withClinvar, layout.positions);

  assert.deepEqual(layout.positions.get('clinvar'), { x: 1172, y: 865 });
  assert.ok(edges.some((edge) => edge.from === 'protein_identity' && edge.to === 'clinvar'));
  for (let index = 0; index < withClinvar.length; index += 1) {
    for (const other of withClinvar.slice(index + 1)) {
      const left = layout.positions.get(withClinvar[index].id);
      const right = layout.positions.get(other.id);
      assert.ok(Math.abs(left.x - right.x) >= PIPELINE_NODE.width || Math.abs(left.y - right.y) >= PIPELINE_NODE.height);
    }
  }
});

test('keeps every backend dependency while portalizing distant sibling branches', () => {
  const { positions } = stageLayout(stages);
  const edges = buildEdges(stages, positions);
  const identityEdges = edges.filter((edge) => edge.from === 'protein_identity');

  assert.equal(edges.length, 20);
  assert.deepEqual(new Set(identityEdges.map((edge) => edge.to)), new Set([
    'variant_predictors',
    'pharmacogenomics',
    'uniprot_features',
    'sequence_frustration',
    'conformational_ensemble',
    'variant_ddg',
  ]));
  assert.ok(edges.every((edge) => edge.d.startsWith('M ') && !edge.d.includes('NaN')));
  assert.ok(edges.every((edge) => !edge.d.includes('C')), 'pipeline routes should not use Bézier curves');
  assert.ok(edges.some((edge) => edge.from === 'structure_modeling' && edge.to === 'conformational_ensemble'));
  assert.ok(edges.some((edge) => edge.from === 'protein_identity' && edge.to === 'variant_ddg'));

  const expectedDirectBranches = new Map([
    ['protein_identity', new Set(['variant_predictors', 'pharmacogenomics', 'uniprot_features', 'sequence_frustration'])],
    ['uniprot_features', new Set(['evolutionary_conservation', 'functional_region_evidence', 'experimental_variant_evidence', 'membrane_topology'])],
    ['structure_modeling', new Set(['conformational_ensemble', 'structural_regime'])],
    ['protein_relaxation_energy', new Set(['physicochemical_context', 'variant_ddg', 'structural_frustration', 'structural_contacts'])],
  ]);
  for (const [source, targets] of expectedDirectBranches) {
    const siblings = edges.filter((edge) => edge.from === source);
    const direct = siblings.filter((edge) => edge.mode === 'direct');
    assert.equal(direct.length, targets.size, source);
    assert.deepEqual(new Set(direct.map((edge) => edge.to)), targets);
    assert.equal(siblings.filter((edge) => edge.mode === 'portal').length, siblings.length - targets.size, source);
  }
  assert.equal(edges.find((edge) => edge.id === 'uniprot_features->evolutionary_conservation')?.mode, 'direct');
  assert.equal(edges.find((edge) => edge.id === 'structure_modeling->conformational_ensemble')?.mode, 'direct');
  assert.equal(edges.find((edge) => edge.id === 'protein_relaxation_energy->variant_ddg')?.mode, 'direct');

  const finalSegmentIsAxisAligned = (path) => {
    const match = path.match(/([-\d.]+) ([-\d.]+) L ([-\d.]+) ([-\d.]+)$/);
    return Boolean(match) && (match[2] === match[4] || match[1] === match[3]);
  };
  const lineSegments = (path) => {
    const points = [...path.matchAll(/[ML]\s+([-\d.]+)\s+([-\d.]+)/g)]
      .map((match) => ({ x: Number(match[1]), y: Number(match[2]) }));
    return points.slice(1).map((point, index) => ({ from: points[index], to: point }));
  };
  const crossesNodeInterior = ({ from, to }, node) => {
    const left = node.x - PIPELINE_NODE.width / 2;
    const right = node.x + PIPELINE_NODE.width / 2;
    const top = node.y - PIPELINE_NODE.height / 2;
    const bottom = node.y + PIPELINE_NODE.height / 2;
    if (from.y === to.y) {
      return from.y > top && from.y < bottom && Math.min(from.x, to.x) < right && Math.max(from.x, to.x) > left;
    }
    if (from.x === to.x) {
      return from.x > left && from.x < right && Math.min(from.y, to.y) < bottom && Math.max(from.y, to.y) > top;
    }
    return true;
  };
  for (const edge of edges) {
    assert.ok(edge.segments.every((segment) => finalSegmentIsAxisAligned(segment.d)), edge.id);
    if (edge.mode !== 'portal') continue;
    assert.equal(edge.segments.length, 2, edge.id);
    assert.ok(edge.portal?.id.startsWith('portal:'), edge.id);
    assert.equal(Object.hasOwn(edge.portal, 'label'), false, edge.id);
    assert.match(edge.portal.accent, /^#[0-9a-f]{6}$/i);
    assert.ok(edge.portal.bridge.startsWith('M '), edge.id);
    assert.notDeepEqual(edge.portal.source, edge.portal.target, edge.id);
    assert.ok(['top', 'bottom', 'gap'].includes(edge.portal.routeSide), edge.id);
    if (edge.portal.routeSide !== 'gap') {
      const sourceBoundary = lineSegments(edge.segments[0].d)[0].from;
      const targetBoundary = lineSegments(edge.segments[1].d).at(-1).to;
      const sourceCenter = positions.get(edge.from).y;
      const targetCenter = positions.get(edge.to).y;
      if (edge.portal.routeSide === 'top') {
        assert.ok(sourceBoundary.y < sourceCenter, `${edge.id} should leave through the upper side`);
        assert.ok(targetBoundary.y <= targetCenter, `${edge.id} should enter through the upper side`);
      } else {
        assert.ok(sourceBoundary.y > sourceCenter, `${edge.id} should leave through the lower side`);
        assert.ok(targetBoundary.y >= targetCenter, `${edge.id} should enter through the lower side`);
      }
    }
    const routeSegments = [
      edge.portal.bridge,
      ...edge.segments.map((segment) => segment.d),
    ].flatMap(lineSegments);
    assert.ok(routeSegments.length >= 4, edge.id);
    for (const segment of routeSegments) {
      for (const node of positions.values()) {
        assert.equal(crossesNodeInterior(segment, node), false, `${edge.id} crosses a node`);
      }
    }
  }

  const variantDdgAnchorYs = edges
    .filter((edge) => edge.to === 'variant_ddg')
    .map((edge) => {
      const targetPath = edge.portal ? edge.segments[1].d : edge.segments[0].d;
      return lineSegments(targetPath).at(-1).to.y;
    })
    .sort((left, right) => left - right);
  assert.equal(variantDdgAnchorYs.length, 3);
  assert.equal(
    variantDdgAnchorYs[1] - variantDdgAnchorYs[0],
    variantDdgAnchorYs[2] - variantDdgAnchorYs[1],
    'variant ΔΔG keeps its three uniform target anchors',
  );

  const routedSegments = edges.flatMap((edge) => [
    ...edge.segments.map((segment) => ({ edgeId: edge.id, ...segment })),
    ...(edge.portal ? [{ edgeId: edge.id, d: edge.portal.bridge }] : []),
  ]).flatMap(({ edgeId, d }) => lineSegments(d).map((segment) => ({ edgeId, ...segment })));
  const openIntervalsOverlap = (leftStart, leftEnd, rightStart, rightEnd) => (
    Math.max(Math.min(leftStart, leftEnd), Math.min(rightStart, rightEnd))
      < Math.min(Math.max(leftStart, leftEnd), Math.max(rightStart, rightEnd))
  );
  const segmentsOverlap = (left, right) => {
    const leftHorizontal = left.from.y === left.to.y;
    const rightHorizontal = right.from.y === right.to.y;
    if (leftHorizontal !== rightHorizontal) return false;
    if (leftHorizontal) {
      return left.from.y === right.from.y
        && openIntervalsOverlap(left.from.x, left.to.x, right.from.x, right.to.x);
    }
    return left.from.x === right.from.x
      && openIntervalsOverlap(left.from.y, left.to.y, right.from.y, right.to.y);
  };
  for (let index = 0; index < routedSegments.length; index += 1) {
    for (const other of routedSegments.slice(index + 1)) {
      if (routedSegments[index].edgeId === other.edgeId) continue;
      assert.equal(
        segmentsOverlap(routedSegments[index], other),
        false,
        `${routedSegments[index].edgeId} overlaps ${other.edgeId}`,
      );
    }
  }
});

test('portalizes a lone dependency that skips a column', () => {
  const graph = [
    { id: 'source', dependencies: [] },
    { id: 'target', dependencies: ['source'] },
  ];
  const positions = new Map([
    ['source', { x: 168, y: 320 }],
    ['target', { x: 830, y: 160 }],
  ]);
  const [edge] = buildEdges(graph, positions);

  assert.equal(edge.mode, 'portal');
  assert.equal(edge.portal.routeSide, 'top');
  assert.match(edge.portal.accent, /^#[0-9a-f]{6}$/i);
  assert.ok(edge.portal.bridge.startsWith('M '));
});

test('compact layout keeps the visible run graph acyclic, ordered, and non-overlapping', () => {
  const visible = stages.filter((stage) => [
    'protein_identity',
    'uniprot_features',
    'sequence_frustration',
    'evolutionary_conservation',
    'functional_region_evidence',
    'membrane_topology',
  ].includes(stage.id));
  const layout = compactStageLayout(visible);
  const edges = buildEdges(visible, layout.positions);

  assert.ok(layout.width < PIPELINE_WORLD.width);
  assert.ok(layout.height < PIPELINE_WORLD.height);
  assert.ok(edges.every((edge) => layout.positions.get(edge.from).x < layout.positions.get(edge.to).x));
  for (let index = 0; index < visible.length; index += 1) {
    for (const other of visible.slice(index + 1)) {
      const left = layout.positions.get(visible[index].id);
      const right = layout.positions.get(other.id);
      assert.ok(Math.abs(left.x - right.x) >= PIPELINE_NODE.width || Math.abs(left.y - right.y) >= PIPELINE_NODE.height);
    }
  }
  assert.ok(edges.every((edge) => edge.d.startsWith('M ') && !edge.d.includes('NaN')));
});
