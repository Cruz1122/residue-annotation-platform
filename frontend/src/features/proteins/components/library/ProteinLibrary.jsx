import { useEffect, useMemo, useState } from 'preact/hooks';
import LucideIcon from '@shared/components/icons/LucideIcon.jsx';
import { readSession, writeSession } from '@shared/lib/session.js';
import '@features/proteins/styles/library.css';

function formatElapsed(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return `${minutes} min ${rest} s`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${minutes % 60} min`;
}

function completionPercent(ms) {
  // Demo-only curve: visually useful, deliberately asymptotic before 100%.
  return Math.min(96, Math.max(1, Math.round(100 * (1 - Math.exp(-ms / 42000)))));
}

function ProteinCard({ protein, now, startedAt }) {
  const elapsed = Math.max(0, now - startedAt);
  const percent = completionPercent(elapsed);

  return (
    <article class="protein-card">
      <div class="protein-preview" aria-label={`Snapshot de ${protein.accession}`}>
        <img src={protein.preview} alt={`Snapshot estructural de ${protein.accession}`} loading="eager" />
      </div>
      <div class="protein-card-title">
        <div class="protein-accession">{protein.accession}</div>
        <div class="protein-name">{protein.gene} · {protein.name}</div>
        <div class="protein-completion">
          <LucideIcon name="clock" />
          <span>Lleva {formatElapsed(elapsed)} · {percent}%</span>
        </div>
      </div>
      <div class="protein-meta">
        <div class="protein-meta-item"><LucideIcon name="tag" /><span>{protein.organism}</span></div>
        <div class="protein-meta-item"><LucideIcon name="activity" /><span>{protein.length} aa</span></div>
        <div class="protein-meta-item"><LucideIcon name="file-text" /><span>{protein.source}</span></div>
        <div class="protein-meta-item"><LucideIcon name="rotate-cw" /><span>Anotación en curso</span></div>
      </div>
      <a class="protein-open" href={`/proteins/${protein.id}/progress/`}>Ver proteína</a>
    </article>
  );
}

export default function ProteinLibrary({ proteins }) {
  const [query, setQuery] = useState('');
  const [now, setNow] = useState(0);
  const [startedAt, setStartedAt] = useState(0);

  useEffect(() => {
    const session = readSession();
    const started = session.runStartedAt || Date.now();
    if (!session.runStartedAt) writeSession({ runStartedAt: started });
    setStartedAt(started);
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, []);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return proteins;
    return proteins.filter((protein) => [protein.accession, protein.gene, protein.name, protein.organism]
      .some((value) => String(value).toLowerCase().includes(needle)));
  }, [proteins, query]);

  return (
    <section class="library-view" aria-label="Mis proteínas">
      <div class="proteins-toolbar">
        <label class="protein-search" aria-label="Buscar proteína">
          <LucideIcon name="search" />
          <input
            type="search"
            placeholder="Buscar proteína"
            autoComplete="off"
            value={query}
            onInput={(event) => setQuery(event.currentTarget.value)}
          />
        </label>
        <button class="protein-filter" type="button" aria-label="Filtrar proteínas" title="Filtro mock">
          <LucideIcon name="sliders-horizontal" />
        </button>
      </div>

      <div class="proteins-grid">
        {filtered.map((protein) => <ProteinCard key={protein.id} protein={protein} now={now} startedAt={startedAt || now} />)}
        {!filtered.length && <div class="library-empty">No hay proteínas que coincidan con la búsqueda.</div>}
      </div>
    </section>
  );
}
