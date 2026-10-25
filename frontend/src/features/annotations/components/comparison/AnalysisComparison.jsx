import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import StatePanel from '@shared/components/feedback/StatePanel.jsx';
import PackIcon from '@shared/components/icons/PackIcon.jsx';
import MetricSelect from '@features/annotations/components/shared/MetricSelect.jsx';
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
import { loadAnalysisArtifactDetails } from '@features/annotations/analysis-artifacts.js';
import { acquireStructureUrl } from '@features/annotations/structure-url-cache.js';
import { isStructureArtifact, structureFormat } from '@features/annotations/structure-format.js';
import { AA3, AA_NAMES, hexToColorInt, oneLetter } from '@features/annotations/viewer-presentation.js';
import { structureSelectionItems } from '@features/annotations/topology-presentation.js';
import { buildComparisonRibbon, createComparisonMeshGeometry } from '@features/annotations/comparison-mesh.js';
import { comparisonCameraAction, comparisonChannelSignature } from '@features/annotations/comparison-camera.js';
import { getZoomOptimizedCanvas3dProps } from '@features/annotations/zoom-rendering.js';
import {
  COMPARISON_MISSING_COLOR,
  buildAvailableComparisonAnalyses,
  composeComparisonSignals,
  reorderActiveAnalyses,
  selectFrustrationMetric,
  selectedResidueSections,
  toggleActiveAnalysis,
} from '@features/annotations/comparison-presentation.js';
import 'molstar/build/viewer/molstar.css';
import '@features/annotations/styles/frustration-comparison.css';
import '@features/annotations/styles/comparison.css';

const ANALYSIS_IDS = ['conservation', 'topology', 'ddg', 'contacts', 'frustration'];
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
  const preferredTypes = ['selected_reference_pdb', 'rosettamp_relaxed_pdb', 'foldx_relaxed_pdb', 'model_cif'];
  const artifact = preferredTypes.map((type) => artifacts.find((item) => item.artifact_type === type)).find(Boolean)
    ?? artifacts.find(isStructureArtifact);
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
  const aaByCanonical = new Map();
  for (const pair of mapping?.canonical_to_structure ?? []) {
    const position = Number(pair?.canonical_position ?? pair?.aa_position);
    const residueNumber = pair?.residue_number ?? pair?.auth_seq_id ?? pair?.label_seq_id;
    if (!Number.isInteger(position) || position < 1 || residueNumber === null || residueNumber === undefined || residueNumber === '') continue;
    const key = residueKey(pair?.chain ?? pair?.auth_asym_id ?? pair?.label_asym_id ?? 'A', residueNumber, pair?.insertion_code ?? pair?.icode ?? '');
    if (byCanonical.has(position) || byStructure.has(key)) continue;
    byCanonical.set(position, key);
    byStructure.set(key, position);
    const aa = String(pair?.aa ?? pair?.aa_ref ?? '').trim().toUpperCase();
    if (aa) aaByCanonical.set(position, aa);
  }
  return { byCanonical, byStructure, aaByCanonical };
}

function collectComparisonCaResidues(structure, structureLib, mapping, sequence) {
  const residues = [];
  const seenResidues = new Set();
  const { Unit, StructureElement, StructureProperties } = structureLib;
  for (const unit of structure.units ?? []) {
    if (!Unit.isAtomic(unit)) continue;
    for (const element of unit.elements) {
      const location = StructureElement.Location.create(structure, unit, element);
      if (StructureProperties.atom.label_atom_id(location).trim().toUpperCase() !== 'CA') continue;
      const residueIndex = unit.residueIndex[element];
      const residueToken = `${unit.id}|${residueIndex}`;
      if (seenResidues.has(residueToken)) continue;
      seenResidues.add(residueToken);

      const authChain = String(StructureProperties.chain.auth_asym_id(location) ?? '').trim();
      const labelChain = String(StructureProperties.chain.label_asym_id(location) ?? '').trim();
      const chain = authChain || labelChain || 'A';
      const authSequence = Number(StructureProperties.residue.auth_seq_id(location));
      const labelSequence = Number(StructureProperties.residue.label_seq_id(location));
      const seq = Number.isFinite(authSequence) ? authSequence : labelSequence;
      const insertionCode = String(StructureProperties.residue.pdbx_PDB_ins_code(location) ?? '').trim();
      const key = residueKey(chain, seq, insertionCode);
      const compId = StructureProperties.residue.label_comp_id(location);
      const aa = oneLetter(compId).toUpperCase();
      const candidatePosition = mapping.byStructure.get(key) ?? null;
      const canonicalAa = Number.isInteger(candidatePosition) ? String(sequence[candidatePosition - 1] ?? '').toUpperCase() : '';
      const mappedAa = Number.isInteger(candidatePosition) ? mapping.aaByCanonical.get(candidatePosition) : null;
      const canonicalPosition = Number.isInteger(candidatePosition)
        && aa === canonicalAa
        && (!mappedAa || aa === mappedAa)
        ? candidatePosition
        : null;
      const ca = unit.conformation.position(element, [0, 0, 0]);
      residues.push({
        canonicalPosition,
        structureOrder: Number(residueIndex),
        structureSegment: String(unit.id),
        chain,
        seq,
        insertionCode,
        aa,
        ca: [ca[0], ca[1], ca[2]],
      });
    }
  }
  return residues;
}

function AnalysisChecklist({ available, activeIds, onToggle, onMove }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (event) => { if (!rootRef.current?.contains(event.target)) setOpen(false); };
    const escape = (event) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  return (
    <div ref={rootRef} class="comparison-checklist">
      <button type="button" class="comparison-checklist-trigger" onClick={() => setOpen((value) => !value)} aria-expanded={open} aria-haspopup="menu">
        <PackIcon name="layers-3" kind="ui" />
        <span>Comparar análisis</span>
        <b>{activeIds.length} activos</b>
      </button>
      {open && (
        <div class="comparison-checklist-menu" role="menu" aria-label="Análisis disponibles para comparar">
          {available.map((analysis) => {
            const selectedIndex = activeIds.indexOf(analysis.id);
            const checked = selectedIndex >= 0;
            return (
              <div class="comparison-checklist-row" key={analysis.id}>
                <button type="button" role="menuitemcheckbox" aria-checked={checked} onClick={() => onToggle(analysis.id)}>
                  <span class={`comparison-checkbox ${checked ? 'is-checked' : ''}`}>{checked ? '✓' : ''}</span>
                  <span><strong>{analysis.label}</strong><small>{analysis.source}</small></span>
                  {checked && <span class="comparison-checklist-order" aria-label={`Posición ${selectedIndex + 1}`}>{selectedIndex + 1}</span>}
                </button>
                {checked && activeIds.length > 1 && (
                  <span class="comparison-order-controls" aria-label={`Orden de ${analysis.label}`}>
                    <button type="button" onClick={() => onMove(analysis.id, 'up')} disabled={selectedIndex === 0} aria-label={`Mover ${analysis.label} una banda arriba`}>↑</button>
                    <button type="button" onClick={() => onMove(analysis.id, 'down')} disabled={selectedIndex === activeIds.length - 1} aria-label={`Mover ${analysis.label} una banda abajo`}>↓</button>
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function FrustrationMetricSelect({ analysis, value, onChange }) {
  if (!analysis || analysis.tracks.length < 2) return null;
  const options = analysis.tracks.map((track) => ({
    value: track.id,
    label: `${track.source} · ${track.label}`,
  }));
  return (
    <div class="comparison-frustration-metric">
      <MetricSelect
        id="comparison-frustration-metric"
        label="Métrica de frustración"
        options={options}
        value={value}
        onChange={onChange}
      />
    </div>
  );
}

function SequenceStrip({ composition, selectedPosition, onSelect }) {
  const trackRef = useRef(null);
  useEffect(() => {
    if (!selectedPosition) return;
    trackRef.current?.querySelector(`[data-position="${selectedPosition}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  }, [selectedPosition]);
  return (
    <div class="comparison-sequence-scroll" role="group" aria-label="Secuencia canónica con canales de análisis" tabIndex={0}>
      <div ref={trackRef} class="comparison-sequence-track">
        {composition.residues.map((residue) => (
          <button
            key={residue.position}
            type="button"
            class={`comparison-sequence-residue ${selectedPosition === residue.position ? 'is-selected' : ''}`}
            data-position={residue.position}
            aria-pressed={selectedPosition === residue.position}
            onClick={() => onSelect(residue.position)}
            title={`${residue.aa}${residue.position}`}
          >
            <span class="comparison-sequence-position">{residue.position % 10 === 0 || selectedPosition === residue.position ? residue.position : ''}</span>
            <strong>{residue.aa}</strong>
            <span class="comparison-sequence-bands" aria-hidden="true">
              {residue.channels.map((channel) => (
                <span class="comparison-sequence-band" key={channel.analysisId}>
                  {channel.colors.map((color, index) => <i key={index} style={{ background: color }} />)}
                </span>
              ))}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function LegendSource({ label, url }) {
  if (!url || !label) return null;
  return <a href={url} target="_blank" rel="noreferrer">{label}</a>;
}

function LegendScale({ analysis }) {
  const legend = analysis.legend;
  const selectedTrack = legend.kind === 'multi' ? legend.tracks?.[0] : null;
  if (legend.kind === 'multi' && !selectedTrack) return null;
  const track = selectedTrack ?? analysis.tracks?.[0];
  const categorical = legend.kind === 'categorical' || Boolean(selectedTrack?.categorical);
  const scaleSegments = track?.scaleSegments ?? [];
  const renderSegmentedScale = categorical && scaleSegments.length > 0;
  const categories = selectedTrack?.categories ?? legend.categories ?? [];
  const ticks = selectedTrack?.scaleTicks ?? null;
  const sourceLabel = legend.sourceLabel ?? track?.source;
  const sourceUrl = legend.sourceUrl ?? track?.sourceUrl;
  const trackLabel = track?.label ?? '';
  const note = selectedTrack
    ? selectedTrack.categorical ? selectedTrack.cutoffNote : selectedTrack.scaleNote
    : legend.note ?? legend.unitNote;
  const scaleLabels = renderSegmentedScale ? scaleSegments.map((segment) => segment.label) : categorical ? [] : ticks
    ? ticks.map((tick) => formatScaleTick(tick, track?.unit))
    : legend.kind === 'continuous'
      ? [
        legend.minLabel ?? formatDomain(legend.domain?.observedMin ?? legend.domain?.min),
        ...(legend.centerLabel ? [legend.centerLabel] : []),
        legend.maxLabel ?? formatDomain(legend.domain?.observedMax ?? legend.domain?.max),
      ]
      : [formatDomain(track?.domain?.min, track?.unit), formatDomain(track?.domain?.max, track?.unit)];
  const colors = selectedTrack?.colors ?? legend.colors ?? [];

  return (
    <div class="comparison-legend-card">
      <header><strong>{analysis.label}</strong></header>
      <small class="comparison-legend-track">{trackLabel}</small>
      <div class="comparison-legend-visual" role="group" aria-label={`Escala de ${analysis.label}`}>
        {renderSegmentedScale
          ? <div class="comparison-segmented-scale" aria-hidden="true">{scaleSegments.map((segment) => <i key={segment.key} style={{ background: segment.color }} />)}</div>
          : categorical
          ? <div class="comparison-category-legend">{categories.map((category) => <span key={category.key}><i style={{ background: category.color }} />{category.label}</span>)}</div>
          : <span class="comparison-gradient" style={{ background: `linear-gradient(90deg, ${colors.join(', ')})` }} />}
      </div>
      <div
        class={`comparison-scale-labels ${ticks ? 'has-ticks' : ''} ${renderSegmentedScale ? 'has-segments' : ''} ${categorical && !renderSegmentedScale ? 'is-empty' : ''}`}
        style={ticks || renderSegmentedScale ? { gridTemplateColumns: `repeat(${scaleLabels.length}, minmax(0, 1fr))` } : undefined}
        aria-hidden={categorical && !renderSegmentedScale ? 'true' : undefined}
      >
        {scaleLabels.map((label, index) => <span key={index}>{label}</span>)}
      </div>
      {note ? <p class="comparison-legend-note">{note}</p> : <span class="comparison-legend-note is-empty" aria-hidden="true" />}
      {sourceLabel && sourceUrl
        ? <LegendSource label={sourceLabel} url={sourceUrl} />
        : <span class="comparison-legend-source-placeholder" aria-hidden="true" />}
    </div>
  );
}

function formatDomain(value, unit = null) {
  if (!Number.isFinite(value)) return '—';
  const number = Number.isInteger(value) ? String(value) : String(Math.round(value * 1000) / 1000);
  return unit ? `${number} ${unit}` : number;
}

function formatScaleTick(value, unit = null) {
  const label = typeof value === 'number' ? formatDomain(value) : String(value);
  return unit ? `${label} ${unit}` : label;
}

function AnalysisLegends({ active }) {
  return (
    <div class={`comparison-legends ${active.length ? '' : 'is-empty'}`}>
      {active.length
        ? active.map((analysis) => <LegendScale key={analysis.id} analysis={analysis} />)
        : <p class="comparison-empty-inline">Selecciona al menos un análisis para componer sus señales.</p>}
    </div>
  );
}

function ResiduePanel({ sequence, selectedPosition, composition, availableAnalyses }) {
  const sections = selectedResidueSections(composition, selectedPosition, availableAnalyses);
  const aa = Number.isInteger(selectedPosition) ? String(sequence[selectedPosition - 1] ?? '?').toUpperCase() : '?';
  const residueCode = AA3[aa] ?? '';
  const residueName = residueCode ? AA_NAMES[residueCode] : 'Residuo';
  return (
    <aside class="comparison-side-panel" aria-label="Datos del residuo seleccionado">
      <div class="frustration-annotations-body">
        <section class="frustration-residue-summary comparison-residue-summary" aria-label="Residuo seleccionado">
          <div class="frustration-residue-letter">{aa}</div>
          <div class="frustration-residue-name">
            <strong>{residueCode ? `${residueCode} - ${residueName}` : residueName}</strong>
            <span>{Number.isInteger(selectedPosition) ? `${aa}${selectedPosition}` : 'Sin residuo seleccionado'}</span>
          </div>
          <strong class="frustration-residue-position">{selectedPosition ?? '—'}</strong>
        </section>
        {!composition.active.length && <StatePanel kind="empty" compact icon="layers-3" title="Ningún análisis seleccionado" description="Selecciona al menos un análisis para comparar sus datos." className="comparison-panel-empty" />}
        {composition.active.length > 0 && !selectedPosition && <StatePanel kind="empty" compact icon="circle-dot" title="Ningún residuo seleccionado" description="Selecciona un aminoácido para consultar los valores publicados." className="comparison-panel-empty" />}
        {composition.active.length > 0 && selectedPosition && !sections.length && <StatePanel kind="empty" compact icon="circle-slash" title="Sin datos para este residuo" description="No hay datos publicados en los análisis activos." className="comparison-panel-empty" />}
        {sections.map((section) => (
          <section class="comparison-evidence-section" key={section.analysisId}>
            <header><div><strong>{section.label}</strong>{section.source && <small>{section.source}</small>}</div><span class="comparison-panel-swatches">{section.colors.map((color, index) => <i key={index} style={{ background: color }} />)}</span></header>
            <dl>{section.rows.map((row, index) => <div key={`${row.label}-${index}`}><dt>{row.label}{row.source ? <small>{row.source}</small> : null}</dt><dd>{row.value}</dd></div>)}</dl>
            {section.note && <p>{section.note}</p>}
          </section>
        ))}
      </div>
    </aside>
  );
}

function comparisonDisplay(composition, caResidues, meshCache, Mesh) {
  let meshEntry = meshCache.current;
  if (!meshEntry || meshEntry.activeCount !== composition.active.length) {
    const meshData = buildComparisonRibbon(caResidues, composition.active.length);
    const geometry = createComparisonMeshGeometry(meshData, Mesh, meshEntry?.geometry);
    meshEntry = { activeCount: composition.active.length, meshData, geometry };
    meshCache.current = meshEntry;
  }
  return {
    ...meshEntry,
    colorsByPosition: new Map(composition.residues.map((residue) => [
      residue.position,
      residue.channels.map((channel) => channel.colors[0] ?? COMPARISON_MISSING_COLOR),
    ])),
    analysisLabels: composition.active.map(({ label }) => label),
    channelSignature: comparisonChannelSignature(composition),
  };
}

function ComparisonStructure({ structureRequest, composition, mapping, sequence, selectedPosition, onSelect, membraneAvailable, showMembrane, membraneVisible, onMembraneState, onToggleMembrane }) {
  const hostRef = useRef(null);
  const viewerRef = useRef(null);
  const mappingRef = useRef(mapping);
  const compositionRef = useRef(composition);
  const onSelectRef = useRef(onSelect);
  const showMembraneRef = useRef(showMembrane);
  const membraneVisibleRef = useRef(membraneVisible);
  const membraneRef = useRef(null);
  const shapeStateRef = useRef(null);
  const meshCacheRef = useRef(null);
  const shapeUpdaterRef = useRef(null);
  const providerRef = useRef(null);
  const updateQueueRef = useRef(Promise.resolve());
  const updateRequestRef = useRef(0);
  const [viewerState, setViewerState] = useState(structureRequest ? 'loading' : 'unavailable');
  const [viewerError, setViewerError] = useState('');
  mappingRef.current = mapping;
  compositionRef.current = composition;
  onSelectRef.current = onSelect;
  showMembraneRef.current = showMembrane;
  membraneVisibleRef.current = membraneVisible;

  useEffect(() => {
    if (!structureRequest || !hostRef.current) return undefined;
    let disposed = false;
    let clickSubscription;
    let viewerInstance;
    const lease = acquireStructureUrl(structureRequest.id, structureRequest.loadUrl);
    setViewerState('loading');
    setViewerError('');

    const makeShapeProvider = (molstar, stateRecord) => {
      const { Mesh, Shape, PluginStateObject: SO, PluginStateTransform, StateTransformer, ShapeRepresentation3D, ParamDefinition: PD } = molstar;
      const transform = PluginStateTransform.BuiltIn({
        name: `comparison-ribbon-${Math.random().toString(36).slice(2)}`,
        display: { name: 'Cinta Cα segmentada por análisis' },
        from: SO.Root,
        to: SO.Shape.Provider,
        params: { revision: PD.Numeric(0, { min: 0, step: 1, isHidden: true }) },
      })({
        canAutoUpdate: () => true,
        apply() {
          return new SO.Shape.Provider({
            label: 'Cinta multicanal sobre Cα',
            data: stateRecord,
            params: Mesh.Params,
            geometryUtils: Mesh.Utils,
            getShape: (_, record) => {
              const { meshData, geometry, colorsByPosition, analysisLabels } = record.current;
              return Shape.create(
                'Residuo segmentado por análisis',
                meshData,
                geometry,
                (groupId) => {
                  const meta = meshData.groupMeta[groupId];
                  if (!meta || !['front', 'back'].includes(meta.face) || meta.channelIndex < 0) return hexToColorInt('#b9c2c6');
                  if (!Number.isInteger(meta.canonicalPosition)) return hexToColorInt(COMPARISON_MISSING_COLOR);
                  return hexToColorInt(colorsByPosition.get(meta.canonicalPosition)?.[meta.channelIndex] ?? COMPARISON_MISSING_COLOR);
                },
                () => 1,
                (groupId) => {
                  const meta = meshData.groupMeta[groupId];
                  const channel = analysisLabels[meta?.channelIndex];
                  return meta?.canonicalPosition
                    ? `${meta.aa}${meta.canonicalPosition}${channel ? ` · ${channel}` : ''}`
                    : `Residuo estructural ${meta?.seq ?? ''}`;
                },
                undefined,
                meshData.groupMeta.length,
              );
            },
          }, { label: 'Cinta multicanal de proteína' });
        },
        update({ b }) {
          b.data.data = stateRecord;
          return StateTransformer.UpdateResult.Updated;
        },
      });
      return { transform, representation: ShapeRepresentation3D };
    };

    async function load() {
      try {
        const [
          { Viewer },
          structureLib,
          { Mesh },
          shapeModule,
          stateObjects,
          stateTransformers,
          representationTransforms,
          { OrderedSet },
          { ParamDefinition },
          objectUrl,
        ] = await Promise.all([
          import('molstar/lib/apps/viewer/app'),
          import('molstar/lib/mol-model/structure'),
          import('molstar/lib/mol-geo/geometry/mesh/mesh'),
          import('molstar/lib/mol-model/shape'),
          import('molstar/lib/mol-plugin-state/objects'),
          import('molstar/lib/mol-state'),
          import('molstar/lib/mol-plugin-state/transforms/representation'),
          import('molstar/lib/mol-data/int'),
          import('molstar/lib/mol-util/param-definition'),
          lease.promise,
        ]);
        if (disposed || !hostRef.current) return;
        const molstar = {
          Mesh,
          Shape: shapeModule.Shape,
          PluginStateObject: stateObjects.PluginStateObject,
          PluginStateTransform: stateObjects.PluginStateTransform,
          StateTransformer: stateTransformers.StateTransformer,
          ShapeRepresentation3D: representationTransforms.ShapeRepresentation3D,
          ParamDefinition,
        };
        const viewer = await Viewer.create(hostRef.current, {
          layoutIsExpanded: false, layoutShowControls: false, layoutShowRemoteState: false,
          layoutShowSequence: false, layoutShowLog: false, layoutShowLeftPanel: false,
          viewportShowExpand: false, viewportShowSelectionMode: false, viewportShowAnimation: false,
          viewportBackgroundColor: '#f7f9f8', pixelScale: 1, resolutionMode: 'auto',
        });
        viewerInstance = viewer;
        viewerRef.current = viewer;
        viewer.plugin.canvas3d?.setProps({
          ...getZoomOptimizedCanvas3dProps(),
          interaction: { maxFps: 60 },
          camera: { helper: { axes: { name: 'off', params: {} } } },
          cameraResetDurationMs: 180,
          cameraResetEasing: 'cubic-out',
          cameraResetTrajectory: 'linear',
        });
        await viewer.loadStructureFromUrl(objectUrl, structureRequest.format, false, { label: structureRequest.label });
        if (disposed) return;

        const structureEntry = viewer.plugin.managers.structure.hierarchy.current.structures[0];
        const structure = structureEntry?.cell?.obj?.data;
        if (!structure) throw new Error('Mol* no expuso la estructura cargada.');
        const caResidues = collectComparisonCaResidues(structure, structureLib, mappingRef.current, sequence);
        if (!caResidues.length) throw new Error('La estructura no contiene residuos con átomo Cα.');
        const { setSubtreeVisibility } = await import('molstar/lib/mol-plugin/behavior/static/state');
        for (const component of structureEntry.components ?? []) {
          for (const representation of component.representations ?? []) {
            setSubtreeVisibility(viewer.plugin.state.data, representation.cell.transform.ref, true);
          }
        }
        const record = { current: comparisonDisplay(compositionRef.current, caResidues, meshCacheRef, Mesh) };
        shapeStateRef.current = record;
        const { transform, representation } = makeShapeProvider(molstar, record);
        const providerReference = `comparison-ribbon-provider-${Math.random().toString(36).slice(2)}`;
        const update = viewer.plugin.state.data.build();
        const provider = update.toRoot().apply(transform, { revision: 0 }, { ref: providerReference });
        provider.apply(representation, { doubleSided: true });
        await viewer.plugin.runTask(viewer.plugin.state.data.updateTree(update));
        providerRef.current = provider.ref;

        const canvas = viewer.plugin.canvas3d;
        const ribbonBounds = record.current.geometry.boundingSphere;
        const fullStructureCenter = Float32Array.from(ribbonBounds.center);
        const fullStructureRadius = ribbonBounds.radius * 1.08;
        if (canvas?.camera && ribbonBounds?.radius > 0) {
          // Fit the generated ribbon itself; source structure bounds omit its width and thickness.
          canvas.camera.focus(fullStructureCenter, fullStructureRadius, 180);
        }

        shapeUpdaterRef.current = (nextComposition) => {
          const requestId = ++updateRequestRef.current;
          updateQueueRef.current = updateQueueRef.current.catch(() => {}).then(async () => {
            if (disposed || requestId !== updateRequestRef.current || !providerRef.current || !shapeStateRef.current) return;
            try {
              const previousDisplay = shapeStateRef.current.current;
              const nextDisplay = comparisonDisplay(nextComposition, caResidues, meshCacheRef, Mesh);
              shapeStateRef.current.current = nextDisplay;
              const next = viewer.plugin.state.data.build();
              next.to(providerRef.current).update(transform, (params) => ({ ...params, revision: requestId }));
              await viewer.plugin.runTask(viewer.plugin.state.data.updateTree(next));
              if (disposed || requestId !== updateRequestRef.current) return;
              const cameraAction = comparisonCameraAction(
                previousDisplay.channelSignature,
                nextDisplay.channelSignature,
              );
              if (cameraAction === 'structure') {
                await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                if (disposed || requestId !== updateRequestRef.current) return;
                viewer.plugin.canvas3d?.camera?.focus(fullStructureCenter, fullStructureRadius, 180);
              }
            } catch (error) {
              console.error(error);
              if (!disposed) {
                setViewerError('No se pudieron actualizar los canales de color de la estructura.');
                setViewerState('error');
              }
            }
          });
          return updateQueueRef.current;
        };

        if (membraneAvailable) {
          onMembraneState('loading');
          try {
            const { tryCreateMembraneOrientation } = await import('molstar/lib/extensions/anvil/behavior');
            const membrane = await tryCreateMembraneOrientation(viewer.plugin, structureEntry.cell, {
              visuals: ['bilayer-planes', 'bilayer-rims'], color: hexToColorInt('#8fb6c8'), radiusFactor: 1,
              sectorOpacity: 0.18, linesSize: 0.65, dashedLines: false,
            });
            membraneRef.current = { ref: membrane.ref, setVisibility: (visible) => setSubtreeVisibility(viewer.plugin.state.data, membrane.ref, !visible) };
            membraneRef.current.setVisibility(showMembraneRef.current && membraneVisibleRef.current);
            onMembraneState('ready');
          } catch { onMembraneState('error'); }
        } else onMembraneState('not_applicable');

        clickSubscription = viewer.subscribe(viewer.plugin.behaviors.interaction.click, (event) => {
          const loci = event?.current?.loci;
          const currentMesh = shapeStateRef.current?.current?.meshData;
          if (loci?.kind === 'group-loci' && loci.shape?.sourceData === currentMesh) {
            const ids = loci.groups?.[0]?.ids;
            const groupId = ids && OrderedSet.size(ids) ? OrderedSet.getAt(ids, 0) : null;
            const position = currentMesh.groupMeta[groupId]?.canonicalPosition;
            if (Number.isInteger(position)) onSelectRef.current(position);
            return;
          }
          if (!structureLib.StructureElement.Loci.is(loci)) return;
          let position = null;
          structureLib.StructureElement.Loci.forEachLocation(loci, (location) => {
            if (position !== null) return;
            const chain = String(structureLib.StructureProperties.chain.auth_asym_id(location) || structureLib.StructureProperties.chain.label_asym_id(location) || 'A');
            const sequenceId = Number(structureLib.StructureProperties.residue.auth_seq_id(location) || structureLib.StructureProperties.residue.label_seq_id(location));
            const insertionCode = String(structureLib.StructureProperties.residue.pdbx_PDB_ins_code(location) || '').trim();
            position = mappingRef.current.byStructure.get(residueKey(chain, sequenceId, insertionCode)) ?? null;
          });
          if (position !== null) onSelectRef.current(position);
        });
        setViewerState('ready');
      } catch (error) {
        console.error(error);
        if (!disposed) {
          setViewerError('No se pudo interpretar la estructura molecular publicada.');
          setViewerState('error');
        }
      }
    }
    void load();
    return () => {
      disposed = true;
      updateRequestRef.current += 1;
      clickSubscription?.unsubscribe?.();
      lease.release();
      viewerInstance?.dispose?.();
      if (viewerRef.current === viewerInstance) viewerRef.current = null;
      membraneRef.current = null;
      shapeStateRef.current = null;
      meshCacheRef.current = null;
      shapeUpdaterRef.current = null;
      providerRef.current = null;
    };
  }, [structureRequest?.id, membraneAvailable]);

  useEffect(() => {
    if (viewerState === 'ready') void shapeUpdaterRef.current?.(composition);
  }, [composition, viewerState]);

  useEffect(() => { membraneRef.current?.setVisibility(Boolean(showMembrane && membraneVisible)); }, [membraneVisible, showMembrane]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || viewerState !== 'ready') return undefined;
    if (!selectedPosition) {
      viewer.plugin.managers.interactivity.lociSelects.deselectAll();
      viewer.plugin.managers.camera.reset?.(undefined, 180, { easing: 'cubic-out', trajectory: 'linear' });
      return undefined;
    }
    const items = structureSelectionItems(mapping.byCanonical, selectedPosition, selectedPosition);
    if (!items.length) return undefined;
    const timer = window.setTimeout(() => {
      try { viewer.structureInteractivity({ elements: { items }, action: ['select', 'focus'], focusOptions: FOCUS_OPTIONS }); } catch { /* Sequence selection remains available. */ }
    }, 60);
    return () => window.clearTimeout(timer);
  }, [mapping, selectedPosition, viewerState]);

  return (
    <div class="comparison-viewport" role="group" aria-label="Estructura molecular única coloreada por análisis">
      <div ref={hostRef} class="comparison-molstar-host" role="img" aria-label="Cinta Cα segmentada por análisis sobre la estructura cargada en Mol*" />
      {showMembrane && (
        <button type="button" class="topology-membrane-toggle comparison-membrane-toggle" onClick={onToggleMembrane} aria-pressed={membraneVisible} title={membraneVisible ? 'Ocultar membrana' : 'Mostrar membrana'}>
          <PackIcon name={membraneVisible ? 'eye-off' : 'eye'} kind="ui" /><span>{membraneVisible ? 'Ocultar membrana' : 'Mostrar membrana'}</span>
        </button>
      )}
      {viewerState === 'loading' && <StatePanel kind="loading" compact title="Cargando estructura" description="Preparando el modelo molecular publicado." className="comparison-viewport-state" />}
      {viewerState === 'unavailable' && <StatePanel kind="empty" compact icon="box" title="Estructura no disponible" description="La corrida no publicó una estructura molecular." className="comparison-viewport-state" />}
      {viewerState === 'error' && <StatePanel kind="error" compact title="No se pudo cargar la estructura" description={viewerError} className="comparison-viewport-state" />}
      {selectedPosition && <div class="frustration-structure-selection" aria-live="polite"><strong>{`${sequence[selectedPosition - 1] ?? '?'}${selectedPosition}`}</strong><span>Residuo seleccionado</span></div>}
      {viewerState === 'ready' && <p class="comparison-disclaimer">La estructura de la proteína se simplificó geométricamente para mejorar la legibilidad de las comparaciones.</p>}
    </div>
  );
}

export default function AnalysisComparison({ proteinId }) {
  const runId = typeof window === 'undefined' ? '' : new URLSearchParams(window.location.search).get('run') ?? '';
  const [protein, setProtein] = useState(null);
  const [run, setRun] = useState(null);
  const [annotations, setAnnotations] = useState([]);
  const [detailsByAnalysis, setDetailsByAnalysis] = useState({});
  const [annotationsTruncated, setAnnotationsTruncated] = useState(false);
  const [activeIds, setActiveIds] = useState([]);
  const [frustrationMetricId, setFrustrationMetricId] = useState('');
  const [selectedPosition, setSelectedPosition] = useState(null);
  const [membraneVisible, setMembraneVisible] = useState(true);
  const [membraneState, setMembraneState] = useState('not_applicable');
  const [state, setState] = useState('loading');
  const [error, setError] = useState('');
  const initializedRef = useRef(false);

  useEffect(() => {
    let active = true;
    async function load() {
      if (!runId) {
        setState('error');
        setError('Selecciona una corrida desde el historial o la vista de progreso para comparar sus análisis.');
        return;
      }
      try {
        const [proteinData, runData, annotationData] = await Promise.all([getProtein(proteinId), getRun(runId), getAllAnnotations(runId)]);
        const detailEntries = await Promise.all(ANALYSIS_IDS.map(async (id) => [id, await loadAnalysisArtifactDetails(runData, id, getArtifactBlob)]));
        if (!active) return;
        setProtein(proteinData);
        setRun(runData);
        setAnnotations(annotationData.rows ?? []);
        setAnnotationsTruncated(Boolean(annotationData.truncated));
        setDetailsByAnalysis(Object.fromEntries(detailEntries));
        setState('ready');
      } catch (requestError) {
        if (!active) return;
        setError(userErrorMessage(requestError, 'No se pudo cargar la comparación de análisis.'));
        setState('error');
      }
    }
    void load();
    return () => { active = false; };
  }, [proteinId, runId]);

  const available = useMemo(() => buildAvailableComparisonAnalyses({ sequence: protein?.sequence ?? '', annotations, detailsByAnalysis }), [annotations, detailsByAnalysis, protein?.sequence]);
  const frustrationAnalysis = available.find(({ id }) => id === 'frustration') ?? null;
  useEffect(() => {
    if (!frustrationAnalysis?.tracks.some(({ id }) => id === frustrationMetricId)) {
      setFrustrationMetricId(frustrationAnalysis?.tracks[0]?.id ?? '');
    }
  }, [frustrationAnalysis, frustrationMetricId]);
  useEffect(() => {
    const ids = available.map(({ id }) => id);
    setActiveIds((current) => {
      const retained = current.filter((id) => ids.includes(id));
      if (!initializedRef.current) {
        initializedRef.current = true;
        return ids;
      }
      return retained;
    });
  }, [available]);

  const presentationAnalyses = useMemo(() => selectFrustrationMetric(available, frustrationMetricId), [available, frustrationMetricId]);
  const composition = useMemo(() => composeComparisonSignals({ sequence: protein?.sequence ?? '', analyses: presentationAnalyses, activeIds }), [activeIds, presentationAnalyses, protein?.sequence]);
  const mapping = useMemo(() => structureMappingMaps(run?.configuration?.structure_mapping ?? {}), [run?.configuration?.structure_mapping]);
  const structureRequest = useMemo(() => structureSource(run), [run]);
  const topologyActive = activeIds.includes('topology');
  const membraneAvailable = (detailsByAnalysis?.topology?.tm_segments?.length ?? 0) > 0
    || Number(detailsByAnalysis?.topology?.span_metadata?.[0]?.segment_count) > 0;
  const showMembrane = topologyActive && membraneAvailable && membraneState === 'ready';

  const togglePosition = (position) => setSelectedPosition((current) => current === position ? null : position);
  useEffect(() => { setMembraneVisible(true); setMembraneState('not_applicable'); setSelectedPosition(null); initializedRef.current = false; }, [proteinId, runId]);

  if (state === 'loading') return <section class="frustration-page comparison-page"><StatePanel kind="loading" fill title="Cargando comparación" description="Consultando los artefactos y metadatos publicados por la corrida." /></section>;
  if (state === 'error') return <section class="frustration-page comparison-page"><StatePanel kind="error" fill title="No se pudo cargar la comparación" description={error} /></section>;

  return (
    <section class="frustration-page comparison-page" aria-label="Comparación de análisis">
      <div class="comparison-top-card">
        <SequenceStrip composition={composition} selectedPosition={selectedPosition} onSelect={togglePosition} />
      </div>

      {annotationsTruncated && <p class="frustration-live-message" role="status">La cobertura de anotaciones es parcial; los valores ausentes se mantienen como “Sin dato publicado”.</p>}
      {!available.length && <p class="frustration-live-message" role="status">Esta corrida no contiene artefactos compatibles con la comparación.</p>}

      <div class="comparison-workspace">
        <main class="comparison-main-card">
          <ComparisonStructure
            structureRequest={structureRequest}
            composition={composition}
            mapping={mapping}
            sequence={protein?.sequence ?? ''}
            selectedPosition={selectedPosition}
            onSelect={togglePosition}
            membraneAvailable={membraneAvailable}
            showMembrane={showMembrane}
            membraneVisible={membraneVisible}
            onMembraneState={setMembraneState}
            onToggleMembrane={() => setMembraneVisible((value) => !value)}
          />
          <div class="comparison-canvas-controls" aria-label="Configuración de análisis">
            <AnalysisChecklist available={available} activeIds={activeIds} onToggle={(id) => setActiveIds((current) => toggleActiveAnalysis(current, id))} onMove={(id, direction) => setActiveIds((current) => reorderActiveAnalyses(current, id, direction))} />
            {activeIds.includes('frustration') && <FrustrationMetricSelect analysis={frustrationAnalysis} value={frustrationMetricId} onChange={setFrustrationMetricId} />}
          </div>
          <AnalysisLegends active={composition.active} />
        </main>
        <ResiduePanel sequence={protein?.sequence ?? ''} selectedPosition={selectedPosition} composition={composition} availableAnalyses={available} />
      </div>
    </section>
  );
}
