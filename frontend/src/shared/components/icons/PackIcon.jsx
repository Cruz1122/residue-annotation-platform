import './icon.css';

const UI_ICON_SOURCES = Object.freeze({
  activity: '/icons/ui/activity.svg',
  'arrow-left': '/icons/ui/arrow-left.svg',
  atom: '/icons/ui/atom.svg',
  box: '/icons/ui/box.svg',
  'chart-column': '/icons/ui/chart-column.svg',
  'circle-check': '/icons/ui/circle-check.svg',
  'circle-dot': '/icons/ui/circle-dot.svg',
  'circle-slash': '/icons/ui/circle-slash.svg',
  'circle-x': '/icons/ui/circle-x.svg',
  clock: '/icons/ui/clock.svg',
  copy: '/icons/ui/copy.svg',
  dna: '/icons/ui/dna.svg',
  download: '/icons/ui/download.svg',
  eye: '/icons/ui/eye.svg',
  'eye-off': '/icons/ui/eye-off.svg',
  'file-text': '/icons/ui/file-text.svg',
  'flask-conical': '/icons/ui/flask-conical.svg',
  folder: '/icons/ui/folder.svg',
  gauge: '/icons/ui/gauge.svg',
  hash: '/icons/ui/hash.svg',
  info: '/icons/ui/info.svg',
  'key-round': '/icons/ui/key-round.svg',
  'layers-3': '/icons/ui/layers-3.svg',
  'loader-circle': '/icons/ui/loader-circle.svg',
  'lock-keyhole': '/icons/ui/lock-keyhole.svg',
  'log-in': '/icons/ui/log-in.svg',
  'log-out': '/icons/ui/log-out.svg',
  mail: '/icons/ui/mail.svg',
  'mail-check': '/icons/ui/mail-check.svg',
  'maximize-2': '/icons/ui/maximize-2.svg',
  network: '/icons/ui/network.svg',
  pause: '/icons/ui/pause.svg',
  play: '/icons/ui/play.svg',
  plus: '/icons/ui/plus.svg',
  'skip-back': '/icons/ui/skip-back.svg',
  'skip-forward': '/icons/ui/skip-forward.svg',
  'chevron-left': '/icons/ui/chevron-left.svg',
  'chevron-right': '/icons/ui/chevron-right.svg',
  'rotate-ccw': '/icons/ui/rotate-ccw.svg',
  'rotate-cw': '/icons/ui/rotate-cw.svg',
  route: '/icons/ui/route.svg',
  'scan-search': '/icons/ui/scan-search.svg',
  search: '/icons/ui/search.svg',
  'shield-check': '/icons/ui/shield-check.svg',
  'sliders-horizontal': '/icons/ui/sliders-horizontal.svg',
  sparkles: '/icons/ui/sparkles.svg',
  tag: '/icons/ui/tag.svg',
  tags: '/icons/ui/tags.svg',
  'triangle-alert': '/icons/ui/triangle-alert.svg',
  upload: '/icons/ui/upload.svg',
  protein: '/icons/ui/protein.svg',
  'user-round': '/icons/ui/user-round.svg',
  'user-round-cog': '/icons/ui/user-round-cog.svg',
  'user-round-plus': '/icons/ui/user-round-plus.svg',
  'users-round': '/icons/ui/users-round.svg',
  waves: '/icons/ui/waves.svg',
  workflow: '/icons/ui/workflow.svg',
  zap: '/icons/ui/zap.svg',
});

const STAGE_ICON_SOURCES = Object.freeze({
  protein_identity: '/icons/stages/01_protein_identity.svg',
  variant_predictors: '/icons/stages/02_variant_predictors.svg',
  pharmacogenomics: '/icons/stages/03_pharmacogenomics.svg',
  conformational_ensemble: '/icons/stages/04_conformational_ensemble.svg',
  sequence_frustration: '/icons/stages/05_sequence_frustration.svg',
  ensemble_frustration: '/icons/stages/06_ensemble_frustration.svg',
  uniprot_features: '/icons/stages/07_uniprot_features.svg',
  evolutionary_conservation: '/icons/stages/08_evolutionary_conservation.svg',
  functional_region_evidence: '/icons/stages/09_functional_region_evidence.svg',
  experimental_variant_evidence: '/icons/stages/10_experimental_variant_evidence.svg',
  membrane_topology: '/icons/stages/11_membrane_topology.svg',
  structure_modeling: '/icons/stages/12_structure_modeling.svg',
  structural_regime: '/icons/stages/13_structural_regime.svg',
  protein_relaxation_energy: '/icons/stages/14_protein_relaxation_energy.svg',
  physicochemical_context: '/icons/stages/15_physicochemical_context.svg',
  variant_ddg: '/icons/stages/16_variant_ddg.svg',
  structural_frustration: '/icons/stages/17_structural_frustration.svg',
  structural_contacts: '/icons/stages/18_structural_contacts.svg',
  clinvar: '/icons/stages/CX_clinvar.svg',
});

/**
 * @param {{ name?: string, kind?: 'ui' | 'stage', className?: string, label?: string }} props
 */
export default function PackIcon({ name = 'circle-dot', kind = 'ui', className = '', label = undefined }) {
  const sources = kind === 'stage' ? STAGE_ICON_SOURCES : UI_ICON_SOURCES;
  const fallback = kind === 'stage' ? 'protein_identity' : 'circle-dot';
  const source = sources[name] ?? sources[fallback];
  const accessibleProps = label
    ? { role: 'img', 'aria-label': label }
    : { 'aria-hidden': 'true' };

  return (
    <span class={`icon-slot ${className}`.trim()} {...accessibleProps}>
      {kind === 'stage' ? (
        <img class="icon-asset icon-asset-stage" src={source} alt="" draggable="false" />
      ) : (
        <span
          class="lucide-icon icon-asset icon-mask"
          style={`--icon-mask: url("${source}")`}
        />
      )}
    </span>
  );
}
