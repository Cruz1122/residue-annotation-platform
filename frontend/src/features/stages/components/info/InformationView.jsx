import { useEffect, useMemo, useState } from 'preact/hooks';
import LucideIcon from '@shared/components/icons/LucideIcon.jsx';
import { ApiError, getAnnotations, getArtifactBlob, getRun } from '@shared/api/client';
import '@features/stages/styles/info.css';

const STATUS_TEXT = {
  pending: 'Pendiente', ready: 'Listo', queued: 'En cola', running: 'En ejecución',
  success: 'Completado', reused: 'Reutilizado', failed: 'Falló', skipped: 'No aplica', cancelled: 'Cancelado',
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
            <dd>{Object.entries(row.values).map(([key, value]) => `${key}=${valueText(value)}`).join(' · ') || 'NA'}</dd>
          </div>
        ))}
      </dl>
      {rows.length > sample.length && <p class="info-empty-note">Se muestran las primeras {sample.length}; el endpoint conserva todas las filas.</p>}
    </div>
  );
}

function ArtifactList({ artifacts }) {
  const [downloading, setDownloading] = useState('');
  const [downloadError, setDownloadError] = useState('');
  if (!artifacts.length) return <div class="artifact-none">Sin artefactos disponibles para esta etapa.</div>;

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
    <div class="artifact-list" aria-live="polite">
      {artifacts.map((artifact) => (
        <button key={artifact.id} type="button" class="artifact-link" onClick={() => downloadArtifact(artifact)} disabled={Boolean(downloading)} title={`Descargar ${artifact.artifact_type}`}>
          <LucideIcon name="file-text" /><span class="artifact-name">{downloading === artifact.id ? 'Descargando…' : artifact.artifact_type}</span><LucideIcon name="download" />
        </button>
      ))}
      {downloadError && <p class="artifact-download-error" role="alert">{downloadError}</p>}
    </div>
  );
}

export default function InformationView({ proteinId }) {
  const [run, setRun] = useState(null);
  const [annotations, setAnnotations] = useState(null);
  const [state, setState] = useState('loading');
  const [error, setError] = useState('');
  const runId = typeof window === 'undefined' ? '' : new URLSearchParams(window.location.search).get('run') ?? '';

  useEffect(() => {
    if (!runId) {
      setState('missing-run');
      return undefined;
    }
    let active = true;
    Promise.all([getRun(runId), getAnnotations(runId)])
      .then(([runData, annotationData]) => {
        if (!active) return;
        setRun(runData);
        setAnnotations(annotationData);
        setState('ready');
      })
      .catch((requestError) => {
        if (!active) return;
        setState('error');
        setError(requestError instanceof ApiError ? requestError.message : 'No se pudo cargar la información de la corrida.');
      });
    return () => { active = false; };
  }, [runId]);

  const rowsByStage = useMemo(() => {
    const grouped = new Map();
    for (const row of annotations?.rows ?? []) grouped.set(row.stage_id, [...(grouped.get(row.stage_id) ?? []), row]);
    return grouped;
  }, [annotations]);

  if (state === 'missing-run') return <section class="info-view info-message"><h1>No hay una corrida seleccionada</h1><p>La información se muestra sólo para una corrida persistida.</p><a class="protein-open" href={`/proteins/${encodeURIComponent(proteinId)}/progress/`}>Ver progreso</a></section>;
  if (state === 'loading') return <section class="info-view info-message"><p>Cargando evidencia persistida…</p></section>;
  if (state === 'error') return <section class="info-view info-message" role="alert"><h1>No se pudo cargar la información</h1><p>{error}</p></section>;

  return (
    <section class="info-view" aria-label="Información y artefactos del pipeline">
      <header class="info-head">
        <div><h1>Información</h1><span class="run-id">Run {run.id}</span></div>
        <div class="info-head-meta">{run.requested_variants.length} variante{run.requested_variants.length === 1 ? '' : 's'} solicitada{run.requested_variants.length === 1 ? '' : 's'}</div>
      </header>
      <div class="info-body">
        <div class="info-notice">Los valores se muestran únicamente cuando el backend ha publicado filas de anotación o artefactos. Ausencia de filas no equivale a cero.</div>
        <div class="info-stages">
          {run.stages.map((stage, index) => {
            const rows = rowsByStage.get(stage.id) ?? [];
            return (
              <article class="info-stage" id={`stage-${stage.id}`} data-info-stage={stage.id} key={stage.id}>
                <header class="info-stage-head">
                  <span class="info-stage-icon"><LucideIcon name="workflow" /></span>
                  <div class="info-stage-title"><strong>{index + 1}. {stage.title}</strong><span>{stage.id} · {stage.legacy_id}{stage.optional ? ' · opcional' : ''}</span></div>
                  <span class={`info-stage-status ${stage.status === 'failed' ? 'status-failed-text' : stage.status === 'skipped' ? 'optional' : ''}`}><LucideIcon name={stage.status === 'failed' ? 'circle-x' : stage.status === 'skipped' ? 'circle-dot' : 'circle-check'} />{STATUS_TEXT[stage.status] ?? stage.status}</span>
                </header>
                <div class="info-stage-grid">
                  <section class="info-pane"><h2 class="info-pane-title">Anotaciones</h2><AnnotationRows rows={rows} /></section>
                  <section class="info-pane"><h2 class="info-pane-title">Artefactos</h2><ArtifactList artifacts={stage.artifacts} /></section>
                </div>
                {stage.error_message && <p class="stage-error" role="alert">{stage.error_code}: {stage.error_message}</p>}
              </article>
            );
          })}
        </div>
      </div>
    </section>
  );
}
