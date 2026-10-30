const TERMINAL_RUN_STATUSES = new Set(['success', 'failed', 'cancelled']);
export const EXTERNAL_TRACKING_STALE_AFTER_MS = 60_000;

export function runUpdatesFinished(run) {
  return TERMINAL_RUN_STATUSES.has(run?.status)
    && run?.external_tracking?.tracking_active !== true;
}

export function runStagePublicationSignature(run, stageIds) {
  const stages = new Map((run?.stages ?? []).map((stage) => [stage.id, stage]));
  return JSON.stringify(stageIds.map((stageId) => {
    const stage = stages.get(stageId);
    const artifacts = (stage?.artifacts ?? [])
      .map((artifact) => [artifact.id, artifact.artifact_type, artifact.sha256])
      .sort(([leftId], [rightId]) => String(leftId).localeCompare(String(rightId)));
    return [stageId, stage?.status ?? null, stage?.stage_result_id ?? null, artifacts];
  }));
}

export function externalTrackingIsUnavailable(tracking, now = Date.now()) {
  if (!tracking) return false;
  if (tracking.connection_status === 'unavailable') return true;
  if (tracking.tracking_active !== true) return false;

  const lastSyncedAt = Date.parse(tracking.last_synced_at ?? '');
  return !Number.isFinite(lastSyncedAt) || now - lastSyncedAt > EXTERNAL_TRACKING_STALE_AFTER_MS;
}

