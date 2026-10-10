/**
 * Single source of truth for the demo pipeline UI.
 * Coordinates use the logical 2360 × 900 canvas used by PipelineProgress.
 */
export const PIPELINE_SIZE = { width: 2360, height: 900 };

/**
 * @typedef {Object} PipelineStage
 * @property {string} id
 * @property {string} legacy
 * @property {string} title
 * @property {string} icon
 * @property {number} x
 * @property {number} y
 * @property {string} estimate
 * @property {string[]} deps
 * @property {boolean} [optional]
 * @property {string} [note]
 * @property {[string, string, string][]} annotations
 * @property {string[]} artifacts
 */

/** @type {PipelineStage[]} */
export const PIPELINE_STAGES = [
  {
    id: 'protein_identity', legacy: 'P01', title: 'Identidad de proteína', icon: 'tag', x: 160, y: 450,
    estimate: 'Puede tardar algunos segundos', deps: [],
    annotations: [['Gen', 'gene', 'LDLR'], ['Accession canónica', 'protein_id', 'P01130'], ['Longitud canónica', 'aa_position / aa_ref', '860 aa']],
    artifacts: ['P01130_canonical.fasta', 'protein_identity.json', 'transcripts.tsv'],
  },
  {
    id: 'variant_predictors', legacy: 'P16', title: 'Predictores de variantes', icon: 'chart-column', x: 500, y: 100,
    estimate: 'Puede tardar un par de minutos', deps: ['protein_identity'],
    annotations: [['AlphaMissense medio', 'alphamissense_mean', '0.624'], ['AlphaMissense máximo', 'alphamissense_max', '0.981'], ['CADD PHRED medio', 'cadd_phred_mean', '23.7'], ['REVEL medio', 'revel_mean', '0.72']],
    artifacts: ['predictor_per_position.tsv', 'predictor_substitutions.tsv', 'transcript_mapping.tsv', 'metadata.json'],
  },
  {
    id: 'pharmacogenomics', legacy: 'P14', title: 'Farmacogenómica', icon: 'flask-conical', x: 500, y: 275,
    estimate: 'Puede tardar algunos segundos', deps: ['protein_identity'],
    annotations: [['Alelos estrella', 'pgx_star_alleles', 'Sin alelo proyectado'], ['Función de alelo', 'pgx_allele_function', 'NA'], ['Evidencia del gen', 'pgx_gene_evidence_level', '1A']],
    artifacts: ['pgx_per_position.tsv', 'pgx_alleles.tsv', 'genomic_mapping.tsv', 'metadata.json'],
  },
  {
    id: 'uniprot_features', legacy: 'P02', title: 'Anotaciones UniProt', icon: 'shield-check', x: 500, y: 450,
    estimate: 'Puede tardar algunos segundos', deps: ['protein_identity'],
    annotations: [['Dominio principal', 'uniprot_domain', 'LDL-receptor class A'], ['Sitio de unión', 'uniprot_binding_site', 'Ca²⁺'], ['PTM', 'uniprot_ptm', 'N-glicosilación'], ['InterPro', 'interpro_entries', 'IPR002172'], ['Estado de mapeo', 'uniprot_mapping_status', 'Exacto']],
    artifacts: ['uniprot_coordinate_mapping.tsv', 'functional_features_long.tsv', 'uniprot_P01130.json'],
  },
  {
    id: 'conformational_ensemble', legacy: 'P17', title: 'Ensamble conformacional', icon: 'layers-3', x: 500, y: 625,
    estimate: 'Este paso normalmente demora horas', deps: ['protein_identity'],
    annotations: [], note: 'Esta etapa no publica columnas en annotations.tsv. El ensemble queda disponible como artefactos para análisis posteriores.',
    artifacts: ['frames_index.tsv', 'ensemble_aligned_ca.xtc', 'ensemble_flat_ca.xtc', 'topology.pdb', 'metadata.json'],
  },
  {
    id: 'sequence_frustration', legacy: 'P18', title: 'Frustración por secuencia', icon: 'activity', x: 500, y: 800,
    estimate: 'Puede tardar un par de minutos', deps: ['protein_identity'],
    annotations: [['Índice medio', 'frustraiseq_index', '−0.18'], ['Clase dominante', 'frustraiseq_class', 'Neutral'], ['Entropía media', 'frustraiseq_entropy', '0.41'], ['Surprisal medio', 'frustraiseq_surprisal', '0.67']],
    artifacts: ['frustraiseq_per_residue.tsv', 'metadata.json'],
  },
  {
    id: 'evolutionary_conservation', legacy: 'P19', title: 'Conservación evolutiva', icon: 'scan-search', x: 870, y: 100,
    estimate: 'Puede tardar varios minutos', deps: ['uniprot_features'],
    annotations: [['Rate4Site', 'rate4site_score', '−1.432'], ['Grado ConSurf', 'consurf_grade', '9 / 9'], ['Posiciones fiables', 'artefacto', '93.4%']],
    artifacts: ['evolution_per_residue.tsv', 'metadata.json'],
  },
  {
    id: 'functional_region_evidence', legacy: 'P15', title: 'Evidencia de región funcional', icon: 'route', x: 870, y: 275,
    estimate: 'Puede tardar algunos segundos', deps: ['uniprot_features'],
    annotations: [['Región LDL-C / estatinas', 'variant_in_statin_ldlc_region', 'False'], ['Mapeo canónico', 'resumen', 'Exacto']],
    artifacts: ['ldlc_statin_evidence.tsv', 'summary.json'],
  },
  {
    id: 'experimental_variant_evidence', legacy: 'P13', title: 'Evidencia experimental', icon: 'flask-conical', x: 870, y: 450,
    estimate: 'Puede tardar algunos segundos', deps: ['uniprot_features'],
    annotations: [['Posición ensayada', 'mavedb_position_assayed', 'Sí'], ['Conjuntos de scores', 'mavedb_n_score_sets', '2'], ['Sustituciones ensayadas', 'mavedb_n_substitutions_tested', '19']],
    artifacts: ['mavedb_details.json'],
  },
  {
    id: 'membrane_topology', legacy: 'P03', title: 'Topología de membrana', icon: 'waves', x: 870, y: 625,
    estimate: 'Puede tardar un par de minutos', deps: ['uniprot_features'],
    annotations: [['Topología TMbed', 'tmbed_topology', 'Hélice transmembrana α'], ['Segmentos TM', 'artefacto', '1'], ['Estado del span', 'artefacto', 'Generado']],
    artifacts: ['raw_prediction.txt', 'tmbed_per_residue.tsv', 'tm_segments.tsv', 'span.txt', 'span_metadata.json'],
  },
  {
    id: 'ensemble_frustration', legacy: 'P20', title: 'Frustración del ensemble', icon: 'waves', x: 870, y: 800,
    estimate: 'Este paso normalmente demora horas', deps: ['conformational_ensemble'],
    annotations: [['Frustración media', 'frustratometer_mean', '−0.533'], ['Conformeros utilizables', 'artefacto', '214'], ['Cobertura del residuo', 'artefacto', '98.6%']],
    artifacts: ['frustratometer_conformers.tsv', 'frustratometer_per_residue.tsv', 'closure.json', 'metadata.json'],
  },
  {
    id: 'structure_modeling', legacy: 'P04', title: 'Modelado estructural', icon: 'layers-3', x: 1210, y: 625,
    estimate: 'Puede tardar varios minutos', deps: ['membrane_topology'],
    annotations: [['QC estructural', 'structure_qc_status', 'Confiable'], ['pLDDT mediana', 'artefacto', '82.4'], ['Cobertura estructural', 'artefacto', '99.5%']],
    artifacts: ['P01130_model.cif', 'af3_confidence_per_residue.tsv', 'structure_qc_per_residue.tsv', 'msa_cache_entry.json'],
  },
  {
    id: 'structural_regime', legacy: 'P05', title: 'Régimen estructural', icon: 'route', x: 1510, y: 625,
    estimate: 'Puede tardar algunos segundos', deps: ['structure_modeling'],
    annotations: [['Régimen dominante', 'structural_regime', 'Soluble plegado'], ['Regla dominante', 'structural_regime_rule', 'R_AQUEOUS_CONFIDENT'], ['Acuerdo topológico', 'topology_agreement', 'Agreement']],
    artifacts: ['structural_regime_detail.tsv'],
  },
  {
    id: 'protein_relaxation_energy', legacy: 'P06', title: 'Relajación y energía', icon: 'zap', x: 1820, y: 625,
    estimate: 'Este paso normalmente demora horas', deps: ['structural_regime'],
    annotations: [['Herramienta', 'energy_tool', 'RosettaMP'], ['Estado', 'energy_status', 'OK'], ['Energía mediana por residuo', 'residue_energy_value', '−2.84 REU']],
    artifacts: ['P01130_relaxed_reference.pdb', 'structure_mapping.tsv', 'selected_reference.json', 'provenance.json'],
  },
  {
    id: 'physicochemical_context', legacy: 'P10', title: 'Contexto fisicoquímico', icon: 'gauge', x: 2200, y: 230,
    estimate: 'Puede tardar un par de minutos', deps: ['protein_relaxation_energy'],
    annotations: [['Estructura secundaria', 'secondary_structure', 'Hélice 31% · Lámina β 22% · Coil 47%'], ['Exposición', 'buried_status', '43% enterrado · 57% expuesto']],
    artifacts: ['dssp_per_residue.tsv', 'sasa_per_residue.tsv', 'physicochemical_context_detail.tsv'],
  },
  {
    id: 'variant_ddg', legacy: 'P07', title: 'ΔΔG de variante', icon: 'activity', x: 2200, y: 420,
    estimate: 'Opcional · Puede tardar varios minutos', deps: ['protein_relaxation_energy'], optional: true,
    annotations: [['Evaluación solicitada', 'ddg_variant_evaluated', 'No'], ['Estado', 'corrida', 'Sin variante de entrada']],
    artifacts: [],
  },
  {
    id: 'structural_frustration', legacy: 'P08', title: 'Frustración estructural', icon: 'sparkles', x: 2200, y: 610,
    estimate: 'Puede tardar varios minutos', deps: ['protein_relaxation_energy'],
    annotations: [['FI single-residue medio', 'structural_frustration_fi_singleresidue', '−0.37'], ['Ventana ±2 media', 'structural_frustration_window5_mean', '−0.31'], ['Estado', 'structural_frustration_status', 'OK']],
    artifacts: ['frustration_per_residue.tsv', 'structure_index.tsv', 'provenance.json', 'native_output.zip'],
  },
  {
    id: 'structural_contacts', legacy: 'P12', title: 'Contactos estructurales', icon: 'network', x: 2200, y: 800,
    estimate: 'Puede tardar varios minutos', deps: ['protein_relaxation_energy'],
    annotations: [['Contactos', 'structural_contacts_n_contacts', '5,284'], ['Residuos pareja', 'structural_contacts_n_partner_residues', '736'], ['Tipos dominantes', 'structural_contacts_contact_types', 'H-bond · hydrophobic · ionic'], ['Estado', 'structural_contacts_status', 'OK']],
    artifacts: ['contact_residue_summary.tsv', 'contacts_long.tsv', 'structure_index.tsv', 'arpeggio.json', 'arpeggio.log'],
  },
];

export const PIPELINE_STAGE_MAP = Object.fromEntries(PIPELINE_STAGES.map((stage) => [stage.id, stage]));

export const PROGRESS_FRAMES = [
  { ms: 1250, running: ['protein_identity'] },
  { ms: 1700, ok: ['protein_identity'], running: ['variant_predictors', 'pharmacogenomics', 'conformational_ensemble', 'sequence_frustration', 'uniprot_features'] },
  { ms: 1600, ok: ['protein_identity', 'variant_predictors', 'conformational_ensemble'], failed: ['pharmacogenomics'], running: ['sequence_frustration', 'uniprot_features', 'ensemble_frustration'] },
  { ms: 1700, ok: ['protein_identity', 'variant_predictors', 'conformational_ensemble', 'sequence_frustration', 'uniprot_features', 'ensemble_frustration'], failed: ['pharmacogenomics'], running: ['evolutionary_conservation', 'functional_region_evidence', 'experimental_variant_evidence', 'membrane_topology'] },
  { ms: 1400, ok: ['protein_identity', 'variant_predictors', 'conformational_ensemble', 'sequence_frustration', 'uniprot_features', 'ensemble_frustration', 'evolutionary_conservation', 'functional_region_evidence', 'experimental_variant_evidence'], failed: ['pharmacogenomics'], running: ['membrane_topology'] },
  { ms: 1300, ok: ['protein_identity', 'variant_predictors', 'conformational_ensemble', 'sequence_frustration', 'uniprot_features', 'ensemble_frustration', 'evolutionary_conservation', 'functional_region_evidence', 'experimental_variant_evidence', 'membrane_topology'], failed: ['pharmacogenomics'], running: ['structure_modeling'] },
  { ms: 1300, ok: ['protein_identity', 'variant_predictors', 'conformational_ensemble', 'sequence_frustration', 'uniprot_features', 'ensemble_frustration', 'evolutionary_conservation', 'functional_region_evidence', 'experimental_variant_evidence', 'membrane_topology', 'structure_modeling'], failed: ['pharmacogenomics'], running: ['structural_regime'] },
  { ms: 1600, ok: ['protein_identity', 'variant_predictors', 'conformational_ensemble', 'sequence_frustration', 'uniprot_features', 'ensemble_frustration', 'evolutionary_conservation', 'functional_region_evidence', 'experimental_variant_evidence', 'membrane_topology', 'structure_modeling', 'structural_regime'], failed: ['pharmacogenomics'], running: ['protein_relaxation_energy'] },
  { ms: 1700, ok: ['protein_identity', 'variant_predictors', 'conformational_ensemble', 'sequence_frustration', 'uniprot_features', 'ensemble_frustration', 'evolutionary_conservation', 'functional_region_evidence', 'experimental_variant_evidence', 'membrane_topology', 'structure_modeling', 'structural_regime', 'protein_relaxation_energy'], failed: ['pharmacogenomics'], skipped: ['variant_ddg'], running: ['physicochemical_context', 'structural_frustration', 'structural_contacts'] },
  { ms: 1500, ok: ['protein_identity', 'variant_predictors', 'conformational_ensemble', 'sequence_frustration', 'uniprot_features', 'ensemble_frustration', 'evolutionary_conservation', 'functional_region_evidence', 'experimental_variant_evidence', 'membrane_topology', 'structure_modeling', 'structural_regime', 'protein_relaxation_energy', 'physicochemical_context', 'structural_frustration'], failed: ['pharmacogenomics'], skipped: ['variant_ddg'], running: ['structural_contacts'] },
  { ms: 2600, ok: ['protein_identity', 'variant_predictors', 'conformational_ensemble', 'sequence_frustration', 'uniprot_features', 'ensemble_frustration', 'evolutionary_conservation', 'functional_region_evidence', 'experimental_variant_evidence', 'membrane_topology', 'structure_modeling', 'structural_regime', 'protein_relaxation_energy', 'physicochemical_context', 'structural_frustration', 'structural_contacts'], failed: ['pharmacogenomics'], skipped: ['variant_ddg'] },
];

export function getStageStatus(frame, id, hasVariants = false, frameIndex = 0) {
  if (id === 'variant_ddg' && hasVariants) {
    if (frameIndex < 8) return 'pending';
    if (frameIndex < 10) return 'running';
    return 'ok';
  }
  if (frame.ok?.includes(id)) return 'ok';
  if (frame.failed?.includes(id)) return 'failed';
  if (frame.skipped?.includes(id)) return 'skipped';
  if (frame.running?.includes(id)) return 'running';
  return 'pending';
}
