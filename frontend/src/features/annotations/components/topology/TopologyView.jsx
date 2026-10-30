import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import StatePanel from '@shared/components/feedback/StatePanel.jsx';
import PackIcon from '@shared/components/icons/PackIcon.jsx';
import { artifactDisplayName } from '@features/artifacts/artifact-display.js';
import {
  getAnnotations,
  getArtifactBlob,
  getArtifactObjectUrl,
  getProtein,
  getRun,
  getUploadObjectUrl,
} from '@shared/api/client';
import { userErrorMessage } from '@shared/lib/error-presentation';
import {
  runStagePublicationSignature,
} from '@features/runs/run-updates.js';
import { loadAnalysisArtifactDetails, structureMappingFromArtifactRows } from '@features/annotations/analysis-artifacts.js';
import { acquireStructureUrl } from '@features/annotations/structure-url-cache.js';
import { isStructureArtifact, structureFormat } from '@features/annotations/structure-format.js';
import { getZoomOptimizedCanvas3dProps } from '@features/annotations/zoom-rendering.js';
import { waitForCanvasDraw } from '@features/annotations/components/shared/canvas-render-readiness.js';
import { sequenceProteinForRun } from '@features/stages/components/info/information-presentation.js';
import { AA3, AA_NAMES, hexToColorInt, mergeAnnotationRows } from '@features/annotations/viewer-presentation.js';
import {
  hasPublishedTopologyData,
  normalizeTopologyClass,
  structureSelectionItems,
  TOPOLOGY_CLASSES,
  topologyClassProbability,
  topologyRegions,
} from '@features/annotations/topology-presentation.js';
import 'molstar/build/viewer/molstar.css';
import '@features/annotations/styles/frustration-comparison.css';
import '@features/annotations/styles/topology.css';

const TMBED_REFERENCE_URL = 'https://doi.org/10.1186/s12859-022-04873-x';
const ANNOTATION_PAGE_SIZE = 50_000;
const MAX_ANNOTATION_PAGES = 20;
const FOCUS_OPTIONS = { extraRadius: 4, durationMs: 180, easing: 'cubic-out', trajectory: 'linear' };

async function getAllAnnotations(runId) {
  const rows = [];
  let offset = 0;
  let lastResponse = null;
  for (let page = 0; page < MAX_ANNOTATION_PAGES; page += 1) {
    const response = await getAnnotations(runId, ANNOTATION_PAGE_SIZE, offset);
    lastResponse = response;
    rows.push(...(response.rows ?? []));
    if (!response.truncated) return { ...response, rows, truncated: false };
    if (!response.rows?.length) return { ...response, rows, truncated: true };
    offset += response.rows.length;
  }
  return { ...lastResponse, rows, truncated: true };
}

function structureSource(run) {
  const artifacts = (run?.stages ?? []).flatMap((stage) => stage.artifacts ?? []);
  const preferredTypes = ['model_cif', 'foldx_relaxed_pdb', 'selected_reference_pdb', 'rosettamp_relaxed_pdb'];
  const artifact = preferredTypes
    .map((type) => artifacts.find((item) => item.artifact_type === type))
    .find(Boolean) ?? artifacts.find(isStructureArtifact);
  if (artifact) {
    return {
      id: artifact.id,
      label: artifactDisplayName(artifact),
      format: structureFormat(artifact),
      loadUrl: () => getArtifactObjectUrl(artifact.id),
    };
  }
  const upload = (run?.uploads ?? []).find((item) => item.input_type === 'structure');
  if (!upload) return null;
  return {
    id: upload.id,
    label: upload.original_filename,
    format: structureFormat(upload),
    loadUrl: () => getUploadObjectUrl(upload.id),
  };
}

function residueKey(chain, residueNumber, insertionCode = '') {
  return `${String(chain || 'A')}|${String(residueNumber)}|${String(insertionCode || '')}`;
}

function structureMappingMaps(mapping) {
  const byCanonical = new Map();
  const byStructure = new Map();
  for (const pair of mapping?.canonical_to_structure ?? []) {
    const canonicalPosition = Number(pair?.canonical_position ?? pair?.aa_position);
    const residueNumber = pair?.residue_number ?? pair?.resseq ?? pair?.auth_seq_id ?? pair?.label_seq_id;
    if (!Number.isInteger(canonicalPosition) || canonicalPosition < 1 || residueNumber === null || residueNumber === undefined || residueNumber === '') continue;
    const key = residueKey(pair?.chain ?? pair?.auth_asym_id ?? pair?.label_asym_id ?? 'A', residueNumber, pair?.insertion_code ?? pair?.icode ?? '');
    if (byCanonical.has(canonicalPosition) || byStructure.has(key)) continue;
    byCanonical.set(canonicalPosition, key);
    byStructure.set(key, canonicalPosition);
  }
  return { byCanonical, byStructure };
}

function recordPosition(record) {
  for (const key of ['aa_position', 'position', 'residue_position', 'canonical_position', 'residue_number']) {
    const position = Number(record?.[key]);
    if (Number.isInteger(position) && position > 0) return position;
  }
  return null;
}

function residueAt(sequence, position) {
  const one = Number.isInteger(position) ? String(sequence ?? '')[position - 1] ?? '?' : '—';
  const code = AA3[one] ?? '';
  return { one, code, name: code ? AA_NAMES[code] : 'Selecciona un residuo' };
}

function formatProbability(value) {
  return Number.isFinite(value) ? `${(value * 100).toLocaleString('es-CO', { maximumFractionDigits: 1 })} %` : 'Sin dato';
}

function topologyRows(sequence, annotationByPosition, artifactDetails) {
  const artifactByPosition = new Map((artifactDetails?.tmbed_per_residue ?? []).map((record) => [recordPosition(record), record]));
  return [...String(sequence ?? '')].map((aa, index) => {
    const position = index + 1;
    const artifact = artifactByPosition.get(position) ?? null;
    const annotation = annotationByPosition.get(position);
    const topologyClass = normalizeTopologyClass(
      artifact?.tmbed_topology
      ?? artifact?.tmbed_label
      ?? annotation?.values?.tmbed_topology,
    );
    return { position, aa, topologyClass, artifact };
  });
}

function SequenceStrip({ rows, selectedStart, selectedEnd, sequenceLabel, onSelect }) {
  const trackRef = useRef(null);
  const selectionEnd = Number.isInteger(selectedEnd) ? selectedEnd : selectedStart;

  useEffect(() => {
    if (!Number.isInteger(selectedStart)) return;
    trackRef.current?.querySelector(`[data-position="${selectedStart}"]`)?.scrollIntoView({
      behavior: 'smooth',
      block: 'nearest',
      inline: 'center',
    });
  }, [selectedStart]);

  return (
    <div class="frustration-sequence-scroll" role="group" aria-label={sequenceLabel} tabIndex={0}>
      <div ref={trackRef} class="frustration-sequence-track">
        {rows.map((row) => {
          const info = TOPOLOGY_CLASSES[row.topologyClass];
          const selected = Number.isInteger(selectedStart) && row.position >= selectedStart && row.position <= selectionEnd;
          const boundary = row.position === selectedStart || row.position === selectionEnd;
          return (
            <button
              key={`${row.position}-${row.aa}`}
              type="button"
              class={`frustration-sequence-residue topology-sequence-residue ${selected ? 'is-selected' : ''}`}
              style={{ '--topology-color': info.color, '--structural-color': info.color, '--sequence-color': info.color }}
              onClick={() => onSelect(row.position)}
              data-position={row.position}
              aria-pressed={selected}
              title={`${row.aa}${row.position} · ${info.label}`}
            >
              <span class="frustration-sequence-position">{row.position % 10 === 0 || boundary ? row.position : ''}</span>
              <span>{row.aa}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function TopologyLegend({ classes }) {
  return (
    <div class="topology-legend" aria-label="Leyenda de clases topológicas de TMbed">
      {classes.map((topologyClass) => {
        const info = TOPOLOGY_CLASSES[topologyClass];
        return <span key={topologyClass}><i style={{ '--legend-color': info.color }} />{info.shortLabel}</span>;
      })}
      <a href={TMBED_REFERENCE_URL} target="_blank" rel="noreferrer">TMbed</a>
    </div>
  );
}

function TopologyStructure({
  structureUrl,
  structurePending,
  structureError,
  structureFormatValue,
  structureLabel,
  colorMap,
  structureByCanonical,
  canonicalByStructure,
  selectedStart,
  selectedEnd,
  selectedResidueLabel,
  focusSelectionOnCamera,
  onPick,
  showMembrane,
  membraneState,
  onMembraneState,
  presentClasses,
  membraneVisible,
  onToggleMembrane,
}) {
  const hostRef = useRef(null);
  const viewerRef = useRef(null);
  const membraneRepresentationRef = useRef(null);
  const membraneVisibleRef = useRef(membraneVisible);
  const colorMapRef = useRef(colorMap);
  const canonicalByStructureRef = useRef(canonicalByStructure);
  const onPickRef = useRef(onPick);
  const [viewerState, setViewerState] = useState(structureError ? 'error' : structureUrl || structurePending ? 'loading' : 'unavailable');
  const [viewerError, setViewerError] = useState(structureError ? 'No se pudo descargar la estructura molecular publicada.' : '');

  colorMapRef.current = colorMap;
  canonicalByStructureRef.current = canonicalByStructure;
  onPickRef.current = onPick;
  membraneVisibleRef.current = membraneVisible;

  useEffect(() => {
    setViewerState(structureError ? 'error' : structurePending || structureUrl ? 'loading' : 'unavailable');
    setViewerError(structureError ? 'No se pudo descargar la estructura molecular publicada.' : '');
    if (!structureUrl || !hostRef.current) return undefined;
    let disposed = false;
    const renderController = new AbortController();
    let clickSubscription;
    let viewerInstance = null;
    let themeProvider = null;

    const disposeViewer = () => {
      membraneRepresentationRef.current = null;
      try { viewerInstance?.dispose?.(); } catch { /* Mol* may already have released WebGL. */ }
      if (viewerRef.current === viewerInstance) viewerRef.current = null;
      viewerInstance = null;
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
        if (disposed) return disposeViewer();
        viewer.plugin.canvas3d?.setProps({
          ...getZoomOptimizedCanvas3dProps(),
          interaction: { maxFps: 60 },
          camera: { helper: { axes: { name: 'off', params: {} } } },
          cameraResetDurationMs: 180,
          cameraResetEasing: 'cubic-out',
          cameraResetTrajectory: 'linear',
        });
        await viewer.loadStructureFromUrl(structureUrl, structureFormatValue, false, { label: structureLabel });
        if (disposed) return disposeViewer();

        const registry = viewer.plugin.representation.structure.themes.colorThemeRegistry;
        const themeName = `topology-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        let themeFactory;
        themeFactory = (ctx, props) => ({
          factory: themeFactory,
          granularity: 'group',
          props,
          description: 'Topología TMbed por residuo',
          color: (location) => {
            try {
              if (!structureLib.StructureElement.Location.is(location)) return hexToColorInt(TOPOLOGY_CLASSES.unknown.color);
              const chain = String(structureLib.StructureProperties.chain.auth_asym_id(location) || structureLib.StructureProperties.chain.label_asym_id(location) || 'A');
              const sequenceId = Number(structureLib.StructureProperties.residue.auth_seq_id(location) || structureLib.StructureProperties.residue.label_seq_id(location));
              const insertionCode = String(structureLib.StructureProperties.residue.pdbx_PDB_ins_code?.(location) || '').trim();
              return hexToColorInt(colorMapRef.current.get(residueKey(chain, sequenceId, insertionCode)) ?? TOPOLOGY_CLASSES.unknown.color);
            } catch {
              return hexToColorInt(TOPOLOGY_CLASSES.unknown.color);
            }
          },
        });
        themeProvider = {
          name: themeName,
          label: 'Topología TMbed',
          category: 'Residue display',
          factory: themeFactory,
          getParams: () => ({}),
          defaultValues: {},
          isApplicable: () => true,
        };
        registry.add(themeProvider);
        await viewer.plugin.dataTransaction(async () => {
          for (const entry of viewer.plugin.managers.structure.hierarchy.current.structures) {
            await viewer.plugin.managers.structure.component.updateRepresentationsTheme(entry.components, { color: themeName });
          }
        });

        if (showMembrane) {
          try {
            const [{ tryCreateMembraneOrientation }, { setSubtreeVisibility }] = await Promise.all([
              import('molstar/lib/extensions/anvil/behavior'),
              import('molstar/lib/mol-plugin/behavior/static/state'),
            ]);
            const structure = viewer.plugin.managers.structure.hierarchy.current.structures[0]?.cell;
            if (!structure) throw new Error('No structure cell');
            const membraneRepresentation = await tryCreateMembraneOrientation(viewer.plugin, structure, {
              visuals: ['bilayer-planes', 'bilayer-rims'],
              color: hexToColorInt('#8fb6c8'),
              radiusFactor: 1, // Preserve ANVIL's calculated membrane extent without visual scaling.
              sectorOpacity: 0.18,
              linesSize: 0.65,
              dashedLines: false,
            });
            membraneRepresentationRef.current = {
              ref: membraneRepresentation.ref,
              setVisibility: (visible) => setSubtreeVisibility(viewer.plugin.state.data, membraneRepresentation.ref, !visible),
            };
            membraneRepresentationRef.current.setVisibility(membraneVisibleRef.current);
            if (!disposed) onMembraneState('ready');
          } catch {
            if (!disposed) onMembraneState('error');
          }
        } else {
          onMembraneState('not_applicable');
        }

        const canvas3d = viewer.plugin.canvas3d;
        const boundingSphere = canvas3d?.boundingSphereVisible ?? canvas3d?.boundingSphere;
        canvas3d?.requestResize?.();
        if (canvas3d?.camera && boundingSphere?.radius > 0) {
          canvas3d.camera.focus(boundingSphere.center, boundingSphere.radius * 0.8, 180);
        }

        clickSubscription = viewer.subscribe(viewer.plugin.behaviors.interaction.click, (event) => {
          const loci = event?.current?.loci;
          if (!structureLib.StructureElement.Loci.is(loci)) return;
          let position = null;
          structureLib.StructureElement.Loci.forEachLocation(loci, (location) => {
            if (position !== null) return;
            const chain = String(structureLib.StructureProperties.chain.auth_asym_id(location) || structureLib.StructureProperties.chain.label_asym_id(location) || 'A');
            const sequenceId = Number(structureLib.StructureProperties.residue.auth_seq_id(location) || structureLib.StructureProperties.residue.label_seq_id(location));
            const insertionCode = String(structureLib.StructureProperties.residue.pdbx_PDB_ins_code?.(location) || '').trim();
            position = canonicalByStructureRef.current.get(residueKey(chain, sequenceId, insertionCode)) ?? null;
          });
          if (position !== null) onPickRef.current(position);
        });
        await waitForCanvasDraw(canvas3d, { signal: renderController.signal });
        if (disposed) return disposeViewer();
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
      renderController.abort();
      clickSubscription?.unsubscribe?.();
      disposeViewer();
    };
  }, [showMembrane, structureError, structureFormatValue, structureLabel, structurePending, structureUrl]);

  useEffect(() => {
    membraneRepresentationRef.current?.setVisibility(membraneVisible);
  }, [membraneVisible]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || viewerState !== 'ready') return undefined;
    if (!Number.isInteger(selectedStart)) {
      try {
        viewer.plugin.managers.interactivity.lociSelects.deselectAll();
        viewer.plugin.managers.camera.reset?.(undefined, 180, { easing: 'cubic-out', trajectory: 'linear' });
      } catch { /* The viewer remains usable if the reset races disposal. */ }
      return undefined;
    }
    const items = structureSelectionItems(structureByCanonical, selectedStart, selectedEnd);
    if (!items.length) return undefined;
    const timer = window.setTimeout(() => {
      try {
        viewer.structureInteractivity({
          elements: { items },
          action: focusSelectionOnCamera ? ['select', 'focus'] : ['select'],
          ...(focusSelectionOnCamera ? { focusOptions: FOCUS_OPTIONS } : {}),
        });
      } catch { /* Selection is an enhancement. */ }
    }, 80);
    return () => window.clearTimeout(timer);
  }, [focusSelectionOnCamera, selectedStart, selectedEnd, structureByCanonical, viewerState]);

  return (
    <div class="frustration-structure-viewport topology-structure-viewport" role="group" aria-label="Estructura molecular coloreada por topología TMbed">
      <div ref={hostRef} class="frustration-molstar-host" role="img" aria-label="Estructura molecular coloreada por topología" />
      {showMembrane && membraneState !== 'error' && (
        <button
          type="button"
          class="topology-membrane-toggle"
          onClick={onToggleMembrane}
          disabled={membraneState !== 'ready'}
          aria-pressed={membraneVisible}
          aria-label={membraneVisible ? 'Ocultar membrana' : 'Mostrar membrana'}
          title={membraneVisible ? 'Ocultar membrana' : 'Mostrar membrana'}
        >
          <PackIcon name={membraneVisible ? 'eye-off' : 'eye'} kind="ui" />
          <span>{membraneVisible ? 'Ocultar membrana' : 'Mostrar membrana'}</span>
        </button>
      )}
      <TopologyLegend classes={presentClasses} />
      {viewerState === 'loading' && <StatePanel kind="loading" compact title="Cargando estructura" description="Preparando el modelo molecular publicado." className="frustration-viewport-state" />}
      {viewerState === 'unavailable' && <StatePanel kind="empty" compact icon="box" title="Estructura no disponible" description="No hay un PDB o mmCIF publicado para esta corrida." className="frustration-viewport-state" />}
      {viewerState === 'error' && <StatePanel kind="error" compact title="No se pudo cargar la estructura" description={viewerError} className="frustration-viewport-state" />}
      {Number.isInteger(selectedStart) && (
        <div class="frustration-structure-selection" aria-live="polite"><strong>{selectedResidueLabel}</strong><span>{selectedStart === selectedEnd ? 'Residuo seleccionado' : 'Región seleccionada'}</span></div>
      )}
    </div>
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

function Disclosure({ title, meta, description, open = false, children }) {
  return (
    <details class="frustration-disclosure" open={open}>
      <summary><span>{title}</span><b>{meta}</b></summary>
      <div class="frustration-disclosure-body">{description && <p>{description}</p>}{children}</div>
    </details>
  );
}

function AnnotationPanel({ rows, selectedPosition, selectedEnd, sequence, segments, topologyPublicationPending, onSelectRange }) {
  const selectedRow = rows.find((row) => row.position === selectedPosition) ?? null;
  const selectedResidue = residueAt(sequence, selectedPosition);
  const info = TOPOLOGY_CLASSES[selectedRow?.topologyClass ?? 'unknown'];
  const probability = selectedRow ? topologyClassProbability(selectedRow.artifact, selectedRow.topologyClass) : null;
  const regions = topologyRegions(rows);

  return (
    <aside class="frustration-annotations" aria-label="Anotaciones de topología">
      <div class="frustration-annotations-body">
        <section class="frustration-residue-summary" aria-label="Residuo seleccionado">
          <div class="frustration-residue-letter">{selectedResidue.one}</div>
          <div class="frustration-residue-name" style={{ '--residue-color': info.color }}>
            <strong>{selectedResidue.code ? `${selectedResidue.code} - ${selectedResidue.name}` : selectedResidue.name}</strong>
            <span>{selectedRow ? `${selectedResidue.one}${selectedPosition}` : 'Selecciona un residuo'}</span>
          </div>
          <strong class="frustration-residue-position">{selectedRow ? selectedPosition : '—'}</strong>
        </section>

        <section class="frustration-values" aria-label="Topología publicada del residuo">
          <h3>Topología TMbed</h3>
          {selectedRow ? (
            <dl class="frustration-evidence-list">
              <EvidenceRow label="Clase predicha" value={info.label} swatch={info.color} />
              {Number.isFinite(probability) && <EvidenceRow label="Probabilidad de la clase" value={formatProbability(probability)} />}
            </dl>
          ) : <p class="frustration-no-data">Selecciona un residuo para ver su clasificación.</p>}
        </section>

        {segments.length > 0 && (
          <Disclosure
            title="Segmentos transmembrana"
            meta={`${segments.length} ${segments.length === 1 ? 'segmento' : 'segmentos'}`}
            description="Segmentos transmembrana publicados por TMbed."
            open
          >
            <div class="topology-region-list">
              {segments.map((segment, index) => {
                const start = Number(segment.start ?? segment.start_position ?? segment.begin);
                const end = Number(segment.end ?? segment.end_position ?? segment.stop);
                const segmentClass = normalizeTopologyClass(segment.segment_type ?? segment.type ?? segment.topology ?? segment.tmbed_topology);
                const segmentInfo = TOPOLOGY_CLASSES[segmentClass];
                const selectable = Number.isInteger(start) && Number.isInteger(end);
                const selected = selectable && selectedPosition === start && selectedEnd === end;
                return (
                  <button
                    key={`${start}-${end}-${index}`}
                    type="button"
                    class={selected ? 'is-selected' : ''}
                    aria-pressed={selected}
                    onClick={() => selectable && onSelectRange(start, end)}
                  >
                    <span><i style={{ '--region-color': segmentInfo.color }} />{segmentInfo.shortLabel}</span><b>{selectable ? `${start}–${end}` : 'Rango no publicado'}</b>
                  </button>
                );
              })}
            </div>
          </Disclosure>
        )}

        <Disclosure
          title="Regiones topológicas"
          meta={regions.length ? `${regions.length} ${regions.length === 1 ? 'región' : 'regiones'}` : undefined}
          description="Tramos contiguos con la misma clase predicha por TMbed."
        >
          <div class="topology-region-list">
            {regions.length === 0 && (
              <StatePanel
                kind={topologyPublicationPending ? 'loading' : 'empty'}
                compact
                title={topologyPublicationPending ? 'Cargando topología' : 'No hay regiones topológicas'}
                description={topologyPublicationPending
                  ? 'Consultando los resultados publicados por TMbed.'
                  : 'No hay clasificaciones topológicas publicadas para esta corrida.'}
              />
            )}
            {regions.map((region) => {
              const regionInfo = TOPOLOGY_CLASSES[region.topologyClass];
              const selected = selectedPosition === region.start && selectedEnd === region.end;
              return (
                <button
                  key={`${region.start}-${region.end}`}
                  type="button"
                  class={selected ? 'is-selected' : ''}
                  aria-pressed={selected}
                  onClick={() => onSelectRange(region.start, region.end)}
                >
                  <span><i style={{ '--region-color': regionInfo.color }} />{regionInfo.shortLabel}</span>
                  <b>{region.start === region.end ? region.start : `${region.start}–${region.end}`} · {region.count}</b>
                </button>
              );
            })}
          </div>
        </Disclosure>

        <p class="topology-source">Clases y probabilidades publicadas por <a href={TMBED_REFERENCE_URL} target="_blank" rel="noreferrer">TMbed</a>.</p>
      </div>
    </aside>
  );
}

/** @param {{ proteinId: string | undefined }} props */
export default function TopologyView({ proteinId }) {
  const runId = typeof window === 'undefined' ? '' : new URLSearchParams(window.location.search).get('run') ?? '';
  const [protein, setProtein] = useState(null);
  const [runProtein, setRunProtein] = useState(null);
  const [run, setRun] = useState(null);
  const [annotations, setAnnotations] = useState([]);
  const [artifactDetails, setArtifactDetails] = useState({});
  const [annotationsTruncated, setAnnotationsTruncated] = useState(false);
  const [structureUrl, setStructureUrl] = useState('');
  const [structureLoadState, setStructureLoadState] = useState('idle');
  const [state, setState] = useState('loading');
  const [error, setError] = useState('');
  const [selection, setSelection] = useState(null);
  const [focusSelectionOnCamera, setFocusSelectionOnCamera] = useState(false);
  const [membraneState, setMembraneState] = useState('not_applicable');
  const [membraneVisible, setMembraneVisible] = useState(true);
  const selectionInitializedRef = useRef(false);
  const latestRunRef = useRef(null);
  const selectedPosition = selection?.start ?? null;
  const selectedEnd = selection?.end ?? null;

  const toggleSelectedPosition = (position) => {
    setFocusSelectionOnCamera(true);
    setSelection((current) => (
      current?.start === position && current?.end === position ? null : { start: position, end: position }
    ));
  };
  const selectRange = (start, end) => {
    setFocusSelectionOnCamera(true);
    setSelection((current) => (
      current?.start === start && current?.end === end ? null : { start, end }
    ));
  };

  useEffect(() => {
    let active = true;
    async function load() {
      if (!runId) {
        setState('no-run');
        return;
      }
      try {
        const [proteinData, runData, annotationData] = await Promise.all([
          getProtein(proteinId),
          getRun(runId),
          getAllAnnotations(runId),
        ]);
        const runProteinData = runData.protein_id && runData.protein_id !== proteinData.id
          ? await getProtein(runData.protein_id)
          : null;
        const details = await loadAnalysisArtifactDetails(runData, 'topology', getArtifactBlob);
        if (!active) return;
        latestRunRef.current = runData;
        setProtein(proteinData);
        setRunProtein(runProteinData);
        setRun(runData);
        setAnnotations(annotationData.rows ?? []);
        setAnnotationsTruncated(Boolean(annotationData.truncated));
        setArtifactDetails(details);
        setState('ready');
      } catch (requestError) {
        if (!active) return;
        setState('error');
        setError(userErrorMessage(requestError, 'No se pudo cargar la vista de topología.'));
      }
    }
    void load();
    return () => { active = false; };
  }, [proteinId, runId]);

  useEffect(() => {
    if (!runId || !run?.external_tracking?.tracking_active) return undefined;
    let active = true;
    let refreshing = false;

    const refresh = async () => {
      if (refreshing || document.visibilityState !== 'visible') return;
      refreshing = true;
      try {
        const nextRun = await getRun(runId);
        if (!active) return;
        const publicationChanged = runStagePublicationSignature(
          latestRunRef.current,
          ['membrane_topology'],
        ) !== runStagePublicationSignature(nextRun, ['membrane_topology']);
        latestRunRef.current = nextRun;
        setRun(nextRun);
        if (!publicationChanged) return;

        const [annotationData, details] = await Promise.all([
          getAllAnnotations(runId),
          loadAnalysisArtifactDetails(nextRun, 'topology', getArtifactBlob),
        ]);
        if (!active) return;
        setAnnotations(annotationData.rows ?? []);
        setAnnotationsTruncated(Boolean(annotationData.truncated));
        setArtifactDetails(details);
      } catch {
        // Keep the last confirmed topology while MN5 or the local API is unavailable.
      } finally {
        refreshing = false;
      }
    };

    const timer = window.setInterval(() => { void refresh(); }, 5000);
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [proteinId, runId, run?.external_tracking?.tracking_active]);

  const structureRequest = useMemo(() => structureSource(run), [run]);
  useEffect(() => {
    let active = true;
    setStructureUrl('');
    setStructureLoadState(structureRequest ? 'loading' : 'unavailable');
    if (!structureRequest) return () => { active = false; };
    const lease = acquireStructureUrl(structureRequest.id, structureRequest.loadUrl);
    lease.promise.then((url) => {
      if (active) {
        setStructureUrl(url);
        setStructureLoadState('ready');
      }
    }).catch(() => {
      if (active) setStructureLoadState('error');
    });
    return () => {
      active = false;
      lease.release();
    };
  }, [structureRequest?.id]);

  const topologyAnnotations = useMemo(
    () => annotations.filter((row) => row.stage_id === 'membrane_topology'),
    [annotations],
  );
  const annotationByPosition = useMemo(() => mergeAnnotationRows(topologyAnnotations), [topologyAnnotations]);
  const sequenceProtein = sequenceProteinForRun(run, protein, runProtein);
  const sequence = sequenceProtein?.sequence ?? '';
  const sequenceLabel = run?.external_tracking?.run_type === 'mutant'
    ? 'Secuencia mutante coloreada por topología TMbed'
    : 'Secuencia canónica coloreada por topología TMbed';
  const rows = useMemo(() => topologyRows(sequence, annotationByPosition, artifactDetails), [annotationByPosition, artifactDetails, sequence]);
  const hasTopologyData = useMemo(
    () => hasPublishedTopologyData(topologyAnnotations, artifactDetails?.tmbed_per_residue),
    [topologyAnnotations, artifactDetails?.tmbed_per_residue],
  );
  const mapping = useMemo(
    () => structureMappingMaps(structureMappingFromArtifactRows(
      run?.configuration?.structure_mapping,
      artifactDetails?.structure_mapping,
    )),
    [artifactDetails?.structure_mapping, run?.configuration?.structure_mapping],
  );
  const colorMap = useMemo(() => {
    const colors = new Map();
    for (const row of rows) {
      const key = mapping.byCanonical.get(row.position);
      if (key) colors.set(key, TOPOLOGY_CLASSES[row.topologyClass].color);
    }
    return colors;
  }, [mapping.byCanonical, rows]);
  const segments = artifactDetails?.tm_segments ?? [];
  const spanMetadata = artifactDetails?.span_metadata?.[0] ?? null;
  const showMembrane = segments.length > 0 || Number(spanMetadata?.segment_count) > 0;
  const topologyStage = run?.stages?.find((stage) => stage.id === 'membrane_topology');
  const topologyPublicationPending = run?.external_tracking?.tracking_active
    && topologyStage?.status === 'success'
    && !hasTopologyData;
  const presentClasses = useMemo(() => {
    const observed = new Set(rows.map((row) => row.topologyClass));
    return ['tm_alpha', 'tm_beta', 'outside', 'inside', 'signal_peptide', 'unknown'].filter((topologyClass) => observed.has(topologyClass));
  }, [rows]);

  useEffect(() => {
    setMembraneState(showMembrane ? 'loading' : 'not_applicable');
  }, [proteinId, runId, showMembrane]);

  useEffect(() => {
    selectionInitializedRef.current = false;
    setFocusSelectionOnCamera(false);
    setSelection(null);
    setMembraneVisible(true);
  }, [proteinId, runId]);

  useEffect(() => {
    if (selectionInitializedRef.current || selectedPosition !== null || !rows.length) return;
    const firstInformative = rows.find((row) => ['tm_alpha', 'tm_beta'].includes(row.topologyClass))
      ?? rows.find((row) => row.topologyClass === 'signal_peptide')
      ?? rows.find((row) => row.topologyClass !== 'unknown')
      ?? rows[0];
    selectionInitializedRef.current = true;
    setSelection({ start: firstInformative.position, end: firstInformative.position });
  }, [rows, selectedPosition]);

  if (state === 'loading') return <section class="frustration-page"><StatePanel kind="loading" fill title="Cargando topología" description="Consultando la corrida y los resultados publicados por TMbed." /></section>;
  if (state === 'no-run') return <section class="frustration-page"><StatePanel kind="empty" fill icon="workflow" title="No hay una corrida seleccionada" description="Selecciona una corrida desde el historial o la vista de progreso para consultar su topología."><a class="protein-open" href="/proteins/">Mis proteínas</a></StatePanel></section>;
  if (state === 'error') return <section class="frustration-page"><StatePanel kind="error" fill title="No se pudo cargar la topología" description={error} /></section>;

  const selectedResidue = residueAt(sequence, selectedPosition);
  const selectedResidueLabel = Number.isInteger(selectedPosition)
    ? selectedPosition === selectedEnd
      ? `${selectedResidue.one}${selectedPosition}`
      : `${selectedResidue.one}${selectedPosition}–${residueAt(sequence, selectedEnd).one}${selectedEnd}`
    : '—';
  return (
    <section class="frustration-page topology-page" aria-label="Topología de membrana">
      <div class="frustration-chain-card">
      <SequenceStrip rows={rows} selectedStart={selectedPosition} selectedEnd={selectedEnd} sequenceLabel={sequenceLabel} onSelect={toggleSelectedPosition} />
      </div>

      {annotationsTruncated && <p class="frustration-live-message" role="status">La cobertura de anotaciones es parcial; los residuos sin resultado se muestran como “Sin dato”.</p>}

      <div class="frustration-workspace topology-workspace">
        <article class="frustration-method-card topology-method-card">
          <header class="frustration-method-head topology-method-head">
            <h2>Topología de membrana</h2>
            <span>TMbed</span>
          </header>
          <TopologyStructure
            structureUrl={structureUrl}
            structurePending={structureLoadState === 'loading'}
            structureError={structureLoadState === 'error'}
            structureFormatValue={structureRequest?.format}
            structureLabel={structureRequest?.label}
            colorMap={colorMap}
            structureByCanonical={mapping.byCanonical}
            canonicalByStructure={mapping.byStructure}
            selectedStart={selectedPosition}
            selectedEnd={selectedEnd}
            selectedResidueLabel={selectedResidueLabel}
            focusSelectionOnCamera={focusSelectionOnCamera}
            onPick={toggleSelectedPosition}
            showMembrane={showMembrane}
            membraneState={membraneState}
            onMembraneState={setMembraneState}
            presentClasses={presentClasses}
            membraneVisible={membraneVisible}
            onToggleMembrane={() => setMembraneVisible((visible) => !visible)}
          />
        </article>
        <AnnotationPanel
          rows={rows}
          selectedPosition={selectedPosition}
          selectedEnd={selectedEnd}
          sequence={sequence}
          segments={segments}
          topologyPublicationPending={topologyPublicationPending}
          onSelectRange={selectRange}
        />
      </div>
    </section>
  );
}
