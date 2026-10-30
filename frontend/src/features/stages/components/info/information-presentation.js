import { structureFormat } from '../../../annotations/structure-format.js';
import { proteinDisplayName } from '../../../proteins/protein-display.js';

const RELAXED_ARTIFACT_TYPES = [
  'rosettamp_relaxed_pdb',
  'foldx_relaxed_pdb',
];

const STRUCTURE_GENERATION_STAGE_IDS = new Set([
  'structure_modeling',
  'protein_relaxation_energy',
]);

const ACTIVE_STAGE_STATUSES = new Set(['pending', 'ready', 'queued', 'running']);

export function sequenceProteinForRun(run, baseProtein, runProtein) {
  if (!run?.protein_id) return null;
  const tracking = run.external_tracking;
  if (
    tracking?.run_type !== 'mutant'
    && tracking?.base_protein_id === baseProtein?.id
  ) return baseProtein;
  if (baseProtein?.id === run.protein_id) return baseProtein;
  if (runProtein?.id === run.protein_id) return runProtein;
  return null;
}

export function proteinNameForRun(protein, run, identityRecords = []) {
  const existingName = proteinDisplayName(protein);
  if (existingName !== 'Proteína sin nombre') return existingName;

  const identity = identityRecords?.[0] ?? {};
  const candidates = [
    identity.gene_symbol,
    identity.recommended_name,
    identity.protein_name,
    identity.uniprot_accession,
    run?.external_tracking?.accession,
    run?.configuration?.scientific_accession,
  ];
  return candidates.find((candidate) => typeof candidate === 'string' && candidate.trim())?.trim()
    ?? existingName;
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
    format: format ?? structureFormat(artifact),
    sha256: artifact.sha256 ?? '',
  };
}

function structureOptionsForSingleRun(run) {
  const options = [];
  const uploads = (run?.uploads ?? []).filter((upload) => upload?.input_type === 'structure' && upload?.id);
  const configuration = run?.configuration ?? {};
  const selectedUpload = uploads.find((upload) => upload.id === configuration.structure_upload_id)
    ?? uploads.find((upload) => configuration.structure_sha256 && upload.sha256 === configuration.structure_sha256)
    ?? uploads[0];

  if (selectedUpload) {
    const format = structureFormat(selectedUpload);
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

  const relaxedArtifacts = RELAXED_ARTIFACT_TYPES
    .map((type) => artifacts.find((artifact) => artifact.artifact_type === type))
    .filter(Boolean);
  for (const relaxedArtifact of relaxedArtifacts) {
    const sameAsInput = Boolean(selectedUpload?.sha256)
      && String(selectedUpload.sha256).toLowerCase() === String(relaxedArtifact.sha256 ?? '').toLowerCase();
    if (sameAsInput) continue;
    const labels = {
      rosettamp_relaxed_pdb: 'Estructura relajada · RosettaMP',
      foldx_relaxed_pdb: 'Estructura relajada · FoldX',
    };
    options.push(artifactOption(relaxedArtifact, 'relaxed', labels[relaxedArtifact.artifact_type]));
  }

  const selectedReference = artifacts.find((artifact) => artifact.artifact_type === 'selected_reference_pdb');
  if (selectedReference) {
    const sameAsInput = Boolean(selectedUpload?.sha256)
      && String(selectedUpload.sha256).toLowerCase() === String(selectedReference.sha256 ?? '').toLowerCase();
    const sameAsRelaxed = relaxedArtifacts.some((artifact) => Boolean(artifact.sha256)
      && String(artifact.sha256).toLowerCase() === String(selectedReference.sha256 ?? '').toLowerCase());
    if (!sameAsInput && !sameAsRelaxed) {
      options.push(artifactOption(selectedReference, 'reference', 'Referencia seleccionada (PDB)'));
    }
  }

  return options;
}

export function structureOptionsForRun(run, relatedRuns = []) {
  const options = structureOptionsForSingleRun(run);
  const relatedOptions = relatedRuns
    .filter((relatedRun) => relatedRun?.id && relatedRun.id !== run?.id)
    .flatMap((relatedRun) => structureOptionsForSingleRun(relatedRun)
      .filter((option) => option.source === 'artifact')
      .map((option) => {
        const runName = relatedRun.external_tracking?.display_name;
        return {
          ...option,
          label: runName ? `${runName} · ${option.label}` : option.label,
          sourceRunId: relatedRun.id,
          sourceRun: relatedRun,
        };
      }));
  return [...options, ...relatedOptions];
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
