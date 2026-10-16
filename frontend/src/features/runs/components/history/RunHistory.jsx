import LucideIcon from '@shared/components/icons/LucideIcon.jsx';
import EmptyState from '@shared/components/feedback/EmptyState.jsx';
import { runFailureMessage } from '@shared/lib/error-presentation';
import '@features/proteins/styles/library.css';

const STATUS_TEXT = {
  pending: 'Preparando',
  running: 'En ejecución',
  success: 'Completada',
  failed: 'Fallida',
  cancel_requested: 'Cancelando',
  cancelled: 'Cancelada',
};

function proteinLabel(protein) {
  return protein?.aliases?.[0]?.identifier || protein?.id || 'Proteína no disponible';
}

function formatDate(value) {
  if (!value) return 'Fecha no disponible';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Fecha no disponible';
  return new Intl.DateTimeFormat('es-CO', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function stageCounts(stages) {
  return stages.reduce((counts, stage) => {
    if (stage.status === 'success') counts.success += 1;
    if (stage.status === 'reused') counts.reused += 1;
    if (stage.status === 'failed') counts.failed += 1;
    if (stage.status === 'skipped') counts.skipped += 1;
    return counts;
  }, { success: 0, reused: 0, failed: 0, skipped: 0 });
}

export default function RunHistory({ runs, proteins, state }) {
  const proteinsById = new Map(proteins.map((protein) => [protein.id, protein]));

  return (
    <section class="run-history" aria-label="Historial de corridas">
      <header class="run-history-head">
        <div>
          <h2>Historial de corridas</h2>
          <p>Cada ejecución conserva su configuración, estado y resultados por separado.</p>
        </div>
        {state === 'ready' && <span class="run-history-count">{runs.length}</span>}
      </header>
      {state === 'loading' && <div class="library-empty">Cargando historial autorizado…</div>}
      {state === 'error' && <div class="library-empty" role="alert">No se pudo cargar el historial.</div>}
      {state === 'ready' && runs.length === 0 && (
        <EmptyState
          className="empty-state-compact"
          icon="workflow"
          label="Historial vacío"
          title="Todavía no tienes corridas registradas."
          copy="Cuando inicies un análisis, sus ejecuciones aparecerán aquí."
        />
      )}
      {state === 'ready' && runs.length > 0 && (
        <div class="run-history-list">
          {runs.map((run) => {
            const protein = proteinsById.get(run.protein_id);
            const counts = stageCounts(run.stages ?? []);
            const configuration = run.configuration;
            return (
              <article class="run-history-card" key={run.id}>
                <div class="run-history-main">
                  <div class="run-history-title">
                    <div>
                      <strong>{proteinLabel(protein)}</strong>
                      <span>{formatDate(run.created_at)}</span>
                    </div>
                    <span class={`run-history-status run-status-${run.status}`}>
                      <i />{STATUS_TEXT[run.status] ?? run.status}
                    </span>
                  </div>
                  <code class="run-history-id">{run.id}</code>
                  <div class="run-history-meta">
                    <span><LucideIcon name="workflow" />{run.stages?.length ?? 0} stages</span>
                    <span><LucideIcon name="play" />{counts.success} ejecutados</span>
                    <span><LucideIcon name="copy" />{counts.reused} reutilizados</span>
                    <span><LucideIcon name="triangle-alert" />{counts.failed} fallidos</span>
                    {configuration && <span><LucideIcon name="dna" />{configuration.normalized_variants?.length ?? 0} variantes · {configuration.structure_source}</span>}
                  </div>
                  {run.error_message && <p class="run-history-error" role="alert">{runFailureMessage(run.error_code, run.error_message)}</p>}
                </div>
                <nav class="run-history-actions" aria-label={`Abrir la corrida ${run.id}`}>
                  <a href={`/proteins/${encodeURIComponent(run.protein_id)}/progress/?run=${encodeURIComponent(run.id)}`}>Progreso</a>
                  <a href={`/proteins/${encodeURIComponent(run.protein_id)}/info/?run=${encodeURIComponent(run.id)}`}>Información</a>
                  <a href={`/proteins/${encodeURIComponent(run.protein_id)}/topology/?run=${encodeURIComponent(run.id)}`}>Explorar resultados</a>
                </nav>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
