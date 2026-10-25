import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { getArtifactObjectUrl, getProtein, getRun, getUploadObjectUrl, subscribeRunEvents } from '@shared/api/client';
import StatePanel from '@shared/components/feedback/StatePanel.jsx';
import MetricSelect from '@features/annotations/components/shared/MetricSelect.jsx';
import { acquireStructureUrl } from '@features/annotations/structure-url-cache.js';
import { getZoomOptimizedCanvas3dProps } from '@features/annotations/zoom-rendering.js';
import { runFailureMessage, userErrorMessage } from '@shared/lib/error-presentation';
import {
  defaultStructureOption,
  structureGenerationFailed,
  structureGenerationPending,
  structureOptionsForRun,
} from './information-presentation.js';
import 'molstar/build/viewer/molstar.css';
import '@features/annotations/styles/frustration-comparison.css';
import '@features/stages/styles/info.css';

const RUN_TERMINAL = new Set(['success', 'failed', 'cancelled']);
const AF3_CONFIDENCE_SCALE = [
  { label: 'Sin dato', color: '#aaaaaa' },
  { label: 'Muy baja · ≤50', color: '#ff7d45' },
  { label: 'Baja · >50–70', color: '#ffdb13' },
  { label: 'Confiable · >70–90', color: '#65cbf3' },
  { label: 'Muy alta · >90', color: '#0053d6' },
];

function runLoadError(requestError, fallback) {
  return userErrorMessage(requestError, fallback);
}

function accessionFor(run, protein) {
  const configured = run?.configuration?.scientific_accession;
  if (configured) return configured;
  return protein?.aliases?.find((alias) => /uniprot/i.test(alias.source ?? ''))?.identifier ?? '';
}

function formatVariant(variant) {
  if (typeof variant === 'string') return variant;
  const identifier = variant?.variant_id ?? variant?.id;
  if (identifier) return String(identifier);
  const reference = variant?.aa_ref ?? variant?.reference_aa ?? '';
  const position = variant?.aa_position ?? variant?.position;
  const alternate = variant?.aa_alt ?? variant?.alternate_aa ?? '';
  return reference && Number.isInteger(Number(position)) && alternate
    ? `${reference}${position}${alternate}`
    : '';
}

function scientificFacts(run, protein, structure) {
  const configuration = run?.configuration ?? {};
  const sequence = String(protein?.sequence ?? '');
  const sequenceLength = Number(protein?.length) || sequence.length;
  const variants = (configuration.normalized_variants ?? run?.requested_variants ?? [])
    .map(formatVariant)
    .filter(Boolean);
  const mappingPairs = structure?.kind === 'alphafold3'
    ? null
    : configuration.structure_mapping?.canonical_to_structure;
  const mappedResidues = Array.isArray(mappingPairs) ? mappingPairs.length : null;
  return [
    ["Acceso científico", accessionFor(run, protein)],
    ["Longitud de secuencia", sequenceLength > 0 ? `${sequenceLength.toLocaleString('es-CO')} aminoácidos` : ''],
    ["Estructura mostrada", structure?.label ?? ''],
    ["Formato estructural", structure?.format === 'mmcif' ? 'mmCIF' : structure?.format?.toUpperCase() ?? ''],
    ["Cadena seleccionada", structure?.kind === 'alphafold3' ? '' : configuration.structure_chain ?? ''],
    ["Residuos mapeados en la estructura de entrada", mappedResidues > 0 ? mappedResidues.toLocaleString('es-CO') : ''],
    ["Variantes solicitadas", variants.length ? variants.join(', ') : ''],
  ].filter(([, value]) => value !== null && value !== undefined && String(value).trim() !== '');
}

function sequenceSelectionItems(selectedPositions, structure, structureMapping) {
  const positions = [...selectedPositions].sort((left, right) => left - right);
  if (structure?.kind === 'alphafold3') {
    return positions.map((position) => ({ auth_asym_id: 'A', auth_seq_id: position }));
  }

  const selected = new Set(positions);
  const byCanonical = new Map();
  for (const pair of structureMapping?.canonical_to_structure ?? []) {
    const canonicalPosition = Number(pair?.canonical_position ?? pair?.aa_position);
    const residueNumber = Number(pair?.residue_number ?? pair?.auth_seq_id ?? pair?.label_seq_id);
    if (!selected.has(canonicalPosition) || !Number.isInteger(residueNumber) || byCanonical.has(canonicalPosition)) continue;
    const chain = pair?.chain ?? pair?.auth_asym_id ?? pair?.label_asym_id ?? 'A';
    const insertionCode = pair?.insertion_code ?? pair?.icode ?? '';
    byCanonical.set(canonicalPosition, {
      auth_asym_id: String(chain),
      auth_seq_id: residueNumber,
      ...(insertionCode ? { pdbx_PDB_ins_code: String(insertionCode) } : {}),
    });
  }
  return positions.flatMap((position) => byCanonical.has(position) ? [byCanonical.get(position)] : []);
}

function SequenceStrip({ sequence, selectedPositions, onTogglePosition, onClearSelection }) {
  if (!sequence) return null;
  return (
    <div class="info-sequence-selection">
      <div class="info-sequence-toolbar">
        <span aria-live="polite">
          {selectedPositions.size
            ? `${selectedPositions.size} ${selectedPositions.size === 1 ? 'aminoácido seleccionado' : 'aminoácidos seleccionados'}`
            : 'Selecciona uno o varios aminoácidos para resaltarlos en la estructura.'}
        </span>
        {selectedPositions.size > 0 && <button type="button" class="info-sequence-clear" onClick={onClearSelection}>Limpiar selección</button>}
      </div>
      <div class="frustration-sequence-scroll" role="group" aria-label={`Secuencia canónica de ${sequence.length} aminoácidos`}>
        <div class="frustration-sequence-track">
          {[...sequence].map((aminoAcid, index) => {
            const position = index + 1;
            const selected = selectedPositions.has(position);
            return (
              <button
                key={`${position}-${aminoAcid}`}
                type="button"
                class={`frustration-sequence-residue info-sequence-residue ${selected ? 'is-selected' : ''}`}
                title={`${aminoAcid}${position}`}
                aria-label={`${selected ? 'Quitar' : 'Seleccionar'} ${aminoAcid}${position}`}
                aria-pressed={selected}
                onClick={() => onTogglePosition(position)}
              >
                <span class="frustration-sequence-position">{position % 10 === 0 || selected ? position : ''}</span>
                <span>{aminoAcid}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function StructureViewport({ structure, structureMapping, selectedPositions, generationPending, generationFailed }) {
  const hostRef = useRef(null);
  const viewerRef = useRef(null);
  const [state, setState] = useState(structure ? 'loading' : 'unavailable');

  useEffect(() => {
    if (!structure || !hostRef.current) {
      setState('unavailable');
      return undefined;
    }

    let disposed = false;
    let viewer = null;
    viewerRef.current = null;
    const lease = acquireStructureUrl(structure.value, () => (
      structure.source === 'upload'
        ? getUploadObjectUrl(structure.id)
        : getArtifactObjectUrl(structure.id)
    ));
    setState('loading');

    const disposeViewer = () => {
      try {
        viewer?.dispose?.();
      } catch {
        // Mol* may already have released its WebGL context during unmount.
      }
      if (viewerRef.current === viewer) viewerRef.current = null;
      viewer = null;
    };

    async function loadStructure() {
      try {
        const [{ Viewer }, url] = await Promise.all([
          import('molstar/lib/apps/viewer/app'),
          lease.promise,
        ]);
        if (disposed || !hostRef.current) return;

        viewer = await Viewer.create(hostRef.current, {
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
        viewerRef.current = viewer;
        if (disposed) {
          disposeViewer();
          return;
        }

        viewer.plugin.canvas3d?.setProps(getZoomOptimizedCanvas3dProps());
        await viewer.loadStructureFromUrl(url, structure.format, false, { label: structure.label });
        if (!disposed) setState('ready');
      } catch {
        disposeViewer();
        if (!disposed) setState('error');
      }
    }

    void loadStructure();
    return () => {
      disposed = true;
      disposeViewer();
      lease.release();
    };
  }, [structure?.format, structure?.id, structure?.label, structure?.source, structure?.value]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || state !== 'ready') return;
    try {
      viewer.plugin.managers.interactivity.lociSelects.deselectAll();
      const items = sequenceSelectionItems(selectedPositions, structure, structureMapping);
      if (items.length) viewer.structureInteractivity({ elements: { items }, action: ['select'] });
    } catch {
      // Keep sequence selection available when the structure has no matching residues.
    }
  }, [selectedPositions, state, structure, structureMapping]);

  const visibleState = structure ? state : generationPending ? 'waiting' : 'unavailable';
  const descriptions = {
    waiting: 'La estructura aparecerá aquí cuando el modelado o la relajación publique su resultado.',
    unavailable: generationFailed
      ? 'El pipeline no publicó una estructura PDB o mmCIF para esta corrida.'
      : 'Esta corrida todavía no tiene un PDB, modelo de AlphaFold 3 ni estructura relajada disponibles.',
  };

  return (
    <div class="frustration-structure-viewport info-structure-viewport">
      <div ref={hostRef} class="frustration-molstar-host" aria-hidden={visibleState !== 'ready'} />
      {structure?.kind === 'alphafold3' && visibleState === 'ready' && <StructureConfidenceScale />}
      {visibleState === 'loading' && <StatePanel kind="loading" compact title="Cargando estructura" description="Preparando el modelo molecular publicado." className="frustration-viewport-state" />}
      {visibleState === 'waiting' && <StatePanel kind="waiting" compact icon="box" title="Estructura aún no disponible" description={descriptions.waiting} className="frustration-viewport-state" />}
      {visibleState === 'unavailable' && <StatePanel kind="empty" compact icon="box" title="Estructura no disponible" description={descriptions.unavailable} className="frustration-viewport-state" />}
      {visibleState === 'error' && <StatePanel kind="error" compact title="No se pudo cargar la estructura" description="El archivo está publicado, pero Mol* no pudo interpretarlo." className="frustration-viewport-state" />}
    </div>
  );
}

function StructureConfidenceScale() {
  return (
    <div class="info-confidence-overlay" aria-label="Escala de confianza pLDDT de AlphaFold 3">
      <span class="info-confidence-title">Confianza pLDDT</span>
      <span class="info-confidence-items">
        {AF3_CONFIDENCE_SCALE.map(({ label, color }) => (
          <span key={label} class="info-confidence-item">
            <i style={{ background: color }} aria-hidden="true" />
            {label}
          </span>
        ))}
      </span>
    </div>
  );
}

function GeneralInformation({ facts }) {
  return (
    <aside class="frustration-annotations info-general-panel" aria-label="Información general científica">
      <header class="info-panel-head"><h2>Información general</h2></header>
      <div class="frustration-annotations-body">
        {facts.length ? (
          <dl class="info-facts">
            {facts.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd title={value}>{value}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p class="info-card-note">Aún no hay metadatos científicos publicados para esta corrida.</p>
        )}
      </div>
    </aside>
  );
}

export default function InformationView({ proteinId }) {
  const [run, setRun] = useState(null);
  const [protein, setProtein] = useState(null);
  const [state, setState] = useState('loading');
  const [error, setError] = useState('');
  const [refreshWarning, setRefreshWarning] = useState('');
  const [selectedStructureValue, setSelectedStructureValue] = useState('');
  const [selectedPositions, setSelectedPositions] = useState(() => new Set());
  const runId = typeof window === 'undefined' ? '' : new URLSearchParams(window.location.search).get('run') ?? '';

  useEffect(() => {
    if (!proteinId) return undefined;
    let active = true;
    setProtein(null);
    getProtein(proteinId)
      .then((result) => { if (active) setProtein(result); })
      .catch(() => { if (active) setProtein(null); });
    return () => { active = false; };
  }, [proteinId]);

  useEffect(() => {
    setRun(null);
    setState('loading');
    setSelectedStructureValue('');
    setSelectedPositions(new Set());
    if (!runId) {
      setState('missing-run');
      return undefined;
    }

    let active = true;
    let timer = null;
    let streamController = null;
    let fallbackAttempts = 0;
    let latestStatus = null;

    const clearTimer = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
    };

    const scheduleFallback = (load, delay = 4000) => {
      if (!active || RUN_TERMINAL.has(latestStatus) || fallbackAttempts >= 3) {
        if (active && fallbackAttempts >= 3) setRefreshWarning('La actualización automática se detuvo; recarga para consultar el estado actual.');
        return;
      }
      fallbackAttempts += 1;
      clearTimer();
      timer = window.setTimeout(load, delay);
    };

    const applySnapshot = (snapshot) => {
      if (!active || !snapshot) return;
      latestStatus = snapshot.status;
      setRun(snapshot);
      setState('ready');
      setError('');
      setRefreshWarning('');
    };

    const connectStream = async (load) => {
      if (!active || RUN_TERMINAL.has(latestStatus)) return;
      streamController?.abort();
      const controller = new AbortController();
      streamController = controller;
      try {
        await subscribeRunEvents(runId, {
          signal: controller.signal,
          onSnapshot: (snapshot) => {
            applySnapshot(snapshot);
            if (RUN_TERMINAL.has(snapshot?.status)) {
              clearTimer();
              controller.abort();
            }
          },
        });
        if (active && !controller.signal.aborted && !RUN_TERMINAL.has(latestStatus)) scheduleFallback(load);
      } catch (streamError) {
        if (!active || controller.signal.aborted || RUN_TERMINAL.has(latestStatus)) return;
        setRefreshWarning(runLoadError(streamError, 'La actualización en vivo no está disponible.'));
        scheduleFallback(load);
      }
    };

    const load = async () => {
      if (!active) return;
      try {
        const snapshot = await getRun(runId);
        applySnapshot(snapshot);
        clearTimer();
        if (!RUN_TERMINAL.has(snapshot?.status)) await connectStream(load);
      } catch (requestError) {
        if (!active) return;
        setState('error');
        setError(runLoadError(requestError, 'No se pudo cargar la corrida.'));
        scheduleFallback(load);
      }
    };

    void load();
    return () => {
      active = false;
      clearTimer();
      streamController?.abort();
    };
  }, [runId]);

  const structureOptions = useMemo(() => structureOptionsForRun(run), [run]);
  const defaultStructure = defaultStructureOption(structureOptions);
  const selectedStructure = structureOptions.find((option) => option.value === selectedStructureValue) ?? defaultStructure;
  const facts = scientificFacts(run, protein, selectedStructure);
  const generatingStructure = structureGenerationPending(run);
  const failedStructureGeneration = structureGenerationFailed(run);
  const toggleSelectedPosition = (position) => {
    setSelectedPositions((current) => {
      const next = new Set(current);
      if (next.has(position)) next.delete(position);
      else next.add(position);
      return next;
    });
  };

  if (state === 'missing-run') {
    return <section class="frustration-page info-view"><StatePanel kind="empty" fill icon="workflow" title="No hay una corrida seleccionada" description="Selecciona una corrida persistida para consultar la proteína y su estructura."><a class="protein-open" href={`/proteins/${encodeURIComponent(proteinId)}/progress/`}>Ver progreso</a></StatePanel></section>;
  }
  if (state === 'loading') return <section class="frustration-page info-view"><StatePanel kind="loading" fill title="Cargando información" description="Consultando la secuencia, los modelos y los metadatos publicados." /></section>;
  if (state === 'error' && !run) return <section class="frustration-page info-view"><StatePanel kind="error" fill title="No se pudo cargar la corrida" description={error} /></section>;
  if (!run) return null;

  return (
    <section class="frustration-page info-view" aria-label="Información de la proteína">
      {refreshWarning && <div class="info-refresh-warning" role="status">{refreshWarning}</div>}

      {protein?.sequence && (
        <div class="frustration-chain-card info-sequence-card">
          <SequenceStrip
            sequence={protein.sequence}
            selectedPositions={selectedPositions}
            onTogglePosition={toggleSelectedPosition}
            onClearSelection={() => setSelectedPositions(new Set())}
          />
        </div>
      )}

      <div class="frustration-workspace info-workspace">
        <article class="frustration-method-card info-structure-card">
          <header class="frustration-method-head info-structure-head">
            <h2>Estructura molecular</h2>
            {structureOptions.length > 0 ? (
              <MetricSelect
                id="information-structure-source"
                label="Seleccionar estructura molecular"
                options={structureOptions}
                value={selectedStructure?.value ?? structureOptions[0].value}
                onChange={setSelectedStructureValue}
                disabled={structureOptions.length < 2}
              />
            ) : <span class="info-structure-empty-label">Sin estructura publicada</span>}
          </header>
          <StructureViewport
            structure={selectedStructure}
            structureMapping={run?.configuration?.structure_mapping}
            selectedPositions={selectedPositions}
            generationPending={generatingStructure}
            generationFailed={failedStructureGeneration}
          />
        </article>
        <GeneralInformation facts={facts} />
      </div>

      {run.status === 'failed' && run.error_message && (
        <p class="info-run-error" role="alert">{runFailureMessage(run.error_code, run.error_message)}</p>
      )}
    </section>
  );
}
