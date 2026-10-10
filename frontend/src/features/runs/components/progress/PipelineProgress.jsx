import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import LucideIcon from '@shared/components/icons/LucideIcon.jsx';
import { PIPELINE_SIZE, PIPELINE_STAGES, PROGRESS_FRAMES, getStageStatus } from '@features/stages/data/pipeline.js';
import { readSession } from '@shared/lib/session.js';
import '@features/runs/styles/progress.css';

const STATUS_ICON = { running: 'rotate-cw', failed: 'circle-x', skipped: 'circle-dot', ok: 'circle-check' };
const STATUS_TEXT = { pending: 'Pendiente', running: 'En ejecución', failed: 'Falló', skipped: 'Omitido', ok: 'Completado' };
const HALF_NODE_WIDTH = 124;

function formatElapsed(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds} s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes} min ${seconds} s`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

function portOffset(index, count, spread) {
  if (count <= 1) return 0;
  return ((index / (count - 1)) - .5) * 2 * spread;
}

function buildEdges() {
  const stageMap = Object.fromEntries(PIPELINE_STAGES.map((stage) => [stage.id, stage]));
  const outgoing = {};
  const incoming = {};
  for (const stage of PIPELINE_STAGES) {
    incoming[stage.id] = [...stage.deps];
    for (const from of stage.deps) (outgoing[from] ||= []).push(stage.id);
  }
  for (const list of Object.values(outgoing)) list.sort((a, b) => stageMap[a].y - stageMap[b].y);
  for (const list of Object.values(incoming)) list.sort((a, b) => stageMap[a].y - stageMap[b].y);

  return PIPELINE_STAGES.flatMap((target) => target.deps.map((from) => {
    const source = stageMap[from];
    const outList = outgoing[from] || [target.id];
    const inList = incoming[target.id] || [from];
    const x1 = source.x + HALF_NODE_WIDTH;
    const x2 = target.x - HALF_NODE_WIDTH;
    const y1 = source.y + portOffset(outList.indexOf(target.id), outList.length, 34);
    const y2 = target.y + portOffset(inList.indexOf(from), inList.length, 22);
    const gap = Math.max(52, x2 - x1);
    const d = Math.abs(y2 - y1) < 4
      ? `M ${x1} ${y1} L ${x2} ${y2}`
      : `M ${x1} ${y1} C ${x1 + Math.max(34, gap * .42)} ${y1}, ${x2 - Math.max(34, gap * .42)} ${y2}, ${x2} ${y2}`;
    return { from, to: target.id, d };
  }));
}

const EDGES = buildEdges();

function StageRuntime({ status, runtime, now }) {
  let text = 'Esperando';
  if (status === 'skipped') text = 'No se ejecutó';
  else if (status === 'running') text = `Lleva ${formatElapsed(runtime.elapsedMs + (runtime.startedAt ? now - runtime.startedAt : 0))}`;
  else if (status === 'ok' || status === 'failed') text = `Duró ${formatElapsed(runtime.finalMs ?? runtime.elapsedMs)}`;

  return (
    <div class="stage-runtime">
      <LucideIcon name="clock" />
      <span>{text}</span>
    </div>
  );
}

export default function PipelineProgress({ proteinId = 'P01130' }) {
  const viewportRef = useRef(null);
  const runtimeRef = useRef(new Map());
  const panRef = useRef(null);
  const [frameIndex, setFrameIndex] = useState(0);
  const [now, setNow] = useState(() => performance.now());
  const [zoom, setZoom] = useState(1);
  const [hasVariants, setHasVariants] = useState(false);

  const frame = PROGRESS_FRAMES[frameIndex];
  const statuses = useMemo(() => Object.fromEntries(PIPELINE_STAGES.map((stage) => [
    stage.id,
    getStageStatus(frame, stage.id, hasVariants, frameIndex),
  ])), [frame, frameIndex, hasVariants]);

  const runtimeFor = (id) => {
    if (!runtimeRef.current.has(id)) runtimeRef.current.set(id, { startedAt: null, elapsedMs: 0, finalMs: null, status: 'pending' });
    return runtimeRef.current.get(id);
  };

  useEffect(() => {
    setHasVariants(readSession().variants.length > 0);
  }, []);

  useEffect(() => {
    const time = performance.now();
    for (const stage of PIPELINE_STAGES) {
      const runtime = runtimeFor(stage.id);
      const next = statuses[stage.id];
      const prev = runtime.status;
      if (next === 'running' && prev !== 'running') {
        runtime.startedAt = time;
        runtime.finalMs = null;
      }
      if (prev === 'running' && next !== 'running' && runtime.startedAt !== null) {
        runtime.elapsedMs += time - runtime.startedAt;
        runtime.startedAt = null;
        runtime.finalMs = runtime.elapsedMs;
      }
      runtime.status = next;
    }
  }, [statuses]);

  useEffect(() => {
    const clock = window.setInterval(() => setNow(performance.now()), 250);
    return () => window.clearInterval(clock);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setFrameIndex((current) => {
        const next = (current + 1) % PROGRESS_FRAMES.length;
        if (next === 0) runtimeRef.current.clear();
        return next;
      });
    }, frame.ms);
    return () => window.clearTimeout(timer);
  }, [frameIndex, frame.ms]);

  const resolved = Object.values(statuses).filter((status) => ['ok', 'failed', 'skipped'].includes(status)).length;
  const percent = Math.round((resolved / PIPELINE_STAGES.length) * 100);

  const setZoomAround = (nextZoom, clientPoint = null) => {
    const viewport = viewportRef.current;
    const clamped = Math.min(1.75, Math.max(.5, nextZoom));
    if (!viewport || clamped === zoom) return setZoom(clamped);

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

  const startPan = (event) => {
    if (event.button !== 0 || event.target.closest?.('.pipeline-node, .progress-zoom')) return;
    const viewport = viewportRef.current;
    if (!viewport) return;
    panRef.current = { id: event.pointerId, x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop };
    viewport.classList.add('is-panning');
    viewport.setPointerCapture?.(event.pointerId);
  };

  const movePan = (event) => {
    const pan = panRef.current;
    const viewport = viewportRef.current;
    if (!pan || !viewport || pan.id !== event.pointerId) return;
    viewport.scrollLeft = pan.left - (event.clientX - pan.x);
    viewport.scrollTop = pan.top - (event.clientY - pan.y);
  };

  const endPan = (event) => {
    if (!panRef.current || (event?.pointerId !== undefined && panRef.current.id !== event.pointerId)) return;
    panRef.current = null;
    viewportRef.current?.classList.remove('is-panning');
  };

  return (
    <section class="progress-view" aria-label="Progreso del pipeline">
      <header class="progress-head">
        <h1>Progreso</h1>
        <div class="progress-actions">
          <div class="progress-counter"><strong>{resolved} de {PIPELINE_STAGES.length}</strong> pasos · {percent}%</div>
          <div class="progress-zoom" aria-label="Zoom del mapa">
            <button type="button" onClick={() => setZoomAround(zoom - .1)} aria-label="Alejar">−</button>
            <button type="button" class="zoom-value" onClick={() => setZoomAround(1)} aria-label="Restablecer zoom">{Math.round(zoom * 100)}%</button>
            <button type="button" onClick={() => setZoomAround(zoom + .1)} aria-label="Acercar">+</button>
          </div>
        </div>
      </header>

      <div
        ref={viewportRef}
        class="pipeline-scroll"
        onWheel={(event) => {
          if (!(event.ctrlKey || event.metaKey || event.altKey)) return;
          event.preventDefault();
          setZoomAround(zoom * (event.deltaY < 0 ? 1.12 : .88), { clientX: event.clientX, clientY: event.clientY });
        }}
        onPointerDown={startPan}
        onPointerMove={movePan}
        onPointerUp={endPan}
        onPointerCancel={endPan}
      >
        <div class="pipeline-scaled" style={{ width: `${PIPELINE_SIZE.width * zoom}px`, height: `${PIPELINE_SIZE.height * zoom}px` }}>
          <div class="pipeline-map" style={{ width: `${PIPELINE_SIZE.width}px`, height: `${PIPELINE_SIZE.height}px`, transform: `scale(${zoom})` }}>
            <svg class="pipeline-edges" viewBox={`0 0 ${PIPELINE_SIZE.width} ${PIPELINE_SIZE.height}`} aria-hidden="true">
              <defs>
                <marker id="pipeline-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
                  <path d="M 0 0 L 10 5 L 0 10 z" />
                </marker>
              </defs>
              {EDGES.map((edge) => <path key={`${edge.from}-${edge.to}`} class={`pipeline-edge edge-${statuses[edge.to]}`} d={edge.d} marker-end="url(#pipeline-arrow)" />)}
            </svg>

            {PIPELINE_STAGES.map((stage) => {
              const status = statuses[stage.id];
              const runtime = runtimeFor(stage.id);
              return (
                <a
                  key={stage.id}
                  class={`pipeline-node status-${status}`}
                  style={{ left: `${stage.x}px`, top: `${stage.y}px` }}
                  href={`/proteins/${proteinId}/info/#stage-${stage.id}`}
                  aria-label={`${stage.title}: ${STATUS_TEXT[status]}`}
                >
                  <div class="stage-kind"><LucideIcon name={stage.icon} /></div>
                  <div class="stage-content">
                    <div class="stage-title-row">
                      <strong>{stage.title}</strong>
                    </div>
                    <div class="stage-time">{stage.estimate}</div>
                    <StageRuntime status={status} runtime={runtime} now={now} />
                  </div>
                  <span class={`stage-status stage-status-${status}`} title={STATUS_TEXT[status]} aria-hidden="true">
                    {STATUS_ICON[status] && <LucideIcon name={STATUS_ICON[status]} />}
                  </span>
                </a>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
