import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import PackIcon from '@shared/components/icons/PackIcon.jsx';
import StageIcon from '@shared/components/icons/StageIcon.jsx';
import StatePanel from '@shared/components/feedback/StatePanel.jsx';
import { ApiError, cancelRun, getActiveRun, getRun, subscribeRunEvents } from '@shared/api/client';
import { presentRunStages } from '@features/runs/stage-visibility.js';
import { runPhase } from '@features/runs/run-phase.js';
import { runFailureMessage, userErrorMessage } from '@shared/lib/error-presentation';
import {
  buildEdges, compactStageLayout, PIPELINE_NODE, stagesForPipelineLayout,
} from '@features/runs/pipeline-layout.js';
import { stagePresentation } from '@features/runs/stage-presentation.js';
import '@features/runs/styles/progress.css';

const STATUS_ICON = {
  pending: 'circle-dot',
  ready: 'circle-dot',
  queued: 'circle-dot',
  running: 'circle-dot',
  failed: 'circle-x',
  blocked: 'circle-dot',
  skipped: 'circle-dot',
  cancelled: 'circle-slash',
  success: 'circle-check',
  reused: 'circle-check',
};

const STATUS_TEXT = {
  pending: 'Pendiente',
  ready: 'Listo',
  queued: 'En cola',
  running: 'En ejecución',
  success: 'Completado',
  reused: 'Resultado reutilizado',
  failed: 'Falló',
  skipped: 'No aplica',
  cancelled: 'Cancelado',
  cancel_requested: 'Cancelación solicitada',
  disabled: 'Desactivado',
  blocked: 'Bloqueado',
};

const OMISSION_REASON_TEXT = {
  provided_pdb_selected: 'PDB proporcionado',
  variants_not_provided: 'Sin variantes confirmadas',
  technical_prerequisite_not_provided: 'Prerrequisito técnico faltante',
  dependency_not_applicable: 'Dependencia no aplicable',
};

const RUN_TERMINAL = new Set(['success', 'failed', 'cancelled']);

function formatElapsed(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (totalSeconds < 60) return `${totalSeconds} s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes} min ${seconds} s`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

function displayStatus(status) {
  if (status === 'success' || status === 'reused') return 'success';
  if (status === 'ready' || status === 'queued') return 'pending';
  if (status === 'cancel_requested') return 'cancelled';
  return status;
}

function edgeStatus(stage) {
  return stage.preflight_status === 'blocked' ? 'blocked' : displayStatus(stage.status);
}

function stageVisualStatus(stage) {
  return stage.preflight_status === 'blocked' ? 'blocked' : displayStatus(stage.status);
}

function StageRuntime({ stage, now }) {
  if (stage.status === 'disabled') return <span>Desactivado</span>;
  if (stage.error_message) return <span class="stage-runtime-error">{STATUS_TEXT[stage.status] ?? stage.status} · {runFailureMessage(stage.error_code, stage.error_message)}</span>;
  if (stage.preflight_status === 'blocked') {
    return <span>Preparación pendiente · {stage.preflight_error_message ? runFailureMessage(stage.preflight_error_code, stage.preflight_error_message) : 'prerrequisito no disponible'}</span>;
  }
  if (stage.preflight_status === 'running') return <span>Comprobando prerrequisitos…</span>;
  if (stage.status === 'skipped' && stage.omission_reason) {
    return <span>No aplica · {OMISSION_REASON_TEXT[stage.omission_reason] ?? stage.omission_reason}</span>;
  }
  if (stage.status === 'reused') {
    const source = stage.reuse_reason?.source_stage_result_id ?? stage.stage_result_id;
    return <span>Resultado reutilizado{source ? ` · resultado ${source}` : ''}</span>;
  }
  if (stage.status === 'running' && stage.started_at) {
    return <span>Lleva {formatElapsed(now - new Date(stage.started_at).getTime())}</span>;
  }
  if (stage.started_at && stage.finished_at) {
    return <span>Duró {formatElapsed(new Date(stage.finished_at).getTime() - new Date(stage.started_at).getTime())}</span>;
  }
  const label = STATUS_TEXT[stage.status] ?? stage.status;
  if (stage.slurm_job_id && (stage.status === 'queued' || stage.status === 'running')) {
    return <span>{label} · job {stage.slurm_job_id}</span>;
  }
  return <span>{label}</span>;
}

function rememberRun(runId) {
  const url = new URL(window.location.href);
  if (url.searchParams.get('run') === runId) return;
  url.searchParams.set('run', runId);
  window.history.replaceState(null, '', `${url.pathname}${url.search}`);
  for (const link of document.querySelectorAll('a.sidebar-item')) {
    const href = link.getAttribute('href');
    if (!href || !href.includes('/proteins/')) continue;
    const next = new URL(href, window.location.origin);
    next.searchParams.set('run', runId);
    link.setAttribute('href', `${next.pathname}${next.search}`);
  }
}

const STAGE_ANALYSIS_ROUTES = {
  membrane_topology: 'topology',
  evolutionary_conservation: 'conservation',
  functional_region_evidence: 'functional-regions',
  uniprot_features: 'functional-regions',
  variant_ddg: 'variant-ddg',
  structural_contacts: 'contacts',
  structural_frustration: 'frustration',
  sequence_frustration: 'frustration',
  ensemble_frustration: 'frustration',
};

function stageHref(proteinId, runId, stageId) {
  const route = STAGE_ANALYSIS_ROUTES[stageId];
  const path = route ? `/${route}/` : '/info/';
  return `/proteins/${encodeURIComponent(proteinId)}${path}?run=${encodeURIComponent(runId)}`;
}

export default function PipelineProgress({ proteinId }) {
  const viewportRef = useRef(null);
  const panRef = useRef(null);
  const userZoomedRef = useRef(false);
  const [run, setRun] = useState(null);
  const [state, setState] = useState('loading');
  const [error, setError] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const [zoom, setZoom] = useState(1);
  const [cancelling, setCancelling] = useState(false);
  const [activeEdgeId, setActiveEdgeId] = useState(null);
  const [activeNodeId, setActiveNodeId] = useState(null);

  const [runId, setRunId] = useState(() => (
    typeof window === 'undefined' ? '' : new URLSearchParams(window.location.search).get('run') ?? ''
  ));

  useEffect(() => {
    let active = true;
    let timer;
    let streamController;
    let finished = false;
    let reconnectAttempts = 0;
    const maxReconnectAttempts = 3;

    const scheduleFallback = (load, delay = 2000) => {
      if (!active || finished) return;
      if (reconnectAttempts >= maxReconnectAttempts) {
        setError('La actualización automática se detuvo; recarga para consultar el estado actual.');
        return;
      }
      reconnectAttempts += 1;
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(load, delay);
    };

    const load = async () => {
      let id = runId;
      if (!id) {
        try {
          const activeRun = await getActiveRun();
          if (activeRun.protein_id === proteinId) {
            id = activeRun.id;
            rememberRun(id);
            if (active) setRunId(id);
          }
        } catch (requestError) {
          if (!(requestError instanceof ApiError) || requestError.status !== 404) {
            if (!active) return;
            setState('error');
            setError(userErrorMessage(requestError, 'No se pudo cargar la corrida activa.'));
            return;
          }
        }
      }
      if (!active) return;
      if (!id) {
        setState('missing-run');
        return;
      }
      try {
        const value = await getRun(id);
        if (!active) return;
        if (!value || typeof value !== 'object') {
          throw new Error('La API devolvió una corrida vacía.');
        }
        let latestStatus = value.status;
        setRun(value);
        setState('ready');
        setError('');
        if (RUN_TERMINAL.has(value.status)) {
          finished = true;
          streamController?.abort();
          if (timer) window.clearTimeout(timer);
          return;
        }

        streamController?.abort();
        const controller = new AbortController();
        streamController = controller;
        try {
          await subscribeRunEvents(id, {
            signal: controller.signal,
            onSnapshot: (snapshot) => {
              if (!active) return;
              latestStatus = snapshot.status;
              setRun(snapshot);
              setState('ready');
              setError('');
              if (RUN_TERMINAL.has(snapshot.status)) {
                finished = true;
                controller.abort();
                if (timer) window.clearTimeout(timer);
              }
            },
          });
          if (active && !finished && !RUN_TERMINAL.has(latestStatus)) scheduleFallback(load);
        } catch (streamError) {
          if (!active || controller.signal.aborted || finished) return;
          // Keep the existing polling path when SSE is unavailable or drops.
          scheduleFallback(load);
        }
      } catch (requestError) {
        if (!active) return;
        setState('error');
        setError(userErrorMessage(requestError, 'No se pudo cargar la corrida.'));
        scheduleFallback(load, 4000);
      }
    };

    void load();
    return () => {
      active = false;
      streamController?.abort();
      if (timer) window.clearTimeout(timer);
    };
  }, [proteinId, runId]);

  useEffect(() => {
    if (!run || RUN_TERMINAL.has(run.status)) {
      setNow(Date.now());
      return undefined;
    }
    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(clock);
  }, [run]);

  const stages = useMemo(() => {
    if (!run?.stages?.length) return [];
    try {
      return presentRunStages(
        run.stages,
      );
    } catch (visibilityError) {
      console.error(visibilityError);
      return run.stages;
    }
  }, [run]);
  const usesAf3 = stages.some((stage) => (
    stage.id === 'structure_modeling' && !['skipped', 'disabled'].includes(stage.status)
  ));
  const graphStages = useMemo(() => {
    const selectedIds = new Set(run?.configuration?.selected_stage_ids ?? []);
    const visibleStages = selectedIds.size
      ? stages.filter((stage) => selectedIds.has(stage.id) || stage.id === 'protein_identity')
      : stages.filter((stage) => stage.status !== 'disabled');
    return stagesForPipelineLayout(visibleStages, usesAf3);
  }, [run, stages, usesAf3]);
  const layout = useMemo(() => compactStageLayout(graphStages), [graphStages]);
  const edges = useMemo(() => buildEdges(graphStages, layout.positions), [graphStages, layout]);
  const phase = runPhase(run);
  const activeCount = graphStages.filter((stage) => stage.status !== 'disabled').length;
  const resolvedCount = graphStages.filter((stage) => (
    stage.status !== 'disabled'
      && ['success', 'reused', 'failed', 'skipped', 'blocked', 'cancelled'].includes(stage.status)
  )).length;
  const percent = activeCount > 0 ? Math.round((resolvedCount / activeCount) * 100) : 100;
  const phaseNeedsBanner = phase.tone !== 'success';

  useEffect(() => {
    if (state !== 'ready') return undefined;
    const viewport = viewportRef.current;
    if (!viewport) return undefined;
    const resizeObserver = new ResizeObserver(() => {
      if (userZoomedRef.current) return;
      const width = viewport.clientWidth;
      const height = viewport.clientHeight;
      const responsiveZoom = Math.min(
        1,
        Math.max(.5, Math.min(
          (width - 32) / layout.width,
          (height - 32) / layout.height,
        )),
      );
      setZoom(responsiveZoom);
    });
    resizeObserver.observe(viewport);
    return () => resizeObserver.disconnect();
  }, [state, layout.width, layout.height]);

  const setZoomAround = (nextZoom, clientPoint = null) => {
    const viewport = viewportRef.current;
    const clamped = Math.min(1.75, Math.max(.5, nextZoom));
    if (!viewport || clamped === zoom) {
      userZoomedRef.current = true;
      setZoom(clamped);
      return;
    }
    userZoomedRef.current = true;
    const rect = viewport.getBoundingClientRect();
    const clientX = clientPoint?.clientX ?? rect.left + viewport.clientWidth / 2;
    const clientY = clientPoint?.clientY ?? rect.top + viewport.clientHeight / 2;
    const contentX = (viewport.scrollLeft + clientX - rect.left) / zoom;
    const contentY = (viewport.scrollTop + clientY - rect.top) / zoom;
    setZoom(clamped);
    requestAnimationFrame(() => {
      viewport.scrollLeft = contentX * clamped - (clientX - rect.left);
      viewport.scrollTop = contentY * clamped - (clientY - rect.top);
    });
  };

  const fitMap = () => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const fit = Math.min(1, Math.max(.5, Math.min(
      (viewport.clientWidth - 32) / layout.width,
      (viewport.clientHeight - 32) / layout.height,
    )));
    setZoomAround(fit);
  };

  const cancel = async () => {
    if (!runId || cancelling) return;
    setCancelling(true);
    try {
      setRun(await cancelRun(runId));
    } catch (requestError) {
      setError(userErrorMessage(requestError, 'No se pudo cancelar la corrida.'));
    } finally {
      setCancelling(false);
    }
  };

  if (state === 'missing-run') {
    return <section class="progress-view"><StatePanel kind="empty" fill icon="workflow" title="No hay una corrida seleccionada" description="Registra una proteína y crea una corrida para consultar su estado."><a class="protein-open" href="/">Registrar proteína</a></StatePanel></section>;
  }
  if (state === 'loading') return <section class="progress-view"><StatePanel kind="loading" fill title="Cargando estado de la corrida" description="Consultando la ejecución persistida y sus etapas." /></section>;
  if (state === 'error') return <section class="progress-view"><StatePanel kind="error" fill title="No se pudo cargar la corrida" description={error}><a class="protein-open" href="/proteins/">Volver al catálogo</a></StatePanel></section>;

  return (
    <section class="progress-view" aria-label="Progreso del pipeline">
      <header class="progress-head">
        <div class="progress-heading">
          <h1>Progreso</h1>
          <p>{resolvedCount} de {activeCount} pasos activos · {percent}%</p>
        </div>
        <div class="progress-actions">
          {!['success', 'failed', 'cancelled'].includes(run.status) && <button class="cancel-run" type="button" onClick={cancel} disabled={cancelling}>{cancelling ? 'Cancelando…' : 'Cancelar'}</button>}
          <div class="progress-zoom" aria-label="Zoom del mapa">
            <button type="button" onClick={() => setZoomAround(zoom - .1)} aria-label="Alejar">−</button>
            <button type="button" class="zoom-value" onClick={() => setZoomAround(1)} aria-label="Restablecer zoom">{Math.round(zoom * 100)}%</button>
            <button type="button" onClick={() => setZoomAround(zoom + .1)} aria-label="Acercar">+</button>
            <button type="button" class="fit-map" onClick={fitMap} aria-label="Ajustar mapa" title="Ajustar mapa"><PackIcon name="maximize-2" kind="ui" /></button>
          </div>
        </div>
      </header>
      {phaseNeedsBanner && (
        <div class={`progress-phase progress-phase-${phase.tone}`} role={phase.tone === 'failed' ? 'alert' : 'status'} aria-live="polite">
          <strong>{phase.label}</strong>{phase.detail && <span>{phase.detail}</span>}
        </div>
      )}
      {run.stages?.some((stage) => stage.error_code === 'stage_execution_unavailable') && <p class="progress-waiting">Esta corrida no se envió al clúster. El worker local no abre la VPN ni lanza Slurm: el túnel lo gestiona el host y el envío exige el perfil SSH.</p>}
      {error && <p class="progress-inline-error" role="alert">{error}</p>}
      <div ref={viewportRef} class="pipeline-scroll" onWheel={(event) => {
        if (!(event.ctrlKey || event.metaKey || event.altKey)) return;
        event.preventDefault();
        setZoomAround(zoom * (event.deltaY < 0 ? 1.12 : .88), { clientX: event.clientX, clientY: event.clientY });
      }} onPointerDown={(event) => {
        if (event.button !== 0 || event.target.closest?.('.pipeline-node, .pipeline-portal-marker, .progress-zoom, .cancel-run')) return;
        const viewport = viewportRef.current;
        if (!viewport) return;
        panRef.current = { id: event.pointerId, x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop };
        viewport.classList.add('is-panning');
        viewport.setPointerCapture?.(event.pointerId);
      }} onPointerMove={(event) => {
        const pan = panRef.current;
        const viewport = viewportRef.current;
        if (!pan || !viewport || pan.id !== event.pointerId) return;
        viewport.scrollLeft = pan.left - (event.clientX - pan.x);
        viewport.scrollTop = pan.top - (event.clientY - pan.y);
      }} onPointerUp={() => { panRef.current = null; viewportRef.current?.classList.remove('is-panning'); }} onPointerCancel={() => { panRef.current = null; viewportRef.current?.classList.remove('is-panning'); }}>
        <div class="pipeline-scaled" style={{ width: `${layout.width * zoom}px`, height: `${layout.height * zoom}px` }}>
          <div class="pipeline-map" style={{ width: `${layout.width}px`, height: `${layout.height}px`, transform: `scale(${zoom})` }}>
            <svg class="pipeline-edges" viewBox={`0 0 ${layout.width} ${layout.height}`} aria-hidden="true">
              <defs>
                {['pending', 'running', 'success', 'failed', 'blocked', 'skipped', 'cancelled', 'disabled'].map((status) => (
                  <marker key={status} id={`pipeline-arrow-${status}`} class={`pipeline-arrow edge-${status}`} viewBox="0 0 10 10" refX="8.6" refY="5" markerWidth="7" markerHeight="7" markerUnits="userSpaceOnUse" orient="auto">
                    <path d="M 1 1 L 9 5 L 1 9 Z" />
                  </marker>
                ))}
              </defs>
              {edges.flatMap((edge) => {
                const target = stages.find((stage) => stage.id === edge.to);
                const status = target ? edgeStatus(target) : 'pending';
                const source = stages.find((stage) => stage.id === edge.from);
                const sourceLabel = source ? stagePresentation(source, run.configuration).label : edge.from;
                const targetLabel = target ? stagePresentation(target, run.configuration).label : edge.to;
                const segments = edge.segments ?? [{ role: 'direct', d: edge.d }];
                const edgeActive = activeEdgeId === edge.id
                  || activeNodeId === edge.from
                  || activeNodeId === edge.to;
                const edgeInteraction = {
                  'data-edge-id': edge.id,
                  onPointerEnter: () => setActiveEdgeId(edge.id),
                  onPointerLeave: () => setActiveEdgeId((current) => current === edge.id ? null : current),
                };
                const paths = segments.flatMap((segment) => [
                    <path
                      key={`${edge.id ?? `${edge.from}-${edge.to}`}-${segment.role}-hit`}
                      class="pipeline-edge-hit-area"
                      d={segment.d}
                      {...edgeInteraction}
                    />,
                    <path
                      key={`${edge.id ?? `${edge.from}-${edge.to}`}-${segment.role}`}
                      class={`pipeline-edge edge-${status}${edge.portal ? ' pipeline-edge--portal' : ''}${edgeActive ? ' pipeline-edge--active' : ''}`}
                      d={segment.d}
                      marker-end={`url(#pipeline-arrow-${status})`}
                      style={edge.portal ? { '--portal-accent': edge.portal.accent } : undefined}
                      {...edgeInteraction}
                    />
                ]);
                if (!edge.portal) return paths;
                const portalTitle = `Conexión indirecta: ${sourceLabel} → ${targetLabel}`;
                const marker = (side, point) => (
                  <g
                    key={`${edge.portal.id}-${side}`}
                    class={`pipeline-portal-marker edge-${status}${edgeActive ? ' is-active' : ''}`}
                    data-portal-id={edge.portal.id}
                    data-portal-side={side}
                    data-edge-id={edge.id}
                    style={{ '--portal-accent': edge.portal.accent }}
                    onPointerEnter={() => setActiveEdgeId(edge.id)}
                    onPointerLeave={() => setActiveEdgeId((current) => current === edge.id ? null : current)}
                    onPointerDown={(event) => event.stopPropagation()}
                  >
                    <title>{portalTitle}</title>
                    <circle
                      class={`pipeline-portal-dot edge-${status}`}
                      cx={point.x}
                      cy={point.y}
                      r={edgeActive ? '6' : '4'}
                    />
                  </g>
                );
                return [
                  <path
                    key={`${edge.portal.id}-bridge-hit`}
                    class="pipeline-portal-bridge-hit-area"
                    d={edge.portal.bridge}
                    {...edgeInteraction}
                  />,
                  <path
                    key={`${edge.portal.id}-bridge`}
                    class={`pipeline-portal-bridge${edgeActive ? ' is-active' : ''}`}
                    d={edge.portal.bridge}
                    style={{ '--portal-accent': edge.portal.accent }}
                    {...edgeInteraction}
                  />,
                  ...paths,
                  marker('source', edge.portal.source),
                  marker('target', edge.portal.target),
                ];
              })}
            </svg>
            {graphStages.map((stage) => {
              const position = layout.positions.get(stage.id);
              const visualStatus = stageVisualStatus(stage);
              const presentation = stagePresentation(stage, run.configuration);
              const nodeHighlighted = activeNodeId === stage.id
                || Boolean(activeEdgeId && edges.some((edge) => (
                  edge.id === activeEdgeId && (edge.from === stage.id || edge.to === stage.id)
                )));
              return (
                <a key={stage.id} class={`pipeline-node pipeline-node--${visualStatus}${nodeHighlighted ? ' pipeline-node--highlighted' : ''}`} data-stage-node={stage.id} style={{ left: `${position.x - PIPELINE_NODE.width / 2}px`, top: `${position.y - PIPELINE_NODE.height / 2}px` }} href={stageHref(proteinId, run.id, stage.id)} title={`Ver información de ${presentation.label}`} aria-label={`${presentation.label} · ${STATUS_TEXT[visualStatus] ?? STATUS_TEXT[stage.status] ?? stage.status}. Abrir sus anotaciones y artefactos`} onPointerEnter={() => { setActiveEdgeId(null); setActiveNodeId(stage.id); }} onPointerLeave={() => setActiveNodeId((current) => current === stage.id ? null : current)} onFocus={() => { setActiveEdgeId(null); setActiveNodeId(stage.id); }} onBlur={() => setActiveNodeId((current) => current === stage.id ? null : current)}>
                  <div class="stage-kind"><StageIcon name={presentation.stageIcon} /></div>
                  <div class="stage-content">
                    <div class="stage-title-row"><strong>{presentation.label}</strong></div>
                    <div class="stage-time">{presentation.estimate}</div>
                    <div class="stage-runtime">{stage.status !== 'disabled' && <PackIcon name="clock" kind="ui" />}<StageRuntime stage={stage} now={now} /></div>
                  </div>
                  <span class={`stage-status stage-status-${visualStatus}`} title={STATUS_TEXT[visualStatus] ?? STATUS_TEXT[stage.status] ?? stage.status} aria-hidden="true">{STATUS_ICON[visualStatus] && <PackIcon name={STATUS_ICON[visualStatus]} kind="ui" className={visualStatus === 'running' ? 'stage-status-spin' : ''} />}</span>
                </a>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
