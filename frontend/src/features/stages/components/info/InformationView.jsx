import { useEffect, useMemo, useState } from 'preact/hooks';
import LucideIcon from '@shared/components/icons/LucideIcon.jsx';
import { ApiError, getAnnotations, getArtifactBlob, getRun, subscribeRunEvents } from '@shared/api/client';
import { presentRunStages } from '@features/runs/stage-visibility.js';
import '@features/stages/styles/info.css';

const STATUS_TEXT = {
  pending: 'Pendiente', ready: 'Listo', queued: 'En cola', running: 'En ejecución',
  success: 'Completado', reused: 'Resultado reutilizado', failed: 'Falló', skipped: 'No aplica', cancelled: 'Cancelado',
  cancel_requested: 'Cancelación solicitada',
  disabled: 'Desactivado',
};

const EVIDENCE_STATUS_TEXT = {
  pending: 'Pendiente',
  partial: 'Parcial',
  available: 'Disponible',
  skipped: 'Omitida',
  failed: 'Fallida',
  cancelled: 'Cancelada',
};

const RUN_TERMINAL = new Set(['success', 'failed', 'cancelled']);

const OMISSION_REASON_TEXT = {
  provided_pdb_selected: 'se usó el PDB proporcionado',
  variants_not_provided: 'no se confirmaron variantes válidas',
  technical_prerequisite_not_provided: 'falta un prerrequisito técnico',
  dependency_not_applicable: 'una dependencia no aplica',
};

function valueText(value) {
  if (value === null || value === undefined) return 'NA';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function AnnotationRows({ rows }) {
  if (!rows.length) return <div class="info-empty-note">No hay evidencia publicada para esta etapa.</div>;
  const sample = rows.slice(0, 8);
  return (
    <div>
      <p class="evidence-count">{rows.length.toLocaleString('es-CO')} fila{rows.length === 1 ? '' : 's'} de anotación</p>
      <dl class="info-annotation-list">
        {sample.map((row) => (
          <div class="info-annotation" key={`${row.stage_result_id}-${row.aa_position}`}>
            <dt><span class="info-annotation-label">Posición {row.aa_position} · {row.aa_ref}</span><span class="info-annotation-key">qc_status: {row.qc_status}</span></dt>
            <dd>{Object.entries(row.values).map(([key, value]) => {
              const unit = row.units?.[key];
              const rendered = valueText(value);
              return `${key}=${rendered}${unit && rendered !== 'NA' ? ` ${unit}` : ''}`;
            }).join(' · ') || 'NA'}</dd>
          </div>
        ))}
      </dl>
      {rows.length > sample.length && <p class="info-empty-note">Se muestran las primeras {sample.length}; el endpoint conserva todas las filas.</p>}
    </div>
  );
}

function ArtifactDownload({ artifact, label = artifact.artifact_type }) {
  const [downloading, setDownloading] = useState('');
  const [downloadError, setDownloadError] = useState('');

  const downloadArtifact = async (artifact) => {
    if (downloading) return;
    setDownloading(artifact.id);
    setDownloadError('');
    try {
      const objectUrl = URL.createObjectURL(await getArtifactBlob(artifact.id));
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = artifact.artifact_type;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    } catch (error) {
      setDownloadError(error instanceof ApiError ? error.message : 'No se pudo descargar el artefacto.');
    } finally {
      setDownloading('');
    }
  };

  return (
    <div class="artifact-download" aria-live="polite">
      <button type="button" class="artifact-link" onClick={() => downloadArtifact(artifact)} disabled={Boolean(downloading)} title={`Descargar ${label}`}>
        <LucideIcon name="file-text" /><span class="artifact-name">{downloading ? 'Descargando…' : label}</span><LucideIcon name="download" />
      </button>
      {downloadError && <p class="artifact-download-error" role="alert">{downloadError}</p>}
    </div>
  );
}

function ArtifactList({ artifacts }) {
  if (!artifacts.length) return <div class="artifact-none">Sin artefactos disponibles para esta etapa.</div>;
  return (
    <div class="artifact-list">
      {artifacts.map((artifact) => <ArtifactDownload key={artifact.id} artifact={artifact} />)}
    </div>
  );
}

function evidenceStatus(stage, rows) {
  if (stage.status === 'failed') return 'failed';
  if (stage.status === 'skipped' || stage.status === 'disabled') return 'skipped';
  if (stage.status === 'cancelled') return 'cancelled';
  if (!['success', 'reused'].includes(stage.status)) return 'pending';
  return rows.length || stage.artifacts.length ? 'available' : 'partial';
}

function EvidenceStatus({ stage, rows }) {
  const status = evidenceStatus(stage, rows);
  return <span class={`info-evidence-status evidence-${status}`}>{EVIDENCE_STATUS_TEXT[status]}</span>;
}

function Provenance({ stage }) {
  const provenance = stage.provenance ?? {};
  if (!Object.keys(provenance).length) return null;
  return (
    <details class="info-provenance">
      <summary>Fuente y provenance publicados</summary>
      <pre>{JSON.stringify(provenance, null, 2)}</pre>
    </details>
  );
}

export default function InformationView({ proteinId }) {
  const [run, setRun] = useState(null);
  const [annotations, setAnnotations] = useState(null);
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
    let timer;
    let streamController;
    let latestRun = null;

    const applySnapshot = (runData, annotationData) => {
      if (!active) return;
      latestRun = runData;
      setRun(runData);
      setAnnotations(annotationData);
      setState('ready');
      setRefreshWarning('');
    };

    const refreshAnnotations = async () => {
      try {
        const annotationData = await getAnnotations(runId);
        if (active) setAnnotations(annotationData);
      } catch (requestError) {
        if (active) setRefreshWarning(requestError instanceof ApiError ? requestError.message : 'No se pudieron actualizar las anotaciones.');
      }
    };

    const schedulePolling = (delay = 2_000) => {
      if (!active) return;
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(async () => {
        try {
          const [runData, annotationData] = await Promise.all([getRun(runId), getAnnotations(runId)]);
          applySnapshot(runData, annotationData);
          if (!RUN_TERMINAL.has(runData.status)) connectStream();
        } catch (requestError) {
          if (!active) return;
          setRefreshWarning(requestError instanceof ApiError ? requestError.message : 'No se pudo actualizar la información.');
          schedulePolling(4_000);
        }
      }, delay);
    };

    const connectStream = async () => {
      if (!active || RUN_TERMINAL.has(latestRun?.status)) return;
      streamController?.abort();
      streamController = new AbortController();
      try {
        await subscribeRunEvents(runId, {
          signal: streamController.signal,
          onSnapshot: (snapshot) => {
            latestRun = snapshot;
            if (active) {
              setRun(snapshot);
              setState('ready');
              void refreshAnnotations();
            }
          },
        });
        if (active && !RUN_TERMINAL.has(latestRun?.status)) schedulePolling();
      } catch (streamError) {
        if (active && !streamController.signal.aborted) {
          setRefreshWarning(streamError instanceof ApiError ? streamError.message : 'La actualización en vivo se desconectó; se reintentará automáticamente.');
          schedulePolling();
        }
      }
    };

    Promise.all([getRun(runId), getAnnotations(runId)])
      .then(([runData, annotationData]) => {
        applySnapshot(runData, annotationData);
        if (!RUN_TERMINAL.has(runData.status)) void connectStream();
      })
      .catch((requestError) => {
        if (!active) return;
        setState('error');
        setError(requestError instanceof ApiError ? requestError.message : 'No se pudo cargar la información de la corrida.');
      });
    return () => {
      active = false;
      streamController?.abort();
      if (timer) window.clearTimeout(timer);
    };
  }, [runId]);

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

  const rowsByStage = useMemo(() => {
    const grouped = new Map();
    for (const row of annotations?.rows ?? []) grouped.set(row.stage_id, [...(grouped.get(row.stage_id) ?? []), row]);
    return grouped;
  }, [annotations]);

  if (state === 'missing-run') return <section class="info-view info-message"><h1>No hay una corrida seleccionada</h1><p>La información se muestra sólo para una corrida persistida.</p><a class="protein-open" href={`/proteins/${encodeURIComponent(proteinId)}/progress/`}>Ver progreso</a></section>;
  if (state === 'loading') return <section class="info-view info-message"><p>Cargando evidencia persistida…</p></section>;
  if (state === 'error') return <section class="info-view info-message" role="alert"><h1>No se pudo cargar la información</h1><p>{error}</p></section>;

  const allArtifacts = run.stages.flatMap((stage) => stage.artifacts ?? []);

  return (
    <section class="info-view" aria-label="Información y artefactos del pipeline">
      <header class="info-head">
        <div><h1>Información</h1><span class="run-id">Run {run.id}</span></div>
        <div class="info-head-meta">{run.requested_variants.length} variante{run.requested_variants.length === 1 ? '' : 's'} solicitada{run.requested_variants.length === 1 ? '' : 's'}</div>
      </header>
      <div class="info-body">
        <div class="info-notice">Los valores se muestran únicamente cuando el backend ha publicado filas de anotación o artefactos. Ausencia de filas no equivale a cero.</div>
        {refreshWarning && <div class="info-refresh-warning" role="status">{refreshWarning}</div>}
        <div class="info-stages">
          <article class="info-stage" id="resultados-completos">
            <header class="info-stage-head">
              <span class="info-stage-icon"><LucideIcon name="folder" /></span>
              <div class="info-stage-title"><strong>Artefactos publicados</strong><span>Descargas autorizadas de la corrida</span></div>
            </header>
            <div class="info-pane">
              <ArtifactList artifacts={allArtifacts} />
            </div>
          </article>
          {stages.map((stage, index) => {
            const rows = rowsByStage.get(stage.id) ?? [];
            return (
              <article class="info-stage" id={`stage-${stage.id}`} data-info-stage={stage.id} key={stage.id}>
                <header class="info-stage-head">
                  <span class="info-stage-icon"><LucideIcon name="workflow" /></span>
                  <div class="info-stage-title"><strong>{index + 1}. {stage.title}</strong><span>{stage.id} · {stage.legacy_id}{stage.optional ? ' · opcional' : ''}</span></div>
                  <div class="info-stage-status-group">
                    <span class={`info-stage-status ${stage.status === 'failed' ? 'status-failed-text' : stage.status === 'skipped' || stage.status === 'disabled' ? 'optional' : ''}`}><LucideIcon name={stage.status === 'failed' ? 'circle-x' : stage.status === 'skipped' ? 'circle-dot' : stage.status === 'disabled' ? 'circle-slash' : 'circle-check'} />{STATUS_TEXT[stage.status] ?? stage.status}{stage.status === 'skipped' && stage.omission_reason ? ` · ${OMISSION_REASON_TEXT[stage.omission_reason] ?? stage.omission_reason}` : ''}</span>
                    <EvidenceStatus stage={stage} rows={rows} />
                  </div>
                </header>
                <div class="info-stage-grid">
                  <section class="info-pane"><h2 class="info-pane-title">Anotaciones</h2><AnnotationRows rows={rows} /></section>
                  <section class="info-pane"><h2 class="info-pane-title">Artefactos</h2><ArtifactList artifacts={stage.artifacts} /></section>
                </div>
                <Provenance stage={stage} />
                {stage.error_message && <p class="stage-error" role="alert">{stage.error_code}: {stage.error_message}</p>}
              </article>
            );
          })}
        </div>
      </div>
    </section>
  );
}
