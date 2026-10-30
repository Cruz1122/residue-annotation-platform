import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import StatePanel from '@shared/components/feedback/StatePanel.jsx';
import { artifactDisplayName } from '@features/artifacts/artifact-display.js';
import {
  getAnnotations,
  getArtifactBlob,
  getArtifactObjectUrl,
  getProtein,
  getRun,
  getUploadObjectUrl,
} from '@shared/api/client';
import { userErrorMessage } from '@shared/lib/error-presentation';
import {
  runStagePublicationSignature,
} from '@features/runs/run-updates.js';
import { loadAnalysisArtifactDetails, structureMappingFromArtifactRows } from '@features/annotations/analysis-artifacts.js';
import { runBelongsToProtein } from '@features/annotations/run-protein-context.js';
import { acquireStructureUrl } from '@features/annotations/structure-url-cache.js';
import { isStructureArtifact, structureFormat } from '@features/annotations/structure-format.js';
import { placeArpeggioOverlayLabels } from '@features/annotations/arpeggio-overlay-layout.js';
import { getZoomOptimizedCanvas3dProps } from '@features/annotations/zoom-rendering.js';
import { waitForCanvasDraw } from '@features/annotations/components/shared/canvas-render-readiness.js';
import {
  formatScaleNumber,
  hexToColorInt,
  mergeAnnotationRows,
  normalizeValue,
} from '@features/annotations/viewer-presentation.js';
import {
  ARPEGGIO_CAVEAT,
  ARPEGGIO_METRIC_OPTIONS,
  ARPEGGIO_ROLE_COLORS,
  aggregateContactRows,
  buildArpeggioModel,
  buildArpeggioRoleColors,
  buildArpeggioSummaryRows,
  contactTypeColor,
  contactTypeLabel,
  contactTypeShortLabel,
  formatArpeggioCount,
  formatArpeggioDistance,
  normalizeContactRows,
  observedContactTypes,
  residueInfo,
} from '@features/annotations/arpeggio-presentation.js';
import 'molstar/build/viewer/molstar.css';
import '@features/annotations/styles/frustration-comparison.css';
import '@features/annotations/styles/arpeggio.css';

const ANNOTATION_PAGE_SIZE = 50_000;
const MAX_ANNOTATION_PAGES = 20;
const CAMERA_RESET_DURATION_MS = 180;
const CAMERA_RESET_OPTIONS = { easing: 'cubic-out', trajectory: 'linear' };
const FOCUS_OPTIONS = { extraRadius: 4, durationMs: 180, easing: 'cubic-out', trajectory: 'linear' };
const STRUCTURE_REFERENCE_TYPES = ['model_cif', 'foldx_relaxed_pdb', 'selected_reference_pdb', 'rosettamp_relaxed_pdb'];

async function getAllAnnotations(runId) {
  const rows = [];
  let offset = 0;
  let lastResponse = null;
  for (let page = 0; page < MAX_ANNOTATION_PAGES; page += 1) {
    const response = await getAnnotations(runId, ANNOTATION_PAGE_SIZE, offset);
    lastResponse = response;
    rows.push(...(response.rows ?? []));
    if (!response.truncated) return { ...response, rows, truncated: false };
    if (!response.rows?.length) return { ...response, rows, truncated: true };
    offset += response.rows.length;
  }
  return { ...lastResponse, rows, truncated: true };
}

function structureSourceForArpeggio(run, provenance) {
  const artifacts = (run?.stages ?? []).flatMap((stage) => stage.artifacts ?? []);
  const inputSha = String(provenance?.inputs?.foldx_wt_pdb?.sha256 ?? '').trim().toLowerCase();
  const candidates = artifacts.filter(isStructureArtifact);
  const matched = inputSha
    ? candidates.find((artifact) => String(artifact.sha256 ?? '').toLowerCase() === inputSha)
    : null;
  const preferred = STRUCTURE_REFERENCE_TYPES
    .map((type) => candidates.find((artifact) => artifact.artifact_type === type))
    .find(Boolean);
  const displayFallback = candidates.find((artifact) => artifact.artifact_type === 'model_cif');
  const artifact = matched ?? preferred ?? displayFallback;
  if (artifact) {
    return {
      id: artifact.id,
      label: artifactDisplayName(artifact),
      format: structureFormat(artifact),
      loadUrl: () => getArtifactObjectUrl(artifact.id),
      referenceMatched: Boolean(matched)
        || (!inputSha && ['model_cif', 'selected_reference_pdb', 'foldx_relaxed_pdb', 'rosettamp_relaxed_pdb'].includes(artifact.artifact_type)),
    };
  }
  const uploads = (run?.uploads ?? []).filter((upload) => upload.input_type === 'structure');
  const matchedUpload = inputSha
    ? uploads.find((upload) => String(upload.sha256 ?? '').toLowerCase() === inputSha)
    : null;
  const upload = matchedUpload;
  if (!upload) return null;
  return {
    id: upload.id,
    label: upload.original_filename,
    format: structureFormat(upload),
    loadUrl: () => getUploadObjectUrl(upload.id),
    referenceMatched: Boolean(matchedUpload),
  };
}

function structureResidueKey(chain, residueNumber, insertionCode = '') {
  return `${String(chain || 'A')}|${String(residueNumber)}|${String(insertionCode || '')}`;
}

function mappingPairValues(pair) {
  const chain = pair?.chain ?? pair?.auth_asym_id ?? pair?.label_asym_id ?? 'A';
  const residueNumber = pair?.residue_number
    ?? pair?.residue_position
    ?? pair?.resseq
    ?? pair?.pdb_resseq
    ?? pair?.auth_seq_id
    ?? pair?.label_seq_id;
  const insertionCode = pair?.insertion_code ?? pair?.icode ?? pair?.pdb_icode ?? '';
  const canonicalPosition = Number(pair?.canonical_position ?? pair?.aa_position);
  if (!Number.isInteger(canonicalPosition) || canonicalPosition < 1 || residueNumber === null || residueNumber === undefined || residueNumber === '') return null;
  return {
    canonicalPosition,
    key: structureResidueKey(chain, residueNumber, insertionCode),
  };
}

function structureMappingMaps(mapping) {
  const byCanonical = new Map();
  const byStructure = new Map();
  for (const pair of mapping?.canonical_to_structure ?? []) {
    const normalized = mappingPairValues(pair);
    if (!normalized || byCanonical.has(normalized.canonicalPosition) || byStructure.has(normalized.key)) continue;
    byCanonical.set(normalized.canonicalPosition, normalized.key);
    byStructure.set(normalized.key, normalized.canonicalPosition);
  }
  return { byCanonical, byStructure };
}

function structureKeyFromLocation(structureLib, location) {
  const chain = String(
    structureLib.StructureProperties.chain.auth_asym_id(location)
    || structureLib.StructureProperties.chain.label_asym_id(location)
    || 'A',
  );
  const sequenceId = Number(
    structureLib.StructureProperties.residue.auth_seq_id(location)
    || structureLib.StructureProperties.residue.label_seq_id(location),
  );
  const insertionCode = String(structureLib.StructureProperties.residue.pdbx_PDB_ins_code?.(location) || '').trim();
  return structureResidueKey(chain, sequenceId, insertionCode);
}

function buildAtomLookup(structure) {
  const atomMap = new Map();
  for (const unit of structure?.units ?? []) {
    if (!unit.elements?.length) continue;
    const hierarchy = unit.model?.atomicHierarchy;
    const conformation = unit.conformation;
    if (!hierarchy?.atoms || !conformation || !hierarchy?.chains || !hierarchy?.chainAtomSegments) continue;
    for (const atomIndex of unit.elements) {
      const residueIndex = unit.residueIndex?.[atomIndex];
      if (residueIndex === undefined) continue;
      const chainIndex = hierarchy.chainAtomSegments.index[atomIndex];
      const chain = String(
        hierarchy.chains.auth_asym_id?.value(chainIndex)
        || hierarchy.chains.label_asym_id?.value(chainIndex)
        || '',
      );
      const residueNumber = Number(
        hierarchy.residues.auth_seq_id?.value(residueIndex)
        ?? hierarchy.residues.label_seq_id?.value(residueIndex),
      );
      if (!chain || !Number.isFinite(residueNumber)) continue;
      const insertionCode = String(hierarchy.residues.pdbx_PDB_ins_code?.value(residueIndex) || '').trim();
      const atomName = String(
        hierarchy.atoms.auth_atom_id?.value(atomIndex)
        || hierarchy.atoms.label_atom_id?.value(atomIndex)
        || '',
      ).trim().toUpperCase();
      const x = Number(conformation.x(atomIndex));
      const y = Number(conformation.y(atomIndex));
      const z = Number(conformation.z(atomIndex));
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
      const key = structureResidueKey(chain, residueNumber, insertionCode);
      if (atomName) atomMap.set(`${key}|${atomName}`, [x, y, z]);
    }
  }
  return { atomMap };
}

// Overlay arrows mark residues, not individual contact atoms. The published
// contact atoms usually belong to side chains, which are hidden by the cartoon
// representation; anchoring to Cα keeps every arrow on the rendered trace.
const OVERLAY_ANCHOR_ATOM = 'CA';

function atomPosition(atomMap, structureKey, atomName = OVERLAY_ANCHOR_ATOM) {
  if (!structureKey) return null;
  return atomMap.get(`${structureKey}|${String(atomName || OVERLAY_ANCHOR_ATOM).toUpperCase()}`)
    ?? atomMap.get(`${structureKey}|${OVERLAY_ANCHOR_ATOM}`)
    ?? null;
}

function arpeggioSelectionItems(selectedKey, contacts) {
  const keys = new Set();
  if (selectedKey) keys.add(selectedKey);
  for (const item of contacts ?? []) {
    if (item.toKey) keys.add(item.toKey);
  }
  const items = [];
  for (const key of keys) {
    const [chain, residueNumber, insertionCode] = String(key).split('|');
    const authSeqId = Number(residueNumber);
    if (!Number.isInteger(authSeqId)) continue;
    items.push({
      auth_asym_id: chain || 'A',
      auth_seq_id: authSeqId,
      ...(insertionCode ? { pdbx_PDB_ins_code: insertionCode } : {}),
    });
  }
  return items;
}

function overlayArrow(x1, y1, x2, y2, size) {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const baseX = x2 - Math.cos(angle) * size;
  const baseY = y2 - Math.sin(angle) * size;
  const perpendicularX = Math.cos(angle + Math.PI / 2) * size * 0.46;
  const perpendicularY = Math.sin(angle + Math.PI / 2) * size * 0.46;
  return [
    `${x2},${y2}`,
    `${baseX + perpendicularX},${baseY + perpendicularY}`,
    `${baseX - perpendicularX},${baseY - perpendicularY}`,
  ].join(' ');
}

function SequenceStrip({ rows, selectedPosition, metricLabel, onSelect }) {
  const trackRef = useRef(null);

  useEffect(() => {
    if (!Number.isInteger(selectedPosition)) return;
    trackRef.current?.querySelector(`[data-arpeggio-residue="${selectedPosition}"]`)?.scrollIntoView({
      behavior: 'smooth',
      block: 'nearest',
      inline: 'center',
    });
  }, [selectedPosition]);

  return (
    <div class="frustration-chain-card arpeggio-chain-card">
      <div class="frustration-sequence-scroll" role="group" aria-label="Secuencia canónica coloreada por contactos ARPEGGIO" tabIndex={0}>
        <div ref={trackRef} class="frustration-sequence-track arpeggio-sequence-track">
          {rows.map((row) => (
            <button
              key={row.position}
              type="button"
              class={[
                'frustration-sequence-residue',
                'arpeggio-sequence-residue',
                row.published ? 'is-published' : 'is-missing',
                row.selected ? 'is-selected' : '',
              ].filter(Boolean).join(' ')}
              style={row.published && row.color ? { '--arpeggio-color': row.color } : undefined}
              onClick={() => onSelect(row.position)}
              aria-pressed={row.selected}
              aria-label={`${row.aa}${row.position}, ${row.published ? `${formatArpeggioCount(row.value)} ${metricLabel.toLowerCase()}` : 'sin dato ARPEGGIO'}`}
              title={`${row.aa}${row.position} · ${row.published ? `${formatArpeggioCount(row.value)} ${metricLabel.toLowerCase()}` : 'Sin dato ARPEGGIO'}`}
              data-arpeggio-residue={row.position}
            >
              <span class="frustration-sequence-position">
                {row.position % 10 === 0 || row.selected ? row.position : ''}
              </span>
              <span>{row.aa}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function MetricSelect({ id, options, value, onChange }) {
  const rootRef = useRef(null);
  const triggerRef = useRef(null);
  const optionRefs = useRef([]);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(() => Math.max(0, options.findIndex((option) => option.value === value)));
  const selected = options.find((option) => option.value === value) ?? options[0];

  useEffect(() => {
    setActiveIndex(Math.max(0, options.findIndex((option) => option.value === value)));
  }, [options, value]);

  useEffect(() => {
    if (!open) return undefined;
    const handleOutside = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', handleOutside);
    return () => document.removeEventListener('pointerdown', handleOutside);
  }, [open]);

  useEffect(() => {
    if (open) optionRefs.current[activeIndex]?.focus();
  }, [activeIndex, open]);

  const openAt = (index) => {
    setActiveIndex(index);
    setOpen(true);
  };
  const choose = (option) => {
    onChange(option.value);
    setOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  };
  const handleTriggerKeyDown = (event) => {
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      setOpen(false);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
      openAt(event.key === 'ArrowUp' ? Math.max(0, selectedIndex - 1) : selectedIndex);
    }
  };
  const handleOptionKeyDown = (event, index) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      choose(options[index]);
      return;
    }
    const navigation = {
      ArrowDown: Math.min(options.length - 1, index + 1),
      ArrowUp: Math.max(0, index - 1),
      Home: 0,
      End: options.length - 1,
    };
    if (navigation[event.key] !== undefined) {
      event.preventDefault();
      setActiveIndex(navigation[event.key]);
    }
  };

  return (
    <div class="frustration-method-select" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        class="frustration-select-trigger arpeggio-metric-trigger"
        aria-label="Métrica de contactos"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${id}-options`}
        data-arpeggio-metric-trigger
        onClick={() => setOpen((current) => !current)}
        onKeyDown={handleTriggerKeyDown}
      >
        <span>{selected?.label ?? 'Métrica'}</span>
        <span aria-hidden="true">⌄</span>
      </button>
      {open && (
        <div id={`${id}-options`} class="frustration-select-options" role="listbox" aria-label="Métrica de contactos">
          {options.map((option, index) => (
            <button
              ref={(node) => { optionRefs.current[index] = node; }}
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              class={option.value === value ? 'is-selected' : ''}
              data-arpeggio-metric-option={option.value}
              onClick={() => choose(option)}
              onFocus={() => setActiveIndex(index)}
              onKeyDown={(event) => handleOptionKeyDown(event, index)}
            >
              <span>{option.label}</span>
              {option.value === value && <span aria-hidden="true">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ContactTypeSelect({ types, selectedTypes, onToggle, onSelectAll }) {
  const rootRef = useRef(null);
  const triggerRef = useRef(null);
  const rowRefs = useRef([]);
  const [open, setOpen] = useState(false);
  const allSelected = types.length > 0 && types.every((type) => selectedTypes.has(type));
  const label = allSelected
    ? 'Todos los contactos'
    : selectedTypes.size === 0
      ? 'Sin tipos'
      : `${selectedTypes.size} de ${types.length} tipos`;

  useEffect(() => {
    if (!open) return undefined;
    const handleOutside = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', handleOutside);
    return () => document.removeEventListener('pointerdown', handleOutside);
  }, [open]);

  const close = () => {
    setOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  };
  const handleRowKeyDown = (event, index, action) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      action();
      return;
    }
    const navigation = {
      ArrowDown: Math.min(types.length, index + 1),
      ArrowUp: Math.max(0, index - 1),
      Home: 0,
      End: types.length,
    };
    if (navigation[event.key] !== undefined) {
      event.preventDefault();
      rowRefs.current[navigation[event.key]]?.focus();
    }
  };

  const handleTriggerKeyDown = (event) => {
    if (event.key === 'Escape') {
      setOpen(false);
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    setOpen(true);
    const target = event.key === 'ArrowUp' ? types.length : 0;
    requestAnimationFrame(() => rowRefs.current[target]?.focus());
  };

  return (
    <div class="arpeggio-filter-select" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        class="frustration-select-trigger arpeggio-filter-trigger"
        aria-label="Tipos de contacto"
        aria-haspopup="menu"
        aria-expanded={open}
        data-arpeggio-contact-trigger
        onClick={() => setOpen((current) => !current)}
        onKeyDown={handleTriggerKeyDown}
      >
        <span>{label}</span>
        <span aria-hidden="true">{open ? '⌃' : '⌄'}</span>
      </button>
      {open && (
        <div class="arpeggio-checklist" role="menu" aria-label="Tipos de contacto">
          <button
            ref={(node) => { rowRefs.current[0] = node; }}
            type="button"
            role="menuitemcheckbox"
            aria-checked={allSelected}
            class={`arpeggio-check-row ${allSelected ? 'is-checked' : ''}`}
            onClick={() => onSelectAll(!allSelected)}
            onKeyDown={(event) => handleRowKeyDown(event, 0, () => onSelectAll(!allSelected))}
          >
            <span class={`arpeggio-check ${allSelected ? 'is-checked' : ''}`} aria-hidden="true">{allSelected ? '✓' : ''}</span>
            <span class="arpeggio-check-label">Todos los contactos</span>
          </button>
          {types.map((type, index) => {
            const checked = selectedTypes.has(type);
            const rowIndex = index + 1;
            return (
              <button
                ref={(node) => { rowRefs.current[rowIndex] = node; }}
                key={type}
                type="button"
                role="menuitemcheckbox"
                aria-checked={checked}
                class={`arpeggio-check-row ${checked ? 'is-checked' : ''}`}
                data-arpeggio-contact-type={type}
                onClick={() => onToggle(type)}
                onKeyDown={(event) => handleRowKeyDown(event, rowIndex, () => onToggle(type))}
              >
                <span class={`arpeggio-check ${checked ? 'is-checked' : ''}`} aria-hidden="true">{checked ? '✓' : ''}</span>
                <span class="arpeggio-check-swatch" style={{ '--contact-color': contactTypeColor(type) }} aria-hidden="true" />
                <span class="arpeggio-check-label">{contactTypeLabel(type)}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ArpeggioScale({ scale, selectedValue }) {
  const hasRange = scale.domain.max > 0 && !scale.allZero;
  const stops = scale.colors
    .map((color, index) => `${color} ${(index / Math.max(1, scale.colors.length - 1)) * 100}%`)
    .join(', ');
  const marker = hasRange && Number.isFinite(selectedValue)
    ? normalizeValue(selectedValue, scale.domain.min, scale.domain.max)
    : null;
  return (
    <div
      class="frustration-metric-scale arpeggio-scale"
      aria-label={`${scale.label}. ${scale.description}. ${scale.filteredEmpty ? '0 con el filtro actual.' : scale.publishedAllZero ? '0 publicados en esta corrida.' : `Escala observada de 0 a ${scale.domain.max}.`} ${scale.caveat}`}
    >
      {hasRange ? (
        <>
          <div class="arpeggio-scale-row">
            <span>{formatScaleNumber(scale.domain.min)}</span>
            <span class="arpeggio-scale-track">
              <span class="frustration-metric-scale-gradient" style={{ background: `linear-gradient(90deg, ${stops})` }} aria-hidden="true" />
              {marker !== null && <span class="arpeggio-scale-marker" style={{ left: `${marker * 100}%` }} aria-hidden="true" />}
            </span>
            <span>{formatScaleNumber(scale.domain.max)}</span>
          </div>
          <p><strong>{scale.label}</strong> · {scale.note} · sin umbrales publicados</p>
        </>
      ) : (
        <p>
          <strong>{scale.label}</strong> · {scale.filteredEmpty ? '0 con el filtro actual' : '0 publicados en esta corrida'} · sin umbrales publicados
        </p>
      )}
      <p class="arpeggio-scale-source">
        {scale.methodLabel} · <a href={scale.sourceUrl} target="_blank" rel="noreferrer">Fuente: {scale.sourceLabel}</a>
      </p>
    </div>
  );
}

function ArpeggioStructure({
  structureUrl,
  structurePending,
  structureError,
  structureFormatValue,
  structureLabel,
  selectedPosition,
  selectedLabel,
  selectedStructureKey,
  focusSelectionOnCamera,
  roleColorByKey,
  overlayContacts,
  mapping,
  onPick,
  scale,
  selectedValue,
}) {
  const hostRef = useRef(null);
  const viewerRef = useRef(null);
  const atomMapRef = useRef(new Map());
  const mappingRef = useRef(mapping);
  const onPickRef = useRef(onPick);
  const roleColorRef = useRef(roleColorByKey);
  const overlayContactsRef = useRef(overlayContacts);
  const selectedKeyRef = useRef(selectedStructureKey);
  const structureReadyRef = useRef(false);
  const updateOverlayRef = useRef(null);
  const overlaySignatureRef = useRef('');
  const themeRegistryRef = useRef(null);
  const themeFactoryRef = useRef(null);
  const themeProviderRef = useRef(null);
  const themeRevisionRef = useRef(0);
  const [viewerState, setViewerState] = useState(structureError ? 'error' : structureUrl || structurePending ? 'loading' : 'unavailable');
  const [viewerError, setViewerError] = useState(structureError ? 'No se pudo descargar la estructura molecular publicada.' : '');
  const [overlayItems, setOverlayItems] = useState([]);
  const [structureReady, setStructureReady] = useState(false);

  mappingRef.current = mapping;
  onPickRef.current = onPick;
  roleColorRef.current = roleColorByKey;
  overlayContactsRef.current = overlayContacts;
  selectedKeyRef.current = selectedStructureKey;

  useEffect(() => {
    if (!structureUrl) {
      setViewerState(structureError ? 'error' : structurePending ? 'loading' : 'unavailable');
    }
  }, [structurePending, structureError, structureUrl]);

  const applyTheme = async (viewer, theme) => {
    if (!viewer?.plugin || !theme) return;
    try {
      await viewer.plugin.dataTransaction(async () => {
        for (const entry of viewer.plugin.managers.structure.hierarchy.current.structures) {
          await viewer.plugin.managers.structure.component.updateRepresentationsTheme(entry.components, { color: theme });
        }
      });
      viewer.plugin.canvas3d?.requestDraw?.();
    } catch {
      // The structure remains readable with the last valid theme.
    }
  };

  const createThemeProvider = (name) => {
    const baseFactory = themeFactoryRef.current;
    if (!baseFactory) return null;
    let themedFactory;
    themedFactory = (ctx, props) => ({
      ...baseFactory(ctx, props),
      // Mol* compares themes by factory identity. A fresh wrapper forces the
      // representation update when selection or filters change.
      factory: themedFactory,
    });
    return {
      name,
      label: 'Contactos ARPEGGIO',
      category: 'Residue display',
      factory: themedFactory,
      getParams: () => ({}),
      defaultValues: {},
      isApplicable: () => true,
    };
  };

  const installTheme = async () => {
    const viewer = viewerRef.current;
    const registry = themeRegistryRef.current;
    if (!viewer?.plugin || !registry || !themeFactoryRef.current) return;
    themeRevisionRef.current += 1;
    const themeName = `arpeggio-contacts-${themeRevisionRef.current}`;
    const provider = createThemeProvider(themeName);
    if (!provider) return;
    const previous = themeProviderRef.current;
    try {
      registry.add(provider);
      themeProviderRef.current = provider;
      await applyTheme(viewer, themeName);
      if (previous && themeProviderRef.current === provider) {
        try {
          registry.remove(previous);
        } catch {
          // A disposed viewer may already have released its theme registry.
        }
      }
    } catch {
      // Keep the last valid theme while the viewer is being replaced.
    }
  };

  useEffect(() => {
    if (structureReady) void installTheme();
  }, [roleColorByKey, structureReady]);

  useEffect(() => {
    setViewerState(structureError ? 'error' : structurePending || structureUrl ? 'loading' : 'unavailable');
    setViewerError(structureError ? 'No se pudo descargar la estructura molecular publicada.' : '');
    setStructureReady(false);
    structureReadyRef.current = false;
    setOverlayItems([]);
    overlaySignatureRef.current = '';
    if (!structureUrl || !hostRef.current) return undefined;

    let disposed = false;
    const renderController = new AbortController();
    let viewerInstance = null;
    let clickSubscription = null;
    let cameraSubscription = null;
    let resizeObserver = null;
    let resizeListener = null;
    let overlayFrame = null;

    const updateOverlay = () => {
      const viewer = viewerRef.current;
      const host = hostRef.current;
      const camera = viewer?.plugin?.canvas3d?.camera;
      if (disposed || !viewer || !host || !camera || !structureReadyRef.current) {
        setOverlayItems([]);
        overlaySignatureRef.current = '';
        return;
      }
      const items = overlayContactsRef.current ?? [];
      if (!items.length) {
        setOverlayItems([]);
        overlaySignatureRef.current = '';
        return;
      }
      const viewport = camera.viewport;
      if (!viewport?.width || !viewport?.height) return;
      const scaleX = host.clientWidth / viewport.width;
      const scaleY = host.clientHeight / viewport.height;
      const projected = [0, 0, 0, 0];
      const next = [];
      for (const item of items) {
        const from = atomPosition(atomMapRef.current, item.fromKey);
        const to = atomPosition(atomMapRef.current, item.toKey);
        if (!from || !to) continue;
        camera.project(projected, from);
        if (!(projected[3] > 0)) continue;
        const x1 = projected[0] * scaleX;
        const y1 = host.clientHeight - projected[1] * scaleY;
        camera.project(projected, to);
        if (!(projected[3] > 0)) continue;
        const x2 = projected[0] * scaleX;
        const y2 = host.clientHeight - projected[1] * scaleY;
        if (!Number.isFinite(x1) || !Number.isFinite(y1) || !Number.isFinite(x2) || !Number.isFinite(y2)) continue;
        if (Math.hypot(x2 - x1, y2 - y1) < 2) continue;
        next.push({
          id: `${item.position}-${item.type}`,
          type: item.type,
          label: item.label,
          color: item.color,
          x1,
          y1,
          x2,
          y2,
          arrow: overlayArrow(x1, y1, x2, y2, 7),
        });
      }

      placeArpeggioOverlayLabels(next, { width: host.clientWidth, height: host.clientHeight });
      const signature = next.map((item) => `${item.id}:${item.x1.toFixed(1)}:${item.y1.toFixed(1)}:${item.x2.toFixed(1)}:${item.y2.toFixed(1)}:${item.labelX.toFixed(1)}:${item.labelY.toFixed(1)}`).join('|');
      if (signature === overlaySignatureRef.current) return;
      overlaySignatureRef.current = signature;
      setOverlayItems(next);
    };
    updateOverlayRef.current = updateOverlay;

    const scheduleOverlay = () => {
      if (overlayFrame !== null) return;
      overlayFrame = requestAnimationFrame(() => {
        overlayFrame = null;
        updateOverlay();
      });
    };

    const disposeViewer = () => {
      if (cameraSubscription) {
        try { cameraSubscription.unsubscribe(); } catch { /* already released */ }
      }
      if (clickSubscription) {
        try { clickSubscription.unsubscribe(); } catch { /* already released */ }
      }
      if (resizeObserver) resizeObserver.disconnect();
      if (resizeListener) window.removeEventListener('resize', resizeListener);
      if (overlayFrame !== null) {
        cancelAnimationFrame(overlayFrame);
        overlayFrame = null;
      }
      try { viewerInstance?.dispose?.(); } catch { /* Mol* already released WebGL */ }
      if (viewerRef.current === viewerInstance) viewerRef.current = null;
      viewerInstance = null;
      updateOverlayRef.current = null;
      setOverlayItems([]);
      overlaySignatureRef.current = '';
      setStructureReady(false);
      structureReadyRef.current = false;
      setViewerState(structureUrl ? 'loading' : 'unavailable');
    };

    async function loadViewer() {
      try {
        const [{ Viewer }, structureLib] = await Promise.all([
          import('molstar/lib/apps/viewer/app'),
          import('molstar/lib/mol-model/structure'),
        ]);
        if (disposed || !hostRef.current) return;
        const viewer = await Viewer.create(hostRef.current, {
          layoutIsExpanded: false,
          layoutShowControls: false,
          layoutShowRemoteState: false,
          layoutShowSequence: false,
          layoutShowLog: false,
          layoutShowLeftPanel: false,
          viewportShowExpand: false,
          viewportShowSelectionMode: false,
          viewportShowAnimation: false,
          viewportBackgroundColor: '#f7f9f8',
          pixelScale: 1,
          resolutionMode: 'auto',
        });
        viewerInstance = viewer;
        viewerRef.current = viewer;
        if (disposed) return disposeViewer();
        viewer.plugin.canvas3d?.setProps({
          ...getZoomOptimizedCanvas3dProps(),
          interaction: { maxFps: 60 },
          camera: { helper: { axes: { name: 'off', params: {} } } },
          cameraResetDurationMs: CAMERA_RESET_DURATION_MS,
          cameraResetEasing: 'cubic-out',
          cameraResetTrajectory: 'linear',
        });
        await viewer.loadStructureFromUrl(structureUrl, structureFormatValue, false, { label: structureLabel });
        if (disposed) return disposeViewer();

        const structure = viewer.plugin.managers.structure.hierarchy.current.structures[0]?.cell?.obj?.data;
        const lookup = buildAtomLookup(structure);
        atomMapRef.current = lookup.atomMap;

        const registry = viewer.plugin.representation.structure.themes.colorThemeRegistry;
        const factory = (ctx, props) => ({
          granularity: 'group',
          props,
          description: 'Contactos ARPEGGIO por residuo',
          color: (location) => {
            try {
              if (!structureLib.StructureElement.Location.is(location)) return hexToColorInt(ARPEGGIO_ROLE_COLORS.context);
              return hexToColorInt(
                roleColorRef.current.get(structureKeyFromLocation(structureLib, location))
                ?? ARPEGGIO_ROLE_COLORS.context,
              );
            } catch {
              return hexToColorInt(ARPEGGIO_ROLE_COLORS.context);
            }
          },
        });
        themeRegistryRef.current = registry;
        themeFactoryRef.current = factory;

        const canvas3d = viewer.plugin.canvas3d;
        const boundingSphere = canvas3d?.boundingSphereVisible ?? canvas3d?.boundingSphere;
        canvas3d?.requestResize?.();
        if (canvas3d?.camera && boundingSphere?.radius > 0) {
          canvas3d.camera.focus(boundingSphere.center, boundingSphere.radius * 0.8, 180);
        }

        clickSubscription = viewer.subscribe(viewer.plugin.behaviors.interaction.click, (event) => {
          const loci = event?.current?.loci;
          if (!structureLib.StructureElement.Loci.is(loci)) return;
          let position = null;
          structureLib.StructureElement.Loci.forEachLocation(loci, (location) => {
            if (position !== null) return;
            position = mappingRef.current.byStructure.get(structureKeyFromLocation(structureLib, location)) ?? null;
          });
          if (position === null) return;
          try {
            viewer.plugin.managers.interactivity.lociSelects.deselectAll();
          } catch {
            // Selection is an enhancement.
          }
          onPickRef.current(position);
        });
        cameraSubscription = canvas3d?.camera?.changed?.subscribe(scheduleOverlay) ?? null;
        resizeObserver = typeof ResizeObserver !== 'undefined'
          ? new ResizeObserver(scheduleOverlay)
          : null;
        resizeObserver?.observe(hostRef.current);
        resizeListener = scheduleOverlay;
        window.addEventListener('resize', resizeListener);

        await installTheme();
        await waitForCanvasDraw(canvas3d, { signal: renderController.signal });
        if (disposed) return;
        structureReadyRef.current = true;
        setStructureReady(true);
        installTheme();
        setViewerState('ready');
        scheduleOverlay();
      } catch (error) {
        console.error(error);
        if (!disposed) {
          setViewerError('No se pudo interpretar la estructura molecular publicada.');
          setViewerState('error');
          setStructureReady(false);
          structureReadyRef.current = false;
        }
      }
    }

    void loadViewer();
    return () => {
      disposed = true;
      renderController.abort();
      disposeViewer();
      themeProviderRef.current = null;
      themeRegistryRef.current = null;
      themeFactoryRef.current = null;
    };
  }, [structureUrl, structureFormatValue, structureLabel]);

  useEffect(() => {
    updateOverlayRef.current?.();
  }, [overlayContacts, selectedPosition]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || viewerState !== 'ready') return undefined;
    if (!Number.isInteger(selectedPosition)) {
      try {
        viewer.plugin.managers.interactivity.lociSelects.deselectAll();
        viewer.plugin.managers.camera.reset?.(undefined, CAMERA_RESET_DURATION_MS, CAMERA_RESET_OPTIONS);
      } catch {
        // Resetting the camera is an enhancement.
      }
      return undefined;
    }
    const items = arpeggioSelectionItems(selectedStructureKey, overlayContactsRef.current);
    if (!items.length) return undefined;
    const timer = window.setTimeout(() => {
      try {
        viewer.plugin.managers.interactivity.lociSelects.deselectAll();
        viewer.structureInteractivity({
          elements: { items },
          action: focusSelectionOnCamera ? ['focus'] : ['select'],
          ...(focusSelectionOnCamera ? { focusOptions: FOCUS_OPTIONS } : {}),
        });
      } catch {
        // Selection/focus is an enhancement; the overlay remains usable.
      }
    }, 80);
    return () => window.clearTimeout(timer);
  }, [focusSelectionOnCamera, selectedPosition, selectedStructureKey, overlayContacts, viewerState]);

  return (
    <div class="frustration-structure-viewport arpeggio-structure-viewport" role="group" aria-label="Estructura molecular ARPEGGIO">
      <div ref={hostRef} class="frustration-molstar-host" role="img" aria-label="Estructura molecular de referencia coloreada por contactos ARPEGGIO" />
      <svg class="arpeggio-contact-overlay" aria-hidden="true">
        {overlayItems.map((item) => (
          <g key={item.id}>
            <line
              x1={item.x1}
              y1={item.y1}
              x2={item.x2}
              y2={item.y2}
              stroke={item.color}
              strokeWidth="1.6"
              strokeDasharray="5 4"
              strokeLinecap="round"
            />
            <polygon points={item.arrow} fill={item.color} />
            <text
              x={item.labelX}
              y={item.labelY}
              text-anchor={item.textAnchor}
              dominant-baseline="middle"
              class="arpeggio-contact-label"
              style={{ '--contact-color': item.color }}
            >
              {item.label}
            </text>
          </g>
        ))}
      </svg>
      <ArpeggioScale scale={scale} selectedValue={selectedValue} />
      {viewerState === 'loading' && (
        <StatePanel kind="loading" compact title="Cargando estructura" description="Preparando el modelo molecular publicado." className="frustration-viewport-state" />
      )}
      {viewerState === 'unavailable' && (
        <StatePanel kind="empty" compact icon="box" title="Estructura no disponible" description="No hay una estructura de referencia publicada para esta corrida." className="frustration-viewport-state" />
      )}
      {viewerState === 'error' && (
        <StatePanel kind="error" compact title="No se pudo cargar la estructura" description={viewerError} className="frustration-viewport-state" />
      )}
      {Number.isInteger(selectedPosition) && structureUrl && viewerState === 'ready' && (
        <div class="frustration-structure-selection" aria-live="polite">
          <strong>{selectedLabel}</strong>
          <span>Residuo seleccionado</span>
        </div>
      )}
    </div>
  );
}

function EvidenceRow({ label, value, swatch = '' }) {
  return (
    <div class="frustration-evidence-row">
      <dt>{label}</dt>
      <dd>{swatch && <span class="frustration-evidence-swatch" style={{ '--swatch-color': swatch }} aria-hidden="true" />}{value}</dd>
    </div>
  );
}

function AnnotationPanel({
  model,
  sequence,
  selectedTypes,
  onToggleType,
  onSelectAllTypes,
  onSelectPartner,
  coverageTruncated,
}) {
  const selected = model.selected;
  const hasSelection = Boolean(selected);
  const hasPublished = Boolean(selected?.published);
  const detailAvailable = Boolean(selected?.detailAvailable);
  const hasContactData = detailAvailable && (selected?.totalContacts ?? 0) > 0;
  const partners = model.partners;
  const publishedTypes = selected?.types ?? [];
  const noTypesSelected = selectedTypes.size === 0;
  const hasPublishedCounts = hasPublished && [selected.totalContacts, selected.partnerCount, selected.clashPartnerCount]
    .some((value) => Number.isFinite(value));

  return (
    <aside class="frustration-annotations arpeggio-annotations" aria-label="Anotaciones ARPEGGIO">
      <div class="frustration-annotations-body">
        <section class="frustration-residue-summary arpeggio-residue-summary" aria-label="Residuo seleccionado">
          <div class="frustration-residue-letter">{selected?.one ?? '—'}</div>
          <div class="frustration-residue-name" style={hasSelection ? { '--residue-color': 'var(--ink)' } : undefined}>
            <strong>{hasSelection ? (selected.code ? `${selected.code} - ${selected.name}` : selected.name) : 'Selecciona un residuo'}</strong>
            <span class="arpeggio-residue-metric-line">
              {hasSelection ? (
                <>
                  {selected.color && <i class="arpeggio-metric-swatch" style={{ '--metric-color': selected.color }} aria-hidden="true" />}
                  <span>{selected.value === null ? 'Sin dato ARPEGGIO' : `${formatArpeggioCount(selected.value)} ${model.metric.shortLabel.toLowerCase()}`}</span>
                </>
              ) : 'Haz clic en la secuencia o en la estructura'}
            </span>
          </div>
          <strong class="frustration-residue-position">{hasSelection ? selected.position : '—'}</strong>
        </section>

        {coverageTruncated && (
          <p class="frustration-live-message arpeggio-coverage-message" role="status">
            La cobertura de anotaciones es parcial; las posiciones sin resultado se mantienen sin dato.
          </p>
        )}

        {!hasSelection && (
          <section class="frustration-values">
            <h3>Contactos ARPEGGIO</h3>
            <p class="frustration-no-data">Selecciona un residuo para consultar sus contactos publicados.</p>
          </section>
        )}

        {hasSelection && (
          <>
            <section class="frustration-values" aria-label="Resumen publicado del residuo">
              <h3>Resumen publicado</h3>
              {hasPublishedCounts ? (
                <dl class="frustration-evidence-list">
                  {Number.isFinite(selected.totalContacts) && <EvidenceRow label="Contactos" value={formatArpeggioCount(selected.totalContacts)} />}
                  {Number.isFinite(selected.partnerCount) && <EvidenceRow label="Residuos asociados" value={formatArpeggioCount(selected.partnerCount)} />}
                  {Number.isFinite(selected.clashPartnerCount) && <EvidenceRow label="Choques de van der Waals" value={formatArpeggioCount(selected.clashPartnerCount)} />}
                  {!detailAvailable && publishedTypes.length > 0 && (
                    <EvidenceRow label="Tipos publicados" value={publishedTypes.map((type) => contactTypeShortLabel(type)).join(' · ')} />
                  )}
                </dl>
              ) : (
                <p class="frustration-no-data">No hay valores ARPEGGIO publicados para este residuo.</p>
              )}
              {Number.isFinite(selected.totalContacts) && (
                <p class="arpeggio-caption">Un contacto es un par residuo–socio con al menos un tipo publicado; cada tipo cuenta una vez. Los pares que solo cumplen la distancia de búsqueda no se cuentan.</p>
              )}
              {Number.isFinite(selected.clashPartnerCount) && selected.clashPartnerCount > 0 && (
                <p class="arpeggio-caption">Los choques de van der Waals son solapamientos estéricos y no se suman a los contactos.</p>
              )}
            </section>

            {hasContactData && (
              <>
                <section class="arpeggio-filter-section" aria-label="Filtro por tipo de contacto">
                  <h3>Filtrar por tipo de contacto</h3>
                  <ContactTypeSelect
                    types={model.observedTypes}
                    selectedTypes={selectedTypes}
                    onToggle={onToggleType}
                    onSelectAll={onSelectAllTypes}
                  />
                </section>

                <section class="arpeggio-partner-section" aria-label="Residuos en contacto">
                  <div class="arpeggio-section-head">
                    <h3>Residuos en contacto</h3>
                    <span>{formatArpeggioCount(partners.length)}</span>
                  </div>
                  {partners.length > 0 ? (
                    <div class="arpeggio-partner-list">
                      <div class="arpeggio-partner-head" aria-hidden="true">
                        <span>Residuo</span>
                        <span>Tipos de contacto</span>
                        <span>Distancia</span>
                      </div>
                      {partners.map((partner) => {
                        const info = residueInfo(sequence, partner.position);
                        return (
                          <button
                            key={partner.position}
                            type="button"
                            class="arpeggio-partner-row"
                            onClick={() => onSelectPartner(partner.position)}
                            aria-label={`${info.label}, ${partner.types.map(contactTypeLabel).join(', ')}, distancia mínima ${formatArpeggioDistance(partner.minDistance)}`}
                          >
                            <span class="arpeggio-partner-name">
                              <strong>{info.label}</strong>
                              <small>{info.name}</small>
                            </span>
                            <span class="arpeggio-partner-types">
                              {partner.types.map((type) => (
                                <span key={type} class="arpeggio-type-chip">
                                  <i style={{ '--contact-color': contactTypeColor(type) }} aria-hidden="true" />
                                  {contactTypeShortLabel(type)}
                                </span>
                              ))}
                            </span>
                            <b class="arpeggio-partner-distance">{formatArpeggioDistance(partner.minDistance)}</b>
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <p class="frustration-no-data">
                      {noTypesSelected
                        ? 'Ningún tipo de contacto seleccionado.'
                        : selected.totalContacts === 0
                          ? 'Este residuo no tiene contactos publicados.'
                          : 'Ningún residuo cumple el filtro de tipos seleccionado.'}
                    </p>
                  )}
                </section>
              </>
            )}

            {!detailAvailable && hasPublishedCounts && (selected.totalContacts ?? 0) > 0 && (
              <p class="arpeggio-detail-unavailable">El detalle por pareja no está disponible para este residuo.</p>
            )}
          </>
        )}

        <p class="arpeggio-panel-caveat">{ARPEGGIO_CAVEAT}</p>
      </div>
    </aside>
  );
}

/** @param {{ proteinId: string | undefined }} props */
export default function ArpeggioView({ proteinId }) {
  const runId = typeof window === 'undefined' ? '' : new URLSearchParams(window.location.search).get('run') ?? '';
  const [protein, setProtein] = useState(null);
  const [run, setRun] = useState(null);
  const [annotations, setAnnotations] = useState([]);
  const [annotationsTruncated, setAnnotationsTruncated] = useState(false);
  const [artifactDetails, setArtifactDetails] = useState({});
  const [structureUrl, setStructureUrl] = useState('');
  const [structureLoadState, setStructureLoadState] = useState('idle');
  const [state, setState] = useState('loading');
  const [error, setError] = useState('');
  const [selectedPosition, setSelectedPosition] = useState(null);
  const [focusSelectionOnCamera, setFocusSelectionOnCamera] = useState(false);
  const [selectedTypes, setSelectedTypes] = useState(null);
  const [metric, setMetric] = useState('contacts');
  const selectionInitializedRef = useRef(false);
  const latestRunRef = useRef(null);

  useEffect(() => {
    let active = true;
    async function load() {
      if (!runId) {
        setState('no-run');
        return;
      }
      try {
        const [proteinData, runData, annotationData] = await Promise.all([
          getProtein(proteinId),
          getRun(runId),
          getAllAnnotations(runId),
        ]);
        if (!runBelongsToProtein(runData, proteinData.id)) {
          if (active) {
            setState('error');
            setError('La corrida seleccionada no corresponde a esta proteína.');
          }
          return;
        }
        const details = await loadAnalysisArtifactDetails(runData, 'contacts', getArtifactBlob);
        if (!active) return;
        latestRunRef.current = runData;
        setProtein(proteinData);
        setRun(runData);
        setAnnotations((annotationData.rows ?? []).filter((row) => row.stage_id === 'structural_contacts'));
        setAnnotationsTruncated(Boolean(annotationData.truncated));
        setArtifactDetails(details);
        setState('ready');
      } catch (requestError) {
        if (!active) return;
        setState('error');
        setError(userErrorMessage(requestError, 'No se pudo cargar la vista ARPEGGIO.'));
      }
    }
    void load();
    return () => { active = false; };
  }, [proteinId, runId]);

  useEffect(() => {
    if (!runId || !run?.external_tracking?.tracking_active) return undefined;
    let active = true;
    let refreshing = false;

    const refresh = async () => {
      if (refreshing || document.visibilityState !== 'visible') return;
      refreshing = true;
      try {
        const nextRun = await getRun(runId);
        if (!active) return;
        const contactsChanged = runStagePublicationSignature(
          latestRunRef.current,
          ['structural_contacts'],
        ) !== runStagePublicationSignature(nextRun, ['structural_contacts']);
        latestRunRef.current = nextRun;
        setRun(nextRun);
        if (!contactsChanged) return;

        const [annotationData, details] = await Promise.all([
          getAllAnnotations(runId),
          loadAnalysisArtifactDetails(nextRun, 'contacts', getArtifactBlob),
        ]);
        if (!active) return;
        setAnnotations((annotationData.rows ?? []).filter((row) => row.stage_id === 'structural_contacts'));
        setAnnotationsTruncated(Boolean(annotationData.truncated));
        setArtifactDetails(details);
      } catch {
        // Keep the last confirmed contacts while MN5 or the local API is unavailable.
      } finally {
        refreshing = false;
      }
    };

    const timer = window.setInterval(() => { void refresh(); }, 5000);
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [proteinId, runId, run?.external_tracking?.tracking_active]);

  const annotationByPosition = useMemo(() => mergeAnnotationRows(annotations), [annotations]);
  const summaryRows = useMemo(
    () => buildArpeggioSummaryRows({
      summaryRecords: artifactDetails.contact_residue_summary ?? [],
      annotationByPosition,
    }),
    [annotationByPosition, artifactDetails.contact_residue_summary],
  );
  const contactRows = useMemo(() => normalizeContactRows(artifactDetails.contacts_long ?? []), [artifactDetails.contacts_long]);
  const observedTypes = useMemo(() => observedContactTypes(summaryRows, contactRows), [contactRows, summaryRows]);
  const contactAggregates = useMemo(() => {
    const all = aggregateContactRows(contactRows);
    return {
      all,
      filtered: selectedTypes === null ? all : aggregateContactRows(contactRows, selectedTypes),
    };
  }, [contactRows, selectedTypes]);
  const provenance = artifactDetails.provenance?.[0] ?? null;
  const availableMetricOptions = useMemo(() => {
    const rows = [...summaryRows.values()];
    return ARPEGGIO_METRIC_OPTIONS.filter((option) => (option.value === 'contacts'
      ? rows.some((row) => row.published && row.totalContacts !== null)
      : rows.some((row) => row.published && row.partnerCount !== null)));
  }, [summaryRows]);
  const model = useMemo(() => buildArpeggioModel({
    summaryRows,
    contactRows,
    allDetailByPosition: contactAggregates.all,
    filteredDetailByPosition: contactAggregates.filtered,
    knownObservedTypes: observedTypes,
    sequence: protein?.sequence,
    metric,
    selectedTypes,
    selectedPosition,
    provenance,
  }), [contactAggregates, contactRows, metric, observedTypes, protein?.sequence, provenance, selectedPosition, selectedTypes, summaryRows]);

  const structureRequest = useMemo(
    () => structureSourceForArpeggio(run, provenance),
    [provenance, run],
  );
  const fallbackMapping = useMemo(() => {
    const byCanonical = new Map();
    const byStructure = new Map();
    for (const row of summaryRows.values()) {
      if (!row.structureKey || byCanonical.has(row.position)) continue;
      byCanonical.set(row.position, row.structureKey);
      if (!byStructure.has(row.structureKey)) byStructure.set(row.structureKey, row.position);
    }
    for (const row of contactRows) {
      for (const [position, key] of [[row.position1, row.key1], [row.position2, row.key2]]) {
        if (!key || byCanonical.has(position)) continue;
        byCanonical.set(position, key);
        if (!byStructure.has(key)) byStructure.set(key, position);
      }
    }
    return { byCanonical, byStructure };
  }, [contactRows, summaryRows]);
  const mapping = useMemo(() => {
    const configured = structureMappingMaps(structureMappingFromArtifactRows(
      run?.configuration?.structure_mapping,
      artifactDetails?.structure_mapping,
    ));
    for (const [position, key] of fallbackMapping.byCanonical) {
      if (!configured.byCanonical.has(position)) configured.byCanonical.set(position, key);
    }
    for (const [key, position] of fallbackMapping.byStructure) {
      if (!configured.byStructure.has(key)) configured.byStructure.set(key, position);
    }
    return configured;
  }, [artifactDetails?.structure_mapping, fallbackMapping, run?.configuration?.structure_mapping]);
  const selectedStructureKey = selectedPosition === null
    ? ''
    : mapping.byCanonical.get(selectedPosition) ?? model.selected?.structureKey ?? '';
  const partnerRoleColor = metric === 'partners' ? '#c2410c' : ARPEGGIO_ROLE_COLORS.partner;
  const roleColorByKey = useMemo(() => buildArpeggioRoleColors({
    referenceMatched: Boolean(structureRequest?.referenceMatched),
    selectedStructureKey,
    selectedColor: model.selected?.color ?? null,
    selectedPublished: Boolean(model.selected?.published),
    partners: model.partners,
    partnerColor: partnerRoleColor,
  }), [model.partners, model.selected?.color, model.selected?.published, partnerRoleColor, selectedStructureKey, structureRequest?.referenceMatched]);
  const overlayContacts = useMemo(
    () => (structureRequest?.referenceMatched ? model.overlayContacts : []),
    [model.overlayContacts, structureRequest?.referenceMatched],
  );

  useEffect(() => {
    let active = true;
    setStructureUrl('');
    setStructureLoadState(structureRequest ? 'loading' : 'unavailable');
    if (!structureRequest) return () => { active = false; };
    const lease = acquireStructureUrl(structureRequest.id, structureRequest.loadUrl);
    lease.promise.then((url) => {
      if (active) {
        setStructureUrl(url);
        setStructureLoadState('ready');
      }
    }).catch(() => {
      if (active) setStructureLoadState('error');
    });
    return () => {
      active = false;
      lease.release();
    };
  }, [structureRequest?.id]);

  useEffect(() => {
    selectionInitializedRef.current = false;
    setFocusSelectionOnCamera(false);
    setSelectedPosition(null);
    setSelectedTypes(null);
    setMetric('contacts');
  }, [proteinId, runId]);

  useEffect(() => {
    if (!availableMetricOptions.length) return;
    if (availableMetricOptions.some((option) => option.value === metric)) return;
    setMetric(availableMetricOptions[0].value);
  }, [availableMetricOptions, metric]);

  useEffect(() => {
    if (selectionInitializedRef.current || selectedPosition !== null) return;
    if (!model.hasPublishedRows || model.autoSelectPosition === null) return;
    selectionInitializedRef.current = true;
    setSelectedPosition(model.autoSelectPosition);
  }, [model.autoSelectPosition, model.hasPublishedRows, selectedPosition]);

  const selectPosition = (position) => {
    setFocusSelectionOnCamera(true);
    setSelectedPosition(position);
  };

  const toggleSelectedPosition = (position) => {
    setFocusSelectionOnCamera(true);
    setSelectedPosition((current) => (current === position ? null : position));
  };

  const toggleType = (type) => {
    setSelectedTypes((current) => {
      const base = new Set(current ?? model.observedTypes);
      if (base.has(type)) base.delete(type);
      else base.add(type);
      return new Set([...base].filter((candidate) => model.observedTypes.includes(candidate)));
    });
  };

  const selectAllTypes = (checked) => {
    setSelectedTypes(checked ? new Set(model.observedTypes) : new Set());
  };

  if (state === 'loading') {
    return <section class="frustration-page"><StatePanel kind="loading" fill title="Cargando ARPEGGIO" description="Consultando la corrida y los contactos publicados." /></section>;
  }
  if (state === 'no-run') {
    return <section class="frustration-page"><StatePanel kind="empty" fill icon="workflow" title="No hay una corrida seleccionada" description="Selecciona una corrida desde el historial o la vista de progreso para consultar ARPEGGIO."><a class="protein-open" href="/proteins/">Mis proteínas</a></StatePanel></section>;
  }
  if (state === 'error') {
    return <section class="frustration-page"><StatePanel kind="error" fill title="No se pudo cargar ARPEGGIO" description={error} /></section>;
  }

  const contactsStage = run?.stages?.find((stage) => stage.id === 'structural_contacts') ?? null;
  const contactsStageStatus = contactsStage?.status ?? 'missing';
  const contactPublicationPending = run?.external_tracking?.tracking_active
    && run.external_tracking.connection_status === 'connected'
    && run.external_tracking.sync_error_code === 'result_publication_pending'
    && ['success', 'reused'].includes(contactsStageStatus);
  if (!model.hasPublishedRows) {
    if (contactsStageStatus === 'failed') {
      return (
        <section class="frustration-page">
          <StatePanel kind="error" fill title="No se pudo publicar ARPEGGIO" description="La etapa de contactos estructurales falló en esta corrida; no hay resultados publicados." />
        </section>
      );
    }
    if (['pending', 'ready', 'queued', 'running'].includes(contactsStageStatus)) {
      return (
        <section class="frustration-page">
          <StatePanel kind="waiting" fill title="ARPEGGIO aún no está disponible" description="La etapa de contactos estructurales todavía está en ejecución." />
        </section>
      );
    }
    if (contactPublicationPending) {
      return (
        <section class="frustration-page">
          <StatePanel
            kind="loading"
            fill
            title="Cargando resultados"
            description="Consultando los resultados publicados de contactos estructurales."
          />
        </section>
      );
    }
    return (
      <section class="frustration-page">
        <StatePanel
          kind="empty"
          fill
          icon="network"
          title="ARPEGGIO no está disponible"
          description={contactsStageStatus === 'missing'
            ? 'La etapa de contactos estructurales no forma parte de esta corrida.'
            : 'La etapa de contactos estructurales no se ejecutó o no publicó filas para esta corrida.'}
        />
      </section>
    );
  }

  const selectedLabel = selectedPosition === null ? '—' : residueInfo(protein?.sequence, selectedPosition).label;
  const coverageTruncated = annotationsTruncated && !(artifactDetails.contact_residue_summary?.length);

  return (
    <section class="frustration-page arpeggio-page" aria-label="ARPEGGIO">
      <SequenceStrip
        rows={model.sequenceRows}
        selectedPosition={selectedPosition}
        metricLabel={model.metric.label}
        onSelect={toggleSelectedPosition}
      />

      <div class="frustration-workspace arpeggio-workspace">
        <article class="frustration-method-card arpeggio-method-card">
          <header class="frustration-method-head arpeggio-method-head">
            <h2>Contactos del residuo</h2>
            <MetricSelect
              id="arpeggio-metric"
              options={availableMetricOptions}
              value={metric}
              onChange={setMetric}
            />
          </header>
          <ArpeggioStructure
            structureUrl={structureUrl}
            structurePending={structureLoadState === 'loading'}
            structureError={structureLoadState === 'error'}
            structureFormatValue={structureRequest?.format}
            structureLabel={structureRequest?.label}
            selectedPosition={selectedPosition}
            selectedLabel={selectedLabel}
            selectedStructureKey={selectedStructureKey}
            focusSelectionOnCamera={focusSelectionOnCamera}
            roleColorByKey={roleColorByKey}
            overlayContacts={overlayContacts}
            mapping={mapping}
            onPick={toggleSelectedPosition}
            scale={model.scale}
            selectedValue={model.selected?.value ?? null}
          />
        </article>
        <AnnotationPanel
          model={model}
          sequence={protein?.sequence}
          selectedTypes={model.selectedTypes}
          onToggleType={toggleType}
          onSelectAllTypes={selectAllTypes}
          onSelectPartner={selectPosition}
          coverageTruncated={coverageTruncated}
        />
      </div>
    </section>
  );
}
