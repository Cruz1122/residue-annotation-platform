import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import StatePanel from '@shared/components/feedback/StatePanel.jsx';
import { getArtifactObjectUrl } from '@shared/api/client';
import { artifactDisplayName } from '@features/artifacts/artifact-display.js';
import { acquireStructureUrl } from '@features/annotations/structure-url-cache.js';
import { getZoomOptimizedCanvas3dProps } from '@features/annotations/zoom-rendering.js';
import 'molstar/build/viewer/molstar.css';

function isStructureArtifact(artifact) {
  const type = String(artifact?.artifact_type ?? '').toLowerCase();
  const media = String(artifact?.media_type ?? '').toLowerCase();
  return /\.(pdb|cif|mmcif)$/.test(type) || media.includes('pdb') || media.includes('cif');
}

function structureFormat(artifact) {
  const type = String(artifact?.artifact_type ?? '').toLowerCase();
  const media = String(artifact?.media_type ?? '').toLowerCase();
  return /\.(cif|mmcif)$/.test(type) || media.includes('cif') ? 'mmcif' : 'pdb';
}

function publishedStructure(run) {
  const artifacts = (run?.stages ?? []).flatMap((stage) => stage.artifacts ?? []);
  const preferred = ['selected_reference_pdb', 'model_cif']
    .map((artifactType) => artifacts.find((artifact) => artifact.artifact_type === artifactType))
    .find(Boolean);
  const artifact = preferred || artifacts.find(isStructureArtifact);
  return artifact
    ? { id: artifact.id, format: structureFormat(artifact), label: artifactDisplayName(artifact) }
    : null;
}

export default function ProteinStructurePreview({ run, label }) {
  const hostRef = useRef(null);
  const viewerRef = useRef(null);
  const [state, setState] = useState('loading');
  const structure = useMemo(() => publishedStructure(run), [run]);

  useEffect(() => {
    if (!structure || !hostRef.current) {
      setState('unavailable');
      return undefined;
    }

    let disposed = false;
    const structureLease = acquireStructureUrl(structure.id, () => getArtifactObjectUrl(structure.id));

    async function loadPreview() {
      try {
        const [{ Viewer }, loadedUrl] = await Promise.all([
          import('molstar/lib/apps/viewer/app'),
          structureLease.promise,
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
          viewportBackgroundColor: '#f3f4f4',
          pixelScale: 1,
          resolutionMode: 'auto',
        });
        if (disposed) {
          viewer.dispose();
          return;
        }
        viewerRef.current = viewer;
        viewer.plugin.canvas3d?.setProps(getZoomOptimizedCanvas3dProps());
        await viewer.loadStructureFromUrl(loadedUrl, structure.format, false, { label: structure.label });
        if (!disposed) setState('ready');
      } catch {
        if (!disposed) setState('error');
      }
    }

    setState('loading');
    loadPreview();
    return () => {
      disposed = true;
      viewerRef.current?.dispose?.();
      viewerRef.current = null;
      structureLease.release();
    };
  }, [structure?.format, structure?.id, structure?.label]);

  return (
    <div class="protein-structure-preview" aria-label={`Vista 3D de ${label}`}>
      <div ref={hostRef} class="protein-preview-molstar" aria-hidden={state !== 'ready'} />
      {state !== 'ready' && (
        <StatePanel
          kind={state === 'loading' ? 'loading' : state === 'error' ? 'error' : 'empty'}
          compact
          title={state === 'loading' ? 'Cargando vista 3D' : state === 'error' ? 'No se pudo cargar la estructura' : 'Estructura no disponible'}
          description={state === 'unavailable' ? 'Esta corrida no publicó un modelo molecular para mostrar.' : ''}
          className="protein-preview-state"
        />
      )}
    </div>
  );
}
