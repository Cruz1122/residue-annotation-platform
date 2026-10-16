import { useEffect, useMemo, useState } from 'preact/hooks';
import LucideIcon from '@shared/components/icons/LucideIcon.jsx';
import EmptyState from '@shared/components/feedback/EmptyState.jsx';
import RunHistory from '@features/runs/components/history/RunHistory.jsx';
import { ApiError, listProteins, listRuns } from '@shared/api/client';
import '@features/proteins/styles/library.css';

function proteinLabel(protein) {
  return protein.aliases?.[0]?.identifier || protein.id;
}

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

function ProteinCard({ protein }) {
  const label = proteinLabel(protein);
  return (
    <article class="protein-card">
      <div class="protein-preview protein-sequence-preview" aria-label={`Secuencia de ${label}`}>
        <code>{protein.sequence.slice(0, 120)}{protein.sequence.length > 120 ? '…' : ''}</code>
      </div>
      <div class="protein-card-title">
        <div class="protein-accession">{label}</div>
        <div class="protein-name">{protein.id}</div>
        <div class="protein-completion">
          <LucideIcon name="hash" />
          <span>{protein.sequence_sha256.slice(0, 12)}…</span>
        </div>
      </div>
      <div class="protein-meta">
        <div class="protein-meta-item"><LucideIcon name="activity" /><span>{protein.length.toLocaleString('es-CO')} aa</span></div>
        <div class="protein-meta-item"><LucideIcon name="tags" /><span>{protein.aliases.length} alias{protein.aliases.length === 1 ? '' : 'es'}</span></div>
      </div>
      <div class="protein-card-actions">
        <a class="protein-open" href={`/proteins/${encodeURIComponent(protein.id)}/progress/`}>Ver progreso</a>
        <a class="protein-open secondary-open" href="/">Crear corrida</a>
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
        setError(requestError instanceof ApiError ? requestError.message : 'No se pudo cargar el catálogo.');
      });
    return () => { active = false; };
  }, []);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return proteins;
    return proteins.filter((protein) => [protein.id, protein.sequence_sha256, ...protein.aliases.map((alias) => alias.identifier)]
      .some((value) => value.toLowerCase().includes(needle)));
  }, [proteins, query]);

  const catalogEmpty = state === 'ready' && proteins.length === 0;

  return (
    <section class="library-view" aria-label="Mis proteínas">
      <div class={`proteins-toolbar ${catalogEmpty ? 'is-single' : ''}`.trim()}>
        <label class="protein-search" aria-label="Buscar proteína">
          <LucideIcon name="search" />
          <input type="search" placeholder="Buscar por ID, alias o hash" autoComplete="off" value={query} onInput={(event) => setQuery(event.currentTarget.value)} />
        </label>
        {!catalogEmpty && (
          <a class="protein-filter" href="/" aria-label="Registrar proteína" title="Registrar proteína"><LucideIcon name="plus" /></a>
        )}
      </div>

      {state === 'loading' && <div class="library-empty">Cargando proteínas desde el backend…</div>}
      {state === 'error' && <div class="library-empty" role="alert">{error}</div>}
      {catalogEmpty && (
        <EmptyState
          icon="dna"
          label="Catálogo vacío"
          title="Aún no tienes proteínas registradas."
          copy="Registra una proteína para iniciar y conservar tus corridas de análisis."
        >
          <a class="library-create" href="/"><LucideIcon name="plus" />Registrar proteína</a>
        </EmptyState>
      )}
      {state === 'ready' && !catalogEmpty && filtered.length > 0 && (
        <div class="proteins-grid">
          {filtered.map((protein) => <ProteinCard key={protein.id} protein={protein} />)}
        </div>
      )}
      {state === 'ready' && !catalogEmpty && !filtered.length && (
        <EmptyState
          icon="scan-search"
          label="Sin resultados"
          title="No hay proteínas que coincidan con la búsqueda."
          copy="Prueba con otro ID, alias o hash de secuencia."
        />
      )}
      <RunHistory runs={runs} proteins={proteins} state={state} />
    </section>
  );
}
