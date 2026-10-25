const RELAXED_ARTIFACT_TYPES = [
  'rosettamp_relaxed_pdb',
  'foldx_relaxed_pdb',
];

const STRUCTURE_GENERATION_STAGE_IDS = new Set([
  'structure_modeling',
  'protein_relaxation_energy',
]);

const ACTIVE_STAGE_STATUSES = new Set(['pending', 'ready', 'queued', 'running']);

function structureFormat(name, mediaType) {
  const sourceName = String(name ?? '').toLowerCase();
  const media = String(mediaType ?? '').toLowerCase();
  return /\.(cif|mmcif)$/.test(sourceName) || media.includes('cif') ? 'mmcif' : 'pdb';
}

function allArtifacts(run) {
  const byId = new Map();
  for (const artifact of [
    ...(run?.run_artifacts ?? []),
    ...(run?.stages ?? []).flatMap((stage) => stage.artifacts ?? []),
  ]) {
    if (artifact?.id && artifact?.artifact_type) byId.set(artifact.id, artifact);
  }
  return [...byId.values()];
}

function artifactOption(artifact, kind, label, format) {
  return {
    value: `artifact:${artifact.id}`,
    id: artifact.id,
    source: 'artifact',
    kind,
    label,
    format: format ?? structureFormat(artifact.artifact_type, artifact.media_type),
    sha256: artifact.sha256 ?? '',
  };
}

export function structureOptionsForRun(run) {
  const options = [];
  const uploads = (run?.uploads ?? []).filter((upload) => upload?.input_type === 'structure' && upload?.id);
  const configuration = run?.configuration ?? {};
  const selectedUpload = uploads.find((upload) => upload.id === configuration.structure_upload_id)
    ?? uploads.find((upload) => configuration.structure_sha256 && upload.sha256 === configuration.structure_sha256)
    ?? uploads[0];

  if (selectedUpload) {
    const format = structureFormat(selectedUpload.original_filename, selectedUpload.media_type);
    const fileName = String(selectedUpload.original_filename ?? '').trim();
    options.push({
      value: `upload:${selectedUpload.id}`,
      id: selectedUpload.id,
      source: 'upload',
      kind: 'provided',
      label: `${format === 'pdb' ? 'PDB proporcionado' : 'Estructura proporcionada'}${fileName ? ` · ${fileName}` : ''}`,
      format,
      sha256: selectedUpload.sha256 ?? '',
    });
  }

  const artifacts = allArtifacts(run);
  const model = artifacts.find((artifact) => artifact.artifact_type === 'model_cif');
  if (model) options.push(artifactOption(model, 'alphafold3', 'Modelo AlphaFold 3', 'mmcif'));

  const relaxedArtifact = RELAXED_ARTIFACT_TYPES
    .map((type) => artifacts.find((artifact) => artifact.artifact_type === type))
    .find(Boolean);
  if (relaxedArtifact) {
    const sameAsInput = Boolean(selectedUpload?.sha256)
      && String(selectedUpload.sha256).toLowerCase() === String(relaxedArtifact.sha256 ?? '').toLowerCase();
    if (!sameAsInput) {
      const labels = {
        rosettamp_relaxed_pdb: 'Estructura relajada · RosettaMP',
        foldx_relaxed_pdb: 'Estructura relajada · FoldX',
      };
      options.push(artifactOption(relaxedArtifact, 'relaxed', labels[relaxedArtifact.artifact_type]));
    }
  }

  const selectedReference = artifacts.find((artifact) => artifact.artifact_type === 'selected_reference_pdb');
  if (selectedReference) {
    const sameAsInput = Boolean(selectedUpload?.sha256)
      && String(selectedUpload.sha256).toLowerCase() === String(selectedReference.sha256 ?? '').toLowerCase();
    const sameAsRelaxed = Boolean(relaxedArtifact?.sha256)
      && String(relaxedArtifact.sha256).toLowerCase() === String(selectedReference.sha256 ?? '').toLowerCase();
    if (!sameAsInput && !sameAsRelaxed) {
      options.push(artifactOption(selectedReference, 'reference', 'Referencia seleccionada (PDB)'));
    }
  }

  return options;
}

export function defaultStructureOption(options = []) {
  return options.find((option) => option.kind === 'provided')
    ?? options.find((option) => option.kind === 'alphafold3')
    ?? options.find((option) => option.kind === 'relaxed')
    ?? options.find((option) => option.kind === 'reference')
    ?? options[0]
    ?? null;
}

export function structureGenerationPending(run) {
  return (run?.stages ?? []).some((stage) => (
    STRUCTURE_GENERATION_STAGE_IDS.has(stage.id)
    && ACTIVE_STAGE_STATUSES.has(stage.status)
  ));
}

export function structureGenerationFailed(run) {
  return (run?.stages ?? []).some((stage) => (
    STRUCTURE_GENERATION_STAGE_IDS.has(stage.id)
    && stage.status === 'failed'
  ));
}
