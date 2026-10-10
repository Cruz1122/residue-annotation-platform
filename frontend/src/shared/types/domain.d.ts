export type StageStatus = 'pending' | 'running' | 'ok' | 'failed' | 'skipped';

export interface ProteinSummary {
  id: string;
  accession: string;
  gene: string;
  name: string;
  organism: string;
  length: number;
  source: string;
  pdb: string;
  preview: string;
}

export interface ResidueRecord {
  index: number;
  authSeqId: number;
  chain: string;
  one: string;
  compId: string;
}

export interface VariantSelection {
  index?: number;
  aa_position: number;
  aa_ref: string;
  aa_alt: string;
  label: string;
}

export interface PipelineArtifact {
  name: string;
  url: string;
  mediaType?: string;
  size?: number;
}

export interface PipelineStage {
  id: string;
  legacy: string;
  title: string;
  icon: string;
  x: number;
  y: number;
  estimate: string;
  deps: string[];
  optional?: boolean;
  note?: string;
  annotations: Array<[label: string, key: string, value: string]>;
  artifacts: string[];
}

export interface PipelineStageRuntime {
  stageId: string;
  status: StageStatus;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface DemoSessionState {
  uploaded: null | {
    pdb: string | null;
    fasta: string | null;
  };
  variants: Array<{
    index: number;
    ref: string;
    alt: string;
    aa_position: number;
    aa_ref: string;
    aa_alt: string;
    label: string;
  }>;
  runStartedAt: number | null;
}
