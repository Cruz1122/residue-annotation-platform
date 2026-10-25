export const PIPELINE_NODE = Object.freeze({ width: 248, height: 128 });

const HALF_NODE_WIDTH = PIPELINE_NODE.width / 2;

/**
 * Lay out only the stages visible for the current run in dependency columns.
 * The persisted registry remains the source of truth.
 */
export function compactStageLayout(stages) {
  const byId = new Map(stages.map((stage) => [stage.id, stage]));
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
      return leftCenter - rightCenter || left.id.localeCompare(right.id);
    });
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

function portOffsets(count, spread) {
  if (count === 0) return [];
  if (count <= 1) return [0];
  const spacing = Math.min(spread * 2, (PIPELINE_NODE.height - 40) / (count - 1));
  const midpoint = (count - 1) / 2;
  return Array.from({ length: count }, (_, index) => (index - midpoint) * spacing);
}

function compareByPosition(positions, left, right) {
  return positions.get(left).y - positions.get(right).y
    || positions.get(left).x - positions.get(right).x
    || left.localeCompare(right);
}

function hasAlternatePath(from, to, childrenById) {
  const pending = (childrenById.get(from) ?? []).filter((stageId) => stageId !== to);
  const visited = new Set([from]);

  while (pending.length) {
    const stageId = pending.pop();
    if (stageId === to) return true;
    if (visited.has(stageId)) continue;
    visited.add(stageId);
    pending.push(...(childrenById.get(stageId) ?? []));
  }
  return false;
}

function curvedEdgePath(source, target, sourceOffset, targetOffset) {
  const x1 = source.x + HALF_NODE_WIDTH + 2;
  const y1 = source.y + sourceOffset;
  const x2 = target.x - HALF_NODE_WIDTH - 11;
  const y2 = target.y + targetOffset;
  const gap = x2 - x1;
  const bend = Math.min(18, Math.max(12, gap * 0.08));
  const controlOffset = gap * 0.38;

  return [
    `M ${x1} ${y1}`,
    `C ${x1 + controlOffset} ${y1 + bend}`,
    `${x2 - controlOffset} ${y2 + bend}`,
    `${x2} ${y2}`,
  ].join(' ');
}

/**
 * Draw the transitive reduction of the visible dependency graph. The backend
 * keeps every declared prerequisite for scheduling; this only removes visual
 * edges implied by another visible path.
 */
export function buildEdges(stages, positions) {
  const visibleIds = new Set(stages.filter((stage) => positions.has(stage.id)).map((stage) => stage.id));
  const outgoing = new Map([...visibleIds].map((stageId) => [stageId, []]));
  const incoming = new Map([...visibleIds].map((stageId) => [stageId, []]));
  const childrenById = new Map([...visibleIds].map((stageId) => [stageId, []]));
  const edges = [];

  for (const target of stages) {
    if (!visibleIds.has(target.id)) continue;
    for (const dependency of target.dependencies ?? []) {
      if (visibleIds.has(dependency)) childrenById.get(dependency).push(target.id);
    }
  }

  for (const target of stages) {
    if (!positions.has(target.id)) continue;
    for (const dependency of target.dependencies ?? []) {
      if (!visibleIds.has(dependency)) continue;
      if (hasAlternatePath(dependency, target.id, childrenById)) continue;
      const edge = { id: `${dependency}->${target.id}`, from: dependency, to: target.id };
      edges.push(edge);
      outgoing.get(dependency).push(edge);
      incoming.get(target.id).push(edge);
    }
  }

  const sourcePorts = new Map();
  const targetPorts = new Map();
  for (const group of outgoing.values()) {
    group.sort((left, right) => compareByPosition(positions, left.to, right.to));
    portOffsets(group.length, 22).forEach((offset, index) => {
      sourcePorts.set(group[index].id, offset);
    });
  }
  for (const group of incoming.values()) {
    group.sort((left, right) => compareByPosition(positions, left.from, right.from));
    portOffsets(group.length, 16).forEach((offset, index) => {
      targetPorts.set(group[index].id, offset);
    });
  }

  return edges.map((edge) => ({
    ...edge,
    mode: 'curved',
    d: curvedEdgePath(
      positions.get(edge.from),
      positions.get(edge.to),
      sourcePorts.get(edge.id),
      targetPorts.get(edge.id),
    ),
  }));
}
