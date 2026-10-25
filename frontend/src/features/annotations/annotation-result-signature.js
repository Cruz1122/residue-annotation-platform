export function annotationResultSignature(run) {
  const stages = Array.isArray(run?.stages) ? run.stages : [];
  return stages
    .map((stage) => {
      if (!stage || typeof stage !== 'object') return '';
      const stageArtifacts = Array.isArray(stage.artifacts) ? stage.artifacts : [];
      const artifacts = stageArtifacts
        .filter((artifact) => artifact && typeof artifact === 'object')
        .map((artifact) => `${artifact.id}:${artifact.artifact_type}:${artifact.sha256 ?? ''}`)
        .sort()
        .join(',');
      return `${stage.id ?? ''}:${stage.stage_result_id ?? ''}:${artifacts}`;
    })
    .sort()
    .join('|');
}
