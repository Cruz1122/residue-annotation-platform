export const STAGE_ANALYSIS_ROUTES = Object.freeze({
  protein_identity: 'info',
  clinvar: 'scientific-evidence',
  variant_predictors: 'scientific-evidence',
  pharmacogenomics: 'scientific-evidence',
  uniprot_features: 'scientific-evidence',
  conformational_ensemble: 'bioemu',
  sequence_frustration: 'frustration',
  evolutionary_conservation: 'conservation',
  functional_region_evidence: 'scientific-evidence',
  experimental_variant_evidence: 'scientific-evidence',
  membrane_topology: 'topology',
  ensemble_frustration: 'bioemu',
  structure_modeling: 'info',
  structural_regime: 'info',
  protein_relaxation_energy: 'variant-ddg',
  physicochemical_context: 'frustration',
  variant_ddg: 'variant-ddg',
  structural_frustration: 'frustration',
  structural_contacts: 'arpeggio',
});

export function stageHref(proteinId, runId, stageId) {
  const route = STAGE_ANALYSIS_ROUTES[stageId] ?? 'info';
  return `/proteins/${encodeURIComponent(proteinId)}/${route}/?run=${encodeURIComponent(runId)}`;
}
