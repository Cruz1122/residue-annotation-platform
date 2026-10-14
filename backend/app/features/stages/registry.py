from dataclasses import asdict, dataclass


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

    def to_dict(self) -> dict[str, object]:
        value = asdict(self)
        value["dependencies"] = list(self.dependencies)
        value["columns"] = list(self.columns)
        return value


STAGE_DEFINITIONS: tuple[StageDefinition, ...] = (
    StageDefinition("protein_identity", "P01", "Identidad de proteína", (), columns=("gene",)),
    StageDefinition(
        "variant_predictors",
        "P16",
        "Predictores de variantes",
        ("protein_identity",),
        cpu=4,
        columns=("alphamissense", "cadd_phred_mean", "revel_mean"),
    ),
    StageDefinition(
        "pharmacogenomics",
        "P14",
        "Farmacogenómica",
        ("protein_identity",),
        columns=("pgx",),
    ),
    StageDefinition(
        "uniprot_features",
        "P02",
        "Anotaciones UniProt",
        ("protein_identity",),
        columns=("uniprot", "interpro"),
    ),
    StageDefinition(
        "conformational_ensemble",
        "P17",
        "Ensamble conformacional",
        ("protein_identity",),
        cpu=4,
        gpu=1,
    ),
    StageDefinition(
        "sequence_frustration",
        "P18",
        "Frustración por secuencia",
        ("protein_identity",),
        cpu=2,
        gpu=1,
        columns=("frustraiseq",),
    ),
    StageDefinition(
        "evolutionary_conservation",
        "P19",
        "Conservación evolutiva",
        ("uniprot_features",),
        columns=("rate4site_score", "consurf_grade"),
    ),
    StageDefinition(
        "functional_region_evidence",
        "P15",
        "Evidencia de región funcional",
        ("uniprot_features",),
        columns=("variant_in_statin_ldlc_region",),
    ),
    StageDefinition(
        "experimental_variant_evidence",
        "P13",
        "Evidencia experimental",
        ("uniprot_features",),
        columns=("mavedb",),
    ),
    StageDefinition(
        "membrane_topology",
        "P03",
        "Topología de membrana",
        ("uniprot_features",),
        cpu=4,
        gpu=1,
        columns=("tmbed_topology",),
    ),
    StageDefinition(
        "ensemble_frustration",
        "P20",
        "Frustración del ensemble",
        ("conformational_ensemble",),
        cpu=4,
        columns=("frustratometer_mean",),
    ),
    StageDefinition(
        "structure_modeling",
        "P04",
        "Modelado estructural",
        ("membrane_topology",),
        cpu=8,
        gpu=1,
        columns=("structure_qc_status",),
    ),
    StageDefinition(
        "structural_regime",
        "P05",
        "Régimen estructural",
        ("structure_modeling",),
        columns=("structural_regime", "structural_regime_rule", "topology_agreement"),
    ),
    StageDefinition(
        "protein_relaxation_energy",
        "P06",
        "Relajación y energía",
        ("structural_regime",),
        cpu=16,
        columns=("residue_energy_value", "energy_tool", "energy_status"),
    ),
    StageDefinition(
        "physicochemical_context",
        "P10",
        "Contexto fisicoquímico",
        ("protein_relaxation_energy",),
        cpu=4,
        columns=("secondary_structure", "buried_status"),
    ),
    StageDefinition(
        "variant_ddg",
        "P07",
        "ΔΔG de variante",
        ("protein_relaxation_energy",),
        optional=True,
        cpu=4,
        columns=("ddg_variant_evaluated",),
    ),
    StageDefinition(
        "structural_frustration",
        "P08",
        "Frustración estructural",
        ("protein_relaxation_energy",),
        cpu=4,
        columns=("structural_frustration",),
    ),
    StageDefinition(
        "structural_contacts",
        "P12",
        "Contactos estructurales",
        ("protein_relaxation_energy",),
        cpu=4,
        columns=("structural_contacts",),
    ),
)

STAGE_BY_ID = {stage.id: stage for stage in STAGE_DEFINITIONS}


def get_stage(stage_id: str) -> StageDefinition:
    try:
        return STAGE_BY_ID[stage_id]
    except KeyError as exc:
        raise ValueError(f"Unknown stage: {stage_id}") from exc
