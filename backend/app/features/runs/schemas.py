from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

AMINO_ACIDS = frozenset("ACDEFGHIKLMNPQRSTVWY")


class VariantRequest(BaseModel):
    aa_position: int = Field(ge=1)
    aa_ref: str = Field(min_length=1, max_length=1)
    aa_alt: str = Field(min_length=1, max_length=1)

    @field_validator("aa_ref", "aa_alt")
    @classmethod
    def normalize_amino_acid(cls, value: str) -> str:
        normalized = value.upper()
        if normalized not in AMINO_ACIDS:
            raise ValueError("amino-acid symbol is not allowed")
        return normalized


class RunCreate(BaseModel):
    protein_id: str = Field(min_length=1, max_length=36)
    variants: list[VariantRequest] = Field(default_factory=list, max_length=10_000)
    upload_ids: list[str] = Field(default_factory=list, max_length=2)
    structure_source: Literal["alphafold3", "provided_pdb"] | None = None
    structure_chain: str | None = Field(default=None, min_length=1, max_length=8)
    scientific_accession: str | None = Field(default=None, min_length=3, max_length=32)
    scientific_parameters: dict[str, Any] = Field(default_factory=dict, max_length=100)

    @model_validator(mode="after")
    def reject_duplicate_positions(self):
        positions = [variant.aa_position for variant in self.variants]
        if len(positions) != len(set(positions)):
            raise ValueError("variant positions must be unique")
        self.variants = sorted(self.variants, key=lambda variant: variant.aa_position)
        return self

    @field_validator("upload_ids")
    @classmethod
    def reject_duplicate_uploads(cls, values: list[str]) -> list[str]:
        if len(values) != len(set(values)):
            raise ValueError("upload_ids must be unique")
        return sorted(values)


class ArtifactRead(BaseModel):
    id: str
    artifact_type: str
    media_type: str
    size: int
    sha256: str
    download_url: str


class StageRead(BaseModel):
    id: str
    legacy_id: str
    title: str
    dependencies: list[str]
    optional: bool
    status: str
    stage_result_id: str | None = None
    cache_key: str | None = None
    cache_factors: dict[str, object] = Field(default_factory=dict)
    reuse_reason: dict[str, object] | None = None
    provenance: dict[str, object] = Field(default_factory=dict)
    omission_reason: str | None = None
    slurm_job_id: str | None = None
    error_code: str | None = None
    error_message: str | None = None
    preflight_status: str = "pending"
    preflight_error_code: str | None = None
    preflight_error_message: str | None = None
    preflight_details: dict[str, object] = Field(default_factory=dict)
    preflight_checked_at: datetime | None = None
    preflight_retry_at: datetime | None = None
    started_at: datetime | None = None
    finished_at: datetime | None = None
    artifacts: list[ArtifactRead] = Field(default_factory=list)


class UploadRead(BaseModel):
    id: str
    input_type: str
    original_filename: str
    sha256: str
    size: int
    media_type: str
    transfer_status: str


class RunConfigurationRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    run_id: str
    protein_id: str
    sequence_sha256: str
    scientific_accession: str | None = None
    fasta_upload_id: str | None = None
    fasta_sha256: str | None = None
    structure_upload_id: str | None = None
    structure_source: Literal["alphafold3", "provided_pdb"]
    structure_sha256: str | None = None
    structure_chain: str | None = None
    structure_mapping: dict[str, object] = Field(default_factory=dict)
    normalized_variants: list[dict[str, object]] = Field(default_factory=list)
    selected_stage_ids: list[str] = Field(default_factory=list)
    omitted_stages: list[dict[str, object]] = Field(default_factory=list)
    scientific_parameters: dict[str, object] = Field(default_factory=dict)
    prerequisites: dict[str, object] = Field(default_factory=dict)
    versions: dict[str, object] = Field(default_factory=dict)
    input_references: dict[str, object] = Field(default_factory=dict)
    owner_id: str
    project_id: str
    confirmation_audit_id: str | None = None
    confirmed_at: datetime | None = None


class RunPreparationRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    run_id: str
    status: str
    required_requirements: list[str] = Field(default_factory=list)
    satisfied_requirements: list[str] = Field(default_factory=list)
    snapshots: dict[str, object] = Field(default_factory=dict)
    preparation_key: str | None = None
    attempt_count: int = 0
    error_code: str | None = None
    error_message: str | None = None
    started_at: datetime | None = None
    checked_at: datetime | None = None
    finished_at: datetime | None = None


class RunRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    protein_id: str
    status: str
    requested_variants: list[dict[str, object]]
    remote_job_id: str | None = None
    error_code: str | None = None
    error_message: str | None = None
    configuration: RunConfigurationRead | None = None
    preparation: RunPreparationRead | None = None
    created_at: datetime | None = None
    started_at: datetime | None = None
    finished_at: datetime | None = None
    stages: list[StageRead]
    uploads: list["UploadRead"] = Field(default_factory=list)


class AnnotationRead(BaseModel):
    stage_id: str
    stage_result_id: str
    aa_position: int
    aa_ref: str
    values: dict[str, object]
    units: dict[str, object]
    qc_status: str


class AnnotationsResponse(BaseModel):
    run_id: str
    rows: list[AnnotationRead]
    pending_stage_ids: list[str]
    failed_stage_ids: list[str]
    truncated: bool = False
