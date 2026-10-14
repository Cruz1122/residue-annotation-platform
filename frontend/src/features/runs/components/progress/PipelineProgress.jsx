import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import LucideIcon from '@shared/components/icons/LucideIcon.jsx';
import { ApiError, cancelRun, getActiveRun, getRun, subscribeRunEvents } from '@shared/api/client';
import { presentRunStages, progressSummary } from '@features/runs/stage-visibility.js';
import '@features/runs/styles/progress.css';

const STATUS_ICON = {
  running: 'rotate-cw',
  failed: 'circle-x',
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
  reused: 'Reutilizado',
  failed: 'Falló',
  skipped: 'No aplica',
  cancelled: 'Cancelado',
  disabled: 'Desactivado',
};

const OMISSION_REASON_TEXT = {
  provided_pdb_selected: 'se usó el PDB proporcionado',
  variants_not_provided: 'no se confirmaron variantes válidas',
  technical_prerequisite_not_provided: 'falta un prerrequisito técnico',
  dependency_not_applicable: 'una dependencia no aplica',
};

const RUN_TERMINAL = new Set(['success', 'failed', 'cancelled']);
const HALF_NODE_WIDTH = 124;

function formatElapsed(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (totalSeconds < 60) return `${totalSeconds} s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes} min ${seconds} s`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

function displayStatus(status) {
  if (status === 'success' || status === 'reused') return 'ok';
  if (status === 'ready' || status === 'queued') return 'queued';
  return status;
}

function stageLayout(stages) {
  const byId = new Map(stages.map((stage) => [stage.id, stage]));
  const levelCache = new Map();
  const levelOf = (stageId, stack = new Set()) => {
    if (levelCache.has(stageId)) return levelCache.get(stageId);
    if (stack.has(stageId)) return 0;
    const stage = byId.get(stageId);
    if (!stage || !stage.dependencies.length) {
      levelCache.set(stageId, 0);
      return 0;
    }
    const nextStack = new Set(stack).add(stageId);
    const level = Math.max(...stage.dependencies.map((dependency) => levelOf(dependency, nextStack))) + 1;
    levelCache.set(stageId, level);
    return level;
  };

  const grouped = new Map();
  stages.forEach((stage) => {
    const level = levelOf(stage.id);
    const group = grouped.get(level) ?? [];
    group.push(stage);
    grouped.set(level, group);
  });

  const positions = new Map();
  let maxRows = 1;
  for (const [level, group] of grouped) {
    maxRows = Math.max(maxRows, group.length);
    group.forEach((stage, index) => {
      positions.set(stage.id, { x: 150 + level * 350, y: 110 + index * 170 });
    });
  }
  const maxLevel = Math.max(0, ...grouped.keys());
  return {
    positions,
    width: Math.max(900, 350 * (maxLevel + 1) + 220),
    height: Math.max(360, 170 * maxRows + 120),
  };
}

function buildEdges(stages, positions) {
  const outgoing = new Map();
  const incoming = new Map();
  stages.forEach((stage) => {
    incoming.set(stage.id, [...stage.dependencies]);
    stage.dependencies.forEach((dependency) => {
      outgoing.set(dependency, [...(outgoing.get(dependency) ?? []), stage.id]);
    });
  });
  const offset = (index, count, spread) => count <= 1 ? 0 : ((index / (count - 1)) - 0.5) * 2 * spread;
  return stages.flatMap((stage) => stage.dependencies.map((dependency) => {
    const source = positions.get(dependency);
    const target = positions.get(stage.id);
    if (!source || !target) return null;
    const fromList = outgoing.get(dependency) ?? [stage.id];
    const toList = incoming.get(stage.id) ?? [dependency];
    const x1 = source.x + HALF_NODE_WIDTH;
    const x2 = target.x - HALF_NODE_WIDTH;
    const y1 = source.y + offset(fromList.indexOf(stage.id), fromList.length, 34);
    const y2 = target.y + offset(toList.indexOf(dependency), toList.length, 22);
    const gap = Math.max(52, x2 - x1);
    const d = Math.abs(y2 - y1) < 4
      ? `M ${x1} ${y1} L ${x2} ${y2}`
      : `M ${x1} ${y1} C ${x1 + Math.max(34, gap * .42)} ${y1}, ${x2 - Math.max(34, gap * .42)} ${y2}, ${x2} ${y2}`;
    return { from: dependency, to: stage.id, d };
  }).filter(Boolean));
}

function StageRuntime({ stage, now }) {
  if (stage.status === 'disabled') return <span>Desactivado</span>;
  if (stage.status === 'skipped' && stage.omission_reason) {
    return <span>No aplica · {OMISSION_REASON_TEXT[stage.omission_reason] ?? stage.omission_reason}</span>;
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

export default function PipelineProgress({ proteinId }) {
  const viewportRef = useRef(null);
  const panRef = useRef(null);
  const [run, setRun] = useState(null);
  const [state, setState] = useState('loading');
  const [error, setError] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const [zoom, setZoom] = useState(1);
  const [cancelling, setCancelling] = useState(false);

  const [runId, setRunId] = useState(() => (
    typeof window === 'undefined' ? '' : new URLSearchParams(window.location.search).get('run') ?? ''
  ));

  useEffect(() => {
    let active = true;
    let timer;
    let streamController;

    const scheduleFallback = (load, delay = 2000) => {
      if (!active) return;
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(load, delay);
    };

    const load = async () => {
      let id = runId;
      try {
        const activeRun = await getActiveRun();
        if (activeRun.protein_id === proteinId && activeRun.id !== id) {
          id = activeRun.id;
          rememberRun(id);
          if (active) setRunId(id);
        }
      } catch (requestError) {
        if (!(requestError instanceof ApiError) || requestError.status !== 404) {
          if (!active) return;
          setState('error');
          setError(requestError instanceof ApiError ? requestError.message : 'No se pudo cargar la corrida activa.');
          return;
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
        setRun(value);
        setState('ready');
        setError('');
        if (RUN_TERMINAL.has(value.status)) return;

        streamController?.abort();
        streamController = new AbortController();
        try {
          await subscribeRunEvents(id, {
            signal: streamController.signal,
            onSnapshot: (snapshot) => {
              if (!active) return;
              setRun(snapshot);
              setState('ready');
              setError('');
              if (RUN_TERMINAL.has(snapshot.status)) streamController?.abort();
            },
          });
          if (active) scheduleFallback(load);
        } catch (streamError) {
          if (!active || streamController?.signal.aborted) return;
          // Keep the existing polling path when SSE is unavailable or drops.
          scheduleFallback(load);
        }
      } catch (requestError) {
        if (!active) return;
        setState('error');
        setError(requestError instanceof ApiError ? requestError.message : 'No se pudo cargar la corrida.');
        scheduleFallback(load, 4000);
      }
    };

    void load();
    return () => {
      active = false;
      streamController?.abort();
      if (timer) window.clearTimeout(timer);
    };
  }, [runId]);

  useEffect(() => {
    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(clock);
  }, []);

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
  const layout = useMemo(() => stageLayout(stages), [stages]);
  const edges = useMemo(() => buildEdges(stages, layout.positions), [stages, layout]);
  const summary = progressSummary(stages);

  const setZoomAround = (nextZoom, clientPoint = null) => {
    const viewport = viewportRef.current;
    const clamped = Math.min(1.75, Math.max(.5, nextZoom));
    if (!viewport || clamped === zoom) {
      setZoom(clamped);
      return;
    }
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

  const cancel = async () => {
    if (!runId || cancelling) return;
    setCancelling(true);
    try {
      setRun(await cancelRun(runId));
    } catch (requestError) {
      setError(requestError instanceof ApiError ? requestError.message : 'No se pudo cancelar la corrida.');
    } finally {
      setCancelling(false);
    }
  };

  if (state === 'missing-run') {
    return <section class="progress-view progress-message"><h1>No hay una corrida seleccionada</h1><p>Registra una proteína y crea una corrida para consultar su estado.</p><a class="protein-open" href="/">Registrar proteína</a></section>;
  }
  if (state === 'loading') return <section class="progress-view progress-message"><p>Cargando estado persistido…</p></section>;
  if (state === 'error') return <section class="progress-view progress-message" role="alert"><h1>No se pudo cargar la corrida</h1><p>{error}</p><a class="protein-open" href="/proteins/">Volver al catálogo</a></section>;

  return (
    <section class="progress-view" aria-label="Progreso del pipeline">
      <header class="progress-head">
        <div>
          <h1>Progreso</h1>
          <span class="run-id">Run {run.id}</span>
        </div>
        <div class="progress-actions">
          <div class="progress-counter"><strong>{summary.completed} de {summary.enabled}</strong> activos · {summary.percentage}% · {STATUS_TEXT[run.status] ?? run.status}</div>
          {!['success', 'failed', 'cancelled'].includes(run.status) && <button class="cancel-run" type="button" onClick={cancel} disabled={cancelling}>{cancelling ? 'Cancelando…' : 'Cancelar'}</button>}
          <div class="progress-zoom" aria-label="Zoom del mapa">
            <button type="button" onClick={() => setZoomAround(zoom - .1)} aria-label="Alejar">−</button>
            <button type="button" class="zoom-value" onClick={() => setZoomAround(1)} aria-label="Restablecer zoom">{Math.round(zoom * 100)}%</button>
            <button type="button" onClick={() => setZoomAround(zoom + .1)} aria-label="Acercar">+</button>
          </div>
        </div>
      </header>
      {run.status === 'pending' && <p class="progress-waiting">El worker todavía no ha tomado esta corrida. Cancélala si quieres liberar el cupo y registrar otra.</p>}
      {run.stages?.some((stage) => stage.error_code === 'stage_execution_unavailable') && <p class="progress-waiting">Esta corrida no se envió al clúster. El worker local no abre la VPN ni lanza Slurm: el túnel lo gestiona el host y el envío exige el perfil SSH.</p>}
      {error && <p class="progress-inline-error" role="alert">{error}</p>}
      <div ref={viewportRef} class="pipeline-scroll" onWheel={(event) => {
        if (!(event.ctrlKey || event.metaKey || event.altKey)) return;
        event.preventDefault();
        setZoomAround(zoom * (event.deltaY < 0 ? 1.12 : .88), { clientX: event.clientX, clientY: event.clientY });
      }} onPointerDown={(event) => {
        if (event.button !== 0 || event.target.closest?.('.pipeline-node, .progress-zoom, .cancel-run')) return;
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
              <defs><marker id="pipeline-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" /></marker></defs>
              {edges.map((edge) => <path key={`${edge.from}-${edge.to}`} class={`pipeline-edge edge-${displayStatus(stages.find((stage) => stage.id === edge.to)?.status ?? 'pending')}`} d={edge.d} marker-end="url(#pipeline-arrow)" />)}
            </svg>
            {stages.map((stage) => {
              const position = layout.positions.get(stage.id);
              const visualStatus = displayStatus(stage.status);
              return (
                <a key={stage.id} class={`pipeline-node status-${visualStatus}`} style={{ left: `${position.x}px`, top: `${position.y}px` }} href={`/proteins/${encodeURIComponent(proteinId)}/info/?run=${encodeURIComponent(run.id)}#stage-${stage.id}`} aria-label={`${stage.title}: ${STATUS_TEXT[stage.status] ?? stage.status}`}>
                  <div class="stage-kind"><LucideIcon name="workflow" /></div>
                  <div class="stage-content">
                    <div class="stage-title-row"><strong>{stage.title}</strong></div>
                    <div class="stage-time">{stage.legacy_id} · {stage.dependencies.length ? `${stage.dependencies.length} dependencia${stage.dependencies.length === 1 ? '' : 's'}` : 'Sin dependencias'}</div>
                    <div class="stage-runtime">{stage.status !== 'disabled' && <LucideIcon name="clock" />}<StageRuntime stage={stage} now={now} /></div>
                  </div>
                  <span class={`stage-status stage-status-${visualStatus}`} title={STATUS_TEXT[stage.status] ?? stage.status} aria-hidden="true">{STATUS_ICON[stage.status] && <LucideIcon name={STATUS_ICON[stage.status]} />}</span>
                </a>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
