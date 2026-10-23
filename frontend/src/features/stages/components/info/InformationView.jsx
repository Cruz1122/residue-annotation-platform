import { useEffect, useState } from 'preact/hooks';
import { getRun, subscribeRunEvents } from '@shared/api/client';
import StatePanel from '@shared/components/feedback/StatePanel.jsx';
import { runFailureMessage, userErrorMessage } from '@shared/lib/error-presentation';
import '@features/stages/styles/info.css';

const RUN_TERMINAL = new Set(['success', 'failed', 'cancelled']);

const STATUS_TEXT = {
  pending: 'Pendiente',
  ready: 'Preparada',
  queued: 'En cola',
  running: 'En ejecución',
  success: 'Completada',
  reused: 'Reutilizada',
  failed: 'Fallida',
  skipped: 'Omitida',
  cancelled: 'Cancelada',
  cancel_requested: 'Cancelación solicitada',
  disabled: 'Deshabilitada',
};

const STRUCTURE_SOURCE_TEXT = {
  alphafold3: 'Modelo estructural generado por AlphaFold 3',
  provided_pdb: 'Estructura PDB proporcionada',
};

function formatDate(value) {
  if (!value) return 'Sin fecha';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Sin fecha';
  return new Intl.DateTimeFormat('es-CO', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function sourceLabel(run) {
  const source = run?.configuration?.structure_source;
  return STRUCTURE_SOURCE_TEXT[source] ?? 'Fuente estructural no publicada';
}

function runLoadError(requestError, fallback) {
  return userErrorMessage(requestError, fallback);
}

export default function InformationView({ proteinId }) {
  const [run, setRun] = useState(null);
  const [state, setState] = useState('loading');
  const [error, setError] = useState('');
  const [refreshWarning, setRefreshWarning] = useState('');
  const runId = typeof window === 'undefined' ? '' : new URLSearchParams(window.location.search).get('run') ?? '';

  useEffect(() => {
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

  const uploads = run?.uploads ?? [];
  const configuration = run?.configuration ?? {};

  if (state === 'missing-run') {
    return <section class="info-view"><StatePanel kind="empty" fill icon="workflow" title="No hay una corrida seleccionada" description="Selecciona una corrida persistida para consultar sus datos."><a class="protein-open" href={`/proteins/${encodeURIComponent(proteinId)}/progress/`}>Ver progreso</a></StatePanel></section>;
  }
  if (state === 'loading') return <section class="info-view"><StatePanel kind="loading" fill title="Cargando datos de la corrida" description="Consultando configuración, entradas y estado." /></section>;
  if (state === 'error' && !run) return <section class="info-view"><StatePanel kind="error" fill title="No se pudo cargar la corrida" description={error} /></section>;
  if (!run) return null;

  return (
    <section class="info-view" aria-label="Información general de la corrida">
      <header class="info-head">
        <div><h1>Información</h1><span class="info-accession">{configuration.scientific_accession ?? 'Sin acceso científico'}</span></div>
        <span class={`info-run-status status-${run.status}`}>{STATUS_TEXT[run.status] ?? run.status}</span>
      </header>
      <div class="info-body">
        {refreshWarning && <div class="info-refresh-warning" role="status">{refreshWarning}</div>}
        <div class="info-summary-grid">
          <article class="info-card">
            <h2>Corrida</h2>
            <dl class="info-facts">
              <div><dt>Acceso</dt><dd>{configuration.scientific_accession ?? 'No publicado'}</dd></div>
              <div><dt>Fecha de creación</dt><dd>{formatDate(run.created_at)}</dd></div>
              <div><dt>Fuente estructural</dt><dd>{sourceLabel(run)}</dd></div>
              <div><dt>Cadena</dt><dd>{configuration.structure_chain || 'No especificada'}</dd></div>
            </dl>
          </article>
        </div>

        <section class="info-card info-card-wide">
          <h2>Entradas de la corrida</h2>
          {uploads.length ? (
            <ul class="info-input-list">
              {uploads.map((upload) => <li key={upload.id}><span>{upload.input_type === 'structure' ? 'Estructura' : 'Secuencia'}</span><strong>{upload.original_filename}</strong></li>)}
            </ul>
          ) : <p class="info-card-note">No hay archivos de entrada asociados.</p>}
        </section>

        {run.error_message && <p class="info-run-error" role="alert">{runFailureMessage(run.error_code, run.error_message)}</p>}
      </div>
    </section>
  );
}
