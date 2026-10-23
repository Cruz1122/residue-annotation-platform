export const PIPELINE_WORLD = Object.freeze({ width: 2490, height: 990 });
export const PIPELINE_WORLD_NO_AF3 = Object.freeze({ width: 1464, height: 990 });
export const PIPELINE_NODE = Object.freeze({ width: 248, height: 128 });

const HALF_NODE_WIDTH = PIPELINE_NODE.width / 2;
const HALF_NODE_HEIGHT = PIPELINE_NODE.height / 2;

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
  // ClinVar is an optional extension of the 18-stage scientific canvas. It
  // keeps the reference geometry intact while remaining visible for runs
  // that actually include the persisted ClinVar stage.
  clinvar: { x: 1172, y: 865 },
});

// Hand-authored coordinates for the provided-PDB path where AF3 is omitted.
// The structural route is compacted and the relaxation stage follows protein identity.
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
  clinvar: { x: 1172, y: 880 },
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
  const maxRows = Math.max(1, ...orderedColumns.map((column) => columns.get(column)?.length ?? 0));
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
    // Center short columns against the busiest layer. This keeps the root and
    // later branches from sticking to the top while leaving no artificial
    // rows between cards in a sparse column.
    const columnOffset = (maxRows - stagesInColumn.length) / 2;
    stagesInColumn.forEach((stage, row) => rowById.set(stage.id, row + columnOffset));
  }

  const marginX = 40;
  const marginY = 32;
  const columnGap = 80;
  const rowGap = 32;
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
  // TODO: Remove this presentation override after the backend models the
  // protein identity → protein relaxation fallback.
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

const PORTAL_GAP = 14;
const PORTAL_LANE_GAP = 5;
const PORTAL_CHANNEL_GAP = 8;
const DIRECT_CHANNEL_GAP = 12;
const PORTAL_ACCENTS = Object.freeze([
  '#2563eb', '#c2410c', '#7c3aed', '#0f766e', '#be185d',
  '#4d7c0f', '#0369a1', '#a16207', '#6d28d9', '#047857',
]);

function compareByPosition(positions, left, right) {
  return positions.get(left).y - positions.get(right).y
    || positions.get(left).x - positions.get(right).x
    || left.localeCompare(right);
}

/**
 * Build the shortest orthogonal route between adjacent columns. Keeping the
 * bend inside the inter-column gap avoids unnecessary Bézier curves and makes
 * the final arrow segment horizontal and predictable.
 */
function pathToEndpoint(x1, y1, x2, y2, bendX = x1 + (x2 - x1) / 2) {
  if (Math.abs(y2 - y1) <= 3) return `M ${x1} ${y1} L ${x2} ${y2}`;

  return [
    `M ${x1} ${y1}`,
    `L ${bendX} ${y1}`,
    `L ${bendX} ${y2}`,
    `L ${x2} ${y2}`,
  ].join(' ');
}

function adjacentPortalBridgePath(source, target) {
  const bendX = source.x + (target.x - source.x) / 2;
  return [
    `M ${source.x} ${source.y}`,
    `L ${bendX} ${source.y}`,
    `L ${bendX} ${target.y}`,
    `L ${target.x} ${target.y}`,
  ].join(' ');
}

function outerPortalBridgePath(source, target) {
  // Each portal gets its own horizontal lane. Keeping the bridge itself to a
  // single segment makes it impossible for two portal bridges on different
  // lanes to share a stretch of line.
  return `M ${source.x} ${source.y} L ${target.x} ${target.y}`;
}

function compactGapChannelPositions(start, end, count, minimumGap) {
  if (count <= 1) return [(start + end) / 2];
  const lower = Math.min(start, end);
  const upper = Math.max(start, end);
  const available = upper - lower;
  const spacing = Math.min(minimumGap, available / (count - 1));
  const span = spacing * (count - 1);
  const offset = (available - span) / 2;
  return Array.from({ length: count }, (_, index) => lower + offset + spacing * index);
}

function compareEdgesByPosition(positions, left, right) {
  return compareByPosition(positions, left.from, right.from)
    || compareByPosition(positions, left.to, right.to)
    || `${left.from}->${left.to}`.localeCompare(`${right.from}->${right.to}`);
}

function preferredPortalRouteSide(positions, edge) {
  const source = positions.get(edge.from);
  const target = positions.get(edge.to);
  return target.y < source.y ? 'top' : 'bottom';
}

export function buildEdges(stages, positions) {
  const stagesById = new Map(stages.map((stage) => [stage.id, stage]));
  const outgoing = new Map(stages.map((stage) => [stage.id, []]));
  const incoming = new Map(stages.map((stage) => [stage.id, []]));
  const edges = [];

  for (const target of stages) {
    for (const dependency of target.dependencies ?? []) {
      const source = positions.has(dependency) ? stagesById.get(dependency) : null;
      if (!source || !positions.has(target.id)) continue;
      const edge = { from: dependency, to: target.id };
      edges.push(edge);
      outgoing.get(dependency)?.push(edge);
      incoming.get(target.id)?.push(edge);
    }
  }

  const sourcePorts = new Map();
  const targetPorts = new Map();
  const directEdgesBySource = new Map();
  const isAdjacentColumnEdge = (edge) => {
    const source = positions.get(edge.from);
    const target = positions.get(edge.to);
    return target.x > source.x && target.x - source.x <= PIPELINE_NODE.width + 100;
  };
  for (const [stageId, group] of outgoing) {
    group.sort((a, b) => compareByPosition(positions, a.to, b.to));
    if (group.length > 1) {
      // Every branch in the next column is safe to draw directly in the gap:
      // there are no cards between the source and target boundaries. Only
      // dependencies that skip a column need a portal route.
      directEdgesBySource.set(stageId, new Set(
        group.filter(isAdjacentColumnEdge).map((edge) => `${edge.from}->${edge.to}`),
      ));
    }
  }
  for (const [stageId, group] of incoming) {
    group.sort((a, b) => compareByPosition(positions, a.from, b.from));
  }

  const isDirectEdge = (edge) => directEdgesBySource.has(edge.from)
    ? directEdgesBySource.get(edge.from).has(`${edge.from}->${edge.to}`)
    : isAdjacentColumnEdge(edge);
  const directBendXByEdge = new Map();
  const directEdgesByGap = new Map();
  for (const edge of edges) {
    if (!isDirectEdge(edge)) continue;
    const source = positions.get(edge.from);
    const target = positions.get(edge.to);
    const gapId = `${source.x}->${target.x}`;
    directEdgesByGap.set(gapId, [...(directEdgesByGap.get(gapId) ?? []), edge]);
  }
  for (const group of directEdgesByGap.values()) {
    group.sort((left, right) => compareEdgesByPosition(positions, left, right));
    const source = positions.get(group[0].from);
    const target = positions.get(group[0].to);
    // The node columns may be far apart for readability, but the branch
    // channels should stay grouped around the middle of that gap. Spreading
    // them across the entire gap makes the edges look disconnected from one
    // another even though they share the same source and target layers.
    const bendXs = compactGapChannelPositions(
      source.x + HALF_NODE_WIDTH + 2,
      target.x - HALF_NODE_WIDTH - 11,
      group.length,
      DIRECT_CHANNEL_GAP,
    );
    group.forEach((edge, index) => {
      directBendXByEdge.set(`${edge.from}->${edge.to}`, bendXs[index]);
    });
  }
  const portalIds = edges
    .filter((edge) => !isDirectEdge(edge))
    .map((edge) => `${edge.from}->${edge.to}`)
    .sort((left, right) => left.localeCompare(right));
  const portalMeta = new Map(portalIds.map((id, index) => [id, {
    accent: PORTAL_ACCENTS[index % PORTAL_ACCENTS.length],
  }]));

  const nodePositions = [...positions.values()];
  const minimumNodeTop = nodePositions.length
    ? Math.min(...nodePositions.map(({ y }) => y - HALF_NODE_HEIGHT))
    : HALF_NODE_HEIGHT;
  const maximumNodeBottom = nodePositions.length
    ? Math.max(...nodePositions.map(({ y }) => y + HALF_NODE_HEIGHT))
    : HALF_NODE_HEIGHT;
  const portalLanes = {
    top: Math.max(6, minimumNodeTop - PORTAL_GAP - 4),
    bottom: maximumNodeBottom + PORTAL_GAP + 4,
  };
  const outerPortalEdges = edges.filter((edge) => !isDirectEdge(edge) && !isAdjacentColumnEdge(edge));
  const portalRouteSideByEdge = new Map();
  const outerPortalEdgesBySide = { top: [], bottom: [] };
  for (const edge of outerPortalEdges) {
    // The side belongs to the relationship, not to whichever global lane is
    // marginally closer. A branch going upward is prioritized on the upper
    // anchor and a branch going downward on the lower anchor, while the
    // original uniform anchor set remains intact when several edges share it.
    const routeSide = preferredPortalRouteSide(positions, edge);
    portalRouteSideByEdge.set(`${edge.from}->${edge.to}`, routeSide);
    outerPortalEdgesBySide[routeSide].push(edge);
  }
  const portSideRank = (edge) => {
    const routeSide = portalRouteSideByEdge.get(`${edge.from}->${edge.to}`);
    if (routeSide === 'top') return 0;
    if (routeSide === 'bottom') return 2;
    return 1;
  };
  const comparePortEdges = (left, right) => portSideRank(left) - portSideRank(right)
    || compareEdgesByPosition(positions, left, right);

  // Keep the original uniform anchor distribution. The route side only
  // decides which existing anchor an edge occupies; it never creates a new
  // y-coordinate outside the node's established port set.
  for (const [stageId, group] of outgoing) {
    group.sort(comparePortEdges);
    portOffsets(group.length, 22).forEach((offset, index) => {
      sourcePorts.set(`${stageId}->${group[index].to}`, offset);
    });
  }
  for (const [stageId, group] of incoming) {
    group.sort(comparePortEdges);
    portOffsets(group.length, 16).forEach((offset, index) => {
      targetPorts.set(`${group[index].from}->${stageId}`, offset);
    });
  }
  const portalLaneYByEdge = new Map();
  for (const [routeSide, group] of Object.entries(outerPortalEdgesBySide)) {
    group.sort((left, right) => compareEdgesByPosition(positions, left, right));
    group.forEach((edge, index) => {
      const laneY = routeSide === 'top'
        ? portalLanes.top - index * PORTAL_LANE_GAP
        : portalLanes.bottom + index * PORTAL_LANE_GAP;
      portalLaneYByEdge.set(`${edge.from}->${edge.to}`, laneY);
    });
  }
  const columnCenters = [...new Set([...positions.values()].map(({ x }) => x))].sort((left, right) => left - right);
  const portalSourceLaneXByEdge = new Map();
  const portalTargetLaneXByEdge = new Map();
  const portalEdgesBySourceColumn = new Map();
  const portalEdgesByTargetColumn = new Map();
  for (const edge of outerPortalEdges) {
    const source = positions.get(edge.from);
    const target = positions.get(edge.to);
    portalEdgesBySourceColumn.set(source.x, [...(portalEdgesBySourceColumn.get(source.x) ?? []), edge]);
    portalEdgesByTargetColumn.set(target.x, [...(portalEdgesByTargetColumn.get(target.x) ?? []), edge]);
  }
  for (const [sourceX, group] of portalEdgesBySourceColumn) {
    group.sort((left, right) => compareEdgesByPosition(positions, left, right));
    const nextColumnX = columnCenters.find((columnX) => columnX > sourceX) ?? positions.get(group[0].to).x;
    const laneXs = compactGapChannelPositions(
      sourceX + HALF_NODE_WIDTH + PORTAL_GAP,
      nextColumnX - HALF_NODE_WIDTH - PORTAL_GAP,
      group.length,
      PORTAL_CHANNEL_GAP,
    );
    group.forEach((edge, index) => {
      portalSourceLaneXByEdge.set(`${edge.from}->${edge.to}`, laneXs[index]);
    });
  }
  for (const [targetX, group] of portalEdgesByTargetColumn) {
    group.sort((left, right) => compareEdgesByPosition(positions, left, right));
    const previousColumnX = [...columnCenters].reverse().find((columnX) => columnX < targetX) ?? positions.get(group[0].from).x;
    const laneXs = compactGapChannelPositions(
      previousColumnX + HALF_NODE_WIDTH + PORTAL_GAP,
      targetX - HALF_NODE_WIDTH - PORTAL_GAP,
      group.length,
      PORTAL_CHANNEL_GAP,
    );
    group.forEach((edge, index) => {
      portalTargetLaneXByEdge.set(`${edge.from}->${edge.to}`, laneXs[index]);
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
    const d = pathToEndpoint(x1, y1, x2, y2, directBendXByEdge.get(id));
    const isDirect = isDirectEdge(edge);
    if (isDirect) {
      return {
        ...edge,
        id,
        mode: 'direct',
        d,
        segments: [{ role: 'direct', d }],
      };
    }

    const adjacent = isAdjacentColumnEdge(edge);
    let routeSide;
    let sourcePortal;
    let targetPortal;
    let sourcePath;
    let targetPath;
    let bridge;
    if (adjacent) {
      // A portal inside the next column does not need to escape the whole
      // canvas. Keep it in the inter-column gap with one vertical dogleg.
      const sourceBoundary = { x: x1, y: y1 };
      const targetBoundary = { x: x2, y: y2 };
      sourcePortal = { x: x1 + PORTAL_GAP, y: y1 };
      targetPortal = { x: x2 - PORTAL_GAP, y: y2 };
      sourcePath = `M ${sourceBoundary.x} ${sourceBoundary.y} L ${sourcePortal.x} ${sourcePortal.y}`;
      targetPath = `M ${targetPortal.x} ${targetPortal.y} L ${targetBoundary.x} ${targetBoundary.y}`;
      bridge = adjacentPortalBridgePath(sourcePortal, targetPortal);
      routeSide = 'gap';
    } else {
      routeSide = portalRouteSideByEdge.get(id);
      const laneY = portalLaneYByEdge.get(id);
      const sourceLaneX = portalSourceLaneXByEdge.get(id);
      const targetLaneX = portalTargetLaneXByEdge.get(id);
      const sourceBoundary = { x: x1, y: y1 };
      const targetBoundary = { x: x2, y: y2 };
      // Start and finish each portal in its own column gap. The vertical legs
      // never enter a node, while the bridge runs on a unique outer lane.
      sourcePortal = { x: sourceLaneX, y: laneY };
      targetPortal = { x: targetLaneX, y: laneY };
      sourcePath = [
        `M ${sourceBoundary.x} ${sourceBoundary.y}`,
        `L ${sourceLaneX} ${sourceBoundary.y}`,
        `L ${sourceLaneX} ${laneY}`,
      ].join(' ');
      targetPath = [
        `M ${targetLaneX} ${laneY}`,
        `L ${targetLaneX} ${targetBoundary.y}`,
        `L ${targetBoundary.x} ${targetBoundary.y}`,
      ].join(' ');
      bridge = outerPortalBridgePath(sourcePortal, targetPortal);
    }
    const portalId = `portal:${id}`;
    const metadata = portalMeta.get(id);
    return {
      ...edge,
      id,
      mode: 'portal',
      // Keep d as the source half for callers that only need one path. The
      // renderer uses segments so both sides of the portal remain visible.
      d: sourcePath,
      portal: {
        id: portalId,
        accent: metadata.accent,
        bridge,
        source: sourcePortal,
        target: targetPortal,
        routeSide,
      },
      segments: [
        { role: 'portal-source', d: sourcePath },
        { role: 'portal-target', d: targetPath },
      ],
    };
  });
}
