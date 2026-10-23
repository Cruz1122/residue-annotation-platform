import { memo } from 'preact/compat';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import AuthenticatedArtifactLink from '@features/artifacts/components/AuthenticatedArtifactLink.tsx';
import { artifactDisplayName } from '@features/artifacts/artifact-display.js';
import StatePanel from '@shared/components/feedback/StatePanel.jsx';
import { getAnnotations, getArtifactBlob, getArtifactObjectUrl, getProtein, getRun, getUploadObjectUrl, subscribeRunEvents } from '@shared/api/client';
import { userErrorMessage } from '@shared/lib/error-presentation';
import { firstDetailValue, loadAnalysisArtifactDetails, presentationRowsFromArtifacts, recordsForPosition, summarizeArtifactRecord } from '@features/annotations/analysis-artifacts.js';
import {
  AA_NAMES,
  ANALYSIS_VIEWS,
  booleanClass,
  MISSING_COLOR,
  MODE_INFO,
  MODE_SCALE_COPY,
  VISUALIZATION_MODES,
  annotationForResidue,
  assignCanonicalPositions,
  canonicalChain,
  colorForValues,
  fixedDomainForMode,
  formatScaleNumber,
  hexToColorInt,
  mergeAnnotationRows,
  measurementForMode,
  normalizeValue,
  oneLetter,
  publishedModeValue,
  readableValue,
  residueDisplayColor,
  residueKey,
  topologyClass,
  viewerModeAvailability,
} from '@features/annotations/viewer-presentation.js';
import 'molstar/build/viewer/molstar.css';
import '@features/annotations/styles/viewer.css';

const RESIDUE_FOCUS_OPTIONS = {
  extraRadius: 4,
  durationMs: 180,
  easing: 'cubic-out',
  trajectory: 'linear',
};
const CAMERA_RESET_DURATION_MS = 180;
const EMPTY_SELECTION = { lo: null, hi: null, active: null };

function publishedField(row, key) {
  const value = row?.values?.[key];
  if (value === null || value === undefined || value === '' || value === 'NA') return 'NA';
  const unit = row.units?.[key];
  return unit ? `${value} ${unit}` : value;
}

function structureFormat(name, mediaType) {
  const lowerName = String(name ?? '').toLowerCase();
  const media = String(mediaType ?? '').toLowerCase();
  if (/\.(cif|mmcif)$/.test(lowerName) || media.includes('cif')) return 'mmcif';
  return 'pdb';
}

function isStructure(name, mediaType) {
  const lowerName = String(name ?? '').toLowerCase();
  const media = String(mediaType ?? '').toLowerCase();
  return /\.(pdb|cif|mmcif)$/.test(lowerName) || media.includes('pdb') || media.includes('cif');
}

function structureSource(run) {
  const artifacts = (run?.stages ?? []).flatMap((stage) => stage.artifacts ?? []);
  const preferredTypes = ['selected_reference_pdb', 'model_cif'];
  const artifact = preferredTypes
    .map((type) => artifacts.find((item) => item.artifact_type === type))
    .find(Boolean) ?? artifacts.find((item) => isStructure(item.artifact_type, item.media_type));
  if (artifact) {
    return {
      id: artifact.id,
      label: artifactDisplayName(artifact),
      format: structureFormat(artifact.artifact_type, artifact.media_type),
      loadUrl: () => getArtifactObjectUrl(artifact.id),
    };
  }
  const upload = (run?.uploads ?? []).find((item) => item.input_type === 'structure');
  if (!upload) return null;
  return {
    id: upload.id,
    label: upload.original_filename,
    format: structureFormat(upload.original_filename, upload.media_type),
    loadUrl: () => getUploadObjectUrl(upload.id),
  };
}

function sameStructureSource(left, right) {
  if (!left || !right) return left === right;
  return left?.id === right?.id && left?.format === right?.format;
}

function chainValue(column, index) {
  return String(column?.value?.(index) || '');
}

function collectChains(structure) {
  const byChain = new Map();
  const seen = new Set();
  for (const unit of structure.units ?? []) {
    if (!unit.residueIndex || !unit.elements?.length) continue;
    const hierarchy = unit.model?.atomicHierarchy;
    if (!hierarchy?.residues || !hierarchy?.chains || !hierarchy.chainAtomSegments) continue;
    const { residues, chains, chainAtomSegments } = hierarchy;
    let start = 0;
    while (start < unit.elements.length) {
      const atomIndex = unit.elements[start];
      const residueIndex = unit.residueIndex[atomIndex];
      let end = start + 1;
      while (end < unit.elements.length && unit.residueIndex[unit.elements[end]] === residueIndex) end += 1;
      const chain = chainValue(chains.auth_asym_id, chainAtomSegments.index[atomIndex])
        || chainValue(chains.label_asym_id, chainAtomSegments.index[atomIndex])
        || 'A';
      const authSeqId = Number(residues.auth_seq_id?.value?.(residueIndex) ?? residues.label_seq_id?.value?.(residueIndex));
      const insCode = String(residues.pdbx_PDB_ins_code?.value?.(residueIndex) || '').trim();
      const compId = String(hierarchy.atoms?.label_comp_id?.value?.(atomIndex) || hierarchy.atoms?.auth_comp_id?.value?.(atomIndex) || 'UNK');
      const key = `${chain}|${authSeqId}|${insCode}`;
      if (Number.isFinite(authSeqId) && !seen.has(key)) {
        seen.add(key);
        const list = byChain.get(chain) ?? [];
        list.push({ chain, authSeqId, insCode, compId, one: oneLetter(compId) });
        byChain.set(chain, list);
      }
      start = end;
    }
  }
  return [...byChain.entries()].map(([id, residues]) => ({
    id,
    residues: residues.sort((left, right) => left.authSeqId - right.authSeqId || left.insCode.localeCompare(right.insCode)),
  }));
}

function buildResidueLociCache(structure, structureLib, OrderedSet) {
  const residueLoci = new Map();
  const { Loci } = structureLib.StructureElement;
  for (const unit of structure.units ?? []) {
    if (!unit.residueIndex || !unit.elements?.length) continue;
    const hierarchy = unit.model?.atomicHierarchy;
    if (!hierarchy?.residues || !hierarchy?.chains || !hierarchy.chainAtomSegments) continue;
    let start = 0;
    while (start < unit.elements.length) {
      const atomIndex = unit.elements[start];
      const residueIndex = unit.residueIndex[atomIndex];
      let end = start + 1;
      while (end < unit.elements.length && unit.residueIndex[unit.elements[end]] === residueIndex) end += 1;
      const chain = chainValue(hierarchy.chains.auth_asym_id, hierarchy.chainAtomSegments.index[atomIndex])
        || chainValue(hierarchy.chains.label_asym_id, hierarchy.chainAtomSegments.index[atomIndex])
        || 'A';
      const authSeqId = Number(hierarchy.residues.auth_seq_id?.value?.(residueIndex) ?? hierarchy.residues.label_seq_id?.value?.(residueIndex));
      const insCode = String(hierarchy.residues.pdbx_PDB_ins_code?.value?.(residueIndex) || '').trim();
      if (Number.isFinite(authSeqId)) {
        const loci = Loci(structure, [{ unit, indices: OrderedSet.ofBounds(start, end) }]);
        const key = `${chain}|${authSeqId}|${insCode}`;
        const existing = residueLoci.get(key);
        residueLoci.set(key, existing ? Loci.union(existing, loci) : loci);
      }
      start = end;
    }
  }
  return residueLoci;
}

function ContinuousLegend({ mode, domain, value, residueSelected }) {
  const spec = VISUALIZATION_MODES[mode];
  const copy = MODE_SCALE_COPY[mode];
  const t = domain ? normalizeValue(value, domain.min, domain.max) : null;
  const stops = spec.colors.map((color, index) => `${color} ${(index / (spec.colors.length - 1)) * 100}%`).join(', ');
  const background = `linear-gradient(90deg, ${stops})`;
  const midpoint = domain ? (domain.min + domain.max) / 2 : null;
  return (
    <div class="continuous-legend" aria-label={`${copy.magnitude}. ${copy.note}`}>
      <p class="continuous-legend__note">
        <strong>{copy.magnitude}</strong>
        <span> · {copy.note}</span>
      </p>
      <div class={`continuous-legend__track ${domain ? '' : 'is-empty'}`} style={domain ? { background } : undefined}>
        {t !== null && (
          <span
            class="continuous-legend__marker"
            style={{ left: `${t * 100}%` }}
            title={`Residuo seleccionado: ${formatScaleNumber(value)}`}
          />
        )}
      </div>
      {domain && (
        <div class="continuous-legend__labels">
          <span>{formatScaleNumber(domain.min)}</span>
          <span title="Punto medio visual">{formatScaleNumber(midpoint)}</span>
          <span>{formatScaleNumber(domain.max)}</span>
        </div>
      )}
      {(!domain || (residueSelected && t === null)) && <span class="continuous-legend__missing">Sin dato</span>}
    </div>
  );
}

const ResidueButton = memo(function ResidueButton({ residue, index, inRange, active, color, onActivate }) {
  return (
    <button
      data-sequence-index={index}
      class={`viewer-residue ${inRange ? 'in-range' : ''} ${active ? 'active' : ''}`}
      style={`--mode-color:${color}`}
      type="button"
      title={`${residue.compId} ${residue.authSeqId}`}
      aria-pressed={inRange}
      onClick={(event) => {
        if (event.detail === 0) onActivate(index);
      }}
    >
      <span class="viewer-residue-pos">{index % 10 === 0 ? residue.authSeqId : ''}</span>
      <span>{residue.one}</span>
    </button>
  );
});

const STAGE_STATUS = {
  pending: 'Pendiente',
  ready: 'Preparada',
  queued: 'En cola',
  running: 'En ejecución',
  success: 'Completada',
  reused: 'Reutilizada',
  failed: 'Fallida',
  skipped: 'Omitida',
  cancelled: 'Cancelada',
  disabled: 'Deshabilitada',
};

function displayField(annotation, key) {
  return readableValue(key, publishedField(annotation, key));
}

function displayDetail(record, keys, unitKeys = [], fallbackUnit = null) {
  const valueKey = keys.find((key) => firstDetailValue(record, [key]) !== null) ?? keys[0];
  const value = firstDetailValue(record, [valueKey]);
  if (value === null) return 'Sin dato';
  const unit = firstDetailValue(record, unitKeys) ?? fallbackUnit;
  const displayValue = readableValue(valueKey, value);
  return unit === null ? displayValue : `${displayValue} ${unit}`;
}

function EvidenceRow({ label, value, tone = '' }) {
  return (
    <div class="analysis-evidence-row">
      <dt>{label}</dt>
      <dd class={tone ? `tone-${tone}` : ''}>{value ?? 'Sin dato'}</dd>
    </div>
  );
}

function EvidenceSection({ title, meta, description, open = false, children }) {
  return (
    <details class="analysis-section" open={open}>
      <summary>
        <span>{title}</span>
        {meta && <b>{meta}</b>}
      </summary>
      <div class="analysis-section-body">
        {description && <p>{description}</p>}
        {children}
      </div>
    </details>
  );
}

function numericDetailValue(record, keys) {
  const value = firstDetailValue(record, keys);
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function ConformationalEnsembleEvidence({ stage, artifactDetails }) {
  const metadata = artifactDetails?.conformational_ensemble_metadata?.[0] ?? null;
  const frames = artifactDetails?.conformational_ensemble_frames_index ?? [];
  const retained = numericDetailValue(metadata, ['qc_retained_total', 'ensemble_size']);
  const rawSamples = numericDetailValue(metadata, ['raw_samples']);
  const failed = numericDetailValue(metadata, ['qc_failed']);
  const rounds = numericDetailValue(metadata, ['bioemu_rounds_done']);
  const status = stage ? (STAGE_STATUS[stage.status] ?? stage.status) : 'No publicada';
  const isPublished = stage?.status === 'success' || stage?.status === 'reused';
  const meta = retained !== null ? `${retained} conformeros retenidos` : status;

  return (
    <EvidenceSection
      title="Ensamble conformacional publicado"
      meta={meta}
      description="Resumen calculado a partir de los metadatos y el índice de frames publicados por MN5. Los archivos numéricos completos quedan disponibles en la sección de descargas."
      open
    >
      {isPublished && metadata ? (
        <dl class="ensemble-evidence">
          <EvidenceRow label="Estado de la etapa" value={status} tone="source" />
          <EvidenceRow label="Modelo" value={firstDetailValue(metadata, ['model']) ?? 'Sin dato'} />
          <EvidenceRow label="Conformeros retenidos" value={retained ?? 'Sin dato'} />
          <EvidenceRow label="Frames indexados" value={frames.length || retained || 'Sin dato'} />
          <EvidenceRow label="Muestras brutas" value={rawSamples ?? 'Sin dato'} />
          <EvidenceRow label="Frames descartados por QC" value={failed ?? 'Sin dato'} />
          <EvidenceRow label="Rondas completadas" value={rounds ?? 'Sin dato'} />
          <EvidenceRow label="Unidad de coordenadas" value={firstDetailValue(metadata, ['coordinate_unit']) ?? 'Sin dato'} />
          <EvidenceRow label="Política de selección" value={firstDetailValue(metadata, ['selection_policy', 'selection']) ?? 'Sin dato'} />
        </dl>
      ) : (
        <p class="analysis-no-data">
          {stage ? `La etapa está ${status.toLowerCase()}, pero no hay metadatos publicados para mostrar.` : 'La etapa conformacional no está incluida en esta corrida.'}
        </p>
      )}
    </EvidenceSection>
  );
}

function AnalysisDetails({ analysis, annotation, residue, run, view, artifactDetails }) {
  const canonicalPosition = residue?.aaPosition ?? residue?.canonicalPosition ?? null;
  const requestedVariant = (run?.requested_variants ?? []).find((variant) => variant.aa_position === canonicalPosition);
  const relatedStages = (run?.stages ?? []).filter((stage) => view.stageIds.includes(stage.id));
  const artifacts = relatedStages.flatMap((stage) => stage.artifacts ?? []);
  const topologyDetail = recordsForPosition(artifactDetails, 'tmbed_per_residue', canonicalPosition)[0];
  const frustrationDetail = recordsForPosition(artifactDetails, 'frustratometer_per_residue', canonicalPosition)[0];
  const frustrationMeasurement = measurementForMode('frustration', annotation?.values);
  const frustrationSource = frustrationMeasurement?.field === 'frustratometer_mean'
    ? 'Ensemble'
    : frustrationMeasurement?.field === 'structural_frustration_fi_singleresidue'
      ? 'Frustración estructural'
      : frustrationMeasurement?.field === 'frustraiseq_index'
        ? 'Frustración por secuencia'
        : 'Sin dato';
  const conservationDetail = recordsForPosition(artifactDetails, 'evolution_per_residue', canonicalPosition)[0];
  const functionalDetail = recordsForPosition(artifactDetails, 'ldlc_statin_evidence', canonicalPosition)[0];
  const functionalFeatures = recordsForPosition(artifactDetails, 'functional_features_long', canonicalPosition);
  const functionalFeatureTypes = [...new Set(functionalFeatures.map((record) => String(record?.feature_type ?? '').trim()).filter(Boolean))];
  const functionalFeatureNames = [...new Set(functionalFeatures.map((record) => String(record?.feature_name ?? '').trim()).filter(Boolean))];
  const functionalSummary = artifactDetails?.summary?.[0];
  const ddgDetail = recordsForPosition(artifactDetails, 'variant_annotations', canonicalPosition)[0];
  const displayedVariant = requestedVariant ?? (ddgDetail?.aa_position && (ddgDetail?.aa_ref || ddgDetail?.aa_alt || ddgDetail?.variant_id)
    ? {
      aa_ref: ddgDetail.aa_ref ?? String(ddgDetail.variant_id ?? '').match(/^([A-Z])\d+/i)?.[1] ?? '?',
      aa_position: ddgDetail.aa_position,
      aa_alt: ddgDetail.aa_alt ?? String(ddgDetail.variant_id ?? '').match(/\d+([A-Z])$/i)?.[1] ?? '?',
    }
    : null);
  const contactDetails = recordsForPosition(artifactDetails, 'contacts_long', canonicalPosition);
  const contactPartners = [...new Set(contactDetails.map((record) => firstDetailValue(record, ['partner_id', 'partner_residue', 'partner_aa_position', 'partner_position'])).filter((value) => value !== null))];
  const functionalFeatureClasses = String(annotation?.values?.functional_feature_class ?? '').split('|');
  const functionalFeatureTone = ['highlighted_segment', 'functional_interest', 'curated_region', 'annotation']
    .find((candidate) => functionalFeatureClasses.includes(candidate)) ?? '';

  return (
    <>
      {residue ? (
        <>
          <div class="viewer-residue-title">
            <div><strong>{residue.one}</strong><span>{residue.compId} · {AA_NAMES[residue.compId] ?? 'Residuo'}</span></div>
            <b>{canonicalPosition ?? `${residue.authSeqId}${residue.insCode || ''}`}</b>
          </div>
          <div class="analysis-context">
            <span>Contexto funcional</span>
            <EvidenceRow label="Dominio UniProt" value={displayField(annotation, 'uniprot_domain')} />
          </div>
        </>
      ) : (
        <div class="analysis-select-prompt"><strong>Selecciona un residuo</strong><span>Haz clic en la secuencia o en el modelo 3D para ver la evidencia publicada.</span></div>
      )}

      {residue && analysis === 'topology' && (
        <EvidenceSection title="Clasificación topológica" meta={displayField(annotation, 'tmbed_topology')} open>
          <dl>
            <EvidenceRow label="TMbed" value={displayField(annotation, 'tmbed_topology')} tone={topologyClass(annotation?.values?.tmbed_topology)} />
            <EvidenceRow label="Topología UniProt" value={displayField(annotation, 'uniprot_topology')} />
            <EvidenceRow label="Régimen estructural" value={displayField(annotation, 'structural_regime')} />
            <EvidenceRow label="Acuerdo topológico" value={displayField(annotation, 'topology_agreement')} />
            {topologyDetail && <EvidenceRow label="Detalle publicado" value={displayDetail(topologyDetail, ['topology', 'tmbed_topology', 'prediction'])} />}
          </dl>
        </EvidenceSection>
      )}

      {residue && analysis === 'frustration' && (
        <EvidenceSection title="Frustración del residuo" meta={frustrationMeasurement ? displayField(annotation, frustrationMeasurement.field) : 'Sin dato'} open>
          <dl>
            <EvidenceRow label="Fuente visualizada" value={frustrationSource} tone={frustrationMeasurement ? 'source' : ''} />
            <EvidenceRow label="Índice numérico" value={frustrationMeasurement ? displayField(annotation, frustrationMeasurement.field) : 'Sin dato'} />
            <EvidenceRow label="Media del ensemble" value={displayField(annotation, 'frustratometer_mean')} />
            <EvidenceRow label="Índice estructural" value={displayField(annotation, 'structural_frustration_fi_singleresidue')} />
            <EvidenceRow label="Índice por secuencia" value={displayField(annotation, 'frustraiseq_index')} />
            <EvidenceRow label="Estructura secundaria" value={displayField(annotation, 'secondary_structure')} />
            <EvidenceRow label="Enterramiento" value={displayField(annotation, 'buried_status')} />
            {frustrationDetail && <EvidenceRow label="Dispersión entre conformeros" value={displayDetail(frustrationDetail, ['frustratometer_sd', 'standard_deviation', 'sd'], ['unit', 'units'])} />}
          </dl>
        </EvidenceSection>
      )}

      {residue && analysis === 'conservation' && (
        <EvidenceSection title="Conservación del residuo" meta={displayField(annotation, 'consurf_grade')} open>
          <dl>
            <EvidenceRow label="Rate4Site" value={displayField(annotation, 'rate4site_score')} />
            <EvidenceRow label="ConSurf" value={displayField(annotation, 'consurf_grade')} />
            {conservationDetail && <EvidenceRow label="Motivo de ausencia" value={displayDetail(conservationDetail, ['na_reason'])} />}
          </dl>
        </EvidenceSection>
      )}

      {residue && analysis === 'functional' && (
        <EvidenceSection title="Evidencia funcional" meta={displayField(annotation, 'variant_in_statin_ldlc_region')} open>
          <dl>
            <EvidenceRow label="Región LDL-C / estatinas" value={displayField(annotation, 'variant_in_statin_ldlc_region')} tone={booleanClass(annotation?.values?.variant_in_statin_ldlc_region)} />
            <EvidenceRow label="Mapeo canónico" value={displayField(annotation, 'uniprot_mapping_status')} />
            {functionalDetail && <EvidenceRow label="Evidencia del recurso" value={displayDetail(functionalDetail, ['evidence', 'source', 'region_name', 'label'])} />}
            {functionalFeatureTypes.length > 0 && <EvidenceRow label="Tipos UniProt" value={functionalFeatureTypes.slice(0, 5).join(' · ')} tone={functionalFeatureTone} />}
            {functionalFeatureNames.length > 0 && <EvidenceRow label="Regiones / sitios" value={functionalFeatureNames.slice(0, 3).join(' · ')} tone={functionalFeatureTone} />}
            {functionalSummary && <EvidenceRow label="Resumen de la etapa" value={summarizeArtifactRecord(functionalSummary)} />}
          </dl>
        </EvidenceSection>
      )}

      {residue && analysis === 'ddg' && (
        <EvidenceSection title="Variante evaluada" meta={displayedVariant ? `${displayedVariant.aa_ref}${displayedVariant.aa_position}${displayedVariant.aa_alt}` : 'Sin variante'} open>
          <dl>
            <EvidenceRow label="Evaluación publicada" value={displayField(annotation, 'ddg_variant_evaluated')} tone={booleanClass(annotation?.values?.ddg_variant_evaluated)} />
            <EvidenceRow label="Sustitución evaluada" value={displayedVariant ? `${displayedVariant.aa_ref} → ${displayedVariant.aa_alt}` : 'Sin dato'} />
            {ddgDetail && <EvidenceRow label="ΔΔG" value={displayField(annotation, 'ddg_value')} />}
            {ddgDetail && <EvidenceRow label="Desviación entre réplicas" value={displayDetail(ddgDetail, ['ddg_sd'], ['ddg_unit', 'unit'], annotation?.units?.ddg_value)} />}
            {ddgDetail && <EvidenceRow label="Réplicas" value={displayDetail(ddgDetail, ['ddg_n_replicates', 'n_replicates'])} />}
          </dl>
        </EvidenceSection>
      )}

      {residue && analysis === 'contacts' && (
        <EvidenceSection title="Contactos del residuo" meta={displayField(annotation, 'structural_contacts_n_contacts')} open>
          <dl>
            <EvidenceRow label="Número de contactos" value={displayField(annotation, 'structural_contacts_n_contacts')} />
            <EvidenceRow label="Residuos asociados" value={displayField(annotation, 'structural_contacts_n_partner_residues')} />
            <EvidenceRow label="Tipos de contacto" value={displayField(annotation, 'structural_contacts_contact_types')} />
            {contactPartners.length > 0 && <EvidenceRow label="Socios registrados" value={`${contactPartners.slice(0, 8).join(', ')}${contactPartners.length > 8 ? ` y ${contactPartners.length - 8} más` : ''}`} />}
          </dl>
        </EvidenceSection>
      )}

      {analysis === 'frustration' && (
        <ConformationalEnsembleEvidence
          stage={(run?.stages ?? []).find((stage) => stage.id === 'conformational_ensemble')}
          artifactDetails={artifactDetails}
        />
      )}

      <EvidenceSection title="Archivos publicados" meta={`${artifacts.length} archivo${artifacts.length === 1 ? '' : 's'}`}>
        <div class="analysis-artifacts">
          {artifacts.length ? artifacts.map((artifact) => (
            <AuthenticatedArtifactLink
              key={artifact.id}
              id={artifact.id}
              artifact={artifact}
              label={artifact.display_name}
              filename={artifact.download_filename}
              formatLabel={artifact.format_label}
              downloadFormat={artifact.download_format}
            />
          )) : <span class="analysis-no-data">No hay artefactos publicados.</span>}
        </div>
      </EvidenceSection>
    </>
  );
}

export default function ProteinViewer({ proteinId, analysis = 'topology' }) {
  const analysisView = ANALYSIS_VIEWS[analysis] ?? ANALYSIS_VIEWS.topology;
  const mode = analysisView.mode;
  const hostRef = useRef(null);
  const viewerRef = useRef(null);
  const structureLibRef = useRef(null);
  const orderedSetRef = useRef(null);
  const structureRef = useRef(null);
  const residueLociRef = useRef(new Map());
  const sequenceRef = useRef('');
  const rangeLociRef = useRef(new Map());
  const themeNamesRef = useRef({});
  const colorMapRef = useRef(new Map());
  const chainsRef = useRef([]);
  const chainIdRef = useRef('');
  const selectionRef = useRef(EMPTY_SELECTION);
  const dragRef = useRef(null);
  const molstarFrameRef = useRef(null);
  const molstarFocusFrameRef = useRef(null);
  const [protein, setProtein] = useState(null);
  const [run, setRun] = useState(null);
  const [artifactDetails, setArtifactDetails] = useState({});
  const [annotations, setAnnotations] = useState([]);
  const [chains, setChains] = useState([]);
  const [chainId, setChainId] = useState('');
  const [state, setState] = useState('loading');
  const [viewerState, setViewerState] = useState('loading');
  const [viewerError, setViewerError] = useState('');
  const [structureMapping, setStructureMapping] = useState({});
  const [structureParsed, setStructureParsed] = useState(false);
  const [error, setError] = useState('');
  const [wipe, setWipe] = useState('covering');
  const [selection, setSelection] = useState(EMPTY_SELECTION);
  const [annotationsOpen, setAnnotationsOpen] = useState(true);
  const runId = typeof window === 'undefined' ? '' : new URLSearchParams(window.location.search).get('run') ?? '';
  const [structureRequest, setStructureRequest] = useState(null);
  const structureSourceRef = useRef(null);
  const structureMappingRef = useRef({});
  const structureChainRef = useRef('');
  const artifactSignature = (run?.stages ?? []).flatMap((stage) => stage.artifacts ?? []).map((artifact) => artifact.id).sort().join(':');

  useEffect(() => {
    chainsRef.current = chains;
    chainIdRef.current = chainId;
  }, [chains, chainId]);

  const applyParsedChains = (parsedChains) => {
    const aligned = assignCanonicalPositions(parsedChains, sequenceRef.current, structureMappingRef.current);
    setChains(aligned);
    const configuredChain = structureChainRef.current;
    const preferredChain = configuredChain && aligned.some((chain) => chain.id === configuredChain)
      ? configuredChain
      : aligned.some((chain) => chain.id === chainIdRef.current) ? chainIdRef.current : aligned[0]?.id;
    setChainId(preferredChain ?? '');
    setStructureParsed(true);
  };

  useEffect(() => {
    let active = true;
    let timer;
    let streamController;
    let latestRun = null;
    let finished = false;
    let reconnectAttempts = 0;
    const maxReconnectAttempts = 3;

    const applyRun = (runData) => {
      if (!active) return;
      latestRun = runData;
      setRun(runData);
      const configuration = runData?.configuration;
      structureMappingRef.current = configuration?.structure_mapping ?? {};
      structureChainRef.current = configuration?.structure_chain ?? '';
      setStructureMapping(configuration?.structure_mapping ?? {});
      const nextStructure = structureSource(runData);
      setRunStructure(nextStructure);
    };

    const refreshAnnotations = async () => {
      if (!runId) return;
      try {
        const annotationData = await getAnnotations(runId);
        if (active) setAnnotations(annotationData.rows ?? []);
      } catch (requestError) {
        if (active) setViewerError(userErrorMessage(requestError, 'No se pudieron actualizar las anotaciones.'));
      }
    };

    const schedulePolling = (delay = 2_000) => {
      if (!active || !runId || finished) return;
      if (reconnectAttempts >= maxReconnectAttempts) {
        setViewerError('La actualización automática se detuvo; recarga para consultar el estado actual.');
        return;
      }
      reconnectAttempts += 1;
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(async () => {
        try {
          const [runData, annotationData] = await Promise.all([getRun(runId), getAnnotations(runId)]);
          applyRun(runData);
          if (active) setAnnotations(annotationData.rows ?? []);
          if (!['success', 'failed', 'cancelled'].includes(runData.status)) connectStream();
          else {
            finished = true;
            streamController?.abort();
          }
        } catch (requestError) {
          if (!active) return;
          setViewerError(userErrorMessage(requestError, 'No se pudo actualizar el visor.'));
          schedulePolling(4_000);
        }
      }, delay);
    };

    const connectStream = async () => {
      if (!active || !runId || finished || ['success', 'failed', 'cancelled'].includes(latestRun?.status)) return;
      streamController?.abort();
      const controller = new AbortController();
      streamController = controller;
      try {
        await subscribeRunEvents(runId, {
          signal: controller.signal,
          onSnapshot: (snapshot) => {
            latestRun = snapshot;
            applyRun(snapshot);
            void refreshAnnotations();
            if (['success', 'failed', 'cancelled'].includes(snapshot.status)) {
              finished = true;
              controller.abort();
              if (timer) window.clearTimeout(timer);
            }
          },
        });
        if (active && !finished && !['success', 'failed', 'cancelled'].includes(latestRun?.status)) schedulePolling();
      } catch (streamError) {
        if (active && !controller.signal.aborted && !finished) {
          setViewerError(userErrorMessage(streamError, 'La actualización en vivo se desconectó; se reintentará automáticamente.'));
          schedulePolling();
        }
      }
    };

    const setRunStructure = (nextStructure) => {
      if (sameStructureSource(structureSourceRef.current, nextStructure)) {
        if (!nextStructure) setViewerState((current) => current === 'loading' ? 'unavailable' : current);
        return;
      }
      structureSourceRef.current = nextStructure;
      setStructureParsed(false);
      setViewerState(nextStructure ? 'loading' : 'unavailable');
      setWipe('covering');
      setStructureRequest(nextStructure);
    };

    Promise.all([getProtein(proteinId), runId ? getRun(runId) : Promise.resolve(null)])
      .then(async ([proteinData, runData]) => {
        const annotationData = runData ? await getAnnotations(runData.id) : null;
        if (!active) return;
        sequenceRef.current = proteinData.sequence;
        const nextChains = canonicalChain(proteinData.sequence);
        setProtein(proteinData);
        setAnnotations(annotationData?.rows ?? []);
        setChains(nextChains);
        setChainId(nextChains[0]?.id ?? '');
        applyRun(runData);
        setState('ready');
        if (runData && !['success', 'failed', 'cancelled'].includes(runData.status)) void connectStream();
        else if (runData) finished = true;
      })
      .catch((requestError) => {
        if (!active) return;
        setState('error');
        setViewerState('unavailable');
        setError(userErrorMessage(requestError, 'No se pudo cargar la proteína.'));
      });
    return () => {
      active = false;
      streamController?.abort();
      if (timer) window.clearTimeout(timer);
    };
  }, [proteinId, runId]);

  useEffect(() => {
    let active = true;
    setArtifactDetails({});
    if (!run) return () => { active = false; };
    loadAnalysisArtifactDetails(run, analysis, getArtifactBlob)
      .then((details) => {
        if (active) setArtifactDetails(details);
      })
      .catch(() => {
        if (active) setArtifactDetails({});
      });
    return () => { active = false; };
  }, [run?.id, artifactSignature, analysis]);

  const activeChain = chains.find((chain) => chain.id === chainId) ?? chains[0] ?? null;
  const residues = activeChain?.residues ?? [];
  const mappingValid = useMemo(() => {
    if (!structureParsed || !activeChain || !protein?.sequence?.length) return false;
    const mappedPositions = new Set(
      activeChain.residues
        .map((residue) => residue.aaPosition)
        .filter((position) => Number.isInteger(position) && position > 0),
    );
    return mappedPositions.size >= Math.ceil(protein.sequence.length * 0.8);
  }, [activeChain, protein, structureParsed]);
  const presentationRows = useMemo(
    () => [...annotations, ...presentationRowsFromArtifacts(artifactDetails, analysis)],
    [analysis, annotations, artifactDetails],
  );
  const annotationByPosition = useMemo(() => {
    return mergeAnnotationRows(presentationRows);
  }, [presentationRows]);
  const domain = useMemo(() => fixedDomainForMode(mode), [mode]);
  const modeAvailability = useMemo(
    () => viewerModeAvailability(presentationRows, {
      structureAvailable: Boolean(structureRequest),
      mappingValid,
    }),
    [mappingValid, presentationRows, structureRequest],
  );
  const colors = useMemo(
    () => residues.map((residue) => residueDisplayColor(mode, residue, annotationForResidue(residue, annotationByPosition), domain)),
    [residues, mode, annotationByPosition, domain],
  );
  const activeResidue = selection.active === null ? null : residues[selection.active] ?? null;
  const activeAnnotation = activeResidue ? annotationForResidue(activeResidue, annotationByPosition) : null;
  const activeMeasurement = measurementForMode(mode, activeAnnotation?.values)?.value ?? null;
  const fieldAvailable = presentationRows.some((row) => publishedModeValue(mode, row?.values) !== null);

  useEffect(() => {
    const textualFallbackAvailable = !structureParsed && (viewerState === 'unavailable' || viewerState === 'error');
    if (selection.active !== null || (!mappingValid && !textualFallbackAvailable) || !residues.length) return;
    const preferredPosition = analysis === 'ddg' ? run?.requested_variants?.[0]?.aa_position : null;
    let index = preferredPosition == null ? -1 : residues.findIndex((residue) => (residue.aaPosition ?? residue.canonicalPosition) === preferredPosition);
    if (index < 0) {
      index = residues.findIndex((residue) => {
        return publishedModeValue(mode, annotationForResidue(residue, annotationByPosition)?.values) !== null;
      });
    }
    if (index < 0) return;
    const next = { lo: index, hi: index, active: index };
    selectionRef.current = next;
    setSelection(next);
  }, [analysis, annotationByPosition, mappingValid, mode, residues, run, selection.active, structureParsed, viewerState]);

  const applyTheme = async (nextMode) => {
    const viewer = viewerRef.current;
    const theme = themeNamesRef.current[nextMode];
    if (!viewer?.plugin || !theme) return;
    try {
      await viewer.plugin.dataTransaction(async () => {
        for (const entry of viewer.plugin.managers.structure.hierarchy.current.structures) {
          await viewer.plugin.managers.structure.component.updateRepresentationsTheme(entry.components, { color: theme });
        }
      });
    } catch (themeError) {
      console.warn('No se pudo aplicar el tema por residuo de Mol*', themeError);
    }
  };

  useEffect(() => {
    const next = new Map();
    for (const chain of chains) {
      for (const residue of chain.residues) {
        const color = residueDisplayColor(mode, residue, annotationForResidue(residue, annotationByPosition), domain);
        next.set(residueKey(residue), hexToColorInt(color));
      }
    }
    colorMapRef.current = next;
    applyTheme(mode);
  }, [chains, mode, annotationByPosition, domain]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      viewerRef.current?.handleResize?.();
      viewerRef.current?.plugin?.canvas3d?.requestResize?.();
    });
    return () => cancelAnimationFrame(frame);
  }, [annotationsOpen, viewerState]);

  useEffect(() => {
    if (!structureRequest || !hostRef.current) return undefined;
    let disposed = false;
    let subscription;
    let structureObjectUrl = '';

    async function loadViewer() {
      try {
        const [{ Viewer }, structureLib, orderedSetMod, objectUrl] = await Promise.all([
          import('molstar/lib/apps/viewer/app'),
          import('molstar/lib/mol-model/structure'),
          import('molstar/lib/mol-data/int'),
          structureRequest.loadUrl(),
        ]);
        structureObjectUrl = objectUrl;
        if (disposed || !hostRef.current) return;
        structureLibRef.current = structureLib;
        orderedSetRef.current = orderedSetMod.OrderedSet;
        const viewer = await Viewer.create(hostRef.current, {
          layoutIsExpanded: false,
          layoutShowControls: false,
          layoutShowRemoteState: false,
          layoutShowSequence: false,
          layoutShowLog: false,
          layoutShowLeftPanel: false,
          viewportShowExpand: false,
          viewportShowSelectionMode: false,
          viewportShowAnimation: false,
          viewportBackgroundColor: '#f3f4f4',
          pixelScale: 1,
          resolutionMode: 'auto',
        });
        if (disposed) {
          viewer.dispose();
          return;
        }
        viewer.plugin.canvas3d?.setProps({
          interaction: { maxFps: 60 },
          cameraResetDurationMs: CAMERA_RESET_DURATION_MS,
          cameraResetEasing: 'cubic-out',
          cameraResetTrajectory: 'linear',
        });
        viewerRef.current = viewer;
        await viewer.loadStructureFromUrl(structureObjectUrl, structureRequest.format, false, { label: structureRequest.label });
        const loaded = viewer.plugin.managers.structure.hierarchy.current.structures[0]?.cell?.obj?.data ?? null;
        structureRef.current = loaded;
        if (loaded) {
          residueLociRef.current = buildResidueLociCache(loaded, structureLib, orderedSetMod.OrderedSet);
          const parsed = collectChains(loaded);
          const parsedResidues = parsed.flatMap((chain) => chain.residues);
          const hasKnownResidues = parsedResidues.some((residue) => AA_NAMES[residue.compId]);
          if (parsed.length && hasKnownResidues) {
            applyParsedChains(parsed);
          } else {
            setStructureParsed(false);
          }
        }
        const registry = viewer.plugin.representation.structure.themes.colorThemeRegistry;
        for (const [themeMode, info] of Object.entries(MODE_INFO)) {
          const name = `residue-display-${themeMode}`;
          const factory = (ctx, props) => ({
            factory,
            granularity: 'group',
            props,
            description: info.title,
            color: (location) => {
              try {
                if (!structureLib.StructureElement.Location.is(location)) return hexToColorInt(MISSING_COLOR);
                const chain = String(structureLib.StructureProperties.chain.auth_asym_id(location) || structureLib.StructureProperties.chain.label_asym_id(location) || 'A');
                const authSeqId = Number(structureLib.StructureProperties.residue.auth_seq_id(location) || structureLib.StructureProperties.residue.label_seq_id(location));
                const insCode = String(structureLib.StructureProperties.residue.pdbx_PDB_ins_code?.(location) || '').trim();
                return colorMapRef.current.get(`${chain}|${authSeqId}|${insCode}`) ?? hexToColorInt(MISSING_COLOR);
              } catch {
                return hexToColorInt(MISSING_COLOR);
              }
            },
          });
          try {
            registry.add({ name, label: info.title, category: 'Residue display', factory, getParams: () => ({}), defaultValues: {}, isApplicable: () => true });
          } catch {
            // A hot reload can leave the provider registered.
          }
          themeNamesRef.current[themeMode] = name;
        }
        await applyTheme(mode);
        subscription = viewer.subscribe(viewer.plugin.behaviors.interaction.click, (event) => {
          const loci = event?.current?.loci;
          if (!structureLib.StructureElement.Loci.is(loci)) return;
          let picked = null;
          structureLib.StructureElement.Loci.forEachLocation(loci, (location) => {
            if (picked) return;
            const chain = String(structureLib.StructureProperties.chain.auth_asym_id(location) || structureLib.StructureProperties.chain.label_asym_id(location) || 'A');
            const authSeqId = Number(structureLib.StructureProperties.residue.auth_seq_id(location) || structureLib.StructureProperties.residue.label_seq_id(location));
            const insCode = String(structureLib.StructureProperties.residue.pdbx_PDB_ins_code?.(location) || '').trim();
            if (Number.isFinite(authSeqId)) picked = { chain, authSeqId, insCode };
          });
          if (!picked) return;
          const chain = chainsRef.current.find((item) => item.id === picked.chain);
          if (!chain) return;
          if (chain.id !== chainIdRef.current) {
            chainIdRef.current = chain.id;
            setChainId(chain.id);
          }
          const index = chain.residues.findIndex((residue) => residue.authSeqId === picked.authSeqId && (residue.insCode || '') === picked.insCode);
          if (index >= 0) selectSingle(index, true);
        });
        if (!disposed) setViewerState('ready');
      } catch (viewerErrorValue) {
        console.error(viewerErrorValue);
        if (!disposed) {
          setViewerError('No se pudo interpretar la estructura molecular publicada.');
          setStructureParsed(false);
          setViewerState('error');
        }
      }
    }

    loadViewer();
    return () => {
      disposed = true;
      if (molstarFrameRef.current !== null) cancelAnimationFrame(molstarFrameRef.current);
      if (molstarFocusFrameRef.current !== null) cancelAnimationFrame(molstarFocusFrameRef.current);
      subscription?.unsubscribe?.();
      viewerRef.current?.dispose?.();
      viewerRef.current = null;
      structureRef.current = null;
      residueLociRef.current = new Map();
      rangeLociRef.current = new Map();
      if (structureObjectUrl) URL.revokeObjectURL(structureObjectUrl);
    };
  }, [structureRequest]);

  useEffect(() => {
    if (!structureRef.current) return;
    const parsed = collectChains(structureRef.current);
    const parsedResidues = parsed.flatMap((chain) => chain.residues);
    if (parsed.length && parsedResidues.some((residue) => AA_NAMES[residue.compId])) applyParsedChains(parsed);
  }, [structureMapping]);

  useEffect(() => {
    if (wipe !== 'covering') return undefined;
    const settled = state === 'error' || (state === 'ready' && viewerState !== 'loading');
    if (!settled) return undefined;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setWipe('gone');
      return undefined;
    }
    setWipe('revealing');
    return undefined;
  }, [state, viewerState, wipe]);

  useEffect(() => {
    if (wipe !== 'revealing') return undefined;
    const timer = window.setTimeout(() => setWipe('gone'), 820);
    return () => window.clearTimeout(timer);
  }, [wipe]);

  const getSelectionLoci = (lo, hi) => {
    const key = `${chainIdRef.current}:${lo}:${hi}`;
    const cached = rangeLociRef.current.get(key);
    if (cached) return cached;
    const { Loci } = structureLibRef.current?.StructureElement ?? {};
    const chain = chainsRef.current.find((item) => item.id === chainIdRef.current);
    if (!Loci || !chain) return null;
    let loci = null;
    for (let index = lo; index <= hi; index += 1) {
      const residueLoci = residueLociRef.current.get(residueKey(chain.residues[index]));
      if (!residueLoci) continue;
      loci = loci ? Loci.union(loci, residueLoci) : residueLoci;
    }
    if (loci) rangeLociRef.current.set(key, loci);
    return loci;
  };

  const syncMolstar = (lo, hi, focus = true) => {
    const viewer = viewerRef.current;
    const chain = chainsRef.current.find((item) => item.id === chainIdRef.current);
    if (!viewer || !chain) return;
    try {
      const loci = getSelectionLoci(lo, hi);
      if (!loci) {
        viewer.structureInteractivity({
          elements: { auth_asym_id: chain.id, beg_auth_seq_id: chain.residues[lo].authSeqId, end_auth_seq_id: chain.residues[hi].authSeqId },
          action: focus ? ['select', 'focus'] : 'select',
          ...(focus ? { focusOptions: RESIDUE_FOCUS_OPTIONS } : {}),
        });
        return;
      }
      viewer.plugin.managers.interactivity.lociSelects.deselectAll();
      viewer.plugin.managers.interactivity.lociSelects.select({ loci });
      if (molstarFocusFrameRef.current !== null) cancelAnimationFrame(molstarFocusFrameRef.current);
      if (focus) {
        molstarFocusFrameRef.current = requestAnimationFrame(() => {
          molstarFocusFrameRef.current = null;
          const current = selectionRef.current;
          if (current.lo !== lo || current.hi !== hi) return;
          viewerRef.current?.plugin?.managers?.camera?.focusLoci?.(loci, RESIDUE_FOCUS_OPTIONS);
        });
      }
    } catch (syncError) {
      console.warn('No se pudo sincronizar la selección con Mol*', syncError);
    }
  };

  const scheduleMolstar = (callback) => {
    if (molstarFrameRef.current !== null) cancelAnimationFrame(molstarFrameRef.current);
    molstarFrameRef.current = requestAnimationFrame(() => {
      molstarFrameRef.current = null;
      callback();
    });
  };

  const clearSelection = () => {
    if (molstarFocusFrameRef.current !== null) cancelAnimationFrame(molstarFocusFrameRef.current);
    molstarFocusFrameRef.current = null;
    selectionRef.current = EMPTY_SELECTION;
    setSelection(EMPTY_SELECTION);
    scheduleMolstar(() => {
      try {
        viewerRef.current?.plugin?.managers?.interactivity?.lociSelects?.deselectAll?.();
      } catch (clearError) {
        console.warn('No se pudo limpiar la selección de Mol*', clearError);
      }
      viewerRef.current?.plugin?.managers?.camera?.reset?.(undefined, CAMERA_RESET_DURATION_MS, {
        easing: 'cubic-out',
        trajectory: 'linear',
      });
    });
  };

  const selectSingle = (index, fromCanvas = false) => {
    const previous = selectionRef.current;
    if (previous.active === index && previous.lo === index && previous.hi === index) {
      clearSelection();
      return;
    }
    const next = { lo: index, hi: index, active: index };
    if (molstarFocusFrameRef.current !== null) cancelAnimationFrame(molstarFocusFrameRef.current);
    molstarFocusFrameRef.current = null;
    selectionRef.current = next;
    setSelection(next);
    if (!fromCanvas) scheduleMolstar(() => syncMolstar(index, index, true));
    requestAnimationFrame(() => document.querySelector(`[data-sequence-index="${index}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' }));
  };

  const commitRange = (lo, hi) => {
    const next = { lo: Math.min(lo, hi), hi: Math.max(lo, hi), active: lo === hi ? lo : null };
    if (molstarFocusFrameRef.current !== null) cancelAnimationFrame(molstarFocusFrameRef.current);
    molstarFocusFrameRef.current = null;
    selectionRef.current = next;
    setSelection(next);
    scheduleMolstar(() => syncMolstar(next.lo, next.hi, true));
  };

  const sequencePointerDown = (event) => {
    const target = event.target?.closest?.('[data-sequence-index]');
    const index = Number(target?.dataset?.sequenceIndex);
    if (!target || !Number.isInteger(index)) return;
    event.preventDefault();
    const previous = selectionRef.current;
    dragRef.current = {
      start: index,
      end: index,
      pointerId: event.pointerId,
      previous,
      wasSelected: previous.active === index && previous.lo === index && previous.hi === index,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const sequencePointerMove = (event) => {
    if (!dragRef.current) return;
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest?.('[data-sequence-index]');
    if (!target) return;
    const index = Number(target.dataset.sequenceIndex);
    if (!Number.isInteger(index) || index === dragRef.current.end) return;
    dragRef.current.end = index;
    const next = { lo: Math.min(dragRef.current.start, index), hi: Math.max(dragRef.current.start, index), active: null };
    selectionRef.current = next;
    setSelection(next);
  };

  const sequencePointerUp = () => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    if (drag.start === drag.end) {
      if (drag.wasSelected) clearSelection();
      else selectSingle(drag.start);
    } else commitRange(drag.start, drag.end);
  };

  const sequencePointerCancel = () => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    selectionRef.current = drag.previous;
    setSelection(drag.previous);
  };

  const chooseChain = (nextChainId) => {
    if (nextChainId === chainId) return;
    setChainId(nextChainId);
    selectionRef.current = EMPTY_SELECTION;
    setSelection(EMPTY_SELECTION);
    rangeLociRef.current = new Map();
  };

  if (state === 'error' && wipe === 'gone') {
    return <section class="viewer-shell"><StatePanel kind="error" fill title="No se pudo cargar la proteína" description={error} /></section>;
  }

  const categoricalMode = VISUALIZATION_MODES[mode].kind === 'categorical';
  const selectedCategoryMissing = categoricalMode && activeResidue && !colorForValues(mode, activeAnnotation?.values, null);

  return (
    <section class={`viewer-shell has-annotations analysis-workspace ${annotationsOpen ? 'annotations-expanded' : 'annotations-collapsed'}`} data-analysis={analysis} aria-label={`${analysisView.title}: modelo molecular, secuencia y evidencia`} onContextMenu={(event) => event.preventDefault()}>
      <div ref={hostRef} class="molstar-host" aria-label={structureRequest ? 'Visor molecular Mol*' : 'Sin modelo 3D disponible'} />
      {viewerState === 'unavailable' && wipe === 'gone' && <StatePanel kind="empty" compact icon="box" title="Estructura no disponible" description="La corrida no tiene un PDB o mmCIF subido ni un artefacto publicado." className="viewer-boot-state" />}
      {viewerState === 'error' && wipe === 'gone' && <StatePanel kind="error" compact title="No se pudo cargar la estructura" description={viewerError || 'Verifica el artefacto y vuelve a intentarlo.'} className="viewer-boot-state" />}
      {(viewerState === 'unavailable' || viewerState === 'error') && wipe === 'gone' && <p class="viewer-accessibility-note" role="status">La secuencia y los estados de evidencia siguen disponibles en formato textual; la vista 3D no está disponible.</p>}

      <div class="viewer-top-stack">
        <div class="viewer-chain-panel">
          <div class="viewer-chain-title">
            <span>{activeChain ? `Cadena ${activeChain.id}` : 'Cadenas'}</span>
            {chains.length > 1 && (
              <div class="viewer-chain-switch" role="tablist" aria-label="Cadenas">
                {chains.map((chain) => (
                  <button key={chain.id} type="button" class={chain.id === activeChain?.id ? 'active' : ''} aria-pressed={chain.id === activeChain?.id} onClick={() => chooseChain(chain.id)}>{chain.id}</button>
                ))}
              </div>
            )}
          </div>
          <div class="viewer-sequence-scroll" onPointerDown={sequencePointerDown} onPointerMove={sequencePointerMove} onPointerUp={sequencePointerUp} onPointerCancel={sequencePointerCancel}>
            <div class={`viewer-sequence-track ${selection.lo !== null ? 'has-selection' : ''}`}>
              {residues.map((residue, index) => (
                <ResidueButton
                  key={residueKey(residue)}
                  residue={residue}
                  index={index}
                  inRange={selection.lo !== null && index >= selection.lo && index <= selection.hi}
                  active={selection.active === index}
                  color={colors[index]}
                  onActivate={selectSingle}
                />
              ))}
            </div>
          </div>
        </div>

      </div>

      <aside class={`viewer-annotations ${annotationsOpen ? 'is-expanded' : 'is-collapsed'}`} aria-label={`Evidencia de ${analysisView.title}`}>
        <div class="viewer-annotations-head">
          <div><span>Análisis</span><h2>{analysisView.title}</h2></div>
          <button
            type="button"
            class="annotations-toggle"
            aria-expanded={annotationsOpen}
            aria-controls="viewer-annotations-body"
            onClick={() => setAnnotationsOpen((open) => !open)}
          >
            {annotationsOpen ? 'Ocultar' : 'Mostrar'}
          </button>
        </div>
        <div id="viewer-annotations-body" class="viewer-annotations-body" hidden={!annotationsOpen}>
          <div class="viewer-mode-panel">
            <div class={`viewer-mode-info ${categoricalMode ? '' : 'is-continuous'}`}>
              {!fieldAvailable && <span class="viewer-mode-pending">No hay un valor publicado para esta vista.</span>}
              {fieldAvailable && !modeAvailability[mode] && <span class="viewer-mode-pending">Hay datos publicados, pero el modelo no tiene un mapeo estructural válido.</span>}
              {categoricalMode ? (
                <span class="viewer-mode-legend">
                  {(MODE_INFO[mode].legend ?? []).map(([label, color]) => <span key={label} class="viewer-legend-item"><i style={{ background: color }} />{label}</span>)}
                  {selectedCategoryMissing && <span class="continuous-legend__missing">Sin dato</span>}
                </span>
              ) : (
                <ContinuousLegend mode={mode} domain={domain} value={activeMeasurement} residueSelected={Boolean(activeResidue)} />
              )}
            </div>
          </div>
          <AnalysisDetails analysis={analysis} annotation={activeAnnotation} residue={activeResidue} run={run} view={analysisView} artifactDetails={artifactDetails} />
        </div>
      </aside>

      {wipe !== 'gone' && (
        <div
          class={`viewer-load-wipe ${wipe === 'revealing' ? 'is-revealing' : ''}`}
          onAnimationEnd={(event) => {
            if (event.animationName === 'viewer-wipe-reveal') setWipe('gone');
          }}
        >
          <div class="viewer-load-mark">
            <span>{state === 'error' ? 'Sin proteína' : viewerState === 'error' ? 'Estructura no leída' : 'Cargando estructura'}</span>
            <i class="viewer-load-rule" />
          </div>
        </div>
      )}
    </section>
  );
}
