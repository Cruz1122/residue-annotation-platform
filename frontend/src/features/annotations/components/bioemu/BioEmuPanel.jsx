import StatePanel from '@shared/components/feedback/StatePanel.jsx';
import PackIcon from '@shared/components/icons/PackIcon.jsx';
import { bioEmuProteinIdentifier, formatBioEmuConformerCounter } from '@features/annotations/bioemu-presentation.js';

const SAMPLE_NOTE = 'Conformeros muestreados; el índice no representa tiempo biológico.';

function hasValue(value) {
  return value !== null && value !== undefined && value !== '';
}

function EvidenceRow({ label, value }) {
  if (!hasValue(value)) return null;
  return <div class="frustration-evidence-row"><dt>{label}</dt><dd>{String(value)}</dd></div>;
}

function DetailSection({ title, children }) {
  return <section class="frustration-values bioemu-panel-section"><h3>{title}</h3>{children}</section>;
}

function playbackStatus(stateLabel) {
  if (stateLabel === 'Selección no disponible') return stateLabel;
  if (stateLabel.startsWith('Cargando') || stateLabel.startsWith('Verificando') || stateLabel.startsWith('Preparando')) return stateLabel;
  if (stateLabel === 'Trayectoria incompatible') return 'Trayectoria incompatible';
  if (stateLabel === 'Error al cargar') return 'No se pudo cargar la trayectoria';
  return 'Trayectoria no disponible';
}

export default function BioEmuPanel({
  run,
  protein,
  metadata,
  structureSummary,
  frameCount,
  currentIndex,
  stateLabel,
  frameIndex,
  metric,
  selectedResidue,
  publishedMetricsAvailable = false,
}) {
  const current = Number.isInteger(currentIndex) && Number.isInteger(frameCount) && frameCount > 0;
  const mapping = current ? frameIndex?.[currentIndex] : null;
  const hasFrameProvenance = Boolean(mapping && (mapping.round !== null || mapping.sourceFrame !== null));
  const hasPublishedMetricRow = Boolean(selectedResidue && publishedMetricsAvailable);
  const status = playbackStatus(stateLabel);
  const proteinIdentifier = bioEmuProteinIdentifier(metadata, run, protein);
  const structureRows = [
    ['Residuos', structureSummary?.residueCount],
    ['Átomos', structureSummary?.atomCount],
    ['Identificador de proteína', proteinIdentifier],
  ].filter(([, value]) => hasValue(value));
  const metadataRows = [
    ['Modelo', metadata?.model],
    ['Conformeros reportados', metadata?.conformerCount],
    ['Muestras iniciales', metadata?.rawSampleCount],
    ['Longitud de secuencia', metadata?.sequenceLength],
    ['Unidad de coordenadas', metadata?.coordinateUnit],
  ].filter(([, value]) => hasValue(value));

  return (
    <aside class="frustration-annotations bioemu-panel" aria-label="Propiedades y metadatos del conformero">
      <div class="frustration-annotations-body">
        <section class="frustration-residue-summary bioemu-conformer-summary" aria-label={current ? 'Conformero actual' : 'Estructura de referencia'}>
          <div class="bioemu-conformer-mark" aria-hidden="true">
            <PackIcon name="layers-3" kind="ui" />
          </div>
          <div class="frustration-residue-name" style={{ '--residue-color': '#172e62' }}>
            <div class="bioemu-conformer-title">
              <strong>{current ? 'Conformero BioEmu' : selectedResidue?.label ?? 'Estructura de referencia'}</strong>
              {current && (
                <span class="bioemu-sampling-info" role="img" aria-label={SAMPLE_NOTE} title={SAMPLE_NOTE}>
                  <PackIcon name="info" kind="ui" />
                </span>
              )}
            </div>
            {!current && <span>{selectedResidue ? `Residuo PDB ${selectedResidue.pdbId} · ${status}` : status}</span>}
          </div>
          <strong
            class={`frustration-residue-position bioemu-conformer-counter ${current ? '' : 'is-unavailable'}`}
            aria-label={current ? `Conformero ${currentIndex + 1} de ${frameCount}; índice de muestra sin escala de tiempo biológico` : 'Sin conformero actual'}
            title={current ? SAMPLE_NOTE : undefined}
          >
            {current ? formatBioEmuConformerCounter(currentIndex, frameCount) : '—'}
          </strong>
        </section>

        {structureRows.length > 0 && (
          <DetailSection title="Topología y corrida">
            <dl class="frustration-evidence-list">
              {structureRows.map(([label, value]) => <EvidenceRow key={label} label={label} value={value} />)}
            </dl>
          </DetailSection>
        )}

        {selectedResidue && (
          <DetailSection title="Residuo seleccionado">
            <dl class="frustration-evidence-list">
              <EvidenceRow label="Posición en secuencia" value={selectedResidue.position} />
              <EvidenceRow label="Residuo PDB" value={selectedResidue.pdbId} />
            </dl>
          </DetailSection>
        )}

        {metadataRows.length > 0 && (
          <DetailSection title="Metadatos publicados por BioEmu">
            <dl class="frustration-evidence-list">
              {metadataRows.map(([label, value]) => <EvidenceRow key={label} label={label} value={value} />)}
            </dl>
          </DetailSection>
        )}

        {current && (hasFrameProvenance || metric || hasPublishedMetricRow) && (
          <DetailSection title="Datos del conformero">
            {stateLabel === 'Selección no disponible' ? null : (
              <>
                {hasFrameProvenance && (
                  <dl class="frustration-evidence-list">
                    {mapping.round !== null && <EvidenceRow label="Ronda de origen" value={mapping.round} />}
                    {mapping.sourceFrame !== null && <EvidenceRow label="Frame XTC de origen" value={mapping.sourceFrame} />}
                  </dl>
                )}
                {metric ? (
                  <div class="bioemu-published-metric">
                    <div class="bioemu-metric-heading"><strong>{metric.name}</strong><b>{metric.value.toLocaleString('es-CO', { maximumFractionDigits: 4 })}</b></div>
                    {metric.unit && <p>Unidad: {metric.unit}.</p>}
                    {metric.referenceUrl && <a href={metric.referenceUrl} target="_blank" rel="noreferrer">Referencia metodológica</a>}
                  </div>
                ) : selectedResidue && publishedMetricsAvailable ? (
                  <dl class="frustration-evidence-list">
                    <EvidenceRow label="Frustratometer FI" value="Sin dato publicado" />
                    <EvidenceRow label="Residuo seleccionado" value={`${selectedResidue.label} · PDB ${selectedResidue.pdbId}`} />
                  </dl>
                ) : null}
              </>
            )}
          </DetailSection>
        )}

        {!current && stateLabel === 'Sin trayectoria disponible' && (
          <StatePanel
            kind="empty"
            compact
            icon="box"
            title="No hay trayectoria de conformeros"
            description="Se muestra la estructura de referencia. Esta corrida no publicó coordenadas para recorrer los conformeros."
          />
        )}
      </div>
    </aside>
  );
}
