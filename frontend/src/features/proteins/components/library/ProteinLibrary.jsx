import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import PackIcon from '@shared/components/icons/PackIcon.jsx';
import StatePanel from '@shared/components/feedback/StatePanel.jsx';
import RunHistory from '@features/runs/components/history/RunHistory.jsx';
import ProteinStructurePreview from '@features/proteins/components/library/ProteinStructurePreview.jsx';
import { getArtifactBlob, listProteins, listRuns } from '@shared/api/client';
import { loadInferredVariantCount } from '@features/annotations/analysis-artifacts.js';
import { userErrorMessage } from '@shared/lib/error-presentation';
import {
  proteinAccession,
  proteinProgressHref,
  proteinSearchValues,
  runStatusClass,
  runStatusLabel,
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

function ProteinCard({ protein, run, structureRun }) {
  const label = proteinAccession(protein, run);
  const variantCountRef = useRef(null);
  const [inferredVariantCount, setInferredVariantCount] = useState(null);
  const variantStage = run?.stages?.find((stage) => stage.id === 'variant_ddg');
  const variantArtifact = variantStage?.artifacts?.find((artifact) => artifact.artifact_type === 'variant_annotations');

  useEffect(() => {
    let active = true;
    let observer;

        if (!['success', 'reused'].includes(variantStage?.status)) {
      setInferredVariantCount(0);
      return () => { active = false; };
    }

    setInferredVariantCount(null);
    async function loadCount() {
      try {
        const count = await loadInferredVariantCount(run, getArtifactBlob);
        if (active) setInferredVariantCount(count);
      } catch {
        if (active) setInferredVariantCount(null);
      }
    }

    const element = variantCountRef.current;
    if (!element || typeof IntersectionObserver === 'undefined') {
      void loadCount();
    } else {
      observer = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer?.disconnect();
          void loadCount();
        }
      }, { rootMargin: '120px' });
      observer.observe(element);
    }

    return () => {
      active = false;
      observer?.disconnect();
    };
  }, [run?.id, variantArtifact?.id, variantArtifact?.media_type, variantArtifact?.size, variantStage?.status]);

  return (
    <article class="protein-card">
      <ProteinStructurePreview run={structureRun} label={label} />
      <div class="protein-card-content">
        <h2 class="protein-accession">{label}</h2>
        <div class="protein-meta">
          <div class="protein-meta-item"><PackIcon name="activity" kind="ui" /><span>{protein.length.toLocaleString('es-CO')} aa</span></div>
          <div ref={variantCountRef} class="protein-meta-item protein-variant-count" aria-live="polite">
            {inferredVariantCount ?? '—'} {inferredVariantCount === 1 ? 'variante inferida' : 'variantes inferidas'}
          </div>
          <div class={`protein-meta-item protein-run-state protein-run-${runStatusClass(run?.status)}`}>
            <span class="protein-run-dot" aria-hidden="true" />
            <span>{run ? runStatusLabel(run.status) : 'Sin corridas'}</span>
          </div>
        </div>
      </div>
      <div class="protein-card-actions">
        <a class="protein-open" href={proteinProgressHref(protein, run)}>Abrir análisis</a>
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

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return proteins;
    return proteins.filter((protein) => proteinSearchValues(protein, latestRunByProtein.get(protein.id))
      .some((value) => value.toLowerCase().includes(needle)));
  }, [proteins, query, latestRunByProtein]);

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
          <h1>Mis proteínas</h1>
        </div>
      </header>
      <div class={`proteins-toolbar ${catalogEmpty ? 'is-single' : ''}`.trim()}>
        <label class="protein-search" aria-label="Buscar proteína">
          <PackIcon name="search" kind="ui" />
          <input type="search" placeholder="Buscar por accession o alias" autoComplete="off" value={query} onInput={(event) => setQuery(event.currentTarget.value)} />
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
              <div class="proteins-grid">
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
