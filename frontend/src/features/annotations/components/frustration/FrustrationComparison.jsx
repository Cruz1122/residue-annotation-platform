import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import StatePanel from '@shared/components/feedback/StatePanel.jsx';
import { artifactDisplayName } from '@features/artifacts/artifact-display.js';
import {
  getAnnotations,
  getArtifactBlob,
  getArtifactObjectUrl,
  getProtein,
  getRun,
  getUploadObjectUrl,
  subscribeRunEvents,
} from '@shared/api/client';
import { userErrorMessage } from '@shared/lib/error-presentation';
import { loadAnalysisArtifactDetails } from '@features/annotations/analysis-artifacts.js';
import { annotationResultSignature } from '@features/annotations/annotation-result-signature.js';
import { acquireStructureUrl } from '@features/annotations/structure-url-cache.js';
import { captureCameraSnapshot, sameCameraSnapshot } from '@features/annotations/camera-snapshot.js';
import { getZoomOptimizedCanvas3dProps } from '@features/annotations/zoom-rendering.js';
import {
  FRUSTRATION_ARTIFACT_TYPES,
  frustrationRecordsAtPosition,
  indexFrustrationArtifactDetails,
} from '@features/annotations/frustration-artifact-index.js';
import MetricSelect from '@features/annotations/components/shared/MetricSelect.jsx';
import {
  classifyFrustrAISeqIndex,
  classifyFrustratometerValue,
  colorForFrustrationMetric,
  FRUSTRAISEQ_INDEX_COLORS,
  FRUSTRAISEQ_INDEX_MINIMALLY_FRUSTRATED_CUTOFF,
  FRUSTRAISEQ_ENTROPY_COLORS,
  FRUSTRAISEQ_ENTROPY_DOMAIN,
  FRUSTRAISEQ_SURPRISAL_COLORS,
  FRUSTRAISEQ_SURPRISAL_DOMAIN,
  FRUSTRATION_CLASS_INFO,
  frustrationClassLabel,
  minimallyFrustratedCutoff,
  normalizeFrustrationClass,
} from '@features/annotations/frustration-presentation.js';
import {
  AA3,
  AA_NAMES,
  finiteAnnotationValue,
  formatScaleNumber,
  hexToColorInt,
  mergeAnnotationRows,
} from '@features/annotations/viewer-presentation.js';
import 'molstar/build/viewer/molstar.css';
import '@features/annotations/styles/frustration-comparison.css';

const TERMINAL_RUN_STATUSES = new Set(['success', 'failed', 'cancelled']);
const RESIDUE_FOCUS_OPTIONS = {
  extraRadius: 4,
  durationMs: 180,
  easing: 'cubic-out',
  trajectory: 'linear',
};
const CAMERA_RESET_OPTIONS = {
  easing: 'cubic-out',
  trajectory: 'linear',
};
const CAMERA_RESET_DURATION_MS = 180;
const CAMERA_SYNC_ACTION_GUARD_MS = 480;
const FRUSTRAISEQ_REFERENCE_URL = 'https://doi.org/10.64898/2026.02.03.703498';

const HOTSPOT_SOURCE_OPTIONS = [
  { value: 'frustratometer', label: 'Frustratometer' },
  { value: 'frustraiseq', label: 'FrustrAI-Seq' },
];

const METHOD_OPTIONS = {
  structure: [
    { value: 'structural_frustration_fi_singleresidue', label: 'Residuo individual (SRFI)', shortLabel: 'SRFI' },
    { value: 'structural_frustration_fi_configurational', label: 'Configuracional (FI)', shortLabel: 'FI configuracional' },
    { value: 'structural_frustration_fi_mutational', label: 'Mutacional (FI)', shortLabel: 'FI mutacional' },
  ],
  sequence: [
    { value: 'frustraiseq_index', label: 'Índice', shortLabel: 'Índice' },
    { value: 'frustraiseq_entropy', label: 'Entropía', shortLabel: 'Entropía' },
    { value: 'frustraiseq_surprisal', label: 'Surprisal', shortLabel: 'Surprisal' },
  ],
};

const ANNOTATION_PAGE_SIZE = 50_000;
const MAX_ANNOTATION_PAGES = 20;

async function getAllFrustrationAnnotations(runId) {
  const rows = [];
  let offset = 0;
  let lastResponse = null;

  for (let page = 0; page < MAX_ANNOTATION_PAGES; page += 1) {
    const response = await getAnnotations(runId, ANNOTATION_PAGE_SIZE, offset);
    lastResponse = response;
    rows.push(...(response.rows ?? []));
    if (!response.truncated) {
      return { ...response, rows, truncated: false };
    }
    if (!response.rows?.length) return { ...response, rows, truncated: true };
    offset += response.rows.length;
  }

  return { ...lastResponse, rows, truncated: true };
}

const SECONDARY_STRUCTURE_LABELS = {
  H: 'En hélice α',
  G: 'En hélice α',
  I: 'En hélice α',
  E: 'En lámina β',
  B: 'En lámina β',
  T: 'En giro',
  S: 'En giro',
  C: 'En bucle superficial',
  L: 'En bucle superficial',
  coil: 'En bucle superficial',
  helix: 'En hélice α',
  sheet: 'En lámina β',
  turn: 'En giro',
};

function structureFormat(name, mediaType) {
  const lowerName = String(name ?? '').toLowerCase();
  const media = String(mediaType ?? '').toLowerCase();
  return /\.(cif|mmcif)$/.test(lowerName) || media.includes('cif') ? 'mmcif' : 'pdb';
}

function isStructure(name, mediaType) {
  const lowerName = String(name ?? '').toLowerCase();
  const media = String(mediaType ?? '').toLowerCase();
  return /\.(pdb|cif|mmcif)$/.test(lowerName) || media.includes('pdb') || media.includes('cif');
}

function structureSource(run) {
  const artifacts = (run?.stages ?? []).flatMap((stage) => stage.artifacts ?? []);
  const preferredTypes = [
    'selected_reference_pdb',
    'rosettamp_relaxed_pdb',
    'foldx_relaxed_pdb',
    'model_cif',
  ];
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

function structureResidueKey(chain, residueNumber, insertionCode = '') {
  return `${String(chain || 'A')}|${String(residueNumber)}|${String(insertionCode || '')}`;
}

function mappingPairValues(pair) {
  const chain = pair?.chain ?? pair?.auth_asym_id ?? pair?.label_asym_id ?? 'A';
  const residueNumber = pair?.residue_number
    ?? pair?.residue_position
    ?? pair?.resseq
    ?? pair?.pdb_resseq
    ?? pair?.auth_seq_id
    ?? pair?.label_seq_id;
  const insertionCode = pair?.insertion_code ?? pair?.icode ?? pair?.pdb_icode ?? '';
  const canonicalPosition = Number(pair?.canonical_position ?? pair?.aa_position);
  if (!Number.isInteger(canonicalPosition) || canonicalPosition < 1 || residueNumber === null || residueNumber === undefined || residueNumber === '') return null;
  return {
    canonicalPosition,
    key: structureResidueKey(chain, residueNumber, insertionCode),
  };
}

function structureMappingMaps(mapping) {
  const byCanonical = new Map();
  const byStructure = new Map();
  for (const pair of mapping?.canonical_to_structure ?? []) {
    const normalized = mappingPairValues(pair);
    if (!normalized || byCanonical.has(normalized.canonicalPosition) || byStructure.has(normalized.key)) continue;
    byCanonical.set(normalized.canonicalPosition, normalized.key);
    byStructure.set(normalized.key, normalized.canonicalPosition);
  }
  return { byCanonical, byStructure };
}

function recordValue(record, field) {
  const value = record?.[field];
  if (value !== null && value !== undefined && value !== '' && value !== 'NA') return value;
  const nested = record?.values?.[field];
  return nested !== null && nested !== undefined && nested !== '' && nested !== 'NA' ? nested : null;
}

function valueFromRecords(records, fields) {
  for (const record of records ?? []) {
    for (const field of fields) {
      const value = recordValue(record, field);
      if (value !== null) return value;
    }
  }
  return null;
}

function getPublishedValue(position, field, annotationByPosition, indexedArtifactDetails, fallbackFields = []) {
  const row = annotationByPosition.get(position);
  for (const candidate of [field, ...fallbackFields]) {
    const direct = row?.values?.[candidate];
    if (direct !== null && direct !== undefined && direct !== '' && direct !== 'NA') return direct;
  }

  const fields = [field, ...fallbackFields];
  const artifactTypes = field.startsWith('frustraiseq_')
    ? [FRUSTRATION_ARTIFACT_TYPES.sequence]
    : field.startsWith('structural_frustration_')
      ? [FRUSTRATION_ARTIFACT_TYPES.structural, FRUSTRATION_ARTIFACT_TYPES.primary]
      : [FRUSTRATION_ARTIFACT_TYPES.primary, FRUSTRATION_ARTIFACT_TYPES.structural];
  for (const artifactType of artifactTypes) {
    const records = frustrationRecordsAtPosition(indexedArtifactDetails, artifactType, position);
    const value = valueFromRecords(records, fields);
    if (value !== null) return value;
  }
  return null;
}

function numericPublishedValue(position, field, annotationByPosition, indexedArtifactDetails, fallbackFields = []) {
  return finiteAnnotationValue(getPublishedValue(position, field, annotationByPosition, indexedArtifactDetails, fallbackFields));
}

function formatValue(value) {
  const number = finiteAnnotationValue(value);
  if (number !== null) return formatScaleNumber(number);
  return String(value ?? 'Sin dato');
}

function readLabel(value) {
  const normalized = String(value ?? '').trim();
  if (!normalized || normalized.toUpperCase() === 'NA') return 'Sin dato publicado';
  return SECONDARY_STRUCTURE_LABELS[normalized] ?? SECONDARY_STRUCTURE_LABELS[normalized.toLowerCase()] ?? normalized;
}

function aaAtPosition(sequence, position) {
  const normalizedPosition = Number(position);
  const aa = Number.isInteger(normalizedPosition) && normalizedPosition > 0
    ? String(sequence ?? '')[normalizedPosition - 1] ?? ''
    : '';
  return {
    one: aa || '?',
    code: AA3[aa] ?? '',
    name: AA_NAMES[AA3[aa]] ?? 'Residuo',
  };
}

function formatResidueName(sequence, position, annotationByPosition) {
  if (!Number.isInteger(position) || position < 1) return 'Sin residuo seleccionado';
  const aa = aaAtPosition(sequence, position);
  const row = annotationByPosition.get(position);
  const reference = String(row?.aa_ref ?? aa.one).trim();
  return `${reference || aa.one}${position}`;
}

function valueDomain(values, field) {
  if (field === 'frustraiseq_entropy') return { ...FRUSTRAISEQ_ENTROPY_DOMAIN };
  if (field === 'frustraiseq_surprisal') return { ...FRUSTRAISEQ_SURPRISAL_DOMAIN };
  if (field.startsWith('frustraiseq_')) {
    const numbers = values.map((value) => finiteAnnotationValue(value)).filter((value) => value !== null);
    if (numbers.length > 1) {
      const min = Math.min(...numbers);
      const max = Math.max(...numbers);
      return max > min ? { min, max } : { min: min - 1, max: max + 1 };
    }
  }
  return null;
}

function requestCameraSync(cameraSyncRef, sourceId) {
  const sync = cameraSyncRef.current;
  if (!sync.enabled || sync.applying || performance.now() < sync.suspendUntil || !sync.cameras.has(sourceId)) return;
  sync.pendingSource = sourceId;
  if (sync.frame !== null) return;
  sync.frame = requestAnimationFrame(() => {
    sync.frame = null;
    const source = sync.cameras.get(sync.pendingSource);
    if (!sync.enabled || performance.now() < sync.suspendUntil || !source) return;
    const snapshot = source.getSnapshot();
    if (sameCameraSnapshot(snapshot, sync.lastSnapshot)) return;
    sync.lastSnapshot = captureCameraSnapshot(snapshot);
    sync.applying = true;
    try {
      for (const [panelId, camera] of sync.cameras.entries()) {
        if (panelId !== sync.pendingSource) camera.setState(snapshot, 0);
      }
    } finally {
      sync.applying = false;
    }
  });
}

function suspendCameraSync(cameraSyncRef, durationMs = CAMERA_SYNC_ACTION_GUARD_MS) {
  const sync = cameraSyncRef.current;
  sync.suspendUntil = Math.max(sync.suspendUntil, performance.now() + durationMs);
  sync.lastSnapshot = null;
  if (sync.frame !== null) {
    cancelAnimationFrame(sync.frame);
    sync.frame = null;
  }
}

function requestCameraSyncAfterAction(cameraSyncRef, sourceId, delayMs = CAMERA_SYNC_ACTION_GUARD_MS) {
  window.setTimeout(() => {
    const sync = cameraSyncRef.current;
    if (sync.enabled && performance.now() >= sync.suspendUntil) {
      sync.lastSnapshot = null;
      requestCameraSync(cameraSyncRef, sourceId);
    }
  }, delayMs);
}

function MetricScale({ methodKind, method, domain }) {
  const isStructural = methodKind === 'structure';
  const methodLabel = METHOD_OPTIONS[methodKind].find((option) => option.value === method)?.shortLabel ?? method;

  if (isStructural) {
    const upperCutoff = minimallyFrustratedCutoff(method);
    const items = [
      { key: 'highly_frustrated', label: 'Alta', detail: 'FI < −1,00' },
      { key: 'neutral', label: 'Neutral', detail: `−1,00 a ${formatValue(upperCutoff)}` },
      { key: 'minimally_frustrated', label: 'Mínima', detail: `FI > ${formatValue(upperCutoff)}` },
    ];

    return (
      <div class="frustration-metric-scale" aria-label={`Escala de ${methodLabel}`}>
        <div class="frustration-metric-scale-segments">
          {items.map((item) => (
            <span key={item.key} style={{ '--segment-color': FRUSTRATION_CLASS_INFO[item.key].color }}>
              <b>{item.label}</b>
              <small>{item.detail}</small>
            </span>
          ))}
        </div>
        <p>Umbrales de FI según <a href="https://doi.org/10.1038/s41467-023-43801-2" target="_blank" rel="noreferrer">Freiberger et al., 2023</a>.</p>
      </div>
    );
  }

  if (method === 'frustraiseq_index') {
    const upperCutoff = FRUSTRAISEQ_INDEX_MINIMALLY_FRUSTRATED_CUTOFF;
    const items = [
      { key: 'highly_frustrated', label: 'Alta', detail: 'Índice < −1,00' },
      { key: 'neutral', label: 'Neutral', detail: `−1,00 a ${formatValue(upperCutoff)}` },
      { key: 'minimally_frustrated', label: 'Mínima', detail: `Índice > ${formatValue(upperCutoff)}` },
    ];

    return (
      <div class="frustration-metric-scale" aria-label="Escala de clasificación FrustrAI-Seq">
        <div class="frustration-metric-scale-segments">
          {items.map((item) => (
            <span key={item.key} style={{ '--segment-color': FRUSTRATION_CLASS_INFO[item.key].color }}>
              <b>{item.label}</b>
              <small>{item.detail}</small>
            </span>
          ))}
        </div>
        <p>
          Clasificaciones publicadas por FrustrAI-Seq. <a href={FRUSTRAISEQ_REFERENCE_URL} target="_blank" rel="noreferrer">Publicación</a>.
        </p>
      </div>
    );
  }

  if (method === 'frustraiseq_entropy') {
    return (
      <div class="frustration-metric-scale frustration-metric-scale-fixed" aria-label="Escala de incertidumbre predictiva de FrustrAI-Seq">
        <strong class="frustration-metric-scale-heading">Incertidumbre predictiva de FrustrAI-Seq</strong>
        <div class="frustration-metric-scale-direction" aria-hidden="true">
          <span>Menor incertidumbre</span>
          <span>Mayor incertidumbre</span>
        </div>
        <span
          class="frustration-metric-scale-gradient frustration-metric-scale-gradient-entropy"
          style={{ '--scale-start': FRUSTRAISEQ_ENTROPY_COLORS[0], '--scale-middle': FRUSTRAISEQ_ENTROPY_COLORS[1], '--scale-end': FRUSTRAISEQ_ENTROPY_COLORS[2] }}
          aria-hidden="true"
        />
        <div class="frustration-metric-scale-ticks" aria-hidden="true">
          {['0', '0.25', '0.50', '0.75', '1'].map((tick) => <span key={tick}>{tick}</span>)}
        </div>
        <a class="frustration-metric-scale-source" href={FRUSTRAISEQ_REFERENCE_URL} target="_blank" rel="noreferrer" aria-label="Fuente de la escala de entropía">Fuente</a>
      </div>
    );
  }

  if (method === 'frustraiseq_surprisal') {
    return (
      <div class="frustration-metric-scale frustration-metric-scale-fixed" aria-label="Escala de desviación del índice respecto al aminoácido de referencia">
        <strong class="frustration-metric-scale-heading">Desviación del índice respecto al aminoácido de referencia</strong>
        <div class="frustration-metric-scale-direction" aria-hidden="true">
          <span>FI menor al esperado</span>
          <span>FI mayor al esperado</span>
        </div>
        <div class="frustration-metric-scale-bar-wrap">
          <span
            class="frustration-metric-scale-gradient frustration-metric-scale-gradient-surprisal"
            style={{ '--scale-start': FRUSTRAISEQ_SURPRISAL_COLORS[0], '--scale-middle': FRUSTRAISEQ_SURPRISAL_COLORS[1], '--scale-end': FRUSTRAISEQ_SURPRISAL_COLORS[2] }}
            aria-hidden="true"
          />
          <span class="frustration-metric-scale-marker" style={{ left: '16.6667%' }} aria-label="Marca exploratoria −2" />
          <span class="frustration-metric-scale-marker" style={{ left: '83.3333%' }} aria-label="Marca exploratoria +2" />
        </div>
        <div class="frustration-metric-scale-ticks frustration-metric-scale-ticks-divergent" aria-hidden="true">
          {['−3', '−2', '−1', '0', '+1', '+2', '+3'].map((tick) => <span key={tick}>{tick}</span>)}
        </div>
        <a class="frustration-metric-scale-source" href={FRUSTRAISEQ_REFERENCE_URL} target="_blank" rel="noreferrer" aria-label="Fuente de la escala de surprisal">Fuente</a>
      </div>
    );
  }

  const minValue = domain ? formatValue(domain.min) : 'Sin dato';
  const maxValue = domain ? formatValue(domain.max) : 'Sin dato';
  return (
    <div class="frustration-metric-scale" aria-label={`Escala numérica de ${methodLabel}`}>
      <div class="frustration-metric-scale-continuous">
        <span>{minValue}</span>
        <span
          class="frustration-metric-scale-gradient"
          style={{ '--scale-start': scaleColors[0], '--scale-middle': scaleColors[1], '--scale-end': scaleColors[2] }}
          aria-hidden="true"
        />
        <span>{maxValue}</span>
      </div>
      <p>Métrica numérica de FrustrAI-Seq; no hay cortes de clasificación publicados para {methodLabel}. <a href={FRUSTRAISEQ_REFERENCE_URL} target="_blank" rel="noreferrer">Fuente</a>.</p>
    </div>
  );
}

function sequenceRows(sequence, annotationByPosition, indexedArtifactDetails, method) {
  return [...String(sequence ?? '')].map((aa, index) => {
    const position = index + 1;
    const value = numericPublishedValue(position, method, annotationByPosition, indexedArtifactDetails);
    const publishedClass = method === 'frustraiseq_index'
      ? getPublishedValue(position, 'frustraiseq_class', annotationByPosition, indexedArtifactDetails)
      : null;
    return { position, aa, value, publishedClass };
  });
}

function ComparisonStructurePanel({
  panelId,
  methodKind,
  method,
  structureUrl,
  structurePending,
  structureError: structureLoadError,
  structureFormatValue,
  structureLabel,
  colorMap,
  domain,
  structureByCanonical,
  canonicalByStructure,
  selectedPosition,
  selectedResidueLabel,
  onPick,
  cameraSyncRef,
  cameraSyncEnabled,
}) {
  const hostRef = useRef(null);
  const viewerRef = useRef(null);
  const themeNameRef = useRef('');
  const themeRegistryRef = useRef(null);
  const themeFactoryRef = useRef(null);
  const themeProviderRef = useRef(null);
  const themeRevisionRef = useRef(0);
  const colorMapRef = useRef(colorMap);
  const canonicalByStructureRef = useRef(canonicalByStructure);
  const onPickRef = useRef(onPick);
  const cameraSyncEnabledRef = useRef(cameraSyncEnabled);
  const [viewerState, setViewerState] = useState(structureLoadError ? 'error' : structureUrl || structurePending ? 'loading' : 'unavailable');
  const [viewerError, setViewerError] = useState(structureLoadError ? 'No se pudo descargar la estructura molecular publicada.' : '');

  colorMapRef.current = colorMap;
  canonicalByStructureRef.current = canonicalByStructure;
  onPickRef.current = onPick;
  cameraSyncEnabledRef.current = cameraSyncEnabled;
  cameraSyncRef.current.enabled = cameraSyncEnabled;

  const applyTheme = async () => {
    const viewer = viewerRef.current;
    const theme = themeNameRef.current;
    if (!viewer?.plugin || !theme) return;
    try {
      await viewer.plugin.dataTransaction(async () => {
        for (const entry of viewer.plugin.managers.structure.hierarchy.current.structures) {
          await viewer.plugin.managers.structure.component.updateRepresentationsTheme(entry.components, {
            color: theme,
          });
        }
      });
      viewer.plugin.canvas3d?.requestDraw?.();
    } catch {
      // The structure remains readable with Mol*'s last valid theme.
    }
  };

  const createThemeProvider = (name) => {
    const baseFactory = themeFactoryRef.current;
    if (!baseFactory) return null;
    let themedFactory;
    themedFactory = (ctx, props) => ({
      ...baseFactory(ctx, props),
      // Mol* compares created themes by factory identity. A fresh wrapper
      // forces a representation update when the color map changes.
      factory: themedFactory,
    });
    return {
      name,
      label: 'Frustración por residuo',
      category: 'Residue display',
      factory: themedFactory,
      getParams: () => ({}),
      defaultValues: {},
      isApplicable: () => true,
    };
  };

  useEffect(() => {
    const viewer = viewerRef.current;
    const registry = themeRegistryRef.current;
    const factory = themeFactoryRef.current;
    if (!viewer?.plugin || !registry || !factory) return;
    const previousProvider = themeProviderRef.current;
    themeRevisionRef.current += 1;
    const themeName = `frustration-comparison-${panelId}-${themeRevisionRef.current}`;
    const provider = createThemeProvider(themeName);
    if (!provider) return;
    try {
      registry.add(provider);
      themeNameRef.current = themeName;
      themeProviderRef.current = provider;
      void applyTheme().then(() => {
        if (previousProvider && themeProviderRef.current === provider) {
          try {
            registry.remove(previousProvider);
          } catch {
            // A disposed viewer may already have released its theme registry.
          }
        }
      });
    } catch {
      // Keep the current theme if a viewer is being disposed during a metric change.
    }
  }, [colorMap]);

  useEffect(() => {
    setViewerState(structureLoadError ? 'error' : structurePending || structureUrl ? 'loading' : 'unavailable');
    setViewerError(structureLoadError ? 'No se pudo descargar la estructura molecular publicada.' : '');
    if (!structureUrl || !hostRef.current) {
      return undefined;
    }
    let disposed = false;
    let subscription;
    let cameraSubscription;
    let viewerInstance = null;

    const disposeViewer = (viewer = viewerInstance) => {
      if (!viewer) return;
      try {
        viewer.dispose?.();
      } catch {
        // Disposal can race with a viewer that already released its WebGL context.
      }
      if (viewerRef.current === viewer) viewerRef.current = null;
      if (viewerInstance === viewer) viewerInstance = null;
    };

    async function loadViewer() {
      try {
        const [{ Viewer }, structureLib] = await Promise.all([
          import('molstar/lib/apps/viewer/app'),
          import('molstar/lib/mol-model/structure'),
        ]);
        if (disposed || !hostRef.current) return;
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
          viewportBackgroundColor: '#f7f9f8',
          pixelScale: 1,
          resolutionMode: 'auto',
        });
        viewerInstance = viewer;
        viewerRef.current = viewer;
        if (disposed) {
          disposeViewer(viewer);
          return;
        }
        viewer.plugin.canvas3d?.setProps({
          ...getZoomOptimizedCanvas3dProps(),
          interaction: { maxFps: 60 },
          camera: { helper: { axes: { name: 'off', params: {} } } },
          cameraResetDurationMs: 180,
          cameraResetEasing: 'cubic-out',
          cameraResetTrajectory: 'linear',
        });
        await viewer.loadStructureFromUrl(structureUrl, structureFormatValue, false, { label: structureLabel });
        if (disposed) {
          disposeViewer(viewer);
          return;
        }

        const canvas3d = viewer.plugin.canvas3d;
        const boundingSphere = canvas3d?.boundingSphereVisible ?? canvas3d?.boundingSphere;
        canvas3d?.requestResize?.();
        if (canvas3d?.camera && boundingSphere?.radius > 0) {
          canvas3d.camera.focus(boundingSphere.center, boundingSphere.radius * 0.25, 180);
        }

        const registry = viewer.plugin.representation.structure.themes.colorThemeRegistry;
        const factory = (ctx, props) => ({
          granularity: 'group',
          props,
          description: 'Frustración por residuo',
          color: (location) => {
            try {
              if (!structureLib.StructureElement.Location.is(location)) return hexToColorInt('#b8bec5');
              const chain = String(
                structureLib.StructureProperties.chain.auth_asym_id(location)
                || structureLib.StructureProperties.chain.label_asym_id(location)
                || 'A',
              );
              const authSeqId = Number(
                structureLib.StructureProperties.residue.auth_seq_id(location)
                || structureLib.StructureProperties.residue.label_seq_id(location),
              );
              const insCode = String(structureLib.StructureProperties.residue.pdbx_PDB_ins_code?.(location) || '').trim();
              return hexToColorInt(colorMapRef.current.get(structureResidueKey(chain, authSeqId, insCode)) ?? '#b8bec5');
            } catch {
              return hexToColorInt('#b8bec5');
            }
          },
        });
        themeRegistryRef.current = registry;
        themeFactoryRef.current = factory;
        const themeName = `frustration-comparison-${panelId}-${themeRevisionRef.current}`;
        const provider = createThemeProvider(themeName);
        try {
          if (provider) {
            registry.add(provider);
            themeNameRef.current = themeName;
            themeProviderRef.current = provider;
          }
        } catch {
          // Hot reload can leave this provider registered.
        }
        const camera = canvas3d?.camera;
        cameraSubscription = camera?.changed?.subscribe(() => {
          if (cameraSyncEnabledRef.current) requestCameraSync(cameraSyncRef, panelId);
        });
        if (camera) {
          cameraSyncRef.current.cameras.set(panelId, camera);
          requestCameraSync(cameraSyncRef, panelId);
        }
        await applyTheme();
        if (disposed) {
          disposeViewer(viewer);
          return;
        }

        subscription = viewer.subscribe(viewer.plugin.behaviors.interaction.click, (event) => {
          const loci = event?.current?.loci;
          if (!structureLib.StructureElement.Loci.is(loci)) return;
          let position = null;
          structureLib.StructureElement.Loci.forEachLocation(loci, (location) => {
            if (position !== null) return;
            const chain = String(
              structureLib.StructureProperties.chain.auth_asym_id(location)
              || structureLib.StructureProperties.chain.label_asym_id(location)
              || 'A',
            );
            const authSeqId = Number(
              structureLib.StructureProperties.residue.auth_seq_id(location)
              || structureLib.StructureProperties.residue.label_seq_id(location),
            );
            const insCode = String(structureLib.StructureProperties.residue.pdbx_PDB_ins_code?.(location) || '').trim();
            position = canonicalByStructureRef.current.get(structureResidueKey(chain, authSeqId, insCode)) ?? null;
          });
          if (position !== null) onPickRef.current(position);
        });
        if (!disposed) setViewerState('ready');
      } catch (error) {
        console.error(error);
        if (!disposed) {
          setViewerError('No se pudo interpretar la estructura molecular publicada.');
          setViewerState('error');
        }
      }
    }

    void loadViewer();
    return () => {
      disposed = true;
      subscription?.unsubscribe?.();
      cameraSubscription?.unsubscribe?.();
      cameraSyncRef.current.cameras.delete(panelId);
      disposeViewer();
      themeNameRef.current = '';
      themeRegistryRef.current = null;
      themeFactoryRef.current = null;
      themeProviderRef.current = null;
    };
  }, [panelId, structureFormatValue, structureLabel, structureLoadError, structurePending, structureUrl]);

  useEffect(() => {
    cameraSyncRef.current.enabled = cameraSyncEnabled;
    if (cameraSyncEnabled) requestCameraSync(cameraSyncRef, panelId);
  }, [cameraSyncEnabled, panelId]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    if (!Number.isInteger(selectedPosition)) {
      try {
        suspendCameraSync(cameraSyncRef);
        viewer.plugin.managers.interactivity.lociSelects.deselectAll();
        viewer.plugin.managers.camera.reset?.(undefined, CAMERA_RESET_DURATION_MS, CAMERA_RESET_OPTIONS);
        requestCameraSyncAfterAction(cameraSyncRef, panelId);
      } catch {
        // Resetting the camera is an enhancement; the viewer remains usable if it races disposal.
      }
      return;
    }
    const key = structureByCanonical.get(selectedPosition);
    if (!key) return;
    const [chain, residueNumber, insertionCode] = key.split('|');
    const focusResidue = () => {
      try {
        suspendCameraSync(cameraSyncRef);
        viewer.plugin.managers.interactivity.lociSelects.deselectAll();
        viewer.structureInteractivity({
          elements: {
            auth_asym_id: chain,
            beg_auth_seq_id: Number(residueNumber),
            end_auth_seq_id: Number(residueNumber),
            pdbx_PDB_ins_code: insertionCode || undefined,
          },
          action: ['select', 'focus'],
          focusOptions: RESIDUE_FOCUS_OPTIONS,
        });
        requestCameraSyncAfterAction(cameraSyncRef, panelId, RESIDUE_FOCUS_OPTIONS.durationMs + 120);
      } catch {
        // Selection is an enhancement; the sequence and table remain usable.
      }
    };
    const focusTimer = window.setTimeout(focusResidue, 80);
    return () => window.clearTimeout(focusTimer);
  }, [selectedPosition, structureByCanonical, viewerState]);

  return (
    <div
      class="frustration-structure-viewport"
      role="group"
      aria-label="Vista molecular coloreada por la métrica de frustración"
    >
      <div
        ref={hostRef}
        class="frustration-molstar-host"
        role="img"
        aria-label={structureUrl ? 'Estructura molecular coloreada' : structureLoadError ? 'No se pudo descargar la estructura molecular' : 'Sin estructura molecular disponible'}
      />
      <MetricScale methodKind={methodKind} method={method} domain={domain} />
      {viewerState === 'loading' && !structureUrl && (
        <StatePanel
          kind="loading"
          compact
          title="Cargando estructura"
          description="Descargando el modelo publicado de la corrida."
          className="frustration-viewport-state"
        />
      )}
      {viewerState === 'unavailable' && (
        <StatePanel
          kind="empty"
          compact
          icon="box"
          title="Estructura no disponible"
          description="No hay un PDB o mmCIF publicado para esta corrida."
          className="frustration-viewport-state"
        />
      )}
      {viewerState === 'error' && (
        <StatePanel
          kind="error"
          compact
          title="No se pudo cargar la estructura"
          description={viewerError}
          className="frustration-viewport-state"
        />
      )}
      {Number.isInteger(selectedPosition) && (
        <div class="frustration-structure-selection" aria-live="polite">
          <strong>{selectedResidueLabel || selectedPosition}</strong>
          <span>Residuo seleccionado</span>
        </div>
      )}
    </div>
  );
}

function SequenceStrip({
  sequence,
  selectedPosition,
  onSelect,
  structureValues,
  sequenceValues,
  sequenceClasses,
  structureMethod,
  sequenceMethod,
  structureDomain,
  sequenceDomain,
}) {
  return (
    <div
      class="frustration-sequence-scroll"
      role="group"
      aria-label="Secuencia canónica; selecciona un residuo para comparar sus valores"
      tabIndex={0}
    >
      <div class="frustration-sequence-track">
        {[...String(sequence ?? '')].map((aa, index) => {
          const position = index + 1;
          const selected = selectedPosition === position;
          const structuralColor = colorForFrustrationMetric({
            value: structureValues.get(position),
            field: structureMethod,
            domain: structureDomain,
          });
          const sequenceColor = colorForFrustrationMetric({
            value: sequenceValues.get(position),
            field: sequenceMethod,
            domain: sequenceDomain,
            publishedClass: sequenceClasses.get(position),
          });
          return (
            <button
              key={`${position}-${aa}`}
              type="button"
              class={`frustration-sequence-residue ${selected ? 'is-selected' : ''}`}
              style={{ '--structural-color': structuralColor, '--sequence-color': sequenceColor }}
              onClick={() => onSelect(position)}
              aria-pressed={selected}
              title={`${aa}${position} · Frustratometer ${formatValue(structureValues.get(position))} · FrustrAI-Seq ${formatValue(sequenceValues.get(position))}`}
            >
              <span class="frustration-sequence-position">{position % 10 === 0 || selected ? position : ''}</span>
              <span>{aa}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function MethodCard({
  title,
  methodKind,
  method,
  onMethodChange,
  structureProps,
  selectedPosition,
  onPick,
  structureUrl,
  structurePending,
  structureError,
  structureFormatValue,
  structureLabel,
  selectedResidueLabel,
  domain,
  cameraSyncRef,
  cameraSyncEnabled,
}) {
  return (
    <article class="frustration-method-card">
      <header class="frustration-method-head">
        <h2>{title}</h2>
        <MetricSelect
          id={`frustration-${methodKind}-metric`}
          label={`Métrica de ${title}`}
          options={METHOD_OPTIONS[methodKind]}
          value={method}
          onChange={onMethodChange}
        />
      </header>
      <ComparisonStructurePanel
        panelId={methodKind}
        methodKind={methodKind}
        method={method}
        structureUrl={structureUrl}
        structurePending={structurePending}
        structureError={structureError}
        structureFormatValue={structureFormatValue}
        structureLabel={structureLabel}
        colorMap={structureProps.colorMap}
        domain={structureProps.domain}
        structureByCanonical={structureProps.byCanonical}
        canonicalByStructure={structureProps.byStructure}
        selectedPosition={selectedPosition}
        selectedResidueLabel={selectedResidueLabel}
        onPick={onPick}
        cameraSyncRef={cameraSyncRef}
        cameraSyncEnabled={cameraSyncEnabled}
      />
    </article>
  );
}

function CameraSyncButton({ enabled, onToggle }) {
  const label = enabled ? 'Desactivar sincronización de cámaras' : 'Activar sincronización de cámaras';
  return (
    <button
      type="button"
      class={`frustration-camera-sync ${enabled ? 'is-active' : ''}`}
      aria-label={label}
      aria-pressed={enabled}
      title={label}
      onClick={onToggle}
    >
      <span aria-hidden="true">⇄</span>
      <span class="sr-only">{enabled ? 'Cámaras sincronizadas' : 'Cámaras independientes'}</span>
    </button>
  );
}

function DisclosureSection({ title, meta, description, open = false, children, className = '' }) {
  return (
    <details class={`frustration-disclosure ${className}`} open={open}>
      <summary>
        <span>{title}</span>
        <b>{meta}</b>
      </summary>
      <div class="frustration-disclosure-body">
        {description && <p>{description}</p>}
        {children}
      </div>
    </details>
  );
}

function HotspotRow({ row, sequence, annotationByPosition, onSelect }) {
  return (
    <button type="button" class="frustration-hotspot-row" onClick={() => onSelect(row.position)}>
      <span class="frustration-hotspot-name">
        <strong>{formatResidueName(sequence, row.position, annotationByPosition)}</strong>
        {row.secondaryStructure && <small>{readLabel(row.secondaryStructure)}</small>}
      </span>
      <b class="frustration-hotspot-value">{formatValue(row.value)}</b>
      <span class="frustration-hotspot-link">Ver en estructura</span>
    </button>
  );
}

function EvidenceRow({ label, value, swatch = '' }) {
  return (
    <div class="frustration-evidence-row">
      <dt>{label}</dt>
      <dd>{swatch && <span class="frustration-evidence-swatch" style={{ '--swatch-color': swatch }} aria-hidden="true" />}{value}</dd>
    </div>
  );
}

function AnnotationPanel({
  sequence,
  selectedPosition,
  onSelect,
  annotationByPosition,
  indexedArtifactDetails,
  structuralValues,
  sequenceValues,
  sequenceClasses,
  structureMethod,
  sequenceMethod,
  structuralDomain,
  sequenceDomain,
}) {
  const hasSelectedPosition = Number.isInteger(selectedPosition) && selectedPosition > 0;
  const selectedRow = hasSelectedPosition ? annotationByPosition.get(selectedPosition) ?? null : null;
  const selectedAa = hasSelectedPosition
    ? aaAtPosition(sequence, selectedPosition)
    : { one: '—', code: '', name: 'Selecciona un residuo' };
  const [hotspotSource, setHotspotSource] = useState(HOTSPOT_SOURCE_OPTIONS[0].value);
  const highlyFrustratedRows = useMemo(() => {
    const rows = [];
    for (let position = 1; position <= String(sequence ?? '').length; position += 1) {
      const structuralValueAtPosition = structuralValues.get(position);
      const sequenceIndexValue = numericPublishedValue(position, 'frustraiseq_index', annotationByPosition, indexedArtifactDetails);
      const value = hotspotSource === 'frustraiseq' ? sequenceIndexValue : structuralValueAtPosition;
      const publishedClass = hotspotSource === 'frustraiseq'
        ? normalizeFrustrationClass(getPublishedValue(position, 'frustraiseq_class', annotationByPosition, indexedArtifactDetails))
        : null;
      const isHighlyFrustrated = hotspotSource === 'frustraiseq'
        ? publishedClass === 'highly_frustrated'
          || (publishedClass === 'unknown' && classifyFrustrAISeqIndex(value) === 'highly_frustrated')
        : classifyFrustratometerValue(value, structureMethod) === 'highly_frustrated';
      if (!isHighlyFrustrated || finiteAnnotationValue(value) === null) continue;
      rows.push({
        position,
        value,
        secondaryStructure: annotationByPosition.get(position)?.values?.secondary_structure,
      });
    }
    return rows.sort((left, right) => left.value - right.value);
  }, [annotationByPosition, indexedArtifactDetails, hotspotSource, sequence, structuralValues, structureMethod]);
  const hotspotRows = highlyFrustratedRows.slice(0, 5);
  const structuralValue = hasSelectedPosition ? structuralValues.get(selectedPosition) : null;
  const sequenceValue = hasSelectedPosition ? sequenceValues.get(selectedPosition) : null;
  const sequenceMetricRows = [
    { field: 'frustraiseq_index', label: 'Índice' },
    { field: 'frustraiseq_entropy', label: 'Entropía' },
    { field: 'frustraiseq_surprisal', label: 'Surprisal' },
  ].map((metric) => ({
    ...metric,
    value: hasSelectedPosition
      ? numericPublishedValue(selectedPosition, metric.field, annotationByPosition, indexedArtifactDetails)
      : null,
  }));
  const structuralClass = classifyFrustratometerValue(structuralValue, structureMethod);
  const structuralColor = colorForFrustrationMetric({
    value: structuralValue,
    field: structureMethod,
    domain: structuralDomain,
  });
  const sequenceColor = colorForFrustrationMetric({
    value: sequenceValue,
    field: sequenceMethod,
    domain: sequenceDomain,
    publishedClass: sequenceClasses.get(selectedPosition),
  });
  const residueColor = hasSelectedPosition && finiteAnnotationValue(structuralValue) !== null
    ? structuralColor
    : sequenceColor;
  const ensembleMean = hasSelectedPosition
    ? numericPublishedValue(selectedPosition, 'frustratometer_mean', annotationByPosition, indexedArtifactDetails)
    : null;
  const ensembleSd = hasSelectedPosition
    ? numericPublishedValue(selectedPosition, 'frustratometer_sd', annotationByPosition, indexedArtifactDetails)
    : null;
  const secondaryStructure = selectedRow?.values?.secondary_structure;
  const uniprotDomain = String(selectedRow?.values?.uniprot_domain ?? '').trim();
  const hasUniprotDomain = Boolean(uniprotDomain && uniprotDomain.toUpperCase() !== 'NA');
  const structureLabel = METHOD_OPTIONS.structure.find((option) => option.value === structureMethod)?.shortLabel ?? 'FI';
  const hasPublishedValue = [structuralValue, ensembleMean, ensembleSd, ...sequenceMetricRows.map((metric) => metric.value)].some((value) => finiteAnnotationValue(value) !== null)
    || Boolean(secondaryStructure);
  const hotspotDescription = hotspotSource === 'frustraiseq'
    ? 'Residuos cuya clase publicada por FrustrAI-Seq es altamente frustrada. Se ordenan por el índice predicho.'
    : `Residuos cuya métrica ${structureLabel} de Frustratometer tiene FI < −1,00. Los valores más negativos aparecen primero.`;
  return (
    <aside class="frustration-annotations" aria-label="Anotaciones de frustración">
      <div class="frustration-annotations-body">
        <section class="frustration-residue-summary" aria-label="Residuo seleccionado">
          <div class="frustration-residue-letter">{selectedAa.one}</div>
          <div class="frustration-residue-name" style={hasSelectedPosition ? { '--residue-color': residueColor } : undefined}><strong>{selectedAa.code ? `${selectedAa.code} - ${selectedAa.name}` : selectedAa.name}</strong><span>{hasSelectedPosition ? formatResidueName(sequence, selectedPosition, annotationByPosition) : 'Selecciona un residuo'}</span></div>
          <strong class="frustration-residue-position">{hasSelectedPosition ? selectedPosition : '—'}</strong>
        </section>

        {hasUniprotDomain && (
          <section class="frustration-functional-context">
            <h3>Contexto funcional</h3>
            <div class="frustration-context-row"><span>◇</span><span>Dominio UniProt</span><strong>{uniprotDomain}</strong></div>
          </section>
        )}

        <section class="frustration-values" aria-label="Valores publicados del residuo">
          <h3>Valores publicados</h3>
          {hasSelectedPosition && hasPublishedValue ? (
            <dl class="frustration-evidence-list">
              {finiteAnnotationValue(structuralValue) !== null && <EvidenceRow label={`Frustratometer · ${structureLabel}`} value={formatValue(structuralValue)} />}
              {finiteAnnotationValue(structuralValue) !== null && <EvidenceRow label="Clase estructural" value={frustrationClassLabel(structuralClass)} swatch={FRUSTRATION_CLASS_INFO[structuralClass].color} />}
              {sequenceMetricRows
                .filter((metric) => finiteAnnotationValue(metric.value) !== null)
                .map((metric) => <EvidenceRow key={metric.field} label={`FrustrAI-Seq · ${metric.label}`} value={formatValue(metric.value)} />)}
              {finiteAnnotationValue(ensembleMean) !== null && <EvidenceRow label="Media del ensemble" value={formatValue(ensembleMean)} />}
              {finiteAnnotationValue(ensembleSd) !== null && <EvidenceRow label="Desviación del ensemble" value={formatValue(ensembleSd)} />}
              {secondaryStructure && <EvidenceRow label="Estructura secundaria" value={readLabel(secondaryStructure)} />}
            </dl>
          ) : (
            <p class="frustration-no-data">{hasSelectedPosition ? 'No hay valores publicados para este residuo.' : 'Selecciona un residuo para ver sus valores.'}</p>
          )}
        </section>

        <DisclosureSection
          title="Altamente frustrados"
          meta={highlyFrustratedRows.length ? `${highlyFrustratedRows.length} residuos` : 'Sin datos'}
          description={hotspotDescription}
          open
        >
          <div class="frustration-hotspot-controls">
            <span>Fuente de clasificación</span>
            <MetricSelect
              id="frustration-hotspot-source"
              label="Fuente de clasificación de altamente frustrados"
              options={HOTSPOT_SOURCE_OPTIONS}
              value={hotspotSource}
              onChange={setHotspotSource}
            />
          </div>
          {hotspotRows.length ? (
            <div class="frustration-hotspot-list">
              {hotspotRows.map((row) => <HotspotRow key={row.position} row={row} sequence={sequence} annotationByPosition={annotationByPosition} onSelect={onSelect} />)}
            </div>
          ) : (
            <p class="frustration-no-data">No hay residuos clasificados como altamente frustrados para esta métrica.</p>
          )}
        </DisclosureSection>
      </div>
    </aside>
  );
}

export default function FrustrationComparison({ proteinId }) {
  const runId = typeof window === 'undefined' ? '' : new URLSearchParams(window.location.search).get('run') ?? '';
  const [protein, setProtein] = useState(null);
  const [run, setRun] = useState(null);
  const [annotations, setAnnotations] = useState([]);
  const [annotationsTruncated, setAnnotationsTruncated] = useState(false);
  const [artifactDetails, setArtifactDetails] = useState({});
  const [structureUrl, setStructureUrl] = useState('');
  const [structureLoadState, setStructureLoadState] = useState('idle');
  const [state, setState] = useState('loading');
  const [error, setError] = useState('');
  const [structureMethod, setStructureMethod] = useState(METHOD_OPTIONS.structure[0].value);
  const [sequenceMethod, setSequenceMethod] = useState(METHOD_OPTIONS.sequence[0].value);
  const [selectedPosition, setSelectedPosition] = useState(null);
  const [cameraSyncEnabled, setCameraSyncEnabled] = useState(true);
  const cameraSyncRef = useRef({
    enabled: true,
    applying: false,
    cameras: new Map(),
    frame: null,
    lastSnapshot: null,
    pendingSource: null,
    suspendUntil: 0,
  });
  const selectionInitializedRef = useRef(false);

  const toggleSelectedPosition = (position) => {
    setSelectedPosition((current) => (current === position ? null : position));
  };

  useEffect(() => {
    let active = true;
    let timer;
    let controller;
    let latestRun = null;
    let latestAnnotationResultSignature = '';
    let annotationRefreshVersion = 0;
    let reconnectAttempts = 0;
    let finished = false;
    setAnnotationsTruncated(false);

    const applyRun = (nextRun) => {
      if (!active) return;
      latestRun = nextRun;
      setRun(nextRun);
    };

    const refreshAnnotations = async (nextRun, reportError = false) => {
      const signature = annotationResultSignature(nextRun);
      if (signature === latestAnnotationResultSignature) return;
      const previousSignature = latestAnnotationResultSignature;
      latestAnnotationResultSignature = signature;
      const version = ++annotationRefreshVersion;
      try {
        const annotationData = await getAllFrustrationAnnotations(runId);
        if (!active || version !== annotationRefreshVersion || signature !== latestAnnotationResultSignature) return;
        setAnnotations(annotationData.rows ?? []);
        setAnnotationsTruncated(Boolean(annotationData.truncated));
      } catch (requestError) {
        if (active && version === annotationRefreshVersion && signature === latestAnnotationResultSignature) {
          latestAnnotationResultSignature = previousSignature;
          if (reportError) setError(userErrorMessage(requestError, 'No se pudieron actualizar las anotaciones de frustración.'));
        }
      }
    };

    const refreshSnapshot = async () => {
      if (!runId) return;
      try {
        const nextRun = await getRun(runId);
        applyRun(nextRun);
        await refreshAnnotations(nextRun, true);
        if (TERMINAL_RUN_STATUSES.has(nextRun.status)) {
          finished = true;
          controller?.abort();
        }
      } catch (requestError) {
        if (active) setError(userErrorMessage(requestError, 'No se pudo actualizar la vista de frustración.'));
      }
    };

    const schedulePolling = (delay = 2_000) => {
      if (!active || finished || !runId || reconnectAttempts >= 4) return;
      reconnectAttempts += 1;
      timer = window.setTimeout(async () => {
        await refreshSnapshot();
        if (active && !finished && !TERMINAL_RUN_STATUSES.has(latestRun?.status)) connectStream();
      }, delay);
    };

    const connectStream = async () => {
      if (!active || finished || !runId || TERMINAL_RUN_STATUSES.has(latestRun?.status)) return;
      controller?.abort();
      controller = new AbortController();
      try {
        await subscribeRunEvents(runId, {
          signal: controller.signal,
          onSnapshot: (snapshot) => {
            reconnectAttempts = 0;
            applyRun(snapshot);
            void refreshAnnotations(snapshot).catch(() => undefined);
            if (TERMINAL_RUN_STATUSES.has(snapshot.status)) {
              finished = true;
              controller.abort();
            }
          },
        });
        if (active && !finished) schedulePolling();
      } catch (streamError) {
        if (active && !controller.signal.aborted && !finished) {
          setError(userErrorMessage(streamError, 'La actualización en vivo se desconectó; se reintentará automáticamente.'));
          schedulePolling(4_000);
        }
      }
    };

    async function load() {
      if (!runId) {
        setState('error');
        setError('Selecciona una corrida desde el historial o la vista de progreso para consultar sus resultados.');
        return;
      }
      try {
        const [proteinData, runData, annotationData] = await Promise.all([
          getProtein(proteinId),
          getRun(runId),
          getAllFrustrationAnnotations(runId),
        ]);
        if (!active) return;
        setProtein(proteinData);
        setAnnotations(annotationData.rows ?? []);
        setAnnotationsTruncated(Boolean(annotationData.truncated));
        latestAnnotationResultSignature = annotationResultSignature(runData);
        applyRun(runData);
        setState('ready');
        if (!TERMINAL_RUN_STATUSES.has(runData.status)) void connectStream();
        else finished = true;
      } catch (requestError) {
        if (!active) return;
        setState('error');
        setError(userErrorMessage(requestError, 'No se pudo cargar la vista de frustración.'));
      }
    }

    void load();
    return () => {
      active = false;
      finished = true;
      controller?.abort();
      if (timer) window.clearTimeout(timer);
    };
  }, [proteinId, runId]);

  useEffect(() => {
    let active = true;
    setArtifactDetails({});
    if (!run) return () => { active = false; };
    loadAnalysisArtifactDetails(run, 'frustration', getArtifactBlob)
      .then((details) => {
        if (active) setArtifactDetails(details);
      })
      .catch(() => {
        if (active) setArtifactDetails({});
      });
    return () => { active = false; };
  }, [run?.id, run?.stages?.map((stage) => (stage.artifacts ?? []).map((artifact) => artifact.id).join(',')).join(':')]);

  const structureRequest = useMemo(() => structureSource(run), [run]);
  useEffect(() => {
    let active = true;
    setStructureUrl('');
    setStructureLoadState(structureRequest ? 'loading' : 'unavailable');
    if (!structureRequest) return () => { active = false; };
    const lease = acquireStructureUrl(structureRequest.id, structureRequest.loadUrl);
    lease.promise
      .then((url) => {
        if (active) {
          setStructureUrl(url);
          setStructureLoadState('ready');
        }
      })
      .catch(() => {
        if (active) {
          setStructureUrl('');
          setStructureLoadState('error');
        }
      });
    return () => {
      active = false;
      lease.release();
    };
  }, [structureRequest?.id]);

  const annotationByPosition = useMemo(() => mergeAnnotationRows(annotations), [annotations]);
  const indexedArtifactDetails = useMemo(() => indexFrustrationArtifactDetails(artifactDetails), [artifactDetails]);
  const structureMapping = run?.configuration?.structure_mapping ?? {};
  const mapping = useMemo(() => structureMappingMaps(structureMapping), [structureMapping]);
  const structuralRows = useMemo(
    () => sequenceRows(protein?.sequence, annotationByPosition, indexedArtifactDetails, structureMethod),
    [annotationByPosition, indexedArtifactDetails, protein?.sequence, structureMethod],
  );
  const sequenceRowsData = useMemo(
    () => sequenceRows(protein?.sequence, annotationByPosition, indexedArtifactDetails, sequenceMethod),
    [annotationByPosition, indexedArtifactDetails, protein?.sequence, sequenceMethod],
  );
  const structuralValues = useMemo(() => new Map(structuralRows.map((row) => [row.position, row.value])), [structuralRows]);
  const sequenceValues = useMemo(() => new Map(sequenceRowsData.map((row) => [row.position, row.value])), [sequenceRowsData]);
  const sequenceClasses = useMemo(() => new Map(sequenceRowsData.map((row) => [row.position, row.publishedClass])), [sequenceRowsData]);
  const structuralDomain = useMemo(() => valueDomain(structuralRows.map((row) => row.value), structureMethod), [structuralRows, structureMethod]);
  const sequenceDomain = useMemo(() => valueDomain(sequenceRowsData.map((row) => row.value), sequenceMethod), [sequenceRowsData, sequenceMethod]);
  const structureColorMap = useMemo(() => {
    const colors = new Map();
    for (const [position, key] of mapping.byCanonical.entries()) {
      colors.set(key, colorForFrustrationMetric({
        value: structuralValues.get(position),
        field: structureMethod,
        domain: structuralDomain,
      }));
    }
    return colors;
  }, [mapping.byCanonical, structuralDomain, structuralValues, structureMethod]);
  const sequenceColorMap = useMemo(() => {
    const colors = new Map();
    for (const [position, key] of mapping.byCanonical.entries()) {
      colors.set(key, colorForFrustrationMetric({
        value: sequenceValues.get(position),
        field: sequenceMethod,
        domain: sequenceDomain,
        publishedClass: sequenceClasses.get(position),
      }));
    }
    return colors;
  }, [mapping.byCanonical, sequenceClasses, sequenceDomain, sequenceValues, sequenceMethod]);
  const availablePositions = useMemo(() => {
    const candidates = structuralRows.filter((row) => row.value !== null).sort((left, right) => left.value - right.value);
    return candidates.length ? candidates : sequenceRowsData.filter((row) => row.value !== null);
  }, [sequenceRowsData, structuralRows]);

  useEffect(() => {
    selectionInitializedRef.current = false;
    setSelectedPosition(null);
  }, [proteinId, runId]);

  useEffect(() => {
    if (selectionInitializedRef.current || selectedPosition !== null || !availablePositions.length) return;
    selectionInitializedRef.current = true;
    setSelectedPosition(availablePositions[0].position);
  }, [availablePositions, selectedPosition]);

  if (state === 'loading') {
    return <section class="frustration-page"><StatePanel kind="loading" fill title="Cargando frustración" description="Consultando la corrida y sus resultados publicados." /></section>;
  }
  if (state === 'error') {
    return <section class="frustration-page"><StatePanel kind="error" fill title="No se pudo cargar la vista de frustración" description={error} /></section>;
  }

  const structureProps = { byCanonical: mapping.byCanonical, byStructure: mapping.byStructure, colorMap: structureColorMap, domain: structuralDomain };
  const sequenceProps = { byCanonical: mapping.byCanonical, byStructure: mapping.byStructure, colorMap: sequenceColorMap, domain: sequenceDomain };

  return (
    <section class="frustration-page" aria-label="Frustración">
      <div class="frustration-chain-card">
        <SequenceStrip
          sequence={protein?.sequence}
          selectedPosition={selectedPosition}
          onSelect={toggleSelectedPosition}
          structureValues={structuralValues}
          sequenceValues={sequenceValues}
          sequenceClasses={sequenceClasses}
          structureMethod={structureMethod}
          sequenceMethod={sequenceMethod}
          structureDomain={structuralDomain}
          sequenceDomain={sequenceDomain}
        />
      </div>

      {error && <p class="frustration-live-message" role="status">{error}</p>}
      {annotationsTruncated && <p class="frustration-live-message" role="status">La vista tiene cobertura parcial de anotaciones porque la API alcanzó el límite de páginas consultadas. Los valores ausentes se mantienen como “Sin dato publicado”.</p>}

      <div class="frustration-workspace">
        <div class="frustration-methods">
          <MethodCard
            title="Frustratometer"
            methodKind="structure"
            method={structureMethod}
            onMethodChange={setStructureMethod}
            structureProps={structureProps}
            selectedPosition={selectedPosition}
            onPick={toggleSelectedPosition}
            structureUrl={structureUrl}
            structurePending={structureLoadState === 'loading'}
            structureError={structureLoadState === 'error'}
            structureFormatValue={structureRequest?.format}
            structureLabel={structureRequest?.label}
            selectedResidueLabel={selectedPosition === null ? '—' : formatResidueName(protein?.sequence, selectedPosition, annotationByPosition)}
            cameraSyncRef={cameraSyncRef}
            cameraSyncEnabled={cameraSyncEnabled}
          />
          <MethodCard
            title="FrustrAI-Seq"
            methodKind="sequence"
            method={sequenceMethod}
            onMethodChange={setSequenceMethod}
            structureProps={sequenceProps}
            selectedPosition={selectedPosition}
            onPick={toggleSelectedPosition}
            structureUrl={structureUrl}
            structurePending={structureLoadState === 'loading'}
            structureError={structureLoadState === 'error'}
            structureFormatValue={structureRequest?.format}
            structureLabel={structureRequest?.label}
            selectedResidueLabel={selectedPosition === null ? '—' : formatResidueName(protein?.sequence, selectedPosition, annotationByPosition)}
            cameraSyncRef={cameraSyncRef}
            cameraSyncEnabled={cameraSyncEnabled}
          />
          <CameraSyncButton enabled={cameraSyncEnabled} onToggle={() => setCameraSyncEnabled((current) => !current)} />
        </div>
        <AnnotationPanel
          sequence={protein?.sequence}
          selectedPosition={selectedPosition}
          onSelect={toggleSelectedPosition}
          annotationByPosition={annotationByPosition}
          indexedArtifactDetails={indexedArtifactDetails}
          structuralValues={structuralValues}
          sequenceValues={sequenceValues}
          sequenceClasses={sequenceClasses}
          structureMethod={structureMethod}
          sequenceMethod={sequenceMethod}
          structuralDomain={structuralDomain}
          sequenceDomain={sequenceDomain}
        />
      </div>
    </section>
  );
}
