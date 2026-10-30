import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import StatePanel from '@shared/components/feedback/StatePanel.jsx';
import AuthenticatedArtifactLink from '@features/artifacts/components/AuthenticatedArtifactLink.tsx';
import { artifactDisplayName } from '@features/artifacts/artifact-display.js';
import {
  getAnnotations,
  getArtifactBlob,
  getArtifactObjectUrl,
  getProtein,
  getRun,
  listRuns,
  getUploadObjectUrl,
  subscribeRunEvents,
} from '@shared/api/client';
import { userErrorMessage } from '@shared/lib/error-presentation';
import { runUpdatesFinished } from '@features/runs/run-updates.js';
import {
  loadDdgVariantDetails,
  loadAnalysisArtifactDetails,
  structureMappingFromArtifactRows,
} from '@features/annotations/analysis-artifacts.js';
import { captureCameraSnapshot, sameCameraSnapshot } from '@features/annotations/camera-snapshot.js';
import { isStructureArtifact, structureFormat } from '@features/annotations/structure-format.js';
import { getZoomOptimizedCanvas3dProps } from '@features/annotations/zoom-rendering.js';
import { waitForCanvasDraw } from '@features/annotations/components/shared/canvas-render-readiness.js';
import {
  AA3,
  AA_NAMES,
  hexToColorInt,
  mergeAnnotationRows,
  readableValue,
} from '@features/annotations/viewer-presentation.js';
import {
  formatPublishedNumber,
  formatVariantNumber,
  indexVariantsByPosition,
  initialVariantSelection,
  isScientistVisibleVariantArtifact,
  mergePublishedVariants,
  publishedDdg,
  publishedTextValue,
  replicateCount,
  variantDetailRows,
  variantKey,
  variantLabel,
  variantRecordFor,
} from '@features/annotations/variant-presentation.js';
import { structureSelectionItems } from '@features/annotations/topology-presentation.js';
import {
  canCompareStructureSources,
  areStructureSourcesReady,
  distinctStructureOptions,
  matchingMutantRun,
  parseVariantStructureArchive,
} from '@features/annotations/variant-structure-presentation.js';
import { acquireStructureUrl } from '@features/annotations/structure-url-cache.js';
import 'molstar/build/viewer/molstar.css';
import '@features/annotations/styles/variant-comparison.css';

const RESIDUE_FOCUS_OPTIONS = {
  extraRadius: 4,
  durationMs: 180,
  easing: 'cubic-out',
  trajectory: 'linear',
};
const CAMERA_RESET_DURATION_MS = 180;
const CAMERA_SYNC_ACTION_GUARD_MS = 480;
const CAMERA_SELECTION_FOCUS_DELAY_MS = 80;
const STRUCTURE_RETRY_DELAY_MS = 250;
const STRUCTURE_NEUTRAL_COLOR = '#73808a';
const REFERENCE_HIGHLIGHT_COLOR = '#2f6ed7';
const MUTANT_HIGHLIGHT_COLOR = '#c9362b';

function allArtifacts(run) {
  const items = [...(run?.run_artifacts ?? []), ...(run?.stages ?? []).flatMap((stage) => stage.artifacts ?? [])];
  const seen = new Set();
  return items.filter((artifact) => {
    if (!artifact?.id || seen.has(artifact.id)) return false;
    seen.add(artifact.id);
    return true;
  });
}

function sourceFromArtifact(artifact, {
  kind = 'reference',
  variantKeyValue = '',
  selectionLabel = 'Original',
} = {}) {
  if (!artifact) return null;
  return {
    key: kind === 'reference' ? 'reference' : `structure:${artifact.id}`,
    kind,
    variantKey: variantKeyValue,
    selectionLabel,
    id: artifact.id,
    artifact,
    label: artifactDisplayName(artifact),
    format: structureFormat(artifact),
    loadUrl: () => getArtifactObjectUrl(artifact.id),
  };
}

function artifactNames(artifact) {
  return [artifact?.artifact_type, artifact?.display_name, artifact?.download_filename, artifact?.filename, artifact?.name]
    .filter(Boolean)
    .join(' ');
}

function isConcreteStructureArtifact(artifact) {
  return isStructureArtifact(artifact);
}

function isVariantStructureArtifact(artifact) {
  return /(mutant|mutated|variant)/.test(artifactNames(artifact).toLowerCase())
    && isConcreteStructureArtifact(artifact);
}

function isVariantDirectoryArtifact(artifact) {
  const mediaType = String(artifact?.media_type ?? '').toLowerCase();
  const filename = String(artifact?.download_filename ?? '').toLowerCase();
  return artifact?.artifact_type === 'variant_dir'
    && (mediaType.includes('zip') || mediaType.includes('tar') || filename.endsWith('.zip') || filename.endsWith('.tar'));
}

function artifactVariantKey(artifact) {
  const directKey = variantKey(artifact);
  if (directKey) return directKey;
  const candidate = artifactNames(artifact);
  const match = candidate.match(/(?:^|[^A-Z])([ACDEFGHIKLMNPQRSTVWY]\d+[ACDEFGHIKLMNPQRSTVWY])(?:$|[^A-Z])/i);
  return match ? variantKey({ variant_id: match[1] }) : '';
}

function structureSources(run, variants = []) {
  const artifacts = allArtifacts(run);
  const preferredTypes = [
    'model_cif',
    'foldx_relaxed_pdb',
    'selected_reference_pdb',
    'rosettamp_relaxed_pdb',
  ];
  const referenceArtifact = preferredTypes
    .map((type) => artifacts.find((item) => item.artifact_type === type))
    .find(Boolean) ?? artifacts.find((item) => isConcreteStructureArtifact(item) && !isVariantStructureArtifact(item));
  const upload = (run?.uploads ?? []).find((item) => item.input_type === 'structure');
  const reference = referenceArtifact
    ? sourceFromArtifact(referenceArtifact)
    : upload
      ? {
          key: 'reference-upload',
          kind: 'reference',
          variantKey: '',
          selectionLabel: 'Original',
          id: upload.id,
          artifact: null,
          label: upload.original_filename,
          format: structureFormat(upload),
          loadUrl: () => getUploadObjectUrl(upload.id),
        }
      : null;

  const variantSources = artifacts
    .filter(isVariantStructureArtifact)
    .map((artifact) => {
      const publishedVariantKey = artifactVariantKey(artifact);
      const publishedVariant = variants.find((variant) => variantKey(variant) === publishedVariantKey);
      return sourceFromArtifact(artifact, {
        kind: 'variant',
        variantKeyValue: publishedVariantKey,
        selectionLabel: publishedVariant ? variantLabel(publishedVariant) : 'Variante publicada',
      });
    })
    .filter(Boolean);

  const variantDirectory = artifacts.find(isVariantDirectoryArtifact) ?? null;

  return { reference, variants: variantSources, variantDirectory };
}

function mutantRunStructureSource(run, variants) {
  const tracking = run?.external_tracking;
  const key = variantKey({ variant_id: tracking?.variant });
  const variant = variants.find((item) => variantKey(item) === key);
  const preferredTypes = [
    'model_cif',
    'foldx_relaxed_pdb',
    'selected_reference_pdb',
    'rosettamp_relaxed_pdb',
  ];
  const artifacts = allArtifacts(run);
  const model = preferredTypes
    .map((type) => artifacts.find((artifact) => artifact.artifact_type === type && isConcreteStructureArtifact(artifact)))
    .find(Boolean) ?? artifacts.find(isConcreteStructureArtifact);
  if (!key || !variant || !model) return null;
  return sourceFromArtifact(model, {
    kind: 'variant',
    variantKeyValue: key,
    selectionLabel: variantLabel(variant),
  });
}

function sourceFromArchiveMember(artifact, member, variants) {
  const publishedVariant = variants.find((variant) => variantKey(variant) === member.variantKey);
  if (!publishedVariant) return null;
  return {
    key: `structure:${artifact.id}:${member.path}`,
    kind: 'variant',
    variantKey: member.variantKey,
    selectionLabel: variantLabel(publishedVariant),
    id: `${artifact.id}:${member.path}`,
    artifact,
    label: member.path,
    format: member.format,
    isArchiveMember: true,
    memberPath: member.path,
    loadUrl: () => Promise.resolve(URL.createObjectURL(member.blob)),
  };
}

function useVariantDirectorySources(artifact, variants) {
  const [sources, setSources] = useState([]);
  const variantSignature = variants.map((variant) => variantKey(variant)).filter(Boolean).join('|');

  useEffect(() => {
    let active = true;
    setSources([]);
    if (!artifact || !variantSignature) return () => { active = false; };

    getArtifactBlob(artifact.id, 'original')
      .then((blob) => blob.arrayBuffer())
      .then((buffer) => parseVariantStructureArchive(buffer, variants))
      .then((members) => {
        if (!active) return;
        setSources(members.map((member) => sourceFromArchiveMember(artifact, member, variants)).filter(Boolean));
      })
      .catch(() => {
        if (active) setSources([]);
      });

    return () => { active = false; };
  }, [artifact?.id, variantSignature]);

  return sources;
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

function structureKeyFromLocation(structureLib, location) {
  const chain = String(
    structureLib.StructureProperties.chain.auth_asym_id(location)
      || structureLib.StructureProperties.chain.label_asym_id(location)
      || 'A',
  );
  const sequenceId = Number(
    structureLib.StructureProperties.residue.auth_seq_id(location)
      || structureLib.StructureProperties.residue.label_seq_id(location),
  );
  const insertionCode = String(structureLib.StructureProperties.residue.pdbx_PDB_ins_code?.(location) || '').trim();
  return structureResidueKey(chain, sequenceId, insertionCode);
}

function selectedResidueFocusSphere(structureLib, viewer, items) {
  const structureEntry = viewer?.plugin?.managers?.structure?.hierarchy?.current?.structures
    ?.find((entry) => entry?.cell?.obj?.data);
  const structure = structureEntry?.cell?.obj?.data;
  const structureElement = structureLib?.StructureElement;
  if (!structure || !structureElement?.Loci || !items.length) return null;
  try {
    const loci = structureElement.Loci.fromSchema(structure, { items });
    if (structureElement.Loci.isEmpty(loci)) return null;
    const residueSphere = structureElement.Loci.getBoundingSphere(loci);
    if (!residueSphere) return null;
    const center = [0, 0, 0];
    let alphaCarbonCount = 0;
    structureElement.Loci.forEachLocation(loci, (location) => {
      if (String(structureLib.StructureProperties.atom.label_atom_id(location)).trim().toUpperCase() !== 'CA') return;
      const position = location.unit.conformation.position(location.element, [0, 0, 0]);
      center[0] += position[0];
      center[1] += position[1];
      center[2] += position[2];
      alphaCarbonCount += 1;
    });
    if (!alphaCarbonCount) return residueSphere;
    return {
      center: center.map((value) => value / alphaCarbonCount),
      radius: residueSphere.radius,
    };
  } catch {
    return null;
  }
}

const ZERO_CAMERA_OFFSET = Object.freeze([0, 0, 0]);

function translateCameraSnapshot(snapshot, offset) {
  const [x = 0, y = 0, z = 0] = offset ?? ZERO_CAMERA_OFFSET;
  if (x === 0 && y === 0 && z === 0) return snapshot;
  const translate = (vector) => new Float32Array([
    Number(vector?.[0] ?? 0) + x,
    Number(vector?.[1] ?? 0) + y,
    Number(vector?.[2] ?? 0) + z,
  ]);
  return {
    ...snapshot,
    position: translate(snapshot.position),
    target: translate(snapshot.target),
  };
}

function updateCameraSyncOffsets(cameraSyncRef) {
  const sync = cameraSyncRef.current;
  const referenceTarget = sync.cameras.get('first')?.getSnapshot?.()?.target;
  const mutantTarget = sync.cameras.get('second')?.getSnapshot?.()?.target;
  if (!referenceTarget || !mutantTarget) return;
  const nextMutantOffset = Array.from(mutantTarget, (value, index) => Number(value) - Number(referenceTarget[index]));
  const currentMutantOffset = sync.cameraOffsets.get('second') ?? ZERO_CAMERA_OFFSET;
  const offsetChanged = nextMutantOffset.some((value, index) => Math.abs(value - currentMutantOffset[index]) > 1e-4);
  sync.cameraOffsets.set('first', ZERO_CAMERA_OFFSET);
  sync.cameraOffsets.set('second', nextMutantOffset);
  if (offsetChanged) {
    sync.lastSnapshot = null;
    sync.appliedSnapshots.clear();
  }
}

function requestCameraSync(cameraSyncRef, sourceId) {
  const sync = cameraSyncRef.current;
  const otherPanelId = sourceId === 'first' ? 'second' : 'first';
  if (!sync.enabled || sync.applying || performance.now() < sync.suspendUntil
    || !sync.cameras.has(sourceId) || !sync.cameras.has(otherPanelId)) return;
  sync.pendingSource = sourceId;
  if (sync.frame !== null) return;
  sync.frame = requestAnimationFrame(() => {
    sync.frame = null;
    const source = sync.cameras.get(sync.pendingSource);
    if (!sync.enabled || performance.now() < sync.suspendUntil || !source) return;
    const snapshot = source.getSnapshot();
    const appliedSnapshot = sync.appliedSnapshots.get(sync.pendingSource);
    if (appliedSnapshot && sameCameraSnapshot(snapshot, appliedSnapshot)) return;
    sync.appliedSnapshots.delete(sync.pendingSource);
    const sourceOffset = sync.cameraOffsets.get(sync.pendingSource) ?? ZERO_CAMERA_OFFSET;
    const canonicalSnapshot = translateCameraSnapshot(snapshot, sourceOffset.map((value) => -value));
    if (sameCameraSnapshot(canonicalSnapshot, sync.lastSnapshot)) return;
    sync.lastSnapshot = captureCameraSnapshot(canonicalSnapshot);
    sync.applying = true;
    try {
      for (const [panelId, camera] of sync.cameras.entries()) {
        if (panelId === sync.pendingSource) continue;
        const targetOffset = sync.cameraOffsets.get(panelId) ?? ZERO_CAMERA_OFFSET;
        camera.setState(translateCameraSnapshot(canonicalSnapshot, targetOffset), 0);
        // Mol* can constrain the target camera to its own radiusMax. Keep
        // the actual applied state so its changed event is not echoed back.
        sync.appliedSnapshots.set(panelId, captureCameraSnapshot(camera.getSnapshot()));
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
  sync.appliedSnapshots.clear();
  if (sync.frame !== null) {
    cancelAnimationFrame(sync.frame);
    sync.frame = null;
  }
}

function requestCameraSyncAfterAction(cameraSyncRef, sourceId, delayMs = CAMERA_SYNC_ACTION_GUARD_MS) {
  const sync = cameraSyncRef.current;
  sync.postActionTimers?.forEach((timer) => window.clearTimeout(timer));
  sync.postActionTimers = new Set();

  const apply = (retry = 0) => {
    const sync = cameraSyncRef.current;
    const otherPanelId = sourceId === 'first' ? 'second' : 'first';
    if (!sync.enabled || !sync.cameras.has(sourceId) || !sync.cameras.has(otherPanelId)) return;
    const remaining = sync.suspendUntil - performance.now();
    if (remaining > 0) {
      const timer = window.setTimeout(() => {
        sync.postActionTimers?.delete(timer);
        apply(retry);
      }, remaining + 16);
      sync.postActionTimers?.add(timer);
      return;
    }
    if (sourceId === 'first') updateCameraSyncOffsets(cameraSyncRef);
    sync.lastSnapshot = null;
    requestCameraSync(cameraSyncRef, sourceId);
    if (retry < 2) {
      const timer = window.setTimeout(() => {
        sync.postActionTimers?.delete(timer);
        apply(retry + 1);
      }, 220);
      sync.postActionTimers?.add(timer);
    }
  };
  const timer = window.setTimeout(() => {
    sync.postActionTimers?.delete(timer);
    apply();
  }, delayMs);
  sync.postActionTimers.add(timer);
}

function useStructureUrl(source) {
  const [loaded, setLoaded] = useState({ sourceId: '', url: '', state: source ? 'loading' : 'unavailable' });
  const [requestRevision, setRequestRevision] = useState(0);
  useEffect(() => {
    let active = true;
    const sourceId = source?.id ?? '';
    setLoaded({ sourceId, url: '', state: source ? 'loading' : 'unavailable' });
    if (!source) return () => { active = false; };
    const lease = acquireStructureUrl(sourceId, source.loadUrl);
    lease.promise
      .then((nextUrl) => {
        if (active) {
          setLoaded({ sourceId, url: nextUrl, state: 'ready' });
        }
      })
      .catch(() => {
        if (active) {
          setLoaded({ sourceId, url: '', state: 'error' });
        }
      });
    return () => {
      active = false;
      lease.release();
    };
  }, [requestRevision, source?.id]);
  const retry = () => setRequestRevision((current) => current + 1);
  return {
    ...(loaded.sourceId === (source?.id ?? '')
      ? { url: loaded.url, state: loaded.state }
      : { url: '', state: source ? 'loading' : 'unavailable' }),
    retry,
  };
}

function VariantStructurePanel({
  panelId,
  title,
  source,
  sourceOptions,
  selectedSourceKey,
  onSourceChange,
  structureUrl,
  structureState,
  retryStructureUrl,
  structureMapping,
  selectedPosition,
  selectionRevision,
  highlightColor,
  onPick,
  onStructureReady,
  cameraSyncRef,
  cameraSyncEnabled,
}) {
  const sourceRole = source?.kind === 'variant' ? 'Mutante' : title;
  const sourceRoleCode = source?.kind === 'variant' ? 'ALT' : 'REF';
  const hostRef = useRef(null);
  const viewerRef = useRef(null);
  const themeRegistryRef = useRef(null);
  const themeFactoryRef = useRef(null);
  const themeProviderRef = useRef(null);
  const themeNameRef = useRef('');
  const themeRevisionRef = useRef(0);
  const structureLibRef = useRef(null);
  const loadQueueRef = useRef(Promise.resolve());
  const loadRevisionRef = useRef(0);
  const hasLoadedStructureRef = useRef(false);
  const structureSnapshotCacheRef = useRef(new Map());
  const mappingRef = useRef(structureMapping.byStructure);
  const selectedPositionRef = useRef(selectedPosition);
  const highlightColorRef = useRef(highlightColor);
  const onPickRef = useRef(onPick);
  const cameraSyncEnabledRef = useRef(cameraSyncEnabled);
  const appliedSelectionTokenRef = useRef('');
  const [viewerReady, setViewerReady] = useState(false);
  const [loadRetry, setLoadRetry] = useState(0);
  const [viewerState, setViewerState] = useState(structureState === 'error' ? 'error' : structureState === 'ready' ? 'loading' : structureState);
  const [viewerError, setViewerError] = useState('');
  const themeSourceIdRef = useRef(source?.id ?? '');
  const onStructureReadyRef = useRef(onStructureReady);

  mappingRef.current = structureMapping.byStructure;
  selectedPositionRef.current = selectedPosition;
  highlightColorRef.current = highlightColor;
  onPickRef.current = onPick;
  cameraSyncEnabledRef.current = cameraSyncEnabled;
  cameraSyncRef.current.enabled = cameraSyncEnabled;
  onStructureReadyRef.current = onStructureReady;

  const applyTheme = async () => {
    const viewer = viewerRef.current;
    const theme = themeNameRef.current;
    if (!viewer?.plugin || !theme) return;
    try {
      await viewer.plugin.dataTransaction(async () => {
        for (const entry of viewer.plugin.managers.structure.hierarchy.current.structures) {
          await viewer.plugin.managers.structure.component.updateRepresentationsTheme(entry.components, { color: theme });
        }
      });
      viewer.plugin.canvas3d?.requestDraw?.();
    } catch {
      // The model remains readable with the last valid Mol* theme.
    }
  };

  const createThemeProvider = (name) => {
    const baseFactory = themeFactoryRef.current;
    if (!baseFactory) return null;
    let themedFactory;
    themedFactory = (ctx, props) => ({
      ...baseFactory(ctx, props),
      factory: themedFactory,
    });
    return {
      name,
      label: 'Comparación de variante',
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
    const sourceId = source?.id ?? '';
    if (themeSourceIdRef.current !== sourceId) {
      themeSourceIdRef.current = sourceId;
      return;
    }
    themeRevisionRef.current += 1;
    const provider = createThemeProvider(`variant-comparison-${panelId}-${themeRevisionRef.current}`);
    if (!provider) return;
    try {
      const queuedTheme = loadQueueRef.current.then(async () => {
        if (viewerRef.current !== viewer) return;
        const previousProvider = themeProviderRef.current;
        try {
          registry.add(provider);
          themeNameRef.current = provider.name;
          themeProviderRef.current = provider;
          await applyTheme();
          if (previousProvider && themeProviderRef.current === provider) {
            registry.remove(previousProvider);
          }
        } catch {
          // Keep the current theme if a selection changes during disposal.
        }
      });
      loadQueueRef.current = queuedTheme.catch(() => undefined);
    } catch {
      // Keep the current theme if a selection changes during disposal.
    }
  }, [highlightColor, panelId, selectedPosition, source?.id, structureMapping]);

  useEffect(() => {
    let disposed = false;
    let subscription;
    let cameraSubscription;
    let viewerInstance = null;

    const disposeViewer = (viewer = viewerInstance) => {
      if (!viewer) return;
      try { viewer.dispose?.(); } catch { /* Mol* may have released its context */ }
      if (viewerRef.current === viewer) viewerRef.current = null;
      if (viewerInstance === viewer) viewerInstance = null;
    };

    async function createViewer() {
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
        structureLibRef.current = structureLib;
        if (disposed) { disposeViewer(viewer); return; }
        viewer.plugin.canvas3d?.setProps({
          ...getZoomOptimizedCanvas3dProps(),
          interaction: { maxFps: 60 },
          // This panel restores or focuses the camera explicitly after structure loads.
          // Mol*'s scene-commit auto-reset can otherwise run after camera sync and move it again.
          camera: { manualReset: true, helper: { axes: { name: 'off', params: {} } } },
          renderer: { selectColor: hexToColorInt(highlightColor) },
          cameraResetDurationMs: 180,
          cameraResetEasing: 'cubic-out',
          cameraResetTrajectory: 'linear',
        });

        const registry = viewer.plugin.representation.structure.themes.colorThemeRegistry;
        const factory = (ctx, props) => ({
          granularity: 'group',
          props,
          description: 'Comparación de variante',
          color: (location) => {
            try {
              if (!structureLib.StructureElement.Location.is(location)) return hexToColorInt(STRUCTURE_NEUTRAL_COLOR);
              const key = structureKeyFromLocation(structureLib, location);
              const canonicalPosition = mappingRef.current.get(key);
              return hexToColorInt(canonicalPosition === selectedPositionRef.current ? highlightColorRef.current : STRUCTURE_NEUTRAL_COLOR);
            } catch {
              return hexToColorInt(STRUCTURE_NEUTRAL_COLOR);
            }
          },
        });
        themeRegistryRef.current = registry;
        themeFactoryRef.current = factory;

        const camera = viewer.plugin.canvas3d?.camera;
        cameraSubscription = camera?.changed?.subscribe(() => {
          if (cameraSyncEnabledRef.current) requestCameraSync(cameraSyncRef, panelId);
        });
        subscription = viewer.subscribe(viewer.plugin.behaviors.interaction.click, (event) => {
          const loci = event?.current?.loci;
          if (!structureLib.StructureElement.Loci.is(loci)) return;
          let position = null;
          structureLib.StructureElement.Loci.forEachLocation(loci, (location) => {
            if (position !== null) return;
            position = mappingRef.current.get(structureKeyFromLocation(structureLib, location)) ?? null;
          });
          if (position !== null) onPickRef.current(position);
        });
        if (!disposed) {
          setViewerReady(true);
          if (!source) setViewerState('unavailable');
        }
      } catch (error) {
        console.error(error);
        if (!disposed) {
          onStructureReadyRef.current?.(panelId, source?.id ?? '', false);
          setViewerError('No se pudo interpretar la estructura molecular publicada.');
          setViewerState('error');
        }
      }
    }

    void createViewer();
    return () => {
      disposed = true;
      loadRevisionRef.current += 1;
      subscription?.unsubscribe?.();
      cameraSubscription?.unsubscribe?.();
      cameraSyncRef.current.cameras.delete(panelId);
      cameraSyncRef.current.appliedSnapshots.delete(panelId);
      disposeViewer();
      setViewerReady(false);
      hasLoadedStructureRef.current = false;
      structureSnapshotCacheRef.current.clear();
      structureLibRef.current = null;
      themeNameRef.current = '';
      themeRegistryRef.current = null;
      themeFactoryRef.current = null;
      themeProviderRef.current = null;
      onStructureReadyRef.current?.(panelId, source?.id ?? '', false);
    };
  }, [panelId]);

  useEffect(() => {
    const canvas3d = viewerRef.current?.plugin?.canvas3d;
    if (!canvas3d) return;
    canvas3d.setProps({ renderer: { selectColor: hexToColorInt(highlightColor) } });
  }, [highlightColor, viewerReady]);

  useEffect(() => {
    if (structureState === 'error') {
      setViewerState('error');
      setViewerError('No se pudo descargar la estructura molecular publicada.');
    } else if (!source) {
      setViewerState('unavailable');
      setViewerError('');
    } else if (!structureUrl) {
      setViewerState('loading');
      setViewerError('');
    }
  }, [source?.id, structureState, structureUrl]);

  useEffect(() => {
    const viewer = viewerRef.current;
    const structureLib = structureLibRef.current;
    if (!source || !structureUrl || !viewerReady || !viewer || !structureLib || !hostRef.current) return undefined;
    let active = true;
    const renderController = new AbortController();
    const revision = ++loadRevisionRef.current;
    setViewerState('loading');
    setViewerError('');
    onStructureReadyRef.current?.(panelId, source.id, false);
    suspendCameraSync(cameraSyncRef);
    cameraSyncRef.current.cameras.delete(panelId);
    cameraSyncRef.current.appliedSnapshots.delete(panelId);

    const load = async () => {
      try {
        if (!active || revision !== loadRevisionRef.current) return;
        const camera = viewer.plugin.canvas3d?.camera;
        const canvas3d = viewer.plugin.canvas3d;
        const mutantLoadUsesReferenceCamera = cameraSyncEnabledRef.current && panelId === 'second';
        const previousCameraSnapshot = hasLoadedStructureRef.current ? camera?.getSnapshot?.() : null;
        await viewer.plugin.clear();
        if (!active || revision !== loadRevisionRef.current) return;
        const drawBaseline = canvas3d?.didDraw?.value;
        const renderReady = waitForCanvasDraw(canvas3d, { signal: renderController.signal, drawBaseline });
        // Handle a timeout while the CIF request is still in flight; it is
        // surfaced below when the load pipeline awaits this promise.
        renderReady.catch(() => undefined);
        const cachedSnapshot = structureSnapshotCacheRef.current.get(source.id);
        if (cachedSnapshot) {
          await viewer.plugin.runTask(viewer.plugin.state.data.setSnapshot(cachedSnapshot));
        } else {
          try {
            await viewer.loadStructureFromUrl(structureUrl, source.format ?? 'pdb', false, { label: source.label });
          } catch {
            if (!active || revision !== loadRevisionRef.current) return;
            await new Promise((resolve) => window.setTimeout(resolve, STRUCTURE_RETRY_DELAY_MS));
            if (!active || revision !== loadRevisionRef.current) return;
            await viewer.plugin.clear();
            await viewer.loadStructureFromUrl(structureUrl, source.format ?? 'pdb', false, { label: source.label });
          }
          if (active && revision === loadRevisionRef.current) {
            structureSnapshotCacheRef.current.delete(source.id);
            structureSnapshotCacheRef.current.set(source.id, viewer.plugin.state.data.getSnapshot());
            while (structureSnapshotCacheRef.current.size > 4) {
              structureSnapshotCacheRef.current.delete(structureSnapshotCacheRef.current.keys().next().value);
            }
          }
        }
        if (!active || revision !== loadRevisionRef.current) return;

        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        if (!active || revision !== loadRevisionRef.current) return;

        canvas3d?.requestResize?.();
        if (canvas3d?.camera && previousCameraSnapshot && !mutantLoadUsesReferenceCamera) {
          canvas3d.camera.setState(previousCameraSnapshot, 0);
        } else if (canvas3d?.camera) {
          viewer.plugin.managers.camera.reset?.(undefined, CAMERA_RESET_DURATION_MS, {
            easing: 'cubic-out',
            trajectory: 'linear',
          });
        }
        hasLoadedStructureRef.current = true;

        const registry = themeRegistryRef.current;
        const previousProvider = themeProviderRef.current;
        themeRevisionRef.current += 1;
        const provider = createThemeProvider(`variant-comparison-${panelId}-${themeRevisionRef.current}`);
        if (registry && provider) {
          try {
            registry.add(provider);
            themeNameRef.current = provider.name;
            themeProviderRef.current = provider;
            if (previousProvider && previousProvider !== provider) {
              try { registry.remove(previousProvider); } catch { /* viewer may be disposing */ }
            }
          } catch { /* keep the neutral Mol* theme if registration races a reload */ }
        }
        await applyTheme();
        if (!active || revision !== loadRevisionRef.current) return;
        canvas3d?.requestResize?.();
        canvas3d?.requestDraw?.();
        await renderReady;
        if (!active || revision !== loadRevisionRef.current) return;
        if (canvas3d?.camera) cameraSyncRef.current.cameras.set(panelId, canvas3d.camera);
        setViewerState('ready');
        onStructureReadyRef.current?.(panelId, source.id, true);
        // While synced, the reference panel owns camera changes. Loading a new
        // mutant structure must not push its independently restored camera back
        // onto the reference panel.
        const syncSourceId = mutantLoadUsesReferenceCamera ? 'first' : panelId;
        requestCameraSyncAfterAction(cameraSyncRef, syncSourceId, mutantLoadUsesReferenceCamera ? 0 : CAMERA_SYNC_ACTION_GUARD_MS);
      } catch (error) {
        console.error(error);
        if (active && revision === loadRevisionRef.current) {
          onStructureReadyRef.current?.(panelId, source.id, false);
          setViewerError('No se pudo interpretar la estructura molecular publicada.');
          setViewerState('error');
        }
      }
    };

    const queuedLoad = loadQueueRef.current.then(load, load);
    loadQueueRef.current = queuedLoad.catch(() => undefined);
    return () => {
      active = false;
      renderController.abort();
      loadRevisionRef.current += 1;
      suspendCameraSync(cameraSyncRef);
      cameraSyncRef.current.cameras.delete(panelId);
      cameraSyncRef.current.appliedSnapshots.delete(panelId);
      onStructureReadyRef.current?.(panelId, source?.id ?? '', false);
    };
  }, [loadRetry, panelId, source?.format, source?.id, source?.label, structureUrl, viewerReady]);

  useEffect(() => {
    cameraSyncRef.current.enabled = cameraSyncEnabled;
    if (cameraSyncEnabled && panelId === 'first') {
      updateCameraSyncOffsets(cameraSyncRef);
      requestCameraSync(cameraSyncRef, 'first');
    }
  }, [cameraSyncEnabled, panelId]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || viewerState !== 'ready' || structureState !== 'ready') return;
    const selectionToken = `${source?.id ?? ''}:${selectionRevision}:${Number.isInteger(selectedPosition) ? selectedPosition : 'none'}`;
    if (selectionToken === appliedSelectionTokenRef.current) return;
    if (!Number.isInteger(selectedPosition)) {
      try {
        viewer.plugin.managers.interactivity.lociSelects.deselectAll();
        if (cameraSyncEnabledRef.current) {
          suspendCameraSync(cameraSyncRef, CAMERA_RESET_DURATION_MS + 40);
        }
        viewer.plugin.managers.camera.reset?.(undefined, CAMERA_RESET_DURATION_MS, { easing: 'cubic-out', trajectory: 'linear' });
        if (!cameraSyncEnabledRef.current || panelId === 'first') {
          requestCameraSyncAfterAction(cameraSyncRef, panelId, CAMERA_RESET_DURATION_MS + 40);
        }
        appliedSelectionTokenRef.current = selectionToken;
      } catch { /* camera reset is an enhancement */ }
      return;
    }
    const items = structureSelectionItems(structureMapping.byCanonical, selectedPosition, selectedPosition);
    if (!items.length) {
      // Keep the token pending while the mapping artifact is still loading.
      if (structureMapping.byCanonical.size > 0) appliedSelectionTokenRef.current = selectionToken;
      return;
    }
    if (selectionRevision === 0) {
      appliedSelectionTokenRef.current = selectionToken;
      return;
    }
    const focusTimer = window.setTimeout(() => {
      try {
        viewer.plugin.managers.interactivity.lociSelects.deselectAll();
        viewer.structureInteractivity({ elements: { items }, action: ['select'] });
        const focusSphere = selectedResidueFocusSphere(structureLibRef.current, viewer, items);
        if (focusSphere) {
          viewer.plugin.managers.camera.focusSphere(focusSphere, RESIDUE_FOCUS_OPTIONS);
        } else {
          viewer.structureInteractivity({
            elements: { items },
            action: ['focus'],
            focusOptions: RESIDUE_FOCUS_OPTIONS,
          });
        }
        appliedSelectionTokenRef.current = selectionToken;
        if (cameraSyncEnabledRef.current && panelId === 'first') {
          requestCameraSyncAfterAction(
            cameraSyncRef,
            panelId,
            CAMERA_SELECTION_FOCUS_DELAY_MS + RESIDUE_FOCUS_OPTIONS.durationMs + 40,
          );
        }
      } catch { /* selection remains available in the sequence and panel */ }
    }, CAMERA_SELECTION_FOCUS_DELAY_MS);
    if (cameraSyncEnabledRef.current) {
      suspendCameraSync(
        cameraSyncRef,
        CAMERA_SELECTION_FOCUS_DELAY_MS + RESIDUE_FOCUS_OPTIONS.durationMs + 16,
      );
    }
    return () => window.clearTimeout(focusTimer);
  }, [panelId, selectedPosition, selectionRevision, source?.id, structureMapping, structureState, structureUrl, viewerState]);

  return (
    <article class="variant-structure-card">
      <header class="variant-structure-head">
        <h2>{sourceRole}</h2>
        {sourceOptions.length > 1 ? (
          <VariantSelect
            id={`variant-structure-${panelId}`}
            label={`Modelo mostrado en ${sourceRole}`}
            options={sourceOptions}
            value={selectedSourceKey}
            onChange={onSourceChange}
          />
        ) : (
          <span>{source?.label ?? 'Estructura publicada'}</span>
        )}
      </header>
      <div class="variant-structure-viewport">
        <div
          ref={hostRef}
          class="variant-molstar-host"
          role="img"
          aria-label={structureUrl ? `${sourceRole}: estructura molecular publicada` : `${sourceRole}: estructura no disponible`}
        />
        {viewerState === 'loading' && (
          <StatePanel kind="loading" compact title="Cargando estructura" description="Descargando el modelo publicado de la corrida." className="variant-viewport-state" />
        )}
        {viewerState === 'unavailable' && (
          <StatePanel kind="empty" compact icon="box" title="Estructura no disponible" description="No hay un PDB o mmCIF publicado para esta vista." className="variant-viewport-state" />
        )}
        {viewerState === 'error' && (
          <StatePanel kind="error" compact title="No se pudo cargar la estructura" description={viewerError} className="variant-viewport-state">
            <button type="button" onClick={() => {
              retryStructureUrl?.();
              setLoadRetry((current) => current + 1);
            }}>Reintentar</button>
          </StatePanel>
        )}
        {Number.isInteger(selectedPosition) && (
          <div class="variant-structure-selection" aria-live="polite">
            <strong>{sourceRoleCode}</strong>
            <span>Residuo {selectedPosition}</span>
          </div>
        )}
      </div>
    </article>
  );
}

function SequenceStrip({ sequence, selectedPosition, variantsByPosition, onSelect }) {
  const selectedResidueRef = useRef(null);

  useEffect(() => {
    if (!Number.isInteger(selectedPosition)) return;
    selectedResidueRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  }, [selectedPosition]);

  return (
    <div class="variant-sequence-scroll" role="group" aria-label="Secuencia canónica; selecciona un residuo para consultar una variante" tabIndex={0}>
      <div class="variant-sequence-track">
        {[...String(sequence ?? '')].map((aa, index) => {
          const position = index + 1;
          const selected = selectedPosition === position;
          const variant = variantsByPosition.get(position);
          const hasVariant = Boolean(variant);
          return (
            <button
              key={`${position}-${aa}`}
              ref={selected ? selectedResidueRef : null}
              type="button"
              class={`variant-sequence-residue ${selected ? 'is-selected' : ''} ${hasVariant ? 'has-variant' : ''}`}
              onClick={() => onSelect(position)}
              aria-pressed={selected}
              title={variant ? `${variantLabel(variant)} · posición ${position}` : `Posición ${position}`}
            >
              <span class="variant-sequence-position">{position % 10 === 0 || selected ? position : ''}</span>
              <span>{aa}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function VariantSelect({ id, label = 'Variante evaluada', options, value, onChange }) {
  const rootRef = useRef(null);
  const triggerRef = useRef(null);
  const optionRefs = useRef([]);
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.value === value) ?? options[0];
  const [activeIndex, setActiveIndex] = useState(() => Math.max(0, options.findIndex((option) => option.value === value)));

  useEffect(() => {
    setActiveIndex(Math.max(0, options.findIndex((option) => option.value === value)));
  }, [options, value]);

  useEffect(() => {
    if (!open) return undefined;
    const handleOutside = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', handleOutside);
    return () => document.removeEventListener('pointerdown', handleOutside);
  }, [open]);

  useEffect(() => {
    if (open) optionRefs.current[activeIndex]?.focus();
  }, [activeIndex, open]);

  if (!selected) return null;
  const choose = (option) => {
    onChange(option.value);
    setOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  };
  const openAt = (index) => {
    setActiveIndex(index);
    setOpen(true);
  };
  const handleTriggerKeyDown = (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
      openAt(event.key === 'ArrowUp' ? Math.max(0, selectedIndex - 1) : selectedIndex);
    }
  };
  const handleOptionKeyDown = (event, index) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      choose(options[index]);
      return;
    }
    const nextIndex = event.key === 'ArrowDown'
      ? Math.min(options.length - 1, index + 1)
      : event.key === 'ArrowUp'
        ? Math.max(0, index - 1)
        : event.key === 'Home'
          ? 0
          : event.key === 'End' ? options.length - 1 : null;
    if (nextIndex !== null) {
      event.preventDefault();
      setActiveIndex(nextIndex);
    }
  };

  return (
    <div class="variant-select" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        class="variant-select-trigger"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${id}-options`}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={handleTriggerKeyDown}
      >
        <span>{selected.label}</span><span aria-hidden="true">⌄</span>
      </button>
      {open && (
        <div id={`${id}-options`} class="variant-select-options" role="listbox" aria-label={label}>
          {options.map((option, index) => (
            <button
              ref={(node) => { optionRefs.current[index] = node; }}
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              class={option.value === value ? 'is-selected' : ''}
              onClick={() => choose(option)}
              onFocus={() => setActiveIndex(index)}
              onKeyDown={(event) => handleOptionKeyDown(event, index)}
            >
              <span>{option.label}</span>
              {option.value === value && <span aria-hidden="true">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function DisclosureSection({ title, meta, description, open = false, children, className = '' }) {
  return (
    <details class={`variant-disclosure ${className}`} open={open}>
      <summary>
        <span>{title}</span>
        {meta && <b>{meta}</b>}
      </summary>
      <div class="variant-disclosure-body">
        {description && <p>{description}</p>}
        {children}
      </div>
    </details>
  );
}

function EvidenceRow({ label, value, tone = '' }) {
  return (
    <div class="variant-evidence-row">
      <dt>{label}</dt>
      <dd class={tone ? `tone-${tone}` : ''}>{value ?? 'Sin dato'}</dd>
    </div>
  );
}

function selectedResidue(sequence, position) {
  const one = Number.isInteger(position) ? String(sequence ?? '')[position - 1] ?? '' : '';
  const code = AA3[one] ?? '';
  return { one: one || '?', code, name: AA_NAMES[code] ?? 'Residuo' };
}

function isConcrete(value) {
  return value !== null && value !== undefined && value !== '' && value !== 'NA';
}

function AnnotationPanel({
  sequence,
  selectedPosition,
  selectedVariant,
  annotation,
  variantRecord,
  replicateRecords,
  provenance,
  referenceSource,
  mutantSource,
  variantArtifacts,
}) {
  const displayPosition = Number.isInteger(selectedPosition) ? selectedPosition : selectedVariant?.aa_position;
  const residue = selectedResidue(sequence, displayPosition);
  const ddg = publishedDdg(variantRecord, annotation?.values, provenance);
  const replicas = replicateCount(replicateRecords, selectedVariant, variantRecord);
  const detailRows = variantDetailRows(variantRecord, annotation?.values, provenance);
  const selectedVariantLabel = selectedVariant ? variantLabel(selectedVariant) : 'Sin variante';
  const domain = publishedTextValue(annotation, ['uniprot_domain']);
  const hasVariantSelection = Boolean(selectedVariant) || Number.isInteger(selectedPosition);
  const panelArtifacts = [referenceSource?.artifact, mutantSource?.artifact, ...variantArtifacts].filter(Boolean).filter((artifact, index, items) => (
    items.findIndex((candidate) => candidate.id === artifact.id) === index
  ));

  return (
    <aside class="variant-annotations" aria-label="Anotaciones de variantes">
      <header class="variant-annotations-head">
        <h2>Anotaciones</h2>
      </header>
      <div class="variant-annotations-body">
        <section class="variant-residue-summary" aria-label="Residuo seleccionado">
          <div class="variant-residue-letter">{residue.one}</div>
          <div class="variant-residue-name">
            <strong>{residue.code ? `${residue.code} - ${residue.name}` : residue.name}</strong>
            <span>{hasVariantSelection ? `${residue.one}${displayPosition}` : 'Selecciona una posición'}</span>
          </div>
          <strong class="variant-residue-position">{hasVariantSelection ? displayPosition : '—'}</strong>
        </section>

        {isConcrete(domain) && (
          <section class="variant-context">
            <h3>Contexto funcional</h3>
            <div class="variant-context-row"><span>◇</span><span>Dominio UniProt</span><strong>{readableValue('uniprot_domain', domain)}</strong></div>
          </section>
        )}

        {hasVariantSelection && selectedVariant ? (
          <DisclosureSection
            title="Evaluación de la variante"
            meta={ddg ? selectedVariantLabel : 'Sin dato publicado'}
            description={`${selectedVariantLabel}: sustitución de ${selectedVariant.aa_ref} por ${selectedVariant.aa_alt} en la posición ${selectedVariant.aa_position}.`}
            open
          >
            <dl>
              {ddg ? (
                <div class="variant-ddg-highlight">
                  <span>ΔΔG publicado</span>
                  <strong>{formatVariantNumber(ddg.value)}{ddg.unit ? ` ${ddg.unit}` : ''}</strong>
                </div>
              ) : <EvidenceRow label="ΔΔG publicado" value="Sin dato publicado" />}
              {replicas !== null && <EvidenceRow label="Réplicas independientes" value={Number.isInteger(replicas) ? String(replicas) : formatPublishedNumber(replicas)} />}
              {detailRows.map((row) => (
                <EvidenceRow
                  key={`${row.label}-${row.value}`}
                  label={row.label}
                  value={`${formatPublishedNumber(row.value)}${row.unit ? ` ${row.unit}` : ''}`}
                />
              ))}
            </dl>
          </DisclosureSection>
        ) : hasVariantSelection ? (
          <p class="variant-no-data">No hay una variante confirmada en esta posición.</p>
        ) : (
          <p class="variant-select-prompt">Selecciona una posición de la secuencia para consultar la evaluación publicada.</p>
        )}

        {panelArtifacts.length > 0 && (
          <DisclosureSection
            title="Modelos y archivos"
            meta={`${panelArtifacts.length} elemento${panelArtifacts.length === 1 ? '' : 's'}`}
            className="variant-artifacts-disclosure"
          >
            <div class="variant-artifact-list">
              {panelArtifacts.map((artifact) => <AuthenticatedArtifactLink key={artifact.id} id={artifact.id} artifact={artifact} />)}
            </div>
          </DisclosureSection>
        )}
      </div>
    </aside>
  );
}

async function getAllVariantAnnotations(runId) {
  const response = await getAnnotations(runId, 50_000);
  return response;
}

async function listAllRunsForBaseProtein(baseProteinId) {
  const runs = [];
  let offset = 0;
  while (true) {
    const page = await listRuns(200, offset, { baseProteinId });
    runs.push(...page);
    if (page.length < 200) return runs;
    offset += page.length;
  }
}

function variantDdgStage(run) {
  return run?.stages?.find((stage) => stage.id === 'variant_ddg') ?? null;
}

function variantDdgArtifact(run) {
  return variantDdgStage(run)?.artifacts?.find((artifact) => artifact.artifact_type === 'variant_annotations') ?? null;
}

function ddgRunPriority(run) {
  const stage = variantDdgStage(run);
  return (variantDdgArtifact(run) ? 4 : 0)
    + (stage?.status === 'success' || stage?.status === 'reused' ? 2 : 0)
    + (run?.status === 'success' || run?.status === 'reused' ? 1 : 0);
}

function latestFirst(left, right) {
  return String(right?.created_at ?? '').localeCompare(String(left?.created_at ?? ''));
}

function associatedDdgRuns(runs, baseProteinId, accession) {
  const candidates = (runs ?? [])
    .filter((candidate) => {
      const tracking = candidate.external_tracking;
      return tracking?.run_type === 'ddg'
        && tracking.base_protein_id === baseProteinId
        && String(tracking.accession ?? '').trim().toUpperCase() === accession
        && variantKey({ variant_id: tracking.variant });
    })
    .sort((left, right) => ddgRunPriority(right) - ddgRunPriority(left) || latestFirst(left, right));
  const uniqueRuns = [];
  const seenVariants = new Set();
  for (const candidate of candidates) {
    const key = variantKey({ variant_id: candidate.external_tracking.variant });
    if (seenVariants.has(key)) continue;
    seenVariants.add(key);
    uniqueRuns.push(candidate);
  }
  return uniqueRuns;
}

async function loadDdgRunDetails(runs) {
  const results = new Array(runs.length);
  let nextIndex = 0;
  const readNext = async () => {
    while (nextIndex < runs.length) {
      const index = nextIndex;
      nextIndex += 1;
      const run = runs[index];
      const details = variantDdgArtifact(run) ? await loadDdgVariantDetails(run, getArtifactBlob) : {};
      results[index] = { run, details };
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, runs.length) }, readNext));
  return results;
}

export default function VariantComparison({ proteinId }) {
  const runId = typeof window === 'undefined' ? '' : new URLSearchParams(window.location.search).get('run') ?? '';
  const [protein, setProtein] = useState(null);
  const [run, setRun] = useState(null);
  const [relatedVariantRun, setRelatedVariantRun] = useState(null);
  const [relatedRuns, setRelatedRuns] = useState([]);
  const [associatedDdgResults, setAssociatedDdgResults] = useState([]);
  const [relatedRunsState, setRelatedRunsState] = useState('idle');
  const [relatedRunsError, setRelatedRunsError] = useState('');
  const [annotations, setAnnotations] = useState([]);
  const [artifactDetails, setArtifactDetails] = useState({});
  const [state, setState] = useState('loading');
  const [error, setError] = useState('');
  const [selectedVariantKey, setSelectedVariantKey] = useState('');
  const [selectedPosition, setSelectedPosition] = useState(null);
  const [selectionRevision, setSelectionRevision] = useState(0);
  const [firstSourceKey, setFirstSourceKey] = useState('');
  const [secondSourceKey, setSecondSourceKey] = useState('');
  const [readyStructureSources, setReadyStructureSources] = useState({ first: '', second: '' });
  const [cameraSyncEnabled, setCameraSyncEnabled] = useState(true);
  const isExternalWildType = run?.external_tracking?.run_type === 'base';
  const baseProteinId = run?.external_tracking?.base_protein_id || run?.protein_id || '';
  const accession = String(run?.external_tracking?.accession ?? run?.configuration?.scientific_accession ?? '').trim().toUpperCase();
  const selectionInitializedRef = useRef(false);
  const cameraSyncRef = useRef({
    enabled: true,
    applying: false,
    cameras: new Map(),
    appliedSnapshots: new Map(),
    cameraOffsets: new Map([['first', ZERO_CAMERA_OFFSET], ['second', ZERO_CAMERA_OFFSET]]),
    frame: null,
    lastSnapshot: null,
    pendingSource: null,
    suspendUntil: 0,
    postActionTimers: new Set(),
  });

  useEffect(() => {
    let active = true;
    let timer;
    let controller;
    let latestRun = null;
    let reconnectAttempts = 0;
    let finished = false;

    const applyRun = (nextRun) => {
      if (!active) return;
      latestRun = nextRun;
      setRun(nextRun);
    };
    const refreshSnapshot = async () => {
      if (!runId) return;
      try {
        const [nextRun, annotationData] = await Promise.all([getRun(runId), getAllVariantAnnotations(runId)]);
        applyRun(nextRun);
        if (active) setAnnotations(annotationData.rows ?? []);
        if (runUpdatesFinished(nextRun)) {
          finished = true;
          controller?.abort();
        }
      } catch (requestError) {
        if (active) setError(userErrorMessage(requestError, 'No se pudo actualizar la vista de variantes.'));
      }
    };
    const schedulePolling = (delay = 2_000) => {
      if (!active || finished || !runId || reconnectAttempts >= 4) return;
      reconnectAttempts += 1;
      timer = window.setTimeout(async () => {
        await refreshSnapshot();
        if (active && !finished && !runUpdatesFinished(latestRun)) void connectStream();
      }, delay);
    };
    const connectStream = async () => {
      if (!active || finished || !runId || runUpdatesFinished(latestRun)) return;
      controller?.abort();
      controller = new AbortController();
      try {
        await subscribeRunEvents(runId, {
          signal: controller.signal,
          onSnapshot: (snapshot) => {
            reconnectAttempts = 0;
            applyRun(snapshot);
            void getAllVariantAnnotations(runId).then((data) => {
              if (active) setAnnotations(data.rows ?? []);
            }).catch(() => undefined);
            if (runUpdatesFinished(snapshot)) {
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
        const runData = await getRun(runId);
        const sequenceProteinId = runData.external_tracking?.run_type === 'base'
          ? runData.external_tracking.base_protein_id || proteinId
          : proteinId;
        const [proteinData, annotationData] = await Promise.all([
          getProtein(sequenceProteinId),
          getAllVariantAnnotations(runId),
        ]);
        if (!active) return;
        let matchingRun = null;
        const runHasStructure = allArtifacts(runData).some(isConcreteStructureArtifact);
        const tracking = runData.external_tracking;
        if (!runHasStructure && tracking?.run_type === 'ddg' && tracking.base_protein_id) {
          try {
            const relatedRuns = await listRuns(200, 0, { baseProteinId: tracking.base_protein_id });
            matchingRun = matchingMutantRun(relatedRuns, tracking);
          } catch {
            // The DDG result remains usable when its related-run lookup is unavailable.
          }
        }
        if (!active) return;
        setProtein(proteinData);
        setAnnotations(annotationData.rows ?? []);
        setRelatedVariantRun(matchingRun);
        applyRun(runData);
        setState('ready');
        if (!runUpdatesFinished(runData)) void connectStream();
        else finished = true;
      } catch (requestError) {
        if (!active) return;
        setState('error');
        setError(userErrorMessage(requestError, 'No se pudo cargar la vista de variantes.'));
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
    setRelatedRuns([]);
    setAssociatedDdgResults([]);
    setRelatedRunsError('');
    if (!isExternalWildType || !baseProteinId) {
      setRelatedRunsState('idle');
      return () => { active = false; };
    }

    setRelatedRunsState('loading');
    const load = async () => {
      try {
        const nextRelatedRuns = await listAllRunsForBaseProtein(baseProteinId);
        if (!active) return;
        const ddgRuns = associatedDdgRuns(nextRelatedRuns, baseProteinId, accession);
        setRelatedRuns(nextRelatedRuns);
        const nextResults = await loadDdgRunDetails(ddgRuns);
        if (!active) return;
        setAssociatedDdgResults(nextResults);
        setRelatedRunsState('ready');
      } catch (requestError) {
        if (!active) return;
        setRelatedRunsError(userErrorMessage(requestError, 'No se pudieron cargar los resultados publicados de las variantes.'));
        setRelatedRunsState('error');
      }
    };
    void load();
    return () => { active = false; };
  }, [accession, baseProteinId, isExternalWildType]);

  useEffect(() => {
    let active = true;
    setArtifactDetails({});
    if (!run) return () => { active = false; };
    loadAnalysisArtifactDetails(run, 'ddg', getArtifactBlob)
      .then((details) => {
        if (active) setArtifactDetails(details);
      })
      .catch(() => {
        if (active) setArtifactDetails({});
      });
    return () => { active = false; };
  }, [run?.id, run?.stages?.map((stage) => (stage.artifacts ?? []).map((artifact) => artifact.id).join(',')).join(':')]);

  const annotationRows = useMemo(() => mergeAnnotationRows(annotations), [annotations]);
  const associatedVariantRecords = useMemo(
    () => [
      ...(artifactDetails.variant_annotations ?? []),
      ...associatedDdgResults.flatMap((result) => result.details.variant_annotations ?? []),
    ],
    [artifactDetails.variant_annotations, associatedDdgResults],
  );
  const detailVariants = isExternalWildType ? associatedVariantRecords : artifactDetails.variant_annotations ?? [];
  const requestedVariants = useMemo(() => [
    ...(run?.requested_variants ?? []),
    ...(run?.configuration?.normalized_variants ?? []),
    ...(artifactDetails.variant_set ?? []),
    ...(isExternalWildType ? associatedDdgResults.map(({ run: ddgRun }) => ({
      variant_id: ddgRun.external_tracking?.variant,
    })) : []),
  ], [artifactDetails.variant_set, associatedDdgResults, isExternalWildType, run?.configuration?.normalized_variants, run?.requested_variants]);
  const variants = useMemo(() => mergePublishedVariants(requestedVariants, detailVariants), [detailVariants, requestedVariants]);
  const initialSelection = initialVariantSelection(variants, selectedVariantKey, selectionInitializedRef.current);
  const activeVariantKey = initialSelection ? variantKey(initialSelection) : '';
  const activeSelectedPosition = selectedPosition ?? initialSelection?.aa_position ?? null;
  const variantSelectionOptions = [
    { value: '', label: 'Selecciona una variante' },
    ...variants.map((variant) => ({
      value: variantKey(variant),
      label: variantLabel(variant),
    })),
  ];
  const variantsByPosition = useMemo(() => indexVariantsByPosition(variants), [variants]);
  const selectedVariant = initialSelection;
  const selectedDdgResult = isExternalWildType
    ? associatedDdgResults.find(({ run: ddgRun }) => variantKey({ variant_id: ddgRun.external_tracking?.variant }) === activeVariantKey) ?? null
    : null;
  const activeDdgRun = selectedDdgResult?.run ?? run;
  const activeDdgDetails = selectedDdgResult?.details ?? artifactDetails;
  const activeDetailVariants = activeDdgDetails.variant_annotations ?? detailVariants;
  const ddgStage = variantDdgStage(activeDdgRun);
  const variantRecord = useMemo(
    () => variantRecordFor(activeDetailVariants, activeVariantKey) ?? variantRecordFor(detailVariants, activeVariantKey),
    [activeDetailVariants, activeVariantKey, detailVariants],
  );
  const activeMutantRun = isExternalWildType && selectedDdgResult
    ? matchingMutantRun(relatedRuns, selectedDdgResult.run.external_tracking)
    : relatedVariantRun;
  const structureSourceSet = useMemo(() => {
    const sources = structureSources(run, variants);
    const fallbackSource = mutantRunStructureSource(activeMutantRun, variants);
    if (isExternalWildType) {
      return fallbackSource ? { ...sources, variants: [...sources.variants, fallbackSource] } : sources;
    }
    if (sources.reference || sources.variants.length || sources.variantDirectory) return sources;
    return fallbackSource ? { ...sources, variants: [fallbackSource] } : sources;
  }, [activeMutantRun, isExternalWildType, run, variants]);
  const referenceSource = structureSourceSet.reference;
  const archiveVariantSources = useVariantDirectorySources(structureSourceSet.variantDirectory, variants);
  const variantSources = useMemo(() => {
    const sources = [];
    const seenVariantKeys = new Set();
    for (const source of [...structureSourceSet.variants, ...archiveVariantSources]) {
      if (!source) continue;
      if (source.variantKey && seenVariantKeys.has(source.variantKey)) continue;
      if (source.variantKey) seenVariantKeys.add(source.variantKey);
      sources.push(source);
    }
    return sources;
  }, [archiveVariantSources, structureSourceSet.variants]);
  const allStructureSources = useMemo(
    () => [referenceSource, ...variantSources].filter(Boolean),
    [referenceSource, variantSources],
  );
  const structureSourceOptions = useMemo(
    () => allStructureSources.map((source) => ({ value: source.key, label: source.selectionLabel })),
    [allStructureSources],
  );
  const structureSourceKeys = structureSourceOptions.map((option) => option.value).join('|');
  const firstSource = allStructureSources.find((source) => source.key === firstSourceKey)
    ?? referenceSource
    ?? allStructureSources[0]
    ?? null;
  const selectedVariantSource = variantSources.find((source) => source.variantKey === activeVariantKey) ?? null;
  const secondSource = allStructureSources.find((source) => source.key === secondSourceKey)
    ?? selectedVariantSource
    ?? (activeVariantKey ? null : variantSources[0] ?? null);
  const firstSourceOptions = useMemo(
    () => distinctStructureOptions(structureSourceOptions, firstSource?.key, secondSource?.key),
    [firstSource?.key, secondSource?.key, structureSourceOptions],
  );
  const secondSourceOptions = useMemo(
    () => distinctStructureOptions(structureSourceOptions, secondSource?.key, firstSource?.key),
    [firstSource?.key, secondSource?.key, structureSourceOptions],
  );
  const hasPairedStructures = canCompareStructureSources(firstSource, secondSource);
  const firstStructure = useStructureUrl(firstSource);
  const secondStructure = useStructureUrl(secondSource);
  const cameraSyncReady = areStructureSourcesReady(readyStructureSources, firstSource, secondSource);
  const markStructureReady = (panelId, sourceId, ready) => {
    setReadyStructureSources((current) => {
      const nextSourceId = ready ? String(sourceId ?? '') : '';
      if (current[panelId] === nextSourceId) return current;
      return { ...current, [panelId]: nextSourceId };
    });
  };
  const structureMapping = useMemo(() => structureMappingMaps(structureMappingFromArtifactRows(
    run?.configuration?.structure_mapping,
    artifactDetails?.structure_mapping,
  )), [artifactDetails?.structure_mapping, run?.configuration?.structure_mapping]);
  const selectedPositionAnnotation = selectedPosition ? annotationRows.get(selectedPosition) : null;
  const selectedRecord = selectedVariant ? variantRecord ?? variantRecordFor(detailVariants, selectedVariant) : null;
  const provenance = activeDdgDetails.provenance?.[0] ?? activeDdgDetails.rosetta_metadata?.[0] ?? null;
  const variantArtifacts = useMemo(
    () => (ddgStage?.artifacts ?? []).filter(isScientistVisibleVariantArtifact),
    [ddgStage],
  );

  useEffect(() => {
    const sourceKeys = structureSourceOptions.map((option) => option.value);
    const defaultFirst = referenceSource?.key ?? sourceKeys[0] ?? '';
    const defaultSecond = variantSources[0]?.key ?? '';
    setFirstSourceKey((current) => sourceKeys.includes(current) ? current : defaultFirst);
    setSecondSourceKey((current) => sourceKeys.includes(current) ? current : defaultSecond);
  }, [referenceSource?.key, structureSourceKeys, variantSources]);

  useEffect(() => {
    if (!activeVariantKey) return;
    const nextSourceKey = selectedVariantSource?.key ?? '';
    if (nextSourceKey && nextSourceKey === firstSource?.key) {
      const alternative = allStructureSources.find((source) => source.key !== firstSource.key);
      setSecondSourceKey(alternative?.key ?? '');
      return;
    }
    setSecondSourceKey(nextSourceKey);
  }, [activeVariantKey, allStructureSources, firstSource?.key, selectedVariantSource?.key]);

  useEffect(() => {
    if (!firstSource?.key || !secondSource?.key || firstSource.key !== secondSource.key) return;
    const alternative = allStructureSources.find((source) => source.key !== firstSource.key);
    setSecondSourceKey(alternative?.key ?? '');
  }, [allStructureSources, firstSource?.key, secondSource?.key]);

  useEffect(() => {
    selectionInitializedRef.current = false;
    setRelatedVariantRun(null);
    setSelectedVariantKey('');
    setSelectedPosition(null);
    setSelectionRevision(0);
    setFirstSourceKey('');
    setSecondSourceKey('');
    setReadyStructureSources({ first: '', second: '' });
  }, [proteinId, runId]);

  useEffect(() => {
    if (selectionInitializedRef.current || !variants.length) return;
    selectionInitializedRef.current = true;
    const firstVariant = variants[0];
    setSelectedVariantKey(variantKey(firstVariant));
    setSelectedPosition(firstVariant.aa_position);
    setSelectionRevision((current) => current === 0 ? 1 : current);
  }, [variants]);

  const selectVariant = (key) => {
    selectionInitializedRef.current = true;
    setSelectionRevision((current) => current + 1);
    if (!key) {
      setSelectedVariantKey('');
      setSelectedPosition(null);
      return;
    }
    const variant = variants.find((item) => variantKey(item) === key);
    if (!variant) return;
    setSelectedVariantKey(key);
    setSelectedPosition(variant.aa_position);
  };
  const selectPosition = (position) => {
    selectionInitializedRef.current = true;
    const isDeselecting = activeSelectedPosition === position;
    setSelectionRevision((current) => current + 1);
    setSelectedPosition(isDeselecting ? null : position);
    if (isDeselecting) {
      setSelectedVariantKey('');
      return;
    }
    const variant = variants.find((item) => item.aa_position === position);
    setSelectedVariantKey(variant ? variantKey(variant) : '');
  };
  const selectSource = (key, setSourceKey, otherSource) => {
    selectionInitializedRef.current = true;
    if (key === otherSource?.key) return;
    const source = allStructureSources.find((item) => item.key === key);
    if (source?.kind === 'variant' && source.variantKey) {
      const variant = variants.find((item) => variantKey(item) === source.variantKey);
      if (variant) {
        setSelectedVariantKey(source.variantKey);
        setSelectedPosition(variant.aa_position);
      }
    }
    setSourceKey(key);
  };
  const selectFirstSource = (key) => {
    selectSource(key, setFirstSourceKey, secondSource);
  };
  const selectSecondSource = (key) => {
    selectSource(key, setSecondSourceKey, firstSource);
  };

  if (state === 'loading' || (isExternalWildType && ['idle', 'loading'].includes(relatedRunsState))) {
    return <section class="variant-page"><StatePanel kind="loading" fill title="Cargando variantes" description="Consultando la corrida y sus resultados publicados." /></section>;
  }
  if (state === 'error') {
    return <section class="variant-page"><StatePanel kind="error" fill title="No se pudo cargar la vista de variantes" description={error} /></section>;
  }
  if (isExternalWildType && relatedRunsState === 'error') {
    return <section class="variant-page"><StatePanel kind="error" fill title="No se pudieron cargar las variantes" description={relatedRunsError} /></section>;
  }

  const hasPublishedVariantRun = variants.length > 0;
  if (!hasPublishedVariantRun) {
    return (
      <section class="variant-page" aria-label="Variantes">
        <StatePanel kind="empty" fill title="No hay variantes confirmadas" description="Esta corrida no publicó variantes para evaluar." />
      </section>
    );
  }

  const annotationForPanel = activeSelectedPosition ? annotationRows.get(activeSelectedPosition) : selectedPositionAnnotation;
  const activeVariant = selectedVariant ?? (activeSelectedPosition ? variants.find((variant) => variant.aa_position === activeSelectedPosition) : null);
  return (
    <section class="variant-page" aria-label={isExternalWildType ? 'ΔΔG de variantes' : 'ΔΔG de variante'}>
      <div class="variant-chain-card">
        <div class="variant-selection-row">
          <span class="variant-selection-label">Variante evaluada</span>
          <VariantSelect
            id="variant-evaluation"
            label="Variante evaluada"
            options={variantSelectionOptions}
            value={activeVariantKey}
            onChange={selectVariant}
          />
        </div>
        <SequenceStrip
          sequence={protein?.sequence}
          selectedPosition={activeSelectedPosition}
          variantsByPosition={variantsByPosition}
          onSelect={selectPosition}
        />
      </div>

      {error && <p class="variant-live-message" role="status">{error}</p>}

      <div class="variant-workspace">
        <div class={`variant-structures ${hasPairedStructures ? 'has-mutant' : 'single-structure'}`}>
          {firstSource && (
            <VariantStructurePanel
              panelId="first"
              title={firstSource.kind === 'variant' ? 'Mutante' : 'Referencia'}
              source={firstSource}
              sourceOptions={firstSourceOptions}
              selectedSourceKey={firstSourceKey}
              onSourceChange={selectFirstSource}
              structureUrl={firstStructure.url}
              structureState={firstStructure.state}
              retryStructureUrl={firstStructure.retry}
              structureMapping={structureMapping}
              selectedPosition={activeSelectedPosition}
              selectionRevision={selectionRevision}
              highlightColor={firstSource.kind === 'variant' ? MUTANT_HIGHLIGHT_COLOR : REFERENCE_HIGHLIGHT_COLOR}
              onPick={selectPosition}
              onStructureReady={markStructureReady}
              cameraSyncRef={cameraSyncRef}
              cameraSyncEnabled={cameraSyncEnabled && hasPairedStructures}
            />
          )}
          {hasPairedStructures && secondSource && (
            <VariantStructurePanel
              panelId="second"
              title={secondSource.kind === 'variant' ? 'Mutante' : 'Referencia'}
              source={secondSource}
              sourceOptions={secondSourceOptions}
              selectedSourceKey={secondSourceKey}
              onSourceChange={selectSecondSource}
              structureUrl={secondStructure.url}
              structureState={secondStructure.state}
              retryStructureUrl={secondStructure.retry}
              structureMapping={structureMapping}
              selectedPosition={activeSelectedPosition}
              selectionRevision={selectionRevision}
              highlightColor={secondSource.kind === 'variant' ? MUTANT_HIGHLIGHT_COLOR : REFERENCE_HIGHLIGHT_COLOR}
              onPick={selectPosition}
              onStructureReady={markStructureReady}
              cameraSyncRef={cameraSyncRef}
              cameraSyncEnabled={cameraSyncEnabled}
            />
          )}
          {hasPairedStructures && firstSource && secondSource && (
            <button
              type="button"
              class={`variant-camera-sync ${cameraSyncEnabled && cameraSyncReady ? 'is-active' : ''} ${!cameraSyncReady ? 'is-pending' : ''}`.trim()}
              aria-label={!cameraSyncReady
                ? 'Sincronización pendiente: espera a que carguen ambos modelos'
                : cameraSyncEnabled ? 'Desactivar sincronización de cámaras' : 'Activar sincronización de cámaras'}
              aria-pressed={cameraSyncEnabled}
              disabled={!cameraSyncReady}
              title={!cameraSyncReady
                ? 'La sincronización se activará cuando ambos modelos terminen de cargar.'
                : cameraSyncEnabled ? 'Sincronización de cámaras activa' : 'Sincronización de cámaras desactivada'}
              onClick={() => setCameraSyncEnabled((current) => !current)}
            >
              ⇄
            </button>
          )}
          {!firstSource && !secondSource && (
            <StatePanel kind="empty" fill title="Estructuras no disponibles" description="La corrida no publicó un PDB o mmCIF para comparar." className="variant-no-structures" />
          )}
        </div>

        <AnnotationPanel
          sequence={protein?.sequence}
          selectedPosition={activeSelectedPosition}
          selectedVariant={activeVariant}
          annotation={annotationForPanel}
          variantRecord={selectedRecord}
          replicateRecords={activeDdgDetails.ddg_replicates ?? []}
          provenance={provenance}
          referenceSource={referenceSource}
          mutantSource={secondSource?.kind === 'variant'
            ? secondSource
            : firstSource?.kind === 'variant' ? firstSource : null}
          variantArtifacts={variantArtifacts}
        />
      </div>
    </section>
  );
}
