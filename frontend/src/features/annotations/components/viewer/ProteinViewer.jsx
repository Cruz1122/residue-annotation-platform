import { memo } from 'preact/compat';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import LucideIcon from '@shared/components/icons/LucideIcon.jsx';
import { ApiError, getAnnotations, getArtifactObjectUrl, getProtein, getRun, getUploadObjectUrl } from '@shared/api/client';
import {
  AA_NAMES,
  ANNOTATION_GROUPS,
  MISSING_COLOR,
  MODE_INFO,
  MODE_SCALE_COPY,
  VISUALIZATION_MODES,
  annotationForResidue,
  assignCanonicalPositions,
  canonicalChain,
  colorForValues,
  finiteAnnotationValue,
  formatScaleNumber,
  hexToColorInt,
  normalizeValue,
  oneLetter,
  readableValue,
  relativeDomain,
  residueDisplayColor,
  residueKey,
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
  if (value === null || value === undefined || value === '') return 'NA';
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
  for (const stage of run?.stages ?? []) {
    for (const artifact of stage.artifacts ?? []) {
      if (!isStructure(artifact.artifact_type, artifact.media_type)) continue;
      return {
        id: artifact.id,
        label: artifact.artifact_type,
        format: structureFormat(artifact.artifact_type, artifact.media_type),
        loadUrl: () => getArtifactObjectUrl(artifact.id),
      };
    }
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
  const background = `linear-gradient(90deg, ${spec.colors[0]} 0%, ${spec.colors[1]} 50%, ${spec.colors[2]} 100%)`;
  const midpoint = domain ? (domain.min + domain.max) / 2 : null;
  return (
    <div class="continuous-legend" aria-label={`${copy.magnitude}. ${copy.note}`}>
      <p class="continuous-legend__note">{copy.magnitude}. {copy.note}</p>
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
          <span>{formatScaleNumber(domain.min)} · {copy.low}</span>
          <span title="Punto medio visual">{formatScaleNumber(midpoint)}</span>
          <span>{formatScaleNumber(domain.max)} · {copy.high}</span>
        </div>
      )}
      {(!domain || (residueSelected && t === null)) && <span class="continuous-legend__missing">Sin dato</span>}
    </div>
  );
}

const ResidueButton = memo(function ResidueButton({ residue, index, inRange, active, color }) {
  return (
    <button
      data-sequence-index={index}
      class={`viewer-residue ${inRange ? 'in-range' : ''} ${active ? 'active' : ''}`}
      style={`--mode-color:${color}`}
      type="button"
      title={`${residue.compId} ${residue.authSeqId}`}
    >
      <span class="viewer-residue-pos">{index % 10 === 0 ? residue.authSeqId : ''}</span>
      <span>{residue.one}</span>
    </button>
  );
});

export default function ProteinViewer({ proteinId }) {
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
  const [annotations, setAnnotations] = useState([]);
  const [chains, setChains] = useState([]);
  const [chainId, setChainId] = useState('');
  const [state, setState] = useState('loading');
  const [viewerState, setViewerState] = useState('loading');
  const [viewerError, setViewerError] = useState('');
  const [error, setError] = useState('');
  const [wipe, setWipe] = useState('covering');
  const [mode, setMode] = useState('regime');
  const [selection, setSelection] = useState(EMPTY_SELECTION);
  const runId = typeof window === 'undefined' ? '' : new URLSearchParams(window.location.search).get('run') ?? '';
  const [structureRequest, setStructureRequest] = useState(null);

  useEffect(() => {
    chainsRef.current = chains;
    chainIdRef.current = chainId;
  }, [chains, chainId]);

  useEffect(() => {
    let active = true;
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
        setStructureRequest(structureSource(runData));
        setViewerState(structureSource(runData) ? 'loading' : 'unavailable');
        setState('ready');
      })
      .catch((requestError) => {
        if (!active) return;
        setState('error');
        setViewerState('unavailable');
        setError(requestError instanceof ApiError ? requestError.message : 'No se pudo cargar la proteína.');
      });
    return () => { active = false; };
  }, [proteinId, runId]);

  const activeChain = chains.find((chain) => chain.id === chainId) ?? chains[0] ?? null;
  const residues = activeChain?.residues ?? [];
  const annotationByPosition = useMemo(() => {
    const rows = new Map();
    for (const row of annotations) rows.set(row.aa_position, row);
    return rows;
  }, [annotations]);
  const domain = useMemo(() => relativeDomain(mode, annotations), [mode, annotations]);
  const colors = useMemo(
    () => residues.map((residue) => residueDisplayColor(mode, residue, annotationForResidue(residue, annotationByPosition), domain)),
    [residues, mode, annotationByPosition, domain],
  );
  const activeResidue = selection.active === null ? null : residues[selection.active] ?? null;
  const activeAnnotation = activeResidue ? annotationForResidue(activeResidue, annotationByPosition) : null;
  const activeMeasurement = finiteAnnotationValue(activeAnnotation?.values?.[VISUALIZATION_MODES[mode].field]);
  const regimeMissing = mode === 'regime' && activeResidue && !colorForValues(mode, activeAnnotation?.values, null);

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
            const aligned = assignCanonicalPositions(parsed, sequenceRef.current);
            setChains(aligned);
            setChainId(aligned[0].id);
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
          const message = viewerErrorValue instanceof Error ? viewerErrorValue.message : 'No se pudo leer la estructura.';
          setViewerError(message);
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
    return <section class="viewer-shell viewer-message" role="alert"><h1>No se pudo cargar la proteína</h1><p>{error}</p></section>;
  }

  return (
    <section class={`viewer-shell ${activeResidue ? 'has-annotations' : ''}`} aria-label="Visor molecular y secuencia" onContextMenu={(event) => event.preventDefault()}>
      <div ref={hostRef} class="molstar-host" aria-label={structureRequest ? 'Visor molecular Mol*' : 'Sin estructura publicada'} />
      {viewerState === 'unavailable' && wipe === 'gone' && <div class="viewer-boot viewer-empty"><LucideIcon name="box" /><strong>Estructura no disponible</strong><span>La corrida no tiene un PDB o mmCIF subido ni un artefacto publicado.</span></div>}
      {viewerState === 'error' && wipe === 'gone' && <div class="viewer-boot error"><strong>No se pudo cargar la estructura</strong><span>{viewerError || 'Verifica el artefacto y vuelve a intentarlo.'}</span></div>}

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
                />
              ))}
            </div>
          </div>
        </div>

        <div class="viewer-mode-panel" aria-label="Modos de color">
          <div class="viewer-mode-buttons">
            {Object.entries(MODE_INFO).map(([key, info]) => (
              <button key={key} class={`viewer-mode ${mode === key ? 'active' : ''}`} type="button" title={info.title} aria-pressed={mode === key} onClick={() => setMode(key)}>
                <LucideIcon name={info.icon} />
              </button>
            ))}
          </div>
          <div class={`viewer-mode-info ${mode === 'regime' ? '' : 'is-continuous'}`}>
            <span class="viewer-mode-title">{MODE_INFO[mode].title}</span>
            {mode === 'regime' ? (
              <span class="viewer-mode-legend">
                {MODE_INFO.regime.legend.map(([label, color]) => <span key={label} class="viewer-legend-item"><i style={{ background: color }} />{label}</span>)}
                {regimeMissing && <span class="continuous-legend__missing">Sin dato</span>}
              </span>
            ) : (
              <ContinuousLegend mode={mode} domain={domain} value={activeMeasurement} residueSelected={Boolean(activeResidue)} />
            )}
          </div>
        </div>
      </div>

      {activeResidue && (
        <aside class="viewer-annotations" aria-label="Anotaciones del residuo">
          <div class="viewer-annotations-head"><h2>Anotaciones</h2></div>
          <div class="viewer-annotations-body">
            <div class="viewer-residue-title">
              <div><strong>{activeResidue.one}</strong><span>{activeResidue.compId} · {AA_NAMES[activeResidue.compId] ?? 'Residuo'}</span></div>
              <b>{activeResidue.authSeqId}{activeResidue.insCode || ''}</b>
            </div>
            <dl class="viewer-annotation-list">
              {ANNOTATION_GROUPS.map(([group, rows]) => (
                <div key={group}>
                  <div class="viewer-annotation-group">{group}</div>
                  {rows.map(([icon, label, key]) => (
                    <div key={key} class="viewer-annotation-row">
                      <dt><span><LucideIcon name={icon} />{label}</span></dt>
                      <dd>{readableValue(key, publishedField(activeAnnotation, key))}</dd>
                    </div>
                  ))}
                </div>
              ))}
            </dl>
          </div>
        </aside>
      )}

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
