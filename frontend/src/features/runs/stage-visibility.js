// The backend registry and persisted RunStage statuses are authoritative.

const RESOLVED = new Set(['success', 'reused', 'failed', 'skipped', 'cancelled']);

export function validateDisabledStages(stages, disabledIds = new Set()) {
  const children = new Map(stages.map((stage) => [stage.id, []]));
  for (const stage of stages) {
    for (const parentId of stage.dependencies ?? []) {
      if (!children.has(parentId)) throw new Error(`Padre desconocido: ${parentId}`);
      children.get(parentId).push(stage.id);
    }
  }
  for (const id of disabledIds) {
    if (!children.has(id)) throw new Error(`Etapa desconocida: ${id}`);
    if (children.get(id).length) throw new Error(`La vista solo puede desactivar hojas: ${id}`);
  }
}

export function presentRunStages(stages) {
  validateDisabledStages(stages);
  return stages.map((stage) => ({ ...stage }));
}

export function progressSummary(stages) {
  const enabled = stages.filter((stage) => stage.status !== 'disabled');
  const completed = enabled.filter((stage) => RESOLVED.has(stage.status)).length;
  return {
    enabled: enabled.length,
    completed,
    percentage: enabled.length ? Math.round((completed / enabled.length) * 100) : 0,
  };
}
