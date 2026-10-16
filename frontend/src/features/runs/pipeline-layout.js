export const PIPELINE_WORLD = Object.freeze({ width: 2490, height: 990 });
export const PIPELINE_WORLD_NO_AF3 = Object.freeze({ width: 1464, height: 990 });
export const PIPELINE_NODE = Object.freeze({ width: 248, height: 128 });

const HALF_NODE_WIDTH = PIPELINE_NODE.width / 2;

// Hand-authored coordinates for the AF3 execution path.
const AF3_POSITIONS = Object.freeze({
  protein_identity: { x: 168, y: 495 },
  variant_predictors: { x: 492, y: 125 },
  pharmacogenomics: { x: 492, y: 305 },
  uniprot_features: { x: 492, y: 495 },
  sequence_frustration: { x: 492, y: 865 },
  evolutionary_conservation: { x: 830, y: 125 },
  functional_region_evidence: { x: 830, y: 305 },
  experimental_variant_evidence: { x: 830, y: 495 },
  membrane_topology: { x: 830, y: 685 },
  structure_modeling: { x: 1172, y: 685 },
  conformational_ensemble: { x: 1514, y: 125 },
  structural_regime: { x: 1514, y: 685 },
  ensemble_frustration: { x: 1856, y: 125 },
  protein_relaxation_energy: { x: 1856, y: 685 },
  physicochemical_context: { x: 2198, y: 225 },
  variant_ddg: { x: 2198, y: 430 },
  structural_frustration: { x: 2198, y: 635 },
  structural_contacts: { x: 2198, y: 840 },
});

// Hand-authored coordinates for the provided-PDB path where AF3 is omitted.
// The structural route is compacted and P06 is placed directly after P01.
const NO_AF3_POSITIONS = Object.freeze({
  protein_identity: { x: 168, y: 495 },
  variant_predictors: { x: 492, y: 80 },
  pharmacogenomics: { x: 492, y: 240 },
  uniprot_features: { x: 492, y: 400 },
  sequence_frustration: { x: 492, y: 560 },
  protein_relaxation_energy: { x: 492, y: 720 },
  structure_modeling: { x: 492, y: 880 },
  evolutionary_conservation: { x: 830, y: 80 },
  functional_region_evidence: { x: 830, y: 240 },
  experimental_variant_evidence: { x: 830, y: 400 },
  conformational_ensemble: { x: 830, y: 560 },
  membrane_topology: { x: 830, y: 720 },
  structural_regime: { x: 830, y: 880 },
  physicochemical_context: { x: 1172, y: 80 },
  structural_frustration: { x: 1172, y: 240 },
  structural_contacts: { x: 1172, y: 400 },
  ensemble_frustration: { x: 1172, y: 560 },
  variant_ddg: { x: 1172, y: 720 },
});

export function stageLayout(stages, usesAf3 = true) {
  const coordinates = usesAf3 ? AF3_POSITIONS : NO_AF3_POSITIONS;
  const world = usesAf3 ? PIPELINE_WORLD : PIPELINE_WORLD_NO_AF3;
  const positions = new Map(stages.flatMap((stage) => (
    coordinates[stage.id] ? [[stage.id, coordinates[stage.id]]] : []
  )));
  const unknownStages = stages.filter((stage) => !positions.has(stage.id));
  if (unknownStages.length) {
    throw new Error(`Pipeline layout is missing coordinates for: ${unknownStages.map((stage) => stage.id).join(', ')}`);
  }
  return { positions, width: world.width, height: world.height };
}

export function stagesForPipelineLayout(stages, usesAf3) {
  if (usesAf3) return stages;
  const identity = stages.find((stage) => stage.id === 'protein_identity');
  // TODO: Remove this presentation override after the backend models the P01 → P06 fallback.
  return stages.map((stage) => stage.id === 'protein_relaxation_energy'
    ? { ...stage, dependencies: identity ? [identity.id] : [] }
    : stage);
}

function portOffsets(count, spread) {
  if (count === 0) return [];
  if (count <= 1) return [0];
  const spacing = Math.min(spread * 2, (PIPELINE_NODE.height - 40) / (count - 1));
  const midpoint = (count - 1) / 2;
  return Array.from({ length: count }, (_, index) => (index - midpoint) * spacing);
}

export function buildEdges(stages, positions) {
  const outgoing = new Map(stages.map((stage) => [stage.id, []]));
  const incoming = new Map(stages.map((stage) => [stage.id, []]));
  const edges = [];

  for (const target of stages) {
    for (const dependency of target.dependencies ?? []) {
      const source = positions.has(dependency) ? stages.find((stage) => stage.id === dependency) : null;
      if (!source || !positions.has(target.id)) continue;
      const edge = { from: dependency, to: target.id };
      edges.push(edge);
      outgoing.get(dependency)?.push(edge);
      incoming.get(target.id)?.push(edge);
    }
  }

  const sourcePorts = new Map();
  const targetPorts = new Map();
  for (const [stageId, group] of outgoing) {
    group.sort((a, b) => positions.get(a.to).y - positions.get(b.to).y
      || positions.get(a.to).x - positions.get(b.to).x
      || a.to.localeCompare(b.to));
    portOffsets(group.length, 22).forEach((offset, index) => {
      sourcePorts.set(`${stageId}->${group[index].to}`, offset);
    });
  }
  for (const [stageId, group] of incoming) {
    group.sort((a, b) => positions.get(a.from).y - positions.get(b.from).y
      || positions.get(a.from).x - positions.get(b.from).x
      || a.from.localeCompare(b.from));
    portOffsets(group.length, 16).forEach((offset, index) => {
      targetPorts.set(`${group[index].from}->${stageId}`, offset);
    });
  }

  return edges.map((edge) => {
    const source = positions.get(edge.from);
    const target = positions.get(edge.to);
    const id = `${edge.from}->${edge.to}`;
    const x1 = source.x + HALF_NODE_WIDTH + 2;
    const y1 = source.y + sourcePorts.get(id);
    const x2 = target.x - HALF_NODE_WIDTH - 11;
    const y2 = target.y + targetPorts.get(id);
    const dx = Math.max(35, Math.min(160, (x2 - x1) * 0.42));
    const d = Math.abs(y2 - y1) <= 3
      ? `M ${x1} ${y1} L ${x2} ${y2}`
      : `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
    return { ...edge, d };
  });
}
