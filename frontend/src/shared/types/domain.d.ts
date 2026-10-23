export type StageStatus =
  | 'pending'
  | 'ready'
  | 'queued'
  | 'running'
  | 'success'
  | 'reused'
  | 'failed'
  | 'skipped'
  | 'cancelled'
  | 'disabled';

export interface ProteinAlias {
  source: string;
  identifier: string;
}

export interface Protein {
  id: string;
  sequence_sha256: string;
  sequence: string;
  length: number;
  aliases: ProteinAlias[];
  created_at: string | null;
  created?: boolean;
}

export interface CreateProteinInput {
  sequence?: string;
  fasta?: string;
  aliases?: ProteinAlias[];
}

export interface VariantRequest {
  aa_position: number;
  aa_ref: string;
  aa_alt: string;
}

export interface CreateRunInput {
  protein_id: string;
  variants: VariantRequest[];
  upload_ids?: string[];
  structure_source?: 'alphafold3' | 'provided_pdb';
  structure_chain?: string;
  scientific_accession?: string;
  scientific_parameters?: Record<string, unknown>;
}

export interface Upload {
  id: string;
  input_type: 'fasta' | 'structure';
  original_filename: string;
  sha256: string;
  size: number;
  media_type: string;
  transfer_status: string;
}

export interface Artifact {
  id: string;
  artifact_type: string;
  media_type: string;
  size: number;
  sha256: string;
  download_url: string;
  display_name?: string;
  format_label?: string;
  download_format?: 'original' | 'xlsx';
  download_filename?: string;
}

export interface RunStage {
  id: string;
  legacy_id: string;
  title: string;
  dependencies: string[];
  optional: boolean;
  status: StageStatus;
  stage_result_id: string | null;
  cache_key: string | null;
  cache_factors: Record<string, unknown>;
  reuse_reason: Record<string, unknown> | null;
  provenance: Record<string, unknown>;
  omission_reason: string | null;
  slurm_job_id: string | null;
  error_code: string | null;
  error_message: string | null;
  preflight_status: string;
  preflight_error_code: string | null;
  preflight_error_message: string | null;
  preflight_details: Record<string, unknown>;
  preflight_checked_at: string | null;
  preflight_retry_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  artifacts: Artifact[];
}

export interface RunPreparation {
  id: string;
  run_id: string;
  status: string;
  required_requirements: string[];
  satisfied_requirements: string[];
  snapshots: Record<string, unknown>;
  preparation_key: string | null;
  attempt_count: number;
  error_code: string | null;
  error_message: string | null;
  started_at: string | null;
  checked_at: string | null;
  finished_at: string | null;
}

export interface RunConfiguration {
  id: string;
  run_id: string;
  protein_id: string;
  sequence_sha256: string;
  scientific_accession: string | null;
  fasta_upload_id: string | null;
  fasta_sha256: string | null;
  structure_upload_id: string | null;
  structure_source: 'alphafold3' | 'provided_pdb';
  structure_sha256: string | null;
  structure_chain: string | null;
  structure_mapping: Record<string, unknown>;
  normalized_variants: VariantRequest[];
  selected_stage_ids: string[];
  omitted_stages: Array<Record<string, unknown>>;
  scientific_parameters: Record<string, unknown>;
  prerequisites: Record<string, unknown>;
  versions: Record<string, unknown>;
  input_references: Record<string, unknown>;
  owner_id: string;
  project_id: string;
  confirmation_audit_id: string | null;
  confirmed_at: string | null;
}

export interface Run {
  id: string;
  protein_id: string;
  status: 'pending' | 'running' | 'success' | 'failed' | 'cancel_requested' | 'cancelled';
  priority?: string | null;
  requested_variants: VariantRequest[];
  remote_job_id: string | null;
  error_code: string | null;
  error_message: string | null;
  configuration: RunConfiguration | null;
  preparation: RunPreparation | null;
  run_artifacts: Artifact[];
  created_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  stages: RunStage[];
  uploads: Upload[];
}

export interface StageDefinition {
  id: string;
  legacy_id: string;
  title: string;
  dependencies: string[];
  optional: boolean;
  cpu: number | null;
  gpu: number | null;
  columns: string[];
}

export interface AnnotationRow {
  stage_id: string;
  stage_result_id: string;
  aa_position: number;
  aa_ref: string;
  values: Record<string, unknown>;
  units: Record<string, unknown>;
  qc_status: string;
}

export interface AnnotationResponse {
  run_id: string;
  rows: AnnotationRow[];
  pending_stage_ids: string[];
  failed_stage_ids: string[];
  truncated?: boolean;
}

export interface HealthResponse {
  status: 'ok';
}
