import { useEffect, useMemo, useState } from 'preact/hooks';
import PackIcon from '@shared/components/icons/PackIcon.jsx';
import StatePanel from '@shared/components/feedback/StatePanel.jsx';
import RunHistory from '@features/runs/components/history/RunHistory.jsx';
import ProteinStructurePreview from '@features/proteins/components/library/ProteinStructurePreview.jsx';
import { listProteins, listRuns } from '@shared/api/client';
import { userErrorMessage } from '@shared/lib/error-presentation';
import {
  proteinDisplayName,
  proteinProgressHref,
  proteinSearchValues,
  runActivityText,
  runStatusClass,
} from '@features/proteins/protein-display.js';
import '@features/proteins/styles/library.css';

async function listAllRuns() {
  const runs = [];
  let offset = 0;
  while (true) {
    const page = await listRuns(200, offset);
    runs.push(...page);
    if (page.length < 200) return runs;
    offset += page.length;
  }
}

function runPipelineSummary(run) {
  const stages = (run?.stages ?? []).filter((stage) => stage.status !== 'disabled');
  const completed = stages.filter((stage) => ['success', 'reused', 'skipped'].includes(stage.status)).length;
  return stages.length > 0 ? `${completed}/${stages.length}` : '—';
}

function ProteinAnalysisDock({ protein, run, now }) {
  const variants = run?.configuration?.normalized_variants ?? run?.requested_variants ?? [];
  const outputs = (run?.run_artifacts ?? [])
    .filter((artifact) => ['final_annotations', 'selected_variants'].includes(artifact.artifact_type));

  return (
    <section class="protein-analysis-dock" aria-label={`Resumen de la corrida de ${proteinDisplayName(protein)}`}>
      <div class="protein-analysis-dock-head">
        <span>Lectura rápida</span>
        <strong>{runActivityText(run, now)}</strong>
      </div>
      <div class="protein-analysis-metrics">
        <div class="protein-analysis-metric">
          <span>Variantes bajo estudio</span>
          <strong>{variants.length || '—'}</strong>
          {variants.length > 0 ? (
            <div class="protein-variant-chips" aria-label="Variantes seleccionadas">
              {variants.map((variant) => <span key={`${variant.aa_ref}${variant.aa_position}${variant.aa_alt}`}>{variant.aa_ref}{variant.aa_position}{variant.aa_alt}</span>)}
            </div>
          ) : <small>Sin variantes confirmadas</small>}
        </div>
        <div class="protein-analysis-metric">
          <span>Pipeline publicado</span>
          <strong>{runPipelineSummary(run)}</strong>
          <small>{run ? 'stages disponibles' : 'Sin ejecución'}</small>
        </div>
        <div class="protein-analysis-metric">
          <span>Salidas listas</span>
          <strong>{outputs.length || '—'}</strong>
          <small>{outputs.length === 1 ? 'exportación disponible' : 'exportaciones disponibles'}</small>
        </div>
      </div>
    </section>
  );
}

function ProteinCard({ protein, run, structureRun }) {
  const label = proteinDisplayName(protein);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!run || !['running', 'cancel_requested'].includes(run.status)) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [run?.id, run?.status]);

  return (
    <article class="protein-card">
      <ProteinStructurePreview run={structureRun} label={label} />
      <div class="protein-card-title">
        <div class="protein-accession">{label}</div>
      </div>
      <div class="protein-meta">
        <div class="protein-meta-item"><PackIcon name="activity" kind="ui" /><span>{protein.length.toLocaleString('es-CO')} aa</span></div>
        <div class={`protein-meta-item protein-run-state protein-run-${runStatusClass(run?.status)}`}>
          <span class="protein-run-dot" aria-hidden="true" />
          <span>{runActivityText(run, now)}</span>
        </div>
      </div>
      <ProteinAnalysisDock protein={protein} run={run} now={now} />
      <div class="protein-card-actions">
        <a class="protein-open" href={proteinProgressHref(protein, run)}>Abrir análisis</a>
        <a class="protein-open secondary-open" href="/">Nueva corrida</a>
      </div>
    </article>
  );
}

export default function ProteinLibrary() {
  const [proteins, setProteins] = useState([]);
  const [runs, setRuns] = useState([]);
  const [query, setQuery] = useState('');
  const [state, setState] = useState('loading');
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    Promise.all([listProteins(), listAllRuns()])
      .then(([proteinItems, runItems]) => {
        if (!active) return;
        setProteins(proteinItems);
        setRuns(runItems);
        setState('ready');
      })
      .catch((requestError) => {
        if (!active) return;
        setState('error');
        setError(userErrorMessage(requestError, 'No se pudo cargar el catálogo.'));
      });
    return () => { active = false; };
  }, []);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return proteins;
    return proteins.filter((protein) => proteinSearchValues(protein)
      .some((value) => value.toLowerCase().includes(needle)));
  }, [proteins, query]);

  const latestRunByProtein = useMemo(() => {
    const result = new Map();
    for (const run of runs) {
      const current = result.get(run.protein_id);
      if (!current || String(run.created_at ?? '') > String(current.created_at ?? '')) {
        result.set(run.protein_id, run);
      }
    }
    return result;
  }, [runs]);

  const latestSuccessfulRunByProtein = useMemo(() => {
    const result = new Map();
    for (const run of runs) {
      if (run.status !== 'success') continue;
      const current = result.get(run.protein_id);
      if (!current || String(run.created_at ?? '') > String(current.created_at ?? '')) {
        result.set(run.protein_id, run);
      }
    }
    return result;
  }, [runs]);

  const catalogEmpty = state === 'ready' && proteins.length === 0;

  return (
    <section class="library-view" aria-label="Mis proteínas">
      <header class="library-head">
        <div>
          <span class="library-kicker">Espacio de trabajo</span>
          <h1>Proteínas</h1>
        </div>
        {state === 'ready' && <span class="library-total">{proteins.length} {proteins.length === 1 ? 'proteína' : 'proteínas'}</span>}
      </header>
      <div class={`proteins-toolbar ${catalogEmpty ? 'is-single' : ''}`.trim()}>
        <label class="protein-search" aria-label="Buscar proteína">
          <PackIcon name="search" kind="ui" />
          <input type="search" placeholder="Buscar por ID, alias o hash" autoComplete="off" value={query} onInput={(event) => setQuery(event.currentTarget.value)} />
        </label>
        {!catalogEmpty && (
          <a class="protein-filter" href="/" aria-label="Registrar proteína" title="Registrar proteína"><PackIcon name="plus" kind="ui" /></a>
        )}
      </div>

      {state === 'loading' && (
        <StatePanel
          kind="loading"
          fill
          title="Cargando proteínas"
          description="Consultando el catálogo y el historial de corridas."
        />
      )}
      {state === 'error' && (
        <StatePanel
          kind="error"
          fill
          title="No se pudo cargar el catálogo"
          description={error}
        />
      )}
      {state === 'ready' && (
        <div class="library-workspace">
          <main class="library-main" aria-label="Proteínas registradas">
            {catalogEmpty && (
              <StatePanel
                kind="empty"
                icon="protein"
                fill
                eyebrow="Catálogo vacío"
                title="Aún no tienes proteínas registradas."
                description="Registra una proteína para iniciar y conservar tus corridas de análisis."
              >
                <a class="library-create" href="/"><PackIcon name="plus" kind="ui" />Registrar proteína</a>
              </StatePanel>
            )}
            {!catalogEmpty && filtered.length > 0 && (
              <div class={`proteins-grid ${filtered.length === 1 ? 'is-single' : ''}`}>
                {filtered.map((protein) => (
                  <ProteinCard
                    key={protein.id}
                    protein={protein}
                    run={latestRunByProtein.get(protein.id)}
                    structureRun={latestSuccessfulRunByProtein.get(protein.id)}
                  />
                ))}
              </div>
            )}
            {!catalogEmpty && !filtered.length && (
              <StatePanel
                kind="empty"
                icon="scan-search"
                fill
                eyebrow="Sin resultados"
                title="No hay proteínas que coincidan con la búsqueda."
                description="Prueba con otro ID, alias o hash de secuencia."
              />
            )}
          </main>
          <aside class="library-history-column" aria-label="Historial de corridas">
            <RunHistory runs={runs} proteins={proteins} />
          </aside>
        </div>
      )}
    </section>
  );
}
