const STAGE_PRESENTATION = Object.freeze({
  protein_identity: { stageIcon: 'protein_identity', estimate: 'Puede tardar algunos segundos' },
  clinvar: { stageIcon: 'clinvar', label: 'Evidencia ClinVar', estimate: 'Puede tardar varios minutos' },
  variant_predictors: { stageIcon: 'variant_predictors', estimate: 'Puede tardar un par de minutos' },
  pharmacogenomics: { stageIcon: 'pharmacogenomics', estimate: 'Puede tardar algunos segundos' },
  uniprot_features: { stageIcon: 'uniprot_features', estimate: 'Puede tardar algunos segundos' },
  sequence_frustration: { stageIcon: 'sequence_frustration', estimate: 'Puede tardar un par de minutos' },
  evolutionary_conservation: { stageIcon: 'evolutionary_conservation', estimate: 'Puede tardar varios minutos' },
  functional_region_evidence: { stageIcon: 'functional_region_evidence', label: 'Regiones asociadas a LDL-C/estatinas', estimate: 'Puede tardar algunos segundos' },
  experimental_variant_evidence: { stageIcon: 'experimental_variant_evidence', estimate: 'Puede tardar algunos segundos' },
  membrane_topology: { stageIcon: 'membrane_topology', estimate: 'Puede tardar un par de minutos' },
  conformational_ensemble: { stageIcon: 'conformational_ensemble', estimate: 'Este paso normalmente demora horas' },
  ensemble_frustration: { stageIcon: 'ensemble_frustration', estimate: 'Este paso normalmente demora horas' },
  structure_modeling: { stageIcon: 'structure_modeling', estimate: 'Puede tardar varios minutos' },
  structural_regime: { stageIcon: 'structural_regime', estimate: 'Puede tardar algunos segundos' },
  protein_relaxation_energy: { stageIcon: 'protein_relaxation_energy', estimate: 'Este paso normalmente demora horas' },
  physicochemical_context: { stageIcon: 'physicochemical_context', estimate: 'Puede tardar un par de minutos' },
  variant_ddg: { stageIcon: 'variant_ddg', label: 'ΔΔG de variantes', estimate: 'Opcional · puede tardar varios minutos' },
  structural_frustration: { stageIcon: 'structural_frustration', estimate: 'Puede tardar varios minutos' },
  structural_contacts: { stageIcon: 'structural_contacts', estimate: 'Puede tardar varios minutos' },
});

export function stagePresentation(stage, configuration = null) {
  const presentation = STAGE_PRESENTATION[stage?.id] ?? {};
  const structureLabel = stage?.id === 'structure_modeling'
    && configuration?.structure_source === 'alphafold3'
    ? 'Modelado estructural AF3'
    : null;

  return {
    label: structureLabel ?? presentation.label ?? stage?.title ?? 'Etapa del pipeline',
    stageIcon: presentation.stageIcon ?? stage?.id ?? 'protein_identity',
    estimate: presentation.estimate ?? 'Tiempo variable según los recursos disponibles',
  };
}
