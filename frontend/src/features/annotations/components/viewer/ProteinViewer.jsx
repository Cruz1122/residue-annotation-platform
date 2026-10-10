import { memo } from 'preact/compat';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import LucideIcon from '@shared/components/icons/LucideIcon.jsx';
import { AA_NAMES, RESIDUES } from '@features/proteins/data/protein.js';
import { MODE_INFO, mockAnnotations, modeColor, readableValue } from '@features/annotations/data/viewer.js';
import { OrderedSet } from 'molstar/lib/mol-data/int';
import 'molstar/build/viewer/molstar.css';
import '@features/annotations/styles/viewer.css';

const MODE_COLORS = Object.fromEntries(
  Object.keys(MODE_INFO).map((mode) => [
    mode,
    RESIDUES.map((residue, index) => modeColor(index, mode, residue)),
  ]),
);

const MODE_COLOR_VALUES = Object.fromEntries(
  Object.entries(MODE_COLORS).map(([mode, colors]) => [
    mode,
    colors.map((color) => Number.parseInt(color.slice(1), 16)),
  ]),
);

const RESIDUE_FOCUS_OPTIONS = {
  extraRadius: 4,
  durationMs: 180,
  easing: 'cubic-out',
  trajectory: 'linear',
};
const CAMERA_RESET_DURATION_MS = 180;

function buildResidueLociCache(structure, structureLib) {
  const residueLoci = new Map();
  const { Loci } = structureLib.StructureElement;

  for (const unit of structure.units) {
    if (!unit.residueIndex || !unit.elements?.length) continue;
    const atomicHierarchy = unit.model.atomicHierarchy;
    if (!atomicHierarchy?.residues || !atomicHierarchy?.chains) continue;

    const { auth_seq_id: authSeqId } = atomicHierarchy.residues;
    const { auth_asym_id: authAsymId } = atomicHierarchy.chains;
    const chainIndex = atomicHierarchy.chainAtomSegments.index;
    let start = 0;

    while (start < unit.elements.length) {
      const atomIndex = unit.elements[start];
      const residueIndex = unit.residueIndex[atomIndex];
      let end = start + 1;

      while (end < unit.elements.length && unit.residueIndex[unit.elements[end]] === residueIndex) end += 1;

      if (authAsymId.value(chainIndex[atomIndex]) === 'A') {
        const authSeq = Number(authSeqId.value(residueIndex));
        if (Number.isFinite(authSeq)) {
          const loci = Loci(structure, [{ unit, indices: OrderedSet.ofBounds(start, end) }]);
          const existing = residueLoci.get(authSeq);
          residueLoci.set(authSeq, existing ? Loci.union(existing, loci) : loci);
        }
      }

      start = end;
    }
  }

  return residueLoci;
}

const ResidueButton = memo(function ResidueButton({ residue, index, inRange, active, color }) {
  return (
    <button
      data-sequence-index={index}
      class={`viewer-residue ${inRange ? 'in-range' : ''} ${active ? 'active' : ''}`}
      style={`--mode-color:${color}`}
      type="button"
      title={`${residue.compId} ${residue.authSeqId}`}
    >
      <span class="viewer-residue-pos">{index % 10 === 0 ? residue.authSeqId : ''}</span>
      <span>{residue.one}</span>
    </button>
  );
});

const ANNOTATION_GROUPS = [
  ['Contexto funcional', [
    ['tag', 'Dominio UniProt', 'uniprot_domain'],
  ]],
  ['Estructura', [
    ['waves', 'Topología de membrana', 'tmbed_topology'],
    ['shield-check', 'Calidad del modelo', 'structure_qc_status'],
    ['layers-3', 'Régimen estructural', 'structural_regime'],
    ['route', 'Estructura secundaria', 'secondary_structure'],
    ['circle-dot', 'Exposición al solvente', 'buried_status'],
    ['zap', 'Energía por residuo', 'residue_energy_value'],
    ['activity', 'Índice de frustración', 'structural_frustration_fi_singleresidue'],
    ['network', 'Contactos estructurales', 'structural_contacts_n_contacts'],
  ]],
  ['Predicción y conservación', [
    ['chart-column', 'AlphaMissense', 'alphamissense_mean'],
    ['gauge', 'CADD PHRED', 'cadd_phred_mean'],
    ['chart-column', 'REVEL', 'revel_mean'],
    ['sparkles', 'Frustración por secuencia', 'frustraiseq_class'],
    ['scan-search', 'Conservación ConSurf', 'consurf_grade'],
  ]],
  ['Evidencia experimental', [
    ['flask-conical', 'Ensayado en MaveDB', 'mavedb_position_assayed'],
  ]],
];

function registerModeThemes(viewer, structureLib) {
  const registry = viewer.plugin.representation.structure.themes.colorThemeRegistry;
  const residueIndex = new Map(RESIDUES.map((residue, index) => [`${residue.chain}|${residue.authSeqId}|`, index]));
  const names = {};

  for (const [mode, info] of Object.entries(MODE_INFO)) {
    const name = `mock-residue-${mode}`;
    const colors = MODE_COLOR_VALUES[mode];
    const factory = (ctx, props) => ({
      factory,
      granularity: 'group',
      props,
      description: `Color mock por residuo · ${info.title}`,
      color: (location) => {
        try {
          if (!structureLib.StructureElement.Location.is(location)) return 0xb8bec5;
          const chain = String(structureLib.StructureProperties.chain.auth_asym_id(location) || structureLib.StructureProperties.chain.label_asym_id(location) || '_');
          const authSeqId = Number(structureLib.StructureProperties.residue.auth_seq_id(location) || structureLib.StructureProperties.residue.label_seq_id(location));
          const insCode = String(structureLib.StructureProperties.residue.pdbx_PDB_ins_code?.(location) || '').trim();
          const index = residueIndex.get(`${chain}|${authSeqId}|${insCode}`) ?? residueIndex.get(`${chain}|${authSeqId}|`);
          return index === undefined ? 0xb8bec5 : colors[index] ?? 0xb8bec5;
        } catch {
          return 0xb8bec5;
        }
      },
    });

    try {
      registry.add({ name, label: info.title, category: 'Mock annotations', factory, getParams: () => ({}), defaultValues: {}, isApplicable: () => true });
      names[mode] = name;
    } catch {
      // Hot-reload or a remount can leave a provider registered in development.
      names[mode] = name;
    }
  }
  return names;
}

export default function ProteinViewer({ protein }) {
  const hostRef = useRef(null);
  const viewerRef = useRef(null);
  const structureLibRef = useRef(null);
  const structureRef = useRef(null);
  const residueLociRef = useRef(new Map());
  const rangeLociRef = useRef(new Map());
  const themeNamesRef = useRef({});
  const selectionRef = useRef({ lo: null, hi: null, active: null });
  const dragRef = useRef(null);
  const molstarFrameRef = useRef(null);
  const molstarFocusFrameRef = useRef(null);
  const [boot, setBoot] = useState('loading');
  const [mode, setMode] = useState('regime');
  const [selection, setSelection] = useState({ lo: null, hi: null, active: null });

  const annotation = useMemo(() => selection.active === null ? null : mockAnnotations(selection.active, RESIDUES[selection.active]), [selection.active]);
  const activeResidue = selection.active === null ? null : RESIDUES[selection.active];
  const hasActiveAnnotation = Boolean(activeResidue && annotation);

  const applyTheme = async (nextMode) => {
    const viewer = viewerRef.current;
    if (!viewer?.plugin) return;
    const theme = themeNamesRef.current[nextMode];
    if (!theme) return;
    try {
      await viewer.plugin.dataTransaction(async () => {
        for (const structure of viewer.plugin.managers.structure.hierarchy.current.structures) {
          await viewer.plugin.managers.structure.component.updateRepresentationsTheme(structure.components, { color: theme });
        }
      });
    } catch (error) {
      console.warn('No se pudo aplicar el tema por residuo de Mol*', error);
    }
  };

  useEffect(() => {
    let disposed = false;
    let clickSubscription = null;

    async function bootViewer() {
      try {
        const [{ Viewer }, structureLib] = await Promise.all([
          import('molstar/lib/apps/viewer/app'),
          import('molstar/lib/mol-model/structure'),
        ]);
        if (disposed || !hostRef.current) return;
        structureLibRef.current = structureLib;
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
          viewportBackgroundColor: '#f3f4f4',
          disableAntialiasing: false,
          pixelScale: 1,
          resolutionMode: 'auto',
        });
        if (disposed) {
          viewer.dispose();
          return;
        }
        // Mol* throttles pointer picking and drag interaction to 30 FPS by default.
        viewer.plugin.canvas3d?.setProps({
          interaction: { maxFps: 60 },
          cameraResetDurationMs: CAMERA_RESET_DURATION_MS,
          cameraResetEasing: 'cubic-out',
          cameraResetTrajectory: 'linear',
        });
        viewerRef.current = viewer;
        await viewer.loadStructureFromUrl(protein.pdb, 'pdb', false, { label: `${protein.id}_model_0` });
        structureRef.current = viewer.plugin.managers.structure.hierarchy.current.structures[0]?.cell?.obj?.data ?? null;
        if (structureRef.current) residueLociRef.current = buildResidueLociCache(structureRef.current, structureLib);
        themeNamesRef.current = registerModeThemes(viewer, structureLib);
        await applyTheme(mode);

        clickSubscription = viewer.subscribe(viewer.plugin.behaviors.interaction.click, (event) => {
          const loci = event?.current?.loci;
          if (!structureLib.StructureElement.Loci.is(loci)) return;
          let picked = null;
          structureLib.StructureElement.Loci.forEachLocation(loci, (location) => {
            if (picked) return;
            const chain = String(structureLib.StructureProperties.chain.auth_asym_id(location) || structureLib.StructureProperties.chain.label_asym_id(location) || '_');
            const authSeqId = Number(structureLib.StructureProperties.residue.auth_seq_id(location) || structureLib.StructureProperties.residue.label_seq_id(location));
            if (chain === 'A' && Number.isFinite(authSeqId)) picked = authSeqId - 1;
          });
          if (picked !== null && picked >= 0 && picked < RESIDUES.length) selectSingle(picked, true);
        });
        setBoot('ready');
      } catch (error) {
        console.error(error);
        setBoot('error');
      }
    }

    bootViewer();
    return () => {
      disposed = true;
      if (molstarFrameRef.current !== null) cancelAnimationFrame(molstarFrameRef.current);
      if (molstarFocusFrameRef.current !== null) cancelAnimationFrame(molstarFocusFrameRef.current);
      clickSubscription?.unsubscribe?.();
      viewerRef.current?.dispose?.();
      viewerRef.current = null;
      structureRef.current = null;
      residueLociRef.current.clear();
      rangeLociRef.current.clear();
    };
  }, []);

  useEffect(() => { applyTheme(mode); }, [mode]);

  const getSelectionLoci = (lo, hi) => {
    const key = `${lo}:${hi}`;
    const cached = rangeLociRef.current.get(key);
    if (cached) return cached;

    const { Loci } = structureLibRef.current?.StructureElement ?? {};
    if (!Loci) return null;

    let loci = null;
    for (let index = lo; index <= hi; index += 1) {
      const residueLoci = residueLociRef.current.get(RESIDUES[index].authSeqId);
      if (!residueLoci) continue;
      loci = loci ? Loci.union(loci, residueLoci) : residueLoci;
    }

    if (loci) rangeLociRef.current.set(key, loci);
    return loci;
  };

  const syncMolstar = (lo, hi, focus = true) => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    try {
      const loci = getSelectionLoci(lo, hi);
      if (!loci) {
        const schema = { auth_asym_id: 'A', beg_auth_seq_id: RESIDUES[lo].authSeqId, end_auth_seq_id: RESIDUES[hi].authSeqId };
        viewer.structureInteractivity({
          elements: schema,
          action: focus ? ['select', 'focus'] : 'select',
          ...(focus ? { focusOptions: RESIDUE_FOCUS_OPTIONS } : {}),
        });
        return;
      }
      viewer.plugin.managers.interactivity.lociSelects.deselectAll();
      viewer.plugin.managers.interactivity.lociSelects.select({ loci });
      if (molstarFocusFrameRef.current !== null) cancelAnimationFrame(molstarFocusFrameRef.current);
      if (focus) {
        molstarFocusFrameRef.current = requestAnimationFrame(() => {
          molstarFocusFrameRef.current = null;
          const current = selectionRef.current;
          if (current.lo !== lo || current.hi !== hi) return;
          viewerRef.current?.plugin?.managers?.camera?.focusLoci?.(loci, RESIDUE_FOCUS_OPTIONS);
        });
      }
    } catch (error) {
      console.warn('No se pudo sincronizar la selección con Mol*', error);
    }
  };

  const scheduleMolstar = (callback) => {
    if (molstarFrameRef.current !== null) cancelAnimationFrame(molstarFrameRef.current);
    molstarFrameRef.current = requestAnimationFrame(() => {
      molstarFrameRef.current = null;
      callback();
    });
  };

  const clearSelection = () => {
    if (molstarFocusFrameRef.current !== null) cancelAnimationFrame(molstarFocusFrameRef.current);
    molstarFocusFrameRef.current = null;
    const next = { lo: null, hi: null, active: null };
    selectionRef.current = next;
    setSelection(next);
    scheduleMolstar(() => {
      try {
        viewerRef.current?.plugin?.managers?.interactivity?.lociSelects?.deselectAll?.();
      } catch (error) {
        console.warn('No se pudo limpiar la selección de Mol*', error);
      }
      viewerRef.current?.plugin?.managers?.camera?.reset?.(undefined, CAMERA_RESET_DURATION_MS, {
        easing: 'cubic-out',
        trajectory: 'linear',
      });
    });
  };

  const selectSingle = (index, fromCanvas = false) => {
    const previous = selectionRef.current;
    const repeated = previous.active === index && previous.lo === index && previous.hi === index;
    if (repeated) {
      clearSelection();
      return;
    }
    const next = { lo: index, hi: index, active: index };
    if (molstarFocusFrameRef.current !== null) cancelAnimationFrame(molstarFocusFrameRef.current);
    molstarFocusFrameRef.current = null;
    selectionRef.current = next;
    setSelection(next);
    if (!fromCanvas) scheduleMolstar(() => syncMolstar(index, index, true));
    requestAnimationFrame(() => document.querySelector(`[data-sequence-index="${index}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' }));
  };

  const commitRange = (lo, hi) => {
    const next = { lo: Math.min(lo, hi), hi: Math.max(lo, hi), active: lo === hi ? lo : null };
    if (molstarFocusFrameRef.current !== null) cancelAnimationFrame(molstarFocusFrameRef.current);
    molstarFocusFrameRef.current = null;
    selectionRef.current = next;
    setSelection(next);
    scheduleMolstar(() => syncMolstar(next.lo, next.hi, true));
  };

  const sequencePointerDown = (event) => {
    const target = event.target?.closest?.('[data-sequence-index]');
    const index = Number(target?.dataset?.sequenceIndex);
    if (!target || !Number.isInteger(index)) return;
    event.preventDefault();
    const previous = selectionRef.current;
    dragRef.current = {
      start: index,
      end: index,
      pointerId: event.pointerId,
      previous,
      wasSelected: previous.active === index && previous.lo === index && previous.hi === index,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const sequencePointerMove = (event) => {
    if (!dragRef.current) return;
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest?.('[data-sequence-index]');
    if (!target) return;
    const index = Number(target.dataset.sequenceIndex);
    if (!Number.isInteger(index) || index === dragRef.current.end) return;
    dragRef.current.end = index;
    const next = { lo: Math.min(dragRef.current.start, index), hi: Math.max(dragRef.current.start, index), active: null };
    selectionRef.current = next;
    setSelection(next);
  };

  const sequencePointerUp = () => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    if (drag.start === drag.end) {
      if (drag.wasSelected) clearSelection();
      else selectSingle(drag.start);
    }
    else commitRange(drag.start, drag.end);
  };

  const sequencePointerCancel = () => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    selectionRef.current = drag.previous;
    setSelection(drag.previous);
  };

  return (
    <section class={`viewer-shell ${hasActiveAnnotation ? 'has-annotations' : ''}`} onContextMenu={(event) => event.preventDefault()}>
      <div ref={hostRef} class="molstar-host" aria-label="Visor molecular Mol*" />
      {boot !== 'ready' && <div class={`viewer-boot ${boot === 'error' ? 'error' : ''}`}>{boot === 'error' ? 'No se pudo inicializar Mol*' : 'Cargando estructura…'}</div>}

      <div class="viewer-top-stack">
        <div class="viewer-chain-panel">
          <div class="viewer-chain-title">Cadena A</div>
          <div class="viewer-sequence-scroll" onPointerDown={sequencePointerDown} onPointerMove={sequencePointerMove} onPointerUp={sequencePointerUp} onPointerCancel={sequencePointerCancel}>
            <div class={`viewer-sequence-track ${selection.lo !== null ? 'has-selection' : ''}`}>
              {RESIDUES.map((residue, index) => (
                <ResidueButton
                  key={index}
                  residue={residue}
                  index={index}
                  inRange={selection.lo !== null && index >= selection.lo && index <= selection.hi}
                  active={selection.active === index}
                  color={MODE_COLORS[mode][index]}
                />
              ))}
            </div>
          </div>
        </div>

        <div class="viewer-mode-panel" aria-label="Modos de color">
          <div class="viewer-mode-buttons">
            {Object.entries(MODE_INFO).map(([key, info]) => (
              <button key={key} class={`viewer-mode ${mode === key ? 'active' : ''}`} type="button" title={info.title} aria-pressed={mode === key} onClick={() => setMode(key)}>
                <LucideIcon name={info.icon} />
              </button>
            ))}
          </div>
          <div class="viewer-mode-info">
            <span class="viewer-mode-title">{MODE_INFO[mode].title}</span>
            <span class="viewer-mode-legend">
              {MODE_INFO[mode].legend.map(([label, color]) => <span key={label} class="viewer-legend-item"><i style={{ background: color }} />{label}</span>)}
            </span>
          </div>
        </div>
      </div>

      {hasActiveAnnotation && (
        <aside class="viewer-annotations" aria-label="Anotaciones del residuo">
          <div class="viewer-annotations-head"><h2>Anotaciones</h2><span class="viewer-mock-badge">Mock</span></div>
          <div class="viewer-annotations-body">
              <div class="viewer-residue-title">
                <div><strong>{activeResidue.one}</strong><span>{activeResidue.compId} · {AA_NAMES[activeResidue.compId]}</span></div>
                <b>{activeResidue.authSeqId}</b>
              </div>
              <dl class="viewer-annotation-list">
                {ANNOTATION_GROUPS.map(([group, rows]) => (
                  <div key={group} class="viewer-annotation-group-wrap">
                    <div class="viewer-annotation-group">{group}</div>
                    {rows.map(([icon, label, key]) => (
                      <div key={key} class="viewer-annotation-row">
                        <dt><span><LucideIcon name={icon} />{label}</span></dt>
                        <dd>{readableValue(key, annotation[key])}</dd>
                      </div>
                    ))}
                  </div>
                ))}
              </dl>
          </div>
        </aside>
      )}
    </section>
  );
}
