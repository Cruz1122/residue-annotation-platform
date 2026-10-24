from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

# These are reader-facing names. The persisted artifact_type remains the
# stable machine contract, while the API exposes this vocabulary to people.
ARTIFACT_NAMES: dict[str, str] = {
    "annotations": "Anotaciones por residuo",
    "final_annotations": "Tabla final de anotaciones",
    "selected_variants": "Variantes seleccionadas",
    "canonical_fasta": "Secuencia canónica (FASTA)",
    "query_fasta": "Secuencia de consulta (FASTA)",
    "reference_mane_fasta": "Secuencia de referencia MANE (FASTA)",
    "protein_identity": "Identidad de la proteína",
    "transcripts": "Transcritos",
    "mane_reference": "Referencia MANE",
    "sifts_mapping": "Mapeo SIFTS",
    "sequence_comparison": "Comparación de secuencias",
    "sequence_assessment": "Evaluación de la secuencia",
    "engineered_mutations": "Mutaciones diseñadas",
    "detected_variants": "Variantes detectadas",
    "unresolved_differences": "Diferencias no resueltas",
    "clinvar_variants": "Variantes ClinVar",
    "clinvar_per_position": "ClinVar por posición",
    "clinvar_metadata": "Metadatos de ClinVar",
    "genomic_mapping": "Mapeo genómico",
    "genomic_substitutions": "Sustituciones genómicas",
    "predictor_per_position": "Predictores por posición",
    "predictor_substitutions": "Predictores por sustitución",
    "transcript_mapping": "Mapeo de transcritos",
    "pgx_per_position": "Farmacogenómica por posición",
    "pgx_alleles": "Alelos farmacogenómicos",
    "uniprot_coordinate_mapping": "Mapeo de coordenadas UniProt",
    "functional_features_long": "Regiones y sitios UniProt",
    "frustraiseq_per_residue": "Índice FrustrAI-Seq por residuo",
    "frustratometer_per_residue": "Frustración estructural por residuo",
    "frustratometer_conformers": "Distribución de frustración entre conformeros",
    "frustration_per_residue": "Frustración por residuo",
    "evolution_per_residue": "Conservación por residuo",
    "ldlc_statin_evidence": "Evidencia de región LDL-C y estatinas",
    "mavedb_details": "Evidencia experimental MaveDB",
    "raw_prediction": "Predicción bruta de topología",
    "tmbed_per_residue": "Clasificación topológica por residuo",
    "tm_segments": "Segmentos transmembrana",
    "span": "Segmentos de topología (SPAN)",
    "span_metadata": "Metadatos de topología",
    "model_cif": "Modelo estructural (mmCIF)",
    "af3_confidence_per_residue": "Confianza AlphaFold 3 por residuo",
    "structure_qc_per_residue": "Control de calidad estructural por residuo",
    "alphafold_dir": "Resultados AlphaFold 3",
    "structural_regime_detail": "Detalle del régimen estructural",
    "structure_mapping": "Mapeo de estructura",
    "selected_reference_pdb": "Estructura de referencia seleccionada (PDB)",
    "selected_reference_json": "Referencia estructural seleccionada (JSON)",
    "rosettamp_relaxed_pdb": "Estructura relajada con RosettaMP (PDB)",
    "foldx_relaxed_pdb": "Estructura relajada con FoldX (PDB)",
    "provenance": "Procedencia del resultado",
    "rosetta_metadata": "Metadatos de Rosetta",
    "variant_annotations": "Resultados de ΔΔG por variante",
    "ddg_replicates": "Réplicas de ΔΔG",
    "variant_dir": "Resultados completos de variantes",
    "variant_set": "Conjunto de variantes (JSON)",
    "dssp_per_residue": "Estructura secundaria por residuo",
    "sasa_per_residue": "Área accesible al solvente por residuo",
    "physicochemical_context_detail": "Contexto fisicoquímico por residuo",
    "conformational_ensemble_final_dir": "Ensemble conformacional completo",
    "ensemble_aligned_ca": "Coordenadas Cα alineadas del ensemble",
    "ensemble_flat_ca": "Coordenadas Cα del ensemble",
    "frames_index": "Índice de frames del ensemble",
    "topology": "Topología estructural",
    "ensemble_cache": "Caché del ensemble",
    "msa_manifest": "Manifiesto de alineamiento múltiple",
    "log": "Registro del análisis",
    "metadata": "Metadatos científicos",
    "closure": "Cierre del análisis",
    "helper_log": "Registro auxiliar del análisis",
    "contact_residue_summary": "Resumen de contactos por residuo",
    "contacts_long": "Contactos estructurales detallados",
    "structure_index": "Índice de estructura",
    "arpeggio_json": "Contactos Arpeggio (JSON)",
    "arpeggio_log": "Registro de Arpeggio",
}

HEADER_NAMES: dict[str, str] = {
    "protein_id": "Proteína",
    "aa_position": "Posición del residuo",
    "canonical_position": "Posición canónica",
    "residue_position": "Posición del residuo",
    "aa_ref": "Aminoácido de referencia",
    "aa_alt": "Aminoácido alternativo",
    "variant_id": "Variante",
    "variant": "Variante",
    "gene": "Gen",
    "uniprot_accession": "Acceso UniProt",
    "uniprot_id": "Identificador UniProt",
    "ddg_value": "ΔΔG",
    "ddg_unit": "Unidad de ΔΔG",
    "ddg_sd": "Desviación estándar de ΔΔG",
    "ddg_n_replicates": "Réplicas de ΔΔG",
    "ddg_variant_evaluated": "Variante evaluada",
    "uniprot_domain": "Dominio UniProt",
    "uniprot_active_site": "Sitio activo UniProt",
    "uniprot_binding_site": "Sitio de unión UniProt",
    "uniprot_ptm": "Modificación postraduccional",
    "uniprot_disulfide_partner": "Pareja de puente disulfuro",
    "uniprot_topology": "Topología UniProt",
    "uniprot_mapping_status": "Estado del mapeo UniProt",
    "tmbed_topology": "Topología de membrana",
    "structural_regime": "Régimen estructural",
    "structural_regime_rule": "Regla del régimen estructural",
    "topology_agreement": "Concordancia topológica",
    "structure_qc_status": "Estado del control de calidad estructural",
    "rate4site_score": "Puntuación Rate4Site",
    "consurf_grade": "Grado ConSurf",
    "frustraiseq_index": "Índice FrustrAI-Seq",
    "frustraiseq_class": "Clase FrustrAI-Seq",
    "frustraiseq_entropy": "Entropía FrustrAI-Seq",
    "frustraiseq_surprisal": "Sorpresa FrustrAI-Seq",
    "structural_frustration_fi_singleresidue": "Frustración estructural por residuo",
    "structural_frustration_fi_singleresidue_window5_mean": (
        "Media móvil de frustración (ventana 5)"
    ),
    "structural_frustration_fi_singleresidue_window5_median": (
        "Mediana móvil de frustración (ventana 5)"
    ),
    "structural_frustration_fi_configurational": "Frustración configuracional",
    "structural_frustration_fi_mutational": "Frustración mutacional",
    "structural_contacts_n_contacts": "Número de contactos",
    "structural_contacts_n_partner_residues": "Residuos asociados",
    "structural_contacts_contact_types": "Tipos de contacto",
    "secondary_structure": "Estructura secundaria",
    "buried_status": "Enterramiento",
    "sasa": "Área accesible al solvente",
    "model": "Modelo",
    "source": "Fuente",
    "status": "Estado",
    "description": "Descripción",
    "message": "Mensaje",
    "variant_index": "Índice de variante",
    "protein_reference_id": "ID de proteína de referencia",
    "hgvs_p": "Cambio proteico HGVS",
    "hgvs_pro": "Cambio proteico HGVS",
    "reference_position": "Posición de referencia",
    "reference_aa": "Aminoácido de referencia",
    "query_position": "Posición de consulta",
    "query_aa": "Aminoácido de consulta",
    "variant_type": "Tipo de variante",
    "classification": "Clasificación",
    "classification_group": "Grupo de clasificación",
    "classification_reason": "Motivo de clasificación",
    "sifts_uniprot_position": "Posición UniProt según SIFTS",
    "evidence": "Evidencia",
    "evidence_sources": "Fuentes de evidencia",
    "resolution_source": "Fuente de resolución",
    "mane_release": "Versión MANE",
    "mane_status": "Estado MANE",
    "hgnc_id": "ID HGNC",
    "symbol": "Símbolo génico",
    "ncbi_gene_id": "ID de gen NCBI",
    "ensembl_gene_id": "ID de gen Ensembl",
    "ensembl_transcript_id": "ID de transcrito Ensembl",
    "ensembl_protein_id": "ID de proteína Ensembl",
    "refseq_transcript_id": "ID de transcrito RefSeq",
    "refseq_protein_id": "ID de proteína RefSeq",
    "sequence_length": "Longitud de la secuencia",
    "sequence_sha256": "SHA-256 de la secuencia",
    "uniprot_sequence_sha256": "SHA-256 de la secuencia UniProt",
    "uniprot_sequence_identical": "Secuencia idéntica a UniProt",
    "summary_path": "Ruta del resumen",
    "protein_fasta_path": "Ruta de la secuencia FASTA",
    "protein_header": "Cabecera FASTA",
    "input_sequence_status": "Estado de la secuencia de entrada",
    "query_source": "Fuente de la secuencia de consulta",
    "query_length": "Longitud de la secuencia de consulta",
    "reference_length": "Longitud de la secuencia de referencia",
    "alignment_mode": "Modo de alineamiento",
    "alignment_matrix": "Matriz de alineamiento",
    "alignment_score": "Puntuación de alineamiento",
    "aligned_pairs": "Pares alineados",
    "exact_matches": "Coincidencias exactas",
    "substitutions": "Sustituciones",
    "insertions_in_query": "Inserciones en la consulta",
    "missing_in_query": "Ausencias en la consulta",
    "identity": "Identidad de secuencia",
    "query_coverage": "Cobertura de la consulta",
    "reference_coverage": "Cobertura de la referencia",
    "n_detected_variants": "Variantes detectadas",
    "n_engineered_differences": "Diferencias diseñadas",
    "n_unresolved_differences": "Diferencias no resueltas",
    "n_unmapped_engineered_records": "Registros diseñados sin mapeo",
    "alignment_index": "Índice de alineamiento",
    "relation": "Relación",
    "pdb_id": "ID PDB",
    "pdb_chain": "Cadena PDB",
    "pdb_resnum": "Número de residuo PDB",
    "pdb_resname": "Nombre de residuo PDB",
    "pdbe_residue_number": "Número de residuo PDBe",
    "pdbe_resname": "Nombre de residuo PDBe",
    "uniprot_resname": "Nombre de residuo UniProt",
    "observed": "Observado",
    "sifts_annotations": "Anotaciones SIFTS",
    "engineered_evidence": "Evidencia de diseño",
    "alphamissense_mean": "Media AlphaMissense",
    "alphamissense_max": "Máximo AlphaMissense",
    "alphamissense_n": "Número de datos AlphaMissense",
    "alphamissense": "Puntuación AlphaMissense",
    "alphamissense_pred": "Predicción AlphaMissense",
    "cadd_phred_mean": "Media CADD PHRED",
    "cadd_phred": "CADD PHRED",
    "cadd_n": "Número de datos CADD",
    "revel_mean": "Media REVEL",
    "revel_n": "Número de datos REVEL",
    "revel": "Puntuación REVEL",
    "revel_source": "Fuente REVEL",
    "revel_from_other_transcript_n": "Datos REVEL de otros transcritos",
    "chrom": "Cromosoma",
    "pos": "Posición genómica",
    "ref": "Alelo de referencia",
    "alt": "Alelo alternativo",
    "refcodon": "Codón de referencia",
    "ref_codon": "Codón de referencia",
    "codonpos": "Posición en el codón",
    "transcript_id": "ID de transcrito",
    "strand": "Hebra",
    "genomic_pos_1": "Posición genómica 1",
    "genomic_pos_2": "Posición genómica 2",
    "genomic_pos_3": "Posición genómica 3",
    "mapping_status": "Estado del mapeo",
    "pgx_star_alleles": "Alelos farmacogenómicos (PGx)",
    "pgx_allele_function": "Función del alelo farmacogenómico",
    "pgx_gene_evidence_level": "Nivel de evidencia farmacogenómica",
    "pgx_aa_changes": "Cambios de aminoácido farmacogenómicos",
    "star_allele": "Alelo estrella",
    "function": "Función",
    "function_source": "Fuente de la función",
    "rsid": "ID dbSNP (rs)",
    "pharmvar_impact": "Impacto PharmVar",
    "pharmvar_agrees": "Concordancia PharmVar",
    "source_accession": "Acceso de la fuente",
    "feature_accession": "Acceso de la característica",
    "feature_type": "Tipo de característica",
    "feature_name": "Nombre de la característica",
    "source_database": "Base de datos de origen",
    "source_start": "Inicio en la fuente",
    "source_end": "Fin en la fuente",
    "interpro_entries": "Entradas InterPro",
    "interpro_status": "Estado InterPro",
    "in_metal_site": "En sitio de unión a metal",
    "clinvar_n_variants": "Variantes ClinVar",
    "clinvar_n_pathogenic_or_likely": "ClinVar patogénicas o probablemente patogénicas",
    "clinvar_n_benign_or_likely": "ClinVar benignas o probablemente benignas",
    "clinvar_n_vus": "ClinVar de significado incierto",
    "clinvar_n_conflicting": "ClinVar con interpretación discordante",
    "clinvar_status": "Estado ClinVar",
    "clnsig": "Significado clínico",
    "clnrevstat": "Estado de revisión clínica",
    "clnsigconf": "Confianza del significado clínico",
    "condition": "Condición clínica",
    "disease_ids": "IDs de enfermedades",
    "variation_id": "ID de variación",
    "allele_id": "ID de alelo",
    "assembly": "Ensamblaje genómico",
    "mavedb_position_assayed": "Posición ensayada en MaveDB",
    "mavedb_n_score_sets": "Conjuntos de puntuaciones MaveDB",
    "mavedb_n_substitutions_tested": "Sustituciones ensayadas en MaveDB",
    "score_set_urn": "URN del conjunto de puntuaciones",
    "score_set_title": "Título del conjunto de puntuaciones",
    "doi": "DOI",
    "score": "Puntuación",
    "rate4site_score_raw": "Puntuación Rate4Site sin transformar",
    "consurf_grade_raw": "Grado ConSurf sin transformar",
    "nongap": "Posiciones no gap",
    "ci_low": "Límite inferior del intervalo de confianza",
    "ci_high": "Límite superior del intervalo de confianza",
    "ci_grade_span": "Amplitud del grado de confianza",
    "reliable": "Resultado fiable",
    "na_reason": "Motivo de dato ausente",
    "tmbed_label": "Etiqueta TMbed",
    "p_tm_beta": "Probabilidad TM β",
    "p_tm_alpha": "Probabilidad TM α",
    "p_signal": "Probabilidad de péptido señal",
    "p_inside": "Probabilidad de región interior",
    "p_outside": "Probabilidad de región exterior",
    "segment_id": "ID del segmento",
    "segment_type": "Tipo de segmento",
    "start": "Inicio",
    "end": "Fin",
    "length": "Longitud",
    "af3_plddt": "pLDDT AlphaFold 3",
    "model_aa": "Aminoácido del modelo",
    "coordinates_present": "Coordenadas disponibles",
    "residue_match": "Coincidencia del residuo",
    "structure_role": "Rol de la estructura",
    "structure_sha256": "SHA-256 de la estructura",
    "source_pdb": "PDB de origen",
    "source_pdb_sha256": "SHA-256 del PDB de origen",
    "clean_pdb": "PDB depurado",
    "clean_pdb_sha256": "SHA-256 del PDB depurado",
    "clean_cif": "mmCIF depurado",
    "clean_cif_sha256": "SHA-256 del mmCIF depurado",
    "arpeggio_json": "JSON de Arpeggio",
    "arpeggio_json_sha256": "SHA-256 del JSON de Arpeggio",
    "arpeggio_cached": "Arpeggio reutilizado desde caché",
    "arpeggio_seconds": "Tiempo de Arpeggio (s)",
    "artifact_dir": "Directorio del artefacto",
    "seconds": "Tiempo (s)",
    "frustratometer_mean": "Media Frustratometer",
    "frustratometer_sd": "Desviación estándar Frustratometer",
    "frustratometer_n": "Número de conformeros Frustratometer",
    "frustratometer_aa_qc": "Control del aminoácido Frustratometer",
    "frustratometer_status": "Estado Frustratometer",
    "structural_frustration_n_contacts_highly_configurational": (
        "Contactos configuracionales altamente frustrados"
    ),
    "structural_frustration_n_contacts_neutrally_configurational": (
        "Contactos configuracionales neutros"
    ),
    "structural_frustration_n_contacts_minimally_configurational": (
        "Contactos configuracionales mínimamente frustrados"
    ),
    "structural_frustration_n_contacts_highly_mutational": (
        "Contactos mutacionales altamente frustrados"
    ),
    "structural_frustration_n_contacts_neutrally_mutational": ("Contactos mutacionales neutros"),
    "structural_frustration_n_contacts_minimally_mutational": (
        "Contactos mutacionales mínimamente frustrados"
    ),
    "structural_frustration_reason": "Motivo de frustración estructural",
    "charge_class": "Clase de carga",
    "hydropathy_kd": "Hidropatía (Kyte–Doolittle)",
    "residue_volume_A3": "Volumen del residuo (Å³)",
    "sasa_A2": "SASA (Å²)",
    "max_asa_A2": "SASA máxima (Å²)",
    "rsasa": "SASA relativa",
    "dssp_code": "Código DSSP",
    "dssp_status": "Estado DSSP",
    "sasa_status": "Estado SASA",
    "pdb_identity_qc": "Control de identidad PDB",
    "pdb_resseq": "Número de residuo PDB",
    "pdb_icode": "Código de inserción PDB",
    "chain": "Cadena",
    "resseq": "Número de residuo",
    "icode": "Código de inserción",
    "pose_index": "Índice de pose",
    "rule": "Regla",
    "regime": "Régimen estructural",
    "rosetta_relaxation_status": "Estado de relajación Rosetta",
    "foldx_relaxation_status": "Estado de relajación FoldX",
    "rosetta_energy_value": "Energía Rosetta",
    "foldx_energy_value": "Energía FoldX",
    "ddg_engine": "Motor de ΔΔG",
    "ddg_status": "Estado de ΔΔG",
    "ddg_qc_reason": "Motivo de control de calidad de ΔΔG",
    "ddg_rosetta_reu_mean": "Media de energía Rosetta (REU)",
    "ddg_rosetta_reu_sd": "Desviación estándar de energía Rosetta (REU)",
    "variant_classification": "Clasificación de la variante",
    "variant_source": "Fuente de la variante",
    "replicate": "Réplica",
    "table_row": "Fila de la tabla",
    "round": "Ronda",
    "xtc_frame": "Frame XTC",
    "conformation": "Conformación",
}

XLSX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

SAFE_STORAGE_SUFFIXES = frozenset(
    {
        ".bin",
        ".cif",
        ".csv",
        ".faa",
        ".fasta",
        ".fa",
        ".gz",
        ".json",
        ".log",
        ".mmcif",
        ".pdb",
        ".tar",
        ".tsv",
        ".txt",
        ".xml",
        ".xlsx",
        ".yaml",
        ".yml",
        ".zip",
    }
)


@dataclass(frozen=True, slots=True)
class ArtifactPresentation:
    display_name: str
    format_label: str
    download_format: str
    download_filename: str


def _fallback_name(value: str) -> str:
    words = re.sub(r"[_-]+", " ", value).strip().split()
    return " ".join(word[:1].upper() + word[1:] for word in words) or "Archivo científico"


def artifact_display_name(artifact_type: str) -> str:
    value = str(artifact_type or "").strip()
    return ARTIFACT_NAMES.get(value, _fallback_name(value))


def header_display_name(header: str) -> str:
    value = str(header or "").strip()
    variant_ddg_match = re.fullmatch(r"variant_ddg_([A-Za-z0-9]+)(?:_(sd|replicates|unit))?", value)
    if variant_ddg_match:
        variant, suffix = variant_ddg_match.groups()
        suffix_name = {
            None: "",
            "sd": " · desviación estándar",
            "replicates": " · réplicas",
            "unit": " · unidad",
        }[suffix]
        return f"ΔΔG {variant}{suffix_name}"
    return HEADER_NAMES.get(value, _fallback_name(value))


def _safe_filename(value: str) -> str:
    normalized = (
        value.lower().replace("δ", "d").replace("Δ", "d").replace("α", "a").replace("β", "b")
    )
    normalized = normalized.encode("ascii", "ignore").decode("ascii")
    normalized = re.sub(r"[^a-z0-9]+", "-", normalized).strip("-")
    return normalized or "archivo-cientifico"


def _original_suffix(storage_key: str, media_type: str) -> str:
    media = str(media_type or "").lower()
    media_suffix = {
        "application/json": ".json",
        "text/plain": ".txt",
        "text/tab-separated-values": ".tsv",
        "text/csv": ".csv",
        "chemical/x-pdb": ".pdb",
        "chemical/x-cif": ".cif",
        "application/gzip": ".gz",
        "application/x-tar": ".tar",
        "application/zip": ".zip",
    }.get(media)
    if media_suffix:
        return media_suffix
    storage_suffix = Path(str(storage_key)).suffix.lower()
    if storage_suffix in SAFE_STORAGE_SUFFIXES and re.fullmatch(
        r"\.[a-z0-9]{1,12}", storage_suffix
    ):
        return storage_suffix
    return ".bin"


def safe_download_media_type(media_type: str) -> str:
    """Return a safe MIME type for an attachment response.

    Artifact media types are persisted metadata, but an invalid value must not
    become a response-header injection vector or make a scientific download
    render as active browser content.
    """

    normalized = str(media_type or "").split(";", 1)[0].strip().lower()
    if re.fullmatch(r"[a-z0-9!#$&^_.+-]+/[a-z0-9!#$&^_.+-]+", normalized):
        return normalized
    return "application/octet-stream"


def artifact_presentation(
    artifact_type: str, media_type: str, storage_key: str
) -> ArtifactPresentation:
    display_name = artifact_display_name(artifact_type)
    is_tabular = str(media_type or "").lower() in {"text/tab-separated-values", "text/csv"}
    if is_tabular:
        return ArtifactPresentation(
            display_name=display_name,
            format_label="Excel (.xlsx)",
            download_format="xlsx",
            download_filename=f"{_safe_filename(display_name)}.xlsx",
        )
    format_label = {
        "application/json": "JSON",
        "chemical/x-pdb": "PDB",
        "chemical/x-cif": "mmCIF",
        "text/plain": "Texto",
        "application/octet-stream": "Binario científico",
        "application/gzip": "GZIP",
        "application/x-tar": "TAR",
        "application/zip": "ZIP",
    }.get(str(media_type or "").lower(), "Archivo científico")
    return ArtifactPresentation(
        display_name=display_name,
        format_label=format_label,
        download_format="original",
        download_filename=(
            f"{_safe_filename(display_name)}{_original_suffix(storage_key, media_type)}"
        ),
    )


def artifact_read_fields(artifact: object) -> dict[str, object]:
    presentation = artifact_presentation(
        str(getattr(artifact, "artifact_type", "")),
        str(getattr(artifact, "media_type", "")),
        str(getattr(artifact, "storage_key", "")),
    )
    return {
        "id": artifact.id,
        "artifact_type": artifact.artifact_type,
        "media_type": artifact.media_type,
        "size": artifact.size,
        "sha256": artifact.sha256,
        "download_url": f"/api/v1/artifacts/{artifact.id}/content",
        "display_name": presentation.display_name,
        "format_label": presentation.format_label,
        "download_format": presentation.download_format,
        "download_filename": presentation.download_filename,
    }
