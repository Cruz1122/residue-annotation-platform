from dataclasses import asdict, dataclass

CANONICAL_ANNOTATION_INPUTS = ("protein_id", "aa_position", "aa_ref")


@dataclass(frozen=True, slots=True)
class StageDefinition:
    id: str
    legacy_id: str
    title: str
    dependencies: tuple[str, ...]
    optional: bool = False
    cpu: int | None = None
    gpu: int | None = None
    columns: tuple[str, ...] = ()
    requires_variant: bool = False
    required_annotations: tuple[str, ...] = CANONICAL_ANNOTATION_INPUTS
    produced_annotations: tuple[str, ...] = ()
    produced_artifacts: tuple[str, ...] = ()
    optional_artifacts: tuple[str, ...] = ()
    consumed_artifacts: tuple[tuple[str, str], ...] = ()
    stage_version: str = "1"
    technical_requirements: tuple[str, ...] = ()
    description: str = ""
    cache_parameters: tuple[str, ...] = (
        "protein.sequence_sha256",
        "stage_version",
        "resource_identity",
        "scientific_parameters",
    )
    network: bool = False
    memory_gb: int | None = None

    def __post_init__(self) -> None:
        # ``columns`` was the original local API name. Keep it as a compatible
        # alias while making the remote contract vocabulary explicit.
        if self.columns and not self.produced_annotations:
            object.__setattr__(self, "produced_annotations", self.columns)
        elif self.produced_annotations and not self.columns:
            object.__setattr__(self, "columns", self.produced_annotations)

    def to_dict(self) -> dict[str, object]:
        value = asdict(self)
        value["dependencies"] = list(self.dependencies)
        value["columns"] = list(self.columns)
        value["display_name"] = self.title
        value["version"] = self.stage_version
        value["required_annotations"] = list(self.required_annotations)
        value["produced_annotations"] = list(self.produced_annotations)
        value["produced_artifacts"] = list(self.produced_artifacts)
        value["optional_artifacts"] = list(self.optional_artifacts)
        value["consumed_artifacts"] = [
            {"producer": producer, "key": key} for producer, key in self.consumed_artifacts
        ]
        value["technical_requirements"] = list(self.technical_requirements)
        value["cache_parameters"] = list(self.cache_parameters)
        value["resources"] = {
            "cpu": self.cpu or 1,
            "gpu": self.gpu or 0,
            "network": self.network,
            "memory_gb": self.memory_gb,
        }
        return value


STAGE_DEFINITIONS: tuple[StageDefinition, ...] = (
    StageDefinition(
        "protein_identity",
        "P01",
        "Identidad de proteína",
        (),
        required_annotations=(),
        columns=("gene",),
        produced_artifacts=(
            "canonical_fasta",
            "protein_identity",
            "transcripts",
            "query_fasta",
            "reference_mane_fasta",
            "mane_reference",
            "sifts_mapping",
            "sequence_comparison",
            "sequence_assessment",
            "engineered_mutations",
            "detected_variants",
            "unresolved_differences",
        ),
        description="Build the canonical sequence and identity evidence scaffold.",
    ),
    StageDefinition(
        "clinvar",
        "P21",
        "Evidencia ClinVar (SNV germinal, GRCh38)",
        ("protein_identity",),
        optional=True,
        cpu=2,
        required_annotations=("gene",),
        columns=(
            "clinvar_n_variants",
            "clinvar_n_pathogenic_or_likely",
            "clinvar_n_benign_or_likely",
            "clinvar_n_vus",
            "clinvar_n_conflicting",
            "clinvar_status",
        ),
        consumed_artifacts=(("protein_identity", "canonical_fasta"),),
        produced_artifacts=(
            "clinvar_variants",
            "clinvar_per_position",
            "clinvar_metadata",
            "genomic_mapping",
            "genomic_substitutions",
        ),
        technical_requirements=("clinvar_local_grch38_vcf", "genomic_mapping"),
        stage_version="clinvar-germline-snv-grch38-v1",
        description=(
            "Link exact GRCh38 missense SNVs to canonical residues while preserving "
            "ClinVar classifications without inferring residue-level pathogenicity."
        ),
    ),
    StageDefinition(
        "variant_predictors",
        "P16",
        "Predictores de variantes",
        ("protein_identity",),
        cpu=4,
        required_annotations=("gene",),
        columns=("alphamissense_mean", "alphamissense_max", "cadd_phred_mean", "revel_mean"),
        consumed_artifacts=(("protein_identity", "canonical_fasta"),),
        produced_artifacts=(
            "predictor_per_position",
            "predictor_substitutions",
            "transcript_mapping",
            "metadata",
        ),
        technical_requirements=("genomic_mapping",),
        description="Aggregate local missense predictor evidence on canonical positions.",
    ),
    StageDefinition(
        "pharmacogenomics",
        "P14",
        "Farmacogenómica",
        ("protein_identity",),
        required_annotations=("gene",),
        columns=("pgx_star_alleles", "pgx_allele_function", "pgx_gene_evidence_level"),
        consumed_artifacts=(("protein_identity", "canonical_fasta"),),
        produced_artifacts=(
            "pgx_per_position",
            "pgx_alleles",
            "metadata",
            "genomic_mapping",
            "genomic_substitutions",
        ),
        technical_requirements=("genomic_mapping",),
        description="Project pharmacogenomic allele and evidence records to canonical residues.",
    ),
    StageDefinition(
        "uniprot_features",
        "P02",
        "Anotaciones UniProt",
        ("protein_identity",),
        required_annotations=("gene",),
        columns=(
            "uniprot_domain",
            "uniprot_active_site",
            "uniprot_binding_site",
            "uniprot_ptm",
            "uniprot_disulfide_partner",
            "uniprot_topology",
            "in_metal_site",
            "interpro_entries",
            "interpro_status",
            "uniprot_mapping_status",
        ),
        consumed_artifacts=(("protein_identity", "canonical_fasta"),),
        produced_artifacts=("uniprot_coordinate_mapping", "functional_features_long"),
        technical_requirements=("external_cache",),
        description="Project cached UniProt and InterPro features to canonical positions.",
        network=True,
    ),
    StageDefinition(
        "conformational_ensemble",
        "P17",
        "Ensamble conformacional",
        ("protein_identity", "structure_modeling"),
        cpu=4,
        gpu=1,
        required_annotations=(),
        consumed_artifacts=(
            ("protein_identity", "canonical_fasta"),
            ("structure_modeling", "msa_cache_entry"),
        ),
        produced_artifacts=(
            "conformational_ensemble_final_dir",
            "metadata",
            "frames_index",
            "ensemble_aligned_ca",
            "ensemble_flat_ca",
            "topology",
            "ensemble_cache",
            "msa_manifest",
            "log",
        ),
        optional_artifacts=("samples_xtc",),
        technical_requirements=("msa_cache:af3-msa-v1",),
        description="Generate and filter a reference conformational ensemble.",
    ),
    StageDefinition(
        "sequence_frustration",
        "P18",
        "Frustración por secuencia",
        ("protein_identity",),
        cpu=2,
        gpu=1,
        required_annotations=(),
        columns=(
            "frustraiseq_index",
            "frustraiseq_class",
            "frustraiseq_entropy",
            "frustraiseq_surprisal",
        ),
        consumed_artifacts=(("protein_identity", "canonical_fasta"),),
        produced_artifacts=("frustraiseq_per_residue", "metadata"),
        description="Calculate sequence frustration without using a structure.",
    ),
    StageDefinition(
        "evolutionary_conservation",
        "P19",
        "Conservación evolutiva",
        ("uniprot_features",),
        required_annotations=("gene",),
        columns=("rate4site_score", "consurf_grade"),
        consumed_artifacts=(("uniprot_features", "uniprot_coordinate_mapping"),),
        produced_artifacts=("evolution_per_residue", "metadata"),
        technical_requirements=("homology_access_or_cache",),
        description="Estimate evolutionary conservation from approved homology evidence.",
        network=True,
    ),
    StageDefinition(
        "functional_region_evidence",
        "P15",
        "Evidencia de región funcional",
        ("uniprot_features",),
        required_annotations=("gene", "uniprot_mapping_status"),
        columns=("variant_in_statin_ldlc_region",),
        consumed_artifacts=(("uniprot_features", "uniprot_coordinate_mapping"),),
        produced_artifacts=("ldlc_statin_evidence", "summary"),
        description="Mark curated LDL-C/statin functional-region evidence.",
    ),
    StageDefinition(
        "experimental_variant_evidence",
        "P13",
        "Evidencia experimental",
        ("uniprot_features",),
        required_annotations=("gene",),
        columns=(
            "mavedb_position_assayed",
            "mavedb_n_score_sets",
            "mavedb_n_substitutions_tested",
        ),
        consumed_artifacts=(("uniprot_features", "uniprot_coordinate_mapping"),),
        produced_artifacts=("mavedb_details",),
        technical_requirements=("mavedb_access_or_cache",),
        description="Summarize experimental MaveDB evidence without interpreting pathogenicity.",
        network=True,
    ),
    StageDefinition(
        "membrane_topology",
        "P03",
        "Topología de membrana",
        ("uniprot_features",),
        cpu=4,
        gpu=1,
        required_annotations=("uniprot_topology",),
        columns=("tmbed_topology",),
        consumed_artifacts=(("uniprot_features", "uniprot_coordinate_mapping"),),
        produced_artifacts=(
            "raw_prediction",
            "tmbed_per_residue",
            "tm_segments",
            "span",
            "span_metadata",
        ),
        description="Predict membrane topology and materialize compatible span evidence.",
    ),
    StageDefinition(
        "ensemble_frustration",
        "P20",
        "Frustración del ensemble",
        ("conformational_ensemble",),
        cpu=4,
        required_annotations=(),
        columns=("frustratometer_mean",),
        consumed_artifacts=(("conformational_ensemble", "conformational_ensemble_final_dir"),),
        produced_artifacts=(
            "frustratometer_conformers",
            "frustratometer_per_residue",
            "metadata",
            "closure",
            "helper_log",
        ),
        description="Summarize frustration over the retained conformers.",
    ),
    StageDefinition(
        "structure_modeling",
        "P04",
        "Modelado estructural",
        ("membrane_topology",),
        cpu=8,
        gpu=1,
        required_annotations=("tmbed_topology",),
        columns=("structure_qc_status",),
        consumed_artifacts=(("membrane_topology", "span"),),
        produced_artifacts=(
            "model_cif",
            "msa_cache_entry",
            "af3_confidence_per_residue",
            "structure_qc_per_residue",
            "alphafold_dir",
        ),
        technical_requirements=("msa_cache:af3-msa-v1",),
        description="Build or reuse a structure and validate residue-level correspondence.",
    ),
    StageDefinition(
        "structural_regime",
        "P05",
        "Régimen estructural",
        ("structure_modeling",),
        required_annotations=("uniprot_topology", "tmbed_topology", "structure_qc_status"),
        columns=("structural_regime", "structural_regime_rule", "topology_agreement"),
        consumed_artifacts=(("structure_modeling", "structure_qc_per_residue"),),
        produced_artifacts=("structural_regime_detail",),
        description="Classify the structural regime from topology and structure QC.",
    ),
    StageDefinition(
        "protein_relaxation_energy",
        "P06",
        "Relajación y energía",
        ("structural_regime",),
        cpu=20,
        required_annotations=("structural_regime", "structural_regime_rule", "topology_agreement"),
        columns=(
            "rosetta_relaxation_status",
            "foldx_relaxation_status",
            "rosetta_energy_value",
            "foldx_energy_value",
        ),
        consumed_artifacts=(("structural_regime", "structural_regime_detail"),),
        produced_artifacts=(
            "structure_mapping",
            "selected_reference_pdb",
            "selected_reference_json",
            "provenance",
        ),
        technical_requirements=("slurm:SLURM_JOB_ID", "command:srun"),
        description="Prepare the selected reference and compute approved energy outputs.",
    ),
    StageDefinition(
        "physicochemical_context",
        "P10",
        "Contexto fisicoquímico",
        ("protein_relaxation_energy",),
        cpu=4,
        required_annotations=(),
        columns=("secondary_structure", "buried_status"),
        consumed_artifacts=(("protein_relaxation_energy", "selected_reference_pdb"),),
        produced_artifacts=(
            "dssp_per_residue",
            "sasa_per_residue",
            "physicochemical_context_detail",
        ),
        description="Derive secondary-structure and solvent-accessibility context.",
    ),
    StageDefinition(
        "variant_ddg",
        "P07",
        "ΔΔG de variante",
        ("protein_identity", "membrane_topology", "protein_relaxation_energy"),
        optional=True,
        cpu=4,
        columns=("ddg_variant_evaluated",),
        required_annotations=(),
        consumed_artifacts=(
            ("protein_identity", "canonical_fasta"),
            ("membrane_topology", "span"),
            ("protein_relaxation_energy", "selected_reference_pdb"),
        ),
        produced_artifacts=(
            "variant_annotations",
            "ddg_replicates",
            "provenance",
            "variant_dir",
            "rosetta_metadata",
            "variant_set",
        ),
        # The remote contract does not repeat the launcher capability, but the
        # registered Rosetta path runs inside an allocated Slurm step. Keep
        # the local execution gate explicit so a normal run cannot claim that
        # DDG is executable on a workstation without the worker capability.
        technical_requirements=("slurm:SLURM_JOB_ID", "command:srun"),
        description="Evaluate requested substitutions against the selected reference structure.",
    ),
    StageDefinition(
        "structural_frustration",
        "P08",
        "Frustración estructural",
        ("protein_relaxation_energy",),
        cpu=4,
        required_annotations=(),
        columns=(
            "structural_frustration_fi_singleresidue",
            "structural_frustration_fi_singleresidue_window5_mean",
            "structural_frustration_fi_singleresidue_window5_median",
            "structural_frustration_fi_configurational",
            "structural_frustration_fi_mutational",
            "structural_frustration_n_contacts_highly_configurational",
            "structural_frustration_n_contacts_neutrally_configurational",
            "structural_frustration_n_contacts_minimally_configurational",
            "structural_frustration_n_contacts_highly_mutational",
            "structural_frustration_n_contacts_neutrally_mutational",
            "structural_frustration_n_contacts_minimally_mutational",
            "structural_frustration_status",
        ),
        consumed_artifacts=(("protein_relaxation_energy", "selected_reference_pdb"),),
        produced_artifacts=(
            "frustration_per_residue",
            "structure_index",
            "provenance",
            "native_output_dir",
        ),
        description="Compute structural frustration and contact summaries for the WT reference.",
    ),
    StageDefinition(
        "structural_contacts",
        "P12",
        "Contactos estructurales",
        ("protein_relaxation_energy",),
        cpu=4,
        required_annotations=(),
        columns=(
            "structural_contacts_n_contacts",
            "structural_contacts_n_partner_residues",
            "structural_contacts_contact_types",
            "structural_contacts_status",
            "structural_contacts_qc_reason",
        ),
        consumed_artifacts=(("protein_relaxation_energy", "selected_reference_pdb"),),
        produced_artifacts=(
            "contact_residue_summary",
            "contacts_long",
            "structure_index",
            "provenance",
            "arpeggio_json",
            "arpeggio_log",
        ),
        technical_requirements=("slurm:SLURM_JOB_ID",),
        description="Summarize WT structural contacts without comparing WT and mutant structures.",
    ),
)

STAGE_BY_ID = {stage.id: stage for stage in STAGE_DEFINITIONS}


def validate_stage_registry() -> None:
    """Validate the local projection of the remote StageSpec contract."""

    if len(STAGE_DEFINITIONS) != 19:
        raise ValueError(
            "the product registry must contain 18 baseline stages plus optional ClinVar"
        )
    if len(STAGE_BY_ID) != len(STAGE_DEFINITIONS):
        raise ValueError("stage identifiers must be unique")
    for stage in STAGE_DEFINITIONS:
        if not stage.stage_version.strip():
            raise ValueError(f"stage {stage.id} has no version")
        if stage.cpu is not None and stage.cpu < 1:
            raise ValueError(f"stage {stage.id} has invalid CPU resources")
        if stage.gpu is not None and stage.gpu < 0:
            raise ValueError(f"stage {stage.id} has invalid GPU resources")
        if len(stage.required_annotations) != len(set(stage.required_annotations)):
            raise ValueError(f"stage {stage.id} repeats a required annotation")
        if any(not name.strip() for name in stage.required_annotations):
            raise ValueError(f"stage {stage.id} has an empty required annotation")
        if not stage.description.strip():
            raise ValueError(f"stage {stage.id} has no description")
        if not stage.cache_parameters:
            raise ValueError(f"stage {stage.id} has no cache factors")
        if len(stage.produced_annotations) != len(set(stage.produced_annotations)):
            raise ValueError(f"stage {stage.id} repeats a produced annotation")
        if len(stage.produced_artifacts) != len(set(stage.produced_artifacts)):
            raise ValueError(f"stage {stage.id} repeats a produced artifact")
        if len(stage.optional_artifacts) != len(set(stage.optional_artifacts)):
            raise ValueError(f"stage {stage.id} repeats an optional artifact")
        if set(stage.produced_artifacts).intersection(stage.optional_artifacts):
            raise ValueError(f"stage {stage.id} marks a required artifact as optional")
        if any(not name.strip() for name in stage.optional_artifacts):
            raise ValueError(f"stage {stage.id} has an empty optional artifact")
        missing = set(stage.dependencies).difference(STAGE_BY_ID)
        if missing:
            raise ValueError(f"stage {stage.id} references unknown dependencies: {sorted(missing)}")
        for producer, artifact_key in stage.consumed_artifacts:
            if (
                producer not in STAGE_BY_ID
                or producer not in stage.dependencies
                or not artifact_key.strip()
                or artifact_key not in STAGE_BY_ID[producer].produced_artifacts
            ):
                raise ValueError(f"stage {stage.id} has an invalid consumed artifact")
        if stage.requires_variant and not stage.optional:
            raise ValueError(f"variant-dependent stage {stage.id} must be optional")

    # Kahn's algorithm catches dependency cycles before a run can be created.
    remaining = {stage.id: set(stage.dependencies) for stage in STAGE_DEFINITIONS}
    while remaining:
        ready = {stage_id for stage_id, deps in remaining.items() if not deps}
        if not ready:
            raise ValueError("stage registry contains a dependency cycle")
        for stage_id in ready:
            remaining.pop(stage_id)
        for deps in remaining.values():
            deps.difference_update(ready)


validate_stage_registry()


def get_stage(stage_id: str) -> StageDefinition:
    try:
        return STAGE_BY_ID[stage_id]
    except KeyError as exc:
        raise ValueError(f"Unknown stage: {stage_id}") from exc
