import { useEffect, useRef, useState } from 'preact/hooks';
import StatePanel from '@shared/components/feedback/StatePanel.jsx';
import {
  classifyBioEmuTrajectoryError,
  validateBioEmuFrameCount,
} from '@features/annotations/bioemu-presentation.js';
import {
  BIOEMU_MAX_INTERPOLATION_SUBSTEPS,
  createInterpolatedBioEmuTrajectory,
  interpolatedBioEmuFrameIndex,
} from '@features/annotations/bioemu-coordinate-interpolation.js';
import { loadBioEmuTrajectory } from '@features/annotations/bioemu-trajectory.js';
import { followBioEmuCameraTarget, updateBioEmuFrame } from '@features/annotations/bioemu-structure-state.js';

const FOCUS_OPTIONS = { extraRadius: 4, durationMs: 180, easing: 'cubic-out', trajectory: 'linear' };

function residueKey(chain, sequenceId, insertionCode = '') {
  return `${String(chain ?? '').trim()}|${String(sequenceId ?? '').trim()}|${String(insertionCode ?? '').trim()}`;
}

function trajectoryFrameCount(plugin, preset, coordinates) {
  const modelCell = plugin.state.data.cells.get(preset?.model?.ref);
  const trajectoryCell = modelCell?.transform?.parent
    ? plugin.state.data.cells.get(modelCell.transform.parent)
    : null;
  const count = trajectoryCell?.obj?.data?.frameCount ?? coordinates?.obj?.data?.frames?.length;
  return Number.isInteger(count) && count > 0 ? count : null;
}

function trajectoryCellForPreset(plugin, preset) {
  const modelCell = plugin.state.data.cells.get(preset?.model?.ref);
  const trajectoryRef = modelCell?.transform?.parent;
  return trajectoryRef ? plugin.state.data.cells.get(trajectoryRef) : null;
}

export default function BioEmuStructure({
  pdbText,
  xtcBytes,
  metadata,
  frameIndex,
  selectedPosition,
  sequenceChain,
  compatibilityError = '',
  externalIssue = null,
  onPick,
  onTrajectoryReady,
  onTrajectoryIssue,
}) {
  const hostRef = useRef(null);
  const viewerRef = useRef(null);
  const selectionRef = useRef(selectedPosition);
  const chainRef = useRef(sequenceChain);
  const onPickRef = useRef(onPick);
  const onReadyRef = useRef(onTrajectoryReady);
  const onIssueRef = useRef(onTrajectoryIssue);
  const externalIssueRef = useRef(externalIssue);
  const cameraFocusModeRef = useRef('structure');
  const [viewerState, setViewerState] = useState('loading');
  const [viewerError, setViewerError] = useState('');

  selectionRef.current = selectedPosition;
  chainRef.current = sequenceChain;
  onPickRef.current = onPick;
  onReadyRef.current = onTrajectoryReady;
  onIssueRef.current = onTrajectoryIssue;
  externalIssueRef.current = externalIssue;

  useEffect(() => {
    if (!hostRef.current || !pdbText) return undefined;
    let disposed = false;
    let viewer = null;
    let structureLib = null;
    let clickSubscription = null;
    let chainResidueMap = new Map();
    let applyFrame = null;
    let restoreTrajectoryData = null;

    const resolvePositionFromLoci = async (loci, structureLib) => {
      if (!structureLib.StructureElement.Loci.is(loci)) return;
      let position = null;
      structureLib.StructureElement.Loci.forEachLocation(loci, (location) => {
        if (position !== null) return;
        const chain = String(structureLib.StructureProperties.chain.auth_asym_id(location) ?? structureLib.StructureProperties.chain.label_asym_id(location) ?? '').trim();
        const sequenceId = String(structureLib.StructureProperties.residue.auth_seq_id(location) ?? structureLib.StructureProperties.residue.label_seq_id(location) ?? '').trim();
        const insertionCode = String(structureLib.StructureProperties.residue.pdbx_PDB_ins_code?.(location) ?? '').trim();
        position = chainResidueMap.get(residueKey(chain, sequenceId, insertionCode)) ?? null;
      });
      if (position !== null) onPickRef.current(position);
    };

    const selectionItems = (position) => {
      const residue = chainRef.current?.residues?.[position - 1];
      if (!residue || !chainRef.current) return [];
      return [{
        auth_asym_id: chainRef.current.chainId,
        beg_auth_seq_id: residue.authSequenceId,
        end_auth_seq_id: residue.authSequenceId,
        pdbx_PDB_ins_code: residue.insertionCode || undefined,
      }];
    };

    const selectPosition = (position, focus = false) => {
      if (!viewer) return false;
      const items = Number.isInteger(position) ? selectionItems(position) : [];
      if (Number.isInteger(position) && !items.length) return false;
      if (focus && Number.isInteger(position)) cameraFocusModeRef.current = 'selection';
      if (!Number.isInteger(position)) cameraFocusModeRef.current = 'structure';
      viewer.structureInteractivity({
        elements: items.length ? { items } : undefined,
        action: focus ? ['select', 'focus'] : 'select',
        ...(focus ? { focusOptions: FOCUS_OPTIONS } : {}),
      });
      return true;
    };

    const loadStaticTopology = async () => {
      await viewer.loadStructureFromData(pdbText, 'pdb', { dataLabel: 'topology.pdb' });
    };

    async function initialize() {
      try {
        const [{ Viewer }, loadedStructureLib, modelApi] = await Promise.all([
          import('molstar/lib/apps/viewer/app'),
          import('molstar/lib/mol-model/structure'),
          import('molstar/lib/mol-model/structure/model/model.js'),
        ]);
        if (disposed || !hostRef.current) return;
        structureLib = loadedStructureLib;
        viewer = await Viewer.create(hostRef.current, {
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
        if (disposed) {
          try { viewer.dispose?.(); } catch { /* The viewer finished initializing after the component unmounted. */ }
          return;
        }
        viewerRef.current = viewer;
        viewer.plugin.canvas3d?.setProps({
          interaction: { maxFps: 60 },
          camera: { helper: { axes: { name: 'off', params: {} } } },
          cameraResetDurationMs: 180,
          cameraResetEasing: 'cubic-out',
          cameraResetTrajectory: 'linear',
        });

        let trajectoryError = '';
        let trajectoryFailureState = null;
        if (xtcBytes) {
          setViewerState('loading-trajectory');
          try {
            const loaded = await loadBioEmuTrajectory(viewer, {
              model: { kind: 'model-data', data: pdbText, format: 'pdb' },
              modelLabel: 'topology.pdb',
              coordinates: { kind: 'coordinates-data', data: xtcBytes, format: 'xtc' },
              coordinatesLabel: 'samples.xtc',
              preset: 'default',
            });
            if (disposed) return;
            const frameCount = trajectoryFrameCount(viewer.plugin, loaded.preset, loaded.coords);
            const countError = validateBioEmuFrameCount(frameCount, metadata, frameIndex);
            if (countError) {
              trajectoryError = countError;
              trajectoryFailureState = 'incompatible';
              onIssueRef.current?.({ state: 'incompatible', message: countError });
              setViewerError(countError);
              await viewer.plugin.clear();
              if (disposed) return;
              await loadStaticTopology();
              if (disposed) return;
              setViewerState('incompatible');
            } else {
              const modelRef = loaded.preset?.model?.ref;
              if (!modelRef) throw new Error('No se encontró el modelo de índice de trayectoria en el estado de Mol*.');
              const trajectoryCell = trajectoryCellForPreset(viewer.plugin, loaded.preset);
              const sourceTrajectory = trajectoryCell?.obj?.data;
              if (!trajectoryCell?.obj || !sourceTrajectory) {
                throw new Error('Mol* no expuso la trayectoria de coordenadas para interpolar los conformeros.');
              }
              const interpolatedTrajectory = createInterpolatedBioEmuTrajectory(sourceTrajectory, {
                maxSubsteps: BIOEMU_MAX_INTERPOLATION_SUBSTEPS,
                modelApi: modelApi.Model,
              });
              trajectoryCell.obj.data = interpolatedTrajectory.trajectory;
              restoreTrajectoryData = () => {
                if (trajectoryCell.obj) trajectoryCell.obj.data = sourceTrajectory;
              };
              applyFrame = async (index, progress = 0) => {
                if (disposed || !viewerRef.current) return;
                try {
                  const virtualIndex = interpolatedBioEmuFrameIndex(
                    index,
                    progress,
                    frameCount,
                    interpolatedTrajectory.maxSubsteps,
                  );
                  await updateBioEmuFrame({
                    index: virtualIndex,
                    commitModelIndex: (modelIndex) => viewer.plugin.state.data.build()
                      .to(modelRef)
                      .update({ modelIndex })
                      .commit({ doNotLogTiming: true }),
                    getSelectedPosition: () => selectionRef.current,
                    selectResidue: (position, options) => selectPosition(position, options.focus),
                    followCameraTarget: ({ selectedPosition }) => {
                      const entries = viewer.plugin?.managers?.structure?.hierarchy?.current?.structures ?? [];
                      const currentStructure = entries.find((entry) => entry?.cell?.obj?.data)?.cell.obj.data;
                      const selectedLoci = Number.isInteger(selectedPosition) && currentStructure
                        ? viewer.plugin?.managers?.structure?.selection?.getLoci?.(currentStructure)
                        : null;
                      followBioEmuCameraTarget({
                        camera: viewer.plugin?.canvas3d?.camera,
                        structure: currentStructure,
                        selectedLoci,
                        lociApi: structureLib.StructureElement.Loci,
                        followSelection: Number.isInteger(selectedPosition) && cameraFocusModeRef.current === 'selection',
                      });
                    },
                    isActive: () => !disposed,
                  });
                } catch (error) {
                  if (!disposed) {
                    const selectionError = /selección actual dejó/i.test(String(error?.message ?? ''));
                    const message = selectionError
                      ? 'El residuo seleccionado dejó de corresponder con topology.pdb. La reproducción se detuvo.'
                      : 'Mol* no pudo actualizar las coordenadas del conformero. La reproducción se detuvo.';
                    setViewerError(message);
                    setViewerState(selectionError ? 'selection-error' : 'trajectory-error');
                    onIssueRef.current?.({ state: selectionError ? 'selection-error' : 'error', message });
                  }
                  throw error;
                }
              };
              onReadyRef.current?.({
                frameCount,
                applyFrame,
                maxInterpolationSteps: interpolatedTrajectory.maxSubsteps,
              });
              setViewerState('ready');
            }
          } catch (error) {
            if (disposed) return;
            const trajectoryIssue = classifyBioEmuTrajectoryError(error);
            trajectoryError = trajectoryIssue.message;
            trajectoryFailureState = trajectoryIssue.state;
            onIssueRef.current?.(trajectoryIssue);
            setViewerError(trajectoryIssue.message);
            await viewer.plugin.clear();
            if (disposed) return;
            await loadStaticTopology();
            if (disposed) return;
            setViewerState(trajectoryIssue.state === 'incompatible' ? 'incompatible' : 'trajectory-error');
          }
        } else {
          setViewerState('loading-topology');
          await loadStaticTopology();
          if (disposed) return;
          if (compatibilityError) {
            setViewerError(compatibilityError);
            setViewerState('incompatible');
            onIssueRef.current?.({ state: 'incompatible', message: compatibilityError });
          } else if (externalIssueRef.current?.state === 'error') {
            setViewerError(externalIssueRef.current.message);
            setViewerState('trajectory-error');
            onIssueRef.current?.(externalIssueRef.current);
          } else {
            setViewerState('trajectory-missing');
            onIssueRef.current?.({ state: 'trajectory-missing', message: '' });
          }
        }
        if (disposed) return;

        chainResidueMap = new Map((chainRef.current?.residues ?? []).map((residue, index) => [
          residueKey(chainRef.current.chainId, residue.authSequenceId, residue.insertionCode),
          index + 1,
        ]));
        clickSubscription = viewer.subscribe(viewer.plugin.behaviors.interaction.click, (event) => {
          void resolvePositionFromLoci(event?.current?.loci, structureLib);
        });
        viewer.plugin.canvas3d?.requestResize?.();
        if (Number.isInteger(selectionRef.current)) selectPosition(selectionRef.current, true);
        else viewer.plugin.managers.camera.reset?.(undefined, 180, FOCUS_OPTIONS);
        if (trajectoryError) setViewerState(trajectoryFailureState === 'error' ? 'trajectory-error' : 'incompatible');
      } catch (error) {
        if (disposed) return;
        const message = 'No se pudo cargar topology.pdb en el visor molecular.';
        setViewerError(message);
        setViewerState('error');
        onIssueRef.current?.({ state: 'error', message });
      }
    }

    void initialize();
    return () => {
      disposed = true;
      clickSubscription?.unsubscribe?.();
      restoreTrajectoryData?.();
      try { viewer?.dispose?.(); } catch { /* Mol* may already have released its WebGL context. */ }
      if (viewerRef.current === viewer) viewerRef.current = null;
      applyFrame = null;
    };
  }, [pdbText, xtcBytes, metadata, frameIndex, compatibilityError]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !['ready', 'trajectory-missing', 'trajectory-error', 'incompatible'].includes(viewerState)) return;
    if (!Number.isInteger(selectedPosition)) {
      selectCurrent(null);
      return;
    }
    const items = selectionItemsForCurrent(selectedPosition, sequenceChain);
    if (!items.length) {
      setViewerError('La selección no se puede asociar con una posición de topology.pdb.');
      setViewerState('selection-error');
      return;
    }
    try {
      cameraFocusModeRef.current = 'selection';
      viewer.structureInteractivity({ elements: { items }, action: ['select', 'focus'], focusOptions: FOCUS_OPTIONS });
    } catch {
      setViewerError('No se pudo mantener la selección del residuo en la topología cargada.');
      setViewerState('selection-error');
    }
  }, [selectedPosition, sequenceChain, viewerState]);

  function selectionItemsForCurrent(position, chain) {
    const residue = chain?.residues?.[position - 1];
    if (!residue || !chain) return [];
    return [{
      auth_asym_id: chain.chainId,
      beg_auth_seq_id: residue.authSequenceId,
      end_auth_seq_id: residue.authSequenceId,
      pdbx_PDB_ins_code: residue.insertionCode || undefined,
    }];
  }

  function selectCurrent(position) {
    const viewer = viewerRef.current;
    if (!viewer) return;
    cameraFocusModeRef.current = Number.isInteger(position) ? 'selection' : 'structure';
    viewer.structureInteractivity({ action: 'select' });
    if (!Number.isInteger(position)) viewer.plugin.managers.camera.reset?.(undefined, 180, FOCUS_OPTIONS);
  }

  return (
    <div class="frustration-structure-viewport topology-structure-viewport bioemu-structure-viewport" role="group" aria-label="Estructura relajada y conformeros BioEmu">
      <div ref={hostRef} class="frustration-molstar-host" role="img" aria-label="Representación cartoon de la estructura relajada y del conformero actual" />
      {viewerState === 'loading-trajectory' && <StatePanel kind="loading" compact title="Cargando trayectoria" description="Mol* prepara los conformeros sobre la topología PDB." className="frustration-viewport-state" />}
      {viewerState === 'loading-topology' && <StatePanel kind="loading" compact title="Cargando topología" description="Preparando topology.pdb en Mol*." className="frustration-viewport-state" />}
      {viewerState === 'incompatible' && <StatePanel kind="error" compact title="Trayectoria incompatible" description={viewerError} className="bioemu-viewport-error" />}
      {viewerState === 'trajectory-error' && <StatePanel kind="error" compact title="Error al cargar la trayectoria" description={`${viewerError} Se conserva topology.pdb para su revisión.`} className="bioemu-viewport-error" />}
      {viewerState === 'selection-error' && <StatePanel kind="warning" compact title="Selección no disponible" description={viewerError} className="bioemu-viewport-error" />}
      {viewerState === 'error' && <StatePanel kind="error" compact title="No se pudo cargar la topología" description={viewerError} className="frustration-viewport-state" />}
      {Number.isInteger(selectedPosition) && (
        <div class="frustration-structure-selection" aria-live="polite"><strong>{selectedPosition}</strong><span>Residuo seleccionado</span></div>
      )}
    </div>
  );
}
