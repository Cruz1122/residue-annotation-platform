const FALLBACK_NAMES = {
  annotations: 'Anotaciones por residuo',
  final_annotations: 'Tabla final de anotaciones',
  selected_variants: 'Variantes seleccionadas',
  canonical_fasta: 'Secuencia canónica (FASTA)',
  query_fasta: 'Secuencia de consulta (FASTA)',
  reference_mane_fasta: 'Secuencia de referencia MANE (FASTA)',
  protein_identity: 'Identidad de la proteína',
  transcripts: 'Transcritos',
  mane_reference: 'Referencia MANE',
  sifts_mapping: 'Mapeo SIFTS',
  sequence_comparison: 'Comparación de secuencias',
  sequence_assessment: 'Evaluación de la secuencia',
  engineered_mutations: 'Mutaciones diseñadas',
  detected_variants: 'Variantes detectadas',
  unresolved_differences: 'Diferencias no resueltas',
  clinvar_variants: 'Variantes ClinVar',
  clinvar_per_position: 'ClinVar por posición',
  clinvar_metadata: 'Metadatos de ClinVar',
  genomic_mapping: 'Mapeo genómico',
  genomic_substitutions: 'Sustituciones genómicas',
  predictor_per_position: 'Predictores por posición',
  predictor_substitutions: 'Predictores por sustitución',
  transcript_mapping: 'Mapeo de transcritos',
  pgx_per_position: 'Farmacogenómica por posición',
  pgx_alleles: 'Alelos farmacogenómicos',
  uniprot_coordinate_mapping: 'Mapeo de coordenadas UniProt',
  functional_features_long: 'Regiones y sitios UniProt',
  frustraiseq_per_residue: 'Índice FrustrAI-Seq por residuo',
  frustratometer_per_residue: 'Frustración estructural por residuo',
  frustratometer_conformers: 'Distribución de frustración entre conformeros',
  frustration_per_residue: 'Frustración por residuo',
  evolution_per_residue: 'Conservación por residuo',
  ldlc_statin_evidence: 'Evidencia de región LDL-C y estatinas',
  mavedb_details: 'Evidencia experimental MaveDB',
  raw_prediction: 'Predicción bruta de topología',
  tmbed_per_residue: 'Clasificación topológica por residuo',
  tm_segments: 'Segmentos transmembrana',
  span: 'Segmentos de topología (SPAN)',
  span_metadata: 'Metadatos de topología',
  model_cif: 'Modelo estructural (mmCIF)',
  af3_confidence_per_residue: 'Confianza AlphaFold 3 por residuo',
  structure_qc_per_residue: 'Control de calidad estructural por residuo',
  structural_regime_detail: 'Detalle del régimen estructural',
  structure_mapping: 'Mapeo de estructura',
  selected_reference_pdb: 'Estructura de referencia seleccionada (PDB)',
  selected_reference_json: 'Referencia estructural seleccionada (JSON)',
  rosettamp_relaxed_pdb: 'Estructura relajada con RosettaMP (PDB)',
  foldx_relaxed_pdb: 'Estructura relajada con FoldX (PDB)',
  provenance: 'Procedencia del resultado',
  rosetta_metadata: 'Metadatos de Rosetta',
  variant_annotations: 'Resultados de ΔΔG por variante',
  ddg_replicates: 'Réplicas de ΔΔG',
  variant_dir: 'Resultados completos de variantes',
  variant_set: 'Conjunto de variantes (JSON)',
  dssp_per_residue: 'Estructura secundaria por residuo',
  sasa_per_residue: 'Área accesible al solvente por residuo',
  physicochemical_context_detail: 'Contexto fisicoquímico por residuo',
  conformational_ensemble_final_dir: 'Ensemble conformacional completo',
  ensemble_aligned_ca: 'Coordenadas Cα alineadas del ensemble',
  ensemble_flat_ca: 'Coordenadas Cα del ensemble',
  frames_index: 'Índice de frames del ensemble',
  topology: 'Topología estructural',
  ensemble_cache: 'Caché del ensemble',
  msa_manifest: 'Manifiesto de alineamiento múltiple',
  log: 'Registro del análisis',
  metadata: 'Metadatos científicos',
  closure: 'Cierre del análisis',
  helper_log: 'Registro auxiliar del análisis',
  contact_residue_summary: 'Resumen de contactos por residuo',
  contacts_long: 'Contactos estructurales detallados',
  structure_index: 'Índice de estructura',
  arpeggio_json: 'Contactos Arpeggio (JSON)',
  arpeggio_log: 'Registro de Arpeggio',
};

const SAFE_DOWNLOAD_EXTENSIONS = new Set([
  '.bin', '.cif', '.csv', '.fa', '.faa', '.fasta', '.gz', '.json', '.log',
  '.mmcif', '.pdb', '.tar', '.tsv', '.txt', '.xml', '.xlsx', '.yaml', '.yml', '.zip',
]);

function fallbackName(value) {
  return String(value ?? '')
    .trim()
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    || 'Archivo científico';
}

function safeDisplayLabel(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\\/]+/g, ' · ')
    .replace(/^\.+/, '')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160)
    || 'Archivo científico';
}

export function artifactDisplayName(artifact) {
  if (artifact?.display_name) return safeDisplayLabel(artifact.display_name);
  const type = String(artifact?.artifact_type ?? '').trim();
  return safeDisplayLabel(FALLBACK_NAMES[type] ?? fallbackName(type));
}

export function artifactFormatLabel(artifact) {
  if (artifact?.format_label) return artifact.format_label;
  if (artifact?.download_format === 'xlsx') return 'Excel (.xlsx)';
  const mediaType = String(artifact?.media_type ?? '').toLowerCase();
  if (mediaType.includes('json')) return 'JSON';
  if (mediaType.includes('pdb')) return 'PDB';
  if (mediaType.includes('cif')) return 'mmCIF';
  if (mediaType.includes('plain')) return 'Texto';
  if (mediaType.includes('gzip')) return 'GZIP';
  if (mediaType.includes('tar')) return 'TAR';
  if (mediaType.includes('zip')) return 'ZIP';
  if (mediaType.includes('tab-separated') || mediaType.includes('csv')) return 'Excel (.xlsx)';
  return 'Archivo científico';
}

export function artifactDownloadFormat(artifact) {
  if (artifact?.download_format === 'original' || artifact?.download_format === 'xlsx') {
    return artifact.download_format;
  }
  const mediaType = String(artifact?.media_type ?? '').toLowerCase();
  return mediaType.includes('tab-separated') || mediaType.includes('csv') ? 'xlsx' : 'original';
}

function filenameBasename(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .split(/[\\/]/)
    .pop()
    ?.trim() ?? '';
}

function safeDownloadStem(value) {
  return filenameBasename(value)
    .replace(/\.[a-z0-9]{1,12}$/i, '')
    .toLowerCase()
    .replace(/δ/g, 'd')
    .replace(/Δ/g, 'd')
    .replace(/α/g, 'a')
    .replace(/β/g, 'b')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'archivo-cientifico';
}

function mediaTypeExtension(mediaType) {
  const normalized = String(mediaType ?? '').toLowerCase();
  return normalized.includes('json') ? '.json'
    : normalized.includes('pdb') ? '.pdb'
      : normalized.includes('mmcif') ? '.mmcif'
        : normalized.includes('cif') ? '.cif'
          : normalized.includes('tab-separated') ? '.tsv'
            : normalized.includes('csv') ? '.csv'
                  : normalized.includes('plain') ? '.txt'
                    : normalized.includes('gzip') ? '.gz'
                      : normalized.includes('tar') ? '.tar'
                        : normalized.includes('zip') ? '.zip'
                        : null;
}

export function sanitizeArtifactFilename(value, artifact = {}) {
  const source = filenameBasename(value) || artifactDisplayName(artifact);
  const sourceExtension = source.match(/\.[a-z0-9]{1,12}$/i)?.[0]?.toLowerCase() ?? '';
  const format = artifactDownloadFormat(artifact);
  const extension = format === 'xlsx'
    ? '.xlsx'
    : mediaTypeExtension(artifact?.media_type) ?? (SAFE_DOWNLOAD_EXTENSIONS.has(sourceExtension) ? sourceExtension : '.bin');
  return `${safeDownloadStem(source)}${extension}`;
}

export function artifactDownloadFilename(artifact) {
  return sanitizeArtifactFilename(artifact?.download_filename, artifact);
}
