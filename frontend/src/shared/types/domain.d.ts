export type StageStatus =
  | 'pending'
  | 'ready'
  | 'queued'
  | 'running'
  | 'success'
  | 'reused'
  | 'failed'
  | 'skipped'
  | 'cancelled';

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
}

export interface RunStage {
  id: string;
  legacy_id: string;
  title: string;
  dependencies: string[];
  optional: boolean;
  status: StageStatus;
  stage_result_id: string | null;
  slurm_job_id: string | null;
  error_code: string | null;
  error_message: string | null;
  started_at: string | null;
  finished_at: string | null;
  artifacts: Artifact[];
}

export interface Run {
  id: string;
  protein_id: string;
  status: 'pending' | 'running' | 'success' | 'failed' | 'cancel_requested' | 'cancelled';
  requested_variants: VariantRequest[];
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
