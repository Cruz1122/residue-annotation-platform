import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import PackIcon from '@shared/components/icons/PackIcon.jsx';
import StatePanel from '@shared/components/feedback/StatePanel.jsx';
import ProteinStructurePreview from '@features/proteins/components/library/ProteinStructurePreview.jsx';
import { getArtifactBlob, listProteins, listRuns } from '@shared/api/client';
import { loadInferredVariantCount } from '@features/annotations/analysis-artifacts.js';
import { userErrorMessage } from '@shared/lib/error-presentation';
import {
  proteinAccession,
  proteinDisplayName,
  proteinProgressHref,
  proteinSearchValues,
  baseProteinStructureRuns,
  groupRunsByBaseProtein,
  isHiddenExternalRunSequenceProtein,
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

function sortNewest(runs) {
  return [...runs].sort((left, right) => String(right.created_at ?? '').localeCompare(String(left.created_at ?? '')));
}

function completedCount(runs, type) {
  return runs.filter((run) => {
    if (type === 'ddg') {
      const stage = run.stages?.find((item) => item.id === 'variant_ddg');
      return ['success', 'reused'].includes(stage?.status);
    }
    return run.status === 'success';
  }).length;
}

function ProteinCard({ protein, runs }) {
  const externalRuns = runs.filter((run) => run.external_tracking);
  const ddgRuns = externalRuns.filter((run) => run.external_tracking.run_type === 'ddg');
  const mutantRuns = externalRuns.filter((run) => run.external_tracking.run_type === 'mutant');
  const activeRuns = runs.filter((run) => ['pending', 'running'].includes(run.status));
  const latestRun = sortNewest(activeRuns.length ? activeRuns : runs)[0] ?? null;
  const latestStructureRun = sortNewest(baseProteinStructureRuns(runs))[0] ?? null;
  const label = proteinAccession(protein, latestRun);
  const displayName = proteinDisplayName(protein);
  const noVariants = externalRuns.length > 0
    && label === 'P22309'
    && ddgRuns.length === 0
    && mutantRuns.length === 0;
  const variantSourceRun = ddgRuns.length ? null : latestRun;
  const variantStage = variantSourceRun?.stages?.find((item) => item.id === 'variant_ddg');
  const variantArtifact = variantStage?.artifacts?.find((artifact) => artifact.artifact_type === 'variant_annotations');
  const [inferredVariantCount, setInferredVariantCount] = useState(null);
  const variantCountRef = useRef(null);

  useEffect(() => {
    let active = true;
    let observer;

    if (ddgRuns.length) {
      setInferredVariantCount(completedCount(ddgRuns, 'ddg'));
      return () => { active = false; };
    }
    if (!variantStage || !['success', 'reused'].includes(variantStage.status)) {
      setInferredVariantCount(0);
      return () => { active = false; };
    }

    setInferredVariantCount(null);
    const loadCount = async () => {
      try {
        const count = await loadInferredVariantCount(variantSourceRun, getArtifactBlob);
        if (active) setInferredVariantCount(count);
      } catch {
        if (active) setInferredVariantCount(null);
      }
    };
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
  }, [ddgRuns.length, label, variantArtifact?.id, variantArtifact?.media_type, variantArtifact?.size, variantSourceRun?.id, variantStage?.status]);

  return (
    <article class="protein-card">
      <ProteinStructurePreview run={latestStructureRun} label={displayName} />
      <div class="protein-card-content">
        <h2 class="protein-accession">{label === displayName ? label : `${label} · ${displayName}`}</h2>
        <div class="protein-meta">
          <div class="protein-meta-item"><PackIcon name="activity" kind="ui" /><span>{protein.length.toLocaleString('es-CO')} aa</span></div>
          <div ref={variantCountRef} class="protein-meta-item protein-variant-count" aria-live="polite">
            {protein.offlineVariantLabel ?? (noVariants
              ? '0 variantes inducidas (P07)'
              : externalRuns.length
                ? `${completedCount(ddgRuns, 'ddg')} variantes inducidas (P07)`
                : `${inferredVariantCount ?? '—'} ${inferredVariantCount === 1 ? 'variante inferida' : 'variantes inferidas'}`)}
          </div>
          <div class={`protein-meta-item protein-run-state protein-run-${runStatusClass(latestRun?.status)}`}>
            <span class="protein-run-dot" aria-hidden="true" />
            <span>{latestRun ? runStatusLabel(latestRun.status) : 'Sin corridas'}</span>
          </div>
        </div>
      </div>
      <div class="protein-card-actions">
        <a class="protein-open" href={proteinProgressHref(protein, latestRun)}>Abrir análisis</a>
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
  const refreshInFlight = useRef(false);
  const hasLoaded = useRef(false);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      if (!active || refreshInFlight.current || document.visibilityState !== 'visible') return;
      refreshInFlight.current = true;
      try {
        const [proteinItems, runItems] = await Promise.all([listProteins(), listAllRuns()]);
        if (!active) return;
        setProteins(proteinItems);
        setRuns(runItems);
        setState('ready');
        setError('');
        hasLoaded.current = true;
      } catch (requestError) {
        if (!active || hasLoaded.current) return;
        setState('error');
        setError(userErrorMessage(requestError, 'No se pudo cargar el catálogo.'));
      } finally {
        refreshInFlight.current = false;
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);

  const runsByBaseProtein = useMemo(() => {
    return groupRunsByBaseProtein(runs);
  }, [runs]);

  const visibleProteins = useMemo(() => {
    return proteins.filter((protein) => !isHiddenExternalRunSequenceProtein(protein.id, runs));
  }, [proteins, runs]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return visibleProteins;
    return visibleProteins.filter((protein) => {
      const groupedRuns = runsByBaseProtein.get(protein.id) ?? [];
      const values = [
        ...proteinSearchValues(protein, groupedRuns[0]),
        ...groupedRuns.flatMap((run) => [
          run.external_tracking?.display_name,
          run.external_tracking?.variant,
          run.external_tracking?.accession,
        ]),
      ].filter(Boolean);
      return values.some((value) => String(value).toLowerCase().includes(needle));
    });
  }, [visibleProteins, query, runsByBaseProtein]);

  const catalogEmpty = state === 'ready' && visibleProteins.length === 0;

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
                    runs={runsByBaseProtein.get(protein.id) ?? []}
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
        </div>
      )}
    </section>
  );
}
