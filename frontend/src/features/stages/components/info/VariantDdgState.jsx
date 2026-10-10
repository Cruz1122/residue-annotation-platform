import { useEffect, useState } from 'preact/hooks';
import LucideIcon from '@shared/components/icons/LucideIcon.jsx';
import { readSession } from '@shared/lib/session.js';

export default function VariantDdgState() {
  const [variants, setVariants] = useState([]);
  useEffect(() => setVariants(readSession().variants), []);

  if (!variants.length) {
    return (
      <div class="variant-ddg-state">
        <div class="info-stage-status optional"><LucideIcon name="circle-dot" />No solicitado</div>
        <div class="variant-ddg-grid">
          <section class="info-pane">
            <h2 class="info-pane-title">Anotaciones</h2>
            <dl class="info-annotation-list">
              <div class="info-annotation"><dt><span class="info-annotation-label">Evaluación solicitada</span><span class="info-annotation-key">ddg_variant_evaluated</span></dt><dd>No</dd></div>
              <div class="info-annotation"><dt><span class="info-annotation-label">Estado</span><span class="info-annotation-key">corrida</span></dt><dd>Sin variante de entrada</dd></div>
            </dl>
          </section>
          <section class="info-pane"><h2 class="info-pane-title">Artefactos</h2><div class="artifact-none">Sin artefactos para esta corrida.</div></section>
        </div>
      </div>
    );
  }

  const labels = variants.map((variant) => variant.label).join(' · ');
  return (
    <div class="variant-ddg-state">
      <div class="info-stage-status"><LucideIcon name="circle-check" />Programado</div>
      <div class="variant-ddg-grid">
        <section class="info-pane">
          <h2 class="info-pane-title">Anotaciones</h2>
          <dl class="info-annotation-list">
            <div class="info-annotation"><dt><span class="info-annotation-label">Evaluación solicitada</span><span class="info-annotation-key">ddg_variant_evaluated</span></dt><dd>Sí</dd></div>
            <div class="info-annotation"><dt><span class="info-annotation-label">Variantes</span><span class="info-annotation-key">variant_id</span></dt><dd>{labels}</dd></div>
            <div class="info-annotation"><dt><span class="info-annotation-label">Número de variantes</span><span class="info-annotation-key">variant_count</span></dt><dd>{variants.length}</dd></div>
          </dl>
        </section>
        <section class="info-pane">
          <h2 class="info-pane-title">Artefactos</h2>
          <div class="artifact-list">
            {['variant_annotations.tsv', 'ddg_replicates.tsv', 'provenance.json'].map((filename) => (
              <a key={filename} class="artifact-link" href={`/mock-artifacts/variant_ddg/${filename}`} download={filename}>
                <LucideIcon name="file-text" /><span class="artifact-name">{filename}</span><LucideIcon name="download" />
              </a>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
