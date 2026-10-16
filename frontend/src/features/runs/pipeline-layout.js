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

/**
 * Lay out only the stages visible for the current run in dependency columns.
 * The persisted registry remains the source of truth; this presentation
 * layout deliberately avoids the large hand-authored canvas used by the
 * legacy all-stages view.
 */
export function compactStageLayout(stages) {
  const byId = new Map(stages.map((stage) => [stage.id, stage]));
  const order = new Map(stages.map((stage, index) => [stage.id, index]));
  const depth = new Map();

  const resolveDepth = (stageId, visiting = new Set()) => {
    if (depth.has(stageId)) return depth.get(stageId);
    if (visiting.has(stageId)) return 0;
    const stage = byId.get(stageId);
    if (!stage) return 0;
    const nextVisiting = new Set(visiting).add(stageId);
    const value = (stage.dependencies ?? [])
      .filter((dependency) => byId.has(dependency))
      .reduce((maximum, dependency) => Math.max(maximum, resolveDepth(dependency, nextVisiting) + 1), 0);
    depth.set(stageId, value);
    return value;
  };

  stages.forEach((stage) => resolveDepth(stage.id));
  const columns = new Map();
  for (const stage of stages) {
    const column = depth.get(stage.id) ?? 0;
    columns.set(column, [...(columns.get(column) ?? []), stage]);
  }

  const rowById = new Map();
  const orderedColumns = [...columns.keys()].sort((left, right) => left - right);
  let maxRows = 1;
  for (const column of orderedColumns) {
    const stagesInColumn = columns.get(column) ?? [];
    stagesInColumn.sort((left, right) => {
      const leftParents = (left.dependencies ?? []).filter((dependency) => rowById.has(dependency));
      const rightParents = (right.dependencies ?? []).filter((dependency) => rowById.has(dependency));
      const leftCenter = leftParents.length
        ? leftParents.reduce((sum, dependency) => sum + rowById.get(dependency), 0) / leftParents.length
        : Number.POSITIVE_INFINITY;
      const rightCenter = rightParents.length
        ? rightParents.reduce((sum, dependency) => sum + rowById.get(dependency), 0) / rightParents.length
        : Number.POSITIVE_INFINITY;
      return leftCenter - rightCenter || order.get(left.id) - order.get(right.id);
    });
    stagesInColumn.forEach((stage, row) => rowById.set(stage.id, row));
    maxRows = Math.max(maxRows, stagesInColumn.length);
  }

  const marginX = 56;
  const marginY = 44;
  const columnGap = 72;
  const rowGap = 28;
  const maxColumn = orderedColumns.at(-1) ?? 0;
  const width = Math.max(760, marginX * 2 + PIPELINE_NODE.width * (maxColumn + 1) + columnGap * maxColumn);
  const height = Math.max(420, marginY * 2 + PIPELINE_NODE.height * maxRows + rowGap * (maxRows - 1));
  const positions = new Map();
  for (const stage of stages) {
    const column = depth.get(stage.id) ?? 0;
    const row = rowById.get(stage.id) ?? 0;
    positions.set(stage.id, {
      x: marginX + PIPELINE_NODE.width / 2 + column * (PIPELINE_NODE.width + columnGap),
      y: marginY + PIPELINE_NODE.height / 2 + row * (PIPELINE_NODE.height + rowGap),
    });
  }
  return { positions, width, height };
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
