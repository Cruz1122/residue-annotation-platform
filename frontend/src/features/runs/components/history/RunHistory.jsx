import PackIcon from '@shared/components/icons/PackIcon.jsx';
import StatePanel from '@shared/components/feedback/StatePanel.jsx';
import AuthenticatedArtifactLink from '@features/artifacts/components/AuthenticatedArtifactLink.tsx';
import { runFailureMessage } from '@shared/lib/error-presentation';
import { proteinAccession, proteinDisplayName } from '@features/proteins/protein-display.js';
import { runResultsRoute } from '@features/runs/run-results-route.js';
import '@features/proteins/styles/library.css';
import { useMemo, useState } from 'preact/hooks';

const STATUS_TEXT = {
  pending: 'Pendiente',
  running: 'En ejecución',
  success: 'Completada',
  failed: 'Fallida',
  cancel_requested: 'Cancelando',
  cancelled: 'Cancelada',
};

function formatDate(value) {
  if (!value) return 'Fecha no disponible';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Fecha no disponible';
  return new Intl.DateTimeFormat('es-CO', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function runProteinId(run) {
  return run.external_tracking?.base_protein_id ?? run.protein_id;
}

function runType(run) {
  const externalType = run.external_tracking?.run_type;
  if (externalType === 'ddg' || externalType === 'mutant'
    || (run.configuration?.normalized_variants ?? run.requested_variants ?? []).length > 0) return 'p07';
  return 'base';
}

const TYPE_TEXT = { p07: 'P07', base: 'Base' };

export default function RunHistory({ runs, proteins }) {
  const [proteinFilter, setProteinFilter] = useState('all');
  const [typeFilter, setTypeFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const proteinsById = new Map(proteins.map((protein) => [protein.id, protein]));
  const proteinOptions = useMemo(() => [...new Set(runs.map(runProteinId))]
    .map((id) => proteinsById.get(id))
    .filter(Boolean)
    .sort((left, right) => proteinAccession(left).localeCompare(proteinAccession(right))), [runs, proteins]);
  const visibleRuns = useMemo(() => runs.filter((run) => (
    (proteinFilter === 'all' || runProteinId(run) === proteinFilter)
    && (typeFilter === 'all' || runType(run) === typeFilter)
    && (statusFilter === 'all' || run.status === statusFilter)
  )), [runs, proteinFilter, typeFilter, statusFilter]);

  return (
    <section class="run-history" aria-label="Historial de corridas">
      <header class="run-history-head">
        <div><h2>Historial de corridas</h2></div>
        <span class="run-history-count">{visibleRuns.length}</span>
      </header>
      {runs.length > 0 && (
        <div class="run-history-filters">
          <label>
            <span>Proteína</span>
            <select aria-label="Filtrar por proteína" value={proteinFilter} onChange={(event) => setProteinFilter(event.currentTarget.value)}>
              <option value="all">Todas las proteínas</option>
              {proteinOptions.map((protein) => (
                <option value={protein.id} key={protein.id}>
                  {proteinAccession(protein)} · {proteinDisplayName(protein)}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Tipo</span>
            <select aria-label="Filtrar por tipo" value={typeFilter} onChange={(event) => setTypeFilter(event.currentTarget.value)}>
              <option value="all">Todos los tipos</option>
              {Object.entries(TYPE_TEXT).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
            </select>
          </label>
          <label>
            <span>Estado</span>
            <select aria-label="Filtrar por estado" value={statusFilter} onChange={(event) => setStatusFilter(event.currentTarget.value)}>
              <option value="all">Todos los estados</option>
              {Object.entries(STATUS_TEXT).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
            </select>
          </label>
        </div>
      )}
      {runs.length === 0 && (
        <StatePanel
          kind="empty"
          compact
          fill
          icon="workflow"
          eyebrow="Historial vacío"
          title="Todavía no tienes corridas registradas."
          description="Cuando inicies un análisis, sus ejecuciones aparecerán aquí."
        />
      )}
      {runs.length > 0 && visibleRuns.length === 0 && (
        <StatePanel
          kind="empty"
          compact
          fill
          icon="scan-search"
          eyebrow="Sin resultados"
          title="No hay corridas para estos filtros."
          description="Cambia los filtros para ver otras corridas."
        />
      )}
      {visibleRuns.length > 0 && (
        <div class="run-history-list">
          {visibleRuns.map((run) => {
            const protein = proteinsById.get(runProteinId(run));
            const tracking = run.external_tracking;
            const configuration = run.configuration;
            const variants = configuration?.normalized_variants ?? run.requested_variants ?? [];
            const title = tracking?.display_name ?? proteinDisplayName(protein);
            return (
              <article class="run-history-card" key={run.id}>
                <div class="run-history-main">
                  <div class="run-history-title">
                    <div>
                      <strong title={title}>{title}</strong>
                      <span>{formatDate(run.created_at)}</span>
                    </div>
                    <span class={`run-history-status run-status-${run.status}`}>
                      <i />{STATUS_TEXT[run.status] ?? run.status}
                    </span>
                  </div>
                  <div class="run-history-meta">
                    {!tracking && variants.length > 0 && (
                      <span><PackIcon name="dna" kind="ui" />{variants.map((variant) => `${variant.aa_ref}${variant.aa_position}${variant.aa_alt}`).join(' · ')}</span>
                    )}
                    {configuration?.structure_source && <span><PackIcon name="box" kind="ui" />{configuration.structure_source === 'alphafold3' ? 'AlphaFold 3' : 'Estructura adjunta'}</span>}
                  </div>
                  {run.error_message && <p class="run-history-error" role="alert">{runFailureMessage(run.error_code, run.error_message)}</p>}
                  {run.run_artifacts?.length > 0 && (
                    <div class="run-history-exports" aria-label="Exportaciones publicadas">
                      {run.run_artifacts.filter((artifact) => ['final_annotations', 'selected_variants'].includes(artifact.artifact_type)).map((artifact) => (
                        <AuthenticatedArtifactLink
                          key={artifact.id}
                          id={artifact.id}
                          artifact={artifact}
                          label={artifact.display_name}
                          filename={artifact.download_filename}
                          formatLabel={artifact.format_label}
                          downloadFormat={artifact.download_format}
                        />
                      ))}
                    </div>
                  )}
                </div>
                <nav class="run-history-actions" aria-label={`Acciones de la corrida ${title}`}>
                  <a href={`/proteins/${encodeURIComponent(run.protein_id)}/${runResultsRoute(run)}/?run=${encodeURIComponent(run.id)}`}>Abrir resultados</a>
                  <a href={`/proteins/${encodeURIComponent(run.protein_id)}/progress/?run=${encodeURIComponent(run.id)}`}>Ver progreso</a>
                </nav>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
