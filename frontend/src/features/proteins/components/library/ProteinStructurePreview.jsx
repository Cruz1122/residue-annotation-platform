import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { getArtifactObjectUrl } from '@shared/api/client';
import { artifactDisplayName } from '@features/artifacts/artifact-display.js';
import { acquireStructureUrl } from '@features/annotations/structure-url-cache.js';
import { structureFormat } from '@features/annotations/structure-format.js';
import { getZoomOptimizedCanvas3dProps } from '@features/annotations/zoom-rendering.js';
import {
  readProteinPreviewSnapshot,
  writeProteinPreviewSnapshot,
} from '@features/proteins/protein-preview-snapshot-cache.js';
import { preferredStructureArtifact } from '@features/proteins/protein-display.js';
import 'molstar/build/viewer/molstar.css';

const PREVIEW_CANVAS_MARGIN = 5;
const PREVIEW_STRUCTURE_PADDING = 0.3;
const PREVIEW_SNAPSHOT_VERSION = 2;

function collectStructurePoints(viewer) {
  const structures = viewer?.plugin?.managers?.structure?.hierarchy?.current?.structures ?? [];
  let positions = new Float32Array(3072);
  let length = 0;
  for (const entry of structures) {
    const structure = entry?.cell?.obj?.data;
    for (const unit of structure?.units ?? []) {
      if (unit.objectPrimitive === 'gaussian') return new Float32Array(0);
      if (!unit.elements?.length || typeof unit.conformation?.position !== 'function') continue;
      for (const element of unit.elements) {
        const point = unit.conformation.position(element, [0, 0, 0]);
        if (!Number.isFinite(point[0]) || !Number.isFinite(point[1]) || !Number.isFinite(point[2])) continue;
        if (length + 4 > positions.length) {
          const largerPositions = new Float32Array(positions.length * 2);
          largerPositions.set(positions);
          positions = largerPositions;
        }
        positions[length] = point[0];
        positions[length + 1] = point[1];
        positions[length + 2] = point[2];
        positions[length + 3] = unit.objectPrimitive === 'sphere'
          ? Math.max(0, Number(unit.conformation.r?.(element)) || 0)
          : 0;
        length += 4;
      }
    }
  }
  return positions.slice(0, length);
}

function buildSupportHull(projections, coordinateOffset) {
  const pointCount = projections.length / 3;
  if (!pointCount) return new Float32Array(0);
  const order = Array.from({ length: pointCount }, (_, index) => index);
  order.sort((left, right) => {
    const xDifference = projections[left * 3 + coordinateOffset] - projections[right * 3 + coordinateOffset];
    return xDifference || projections[right * 3] - projections[left * 3];
  });

  const hull = [];
  let previousX = Number.NaN;
  for (const pointIndex of order) {
    const x = projections[pointIndex * 3 + coordinateOffset];
    const depth = projections[pointIndex * 3];
    if (x === previousX) continue;
    previousX = x;
    while (hull.length >= 2) {
      const previous = hull[hull.length - 2];
      const last = hull[hull.length - 1];
      const cross = (last[0] - previous[0]) * (depth - last[1]) - (last[1] - previous[1]) * (x - last[0]);
      if (cross < 0) break;
      hull.pop();
    }
    hull.push([x, depth]);
  }

  const support = new Float32Array(hull.length * 2);
  hull.forEach(([x, depth], index) => {
    support[index * 2] = x;
    support[index * 2 + 1] = depth;
  });
  return support;
}

function supportDistance(hull, slope) {
  let low = 0;
  let high = hull.length / 2 - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    const current = hull[middle * 2 + 1] + slope * hull[middle * 2];
    const next = hull[(middle + 1) * 2 + 1] + slope * hull[(middle + 1) * 2];
    if (current <= next) low = middle + 1;
    else high = middle;
  }
  return hull.length ? hull[low * 2 + 1] + slope * hull[low * 2] : Number.NEGATIVE_INFINITY;
}

function prepareStructureFrame(coordinates, bounds) {
  const useStructurePoints = coordinates.length > 0;
  const fallbackPoints = bounds?.extrema ?? [];
  const pointCount = useStructurePoints ? coordinates.length / 4 : fallbackPoints.length;
  const center = useStructurePoints ? [0, 0, 0] : [...(bounds?.center ?? [0, 0, 0])];
  if (useStructurePoints) {
    for (let pointIndex = 0; pointIndex < pointCount; pointIndex += 1) {
      for (let axis = 0; axis < 3; axis += 1) center[axis] += coordinates[pointIndex * 4 + axis] / pointCount;
    }
  }
  const covariance = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let pointIndex = 0; pointIndex < pointCount; pointIndex += 1) {
    const point = useStructurePoints ? null : fallbackPoints[pointIndex];
    const deltaX = (useStructurePoints ? coordinates[pointIndex * 4] : point[0]) - center[0];
    const deltaY = (useStructurePoints ? coordinates[pointIndex * 4 + 1] : point[1]) - center[1];
    const deltaZ = (useStructurePoints ? coordinates[pointIndex * 4 + 2] : point[2]) - center[2];
    covariance[0][0] += deltaX * deltaX;
    covariance[0][1] += deltaX * deltaY;
    covariance[0][2] += deltaX * deltaZ;
    covariance[1][0] += deltaY * deltaX;
    covariance[1][1] += deltaY * deltaY;
    covariance[1][2] += deltaY * deltaZ;
    covariance[2][0] += deltaZ * deltaX;
    covariance[2][1] += deltaZ * deltaY;
    covariance[2][2] += deltaZ * deltaZ;
  }
  let principalAxisIndex = 0;
  for (let axis = 1; axis < 3; axis += 1) {
    if (covariance[axis][axis] > covariance[principalAxisIndex][principalAxisIndex]) principalAxisIndex = axis;
  }
  let principalAxis = [0, 0, 0];
  principalAxis[principalAxisIndex] = 1;
  for (let iteration = 0; iteration < 12; iteration += 1) {
    const next = covariance.map((row) => row.reduce((sum, value, index) => sum + value * principalAxis[index], 0));
    const magnitude = Math.hypot(...next);
    if (!magnitude) break;
    principalAxis = next.map((coordinate) => coordinate / magnitude);
  }
  const referenceAxis = Math.abs(principalAxis[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const cameraDirection = [
    principalAxis[1] * referenceAxis[2] - principalAxis[2] * referenceAxis[1],
    principalAxis[2] * referenceAxis[0] - principalAxis[0] * referenceAxis[2],
    principalAxis[0] * referenceAxis[1] - principalAxis[1] * referenceAxis[0],
  ];
  const directionMagnitude = Math.hypot(...cameraDirection);
  if (!directionMagnitude) return null;
  for (let index = 0; index < 3; index += 1) cameraDirection[index] /= directionMagnitude;
  const right = [
    principalAxis[1] * cameraDirection[2] - principalAxis[2] * cameraDirection[1],
    principalAxis[2] * cameraDirection[0] - principalAxis[0] * cameraDirection[2],
    principalAxis[0] * cameraDirection[1] - principalAxis[1] * cameraDirection[0],
  ];
  const projections = new Float32Array(pointCount * 3);
  for (let pointIndex = 0; pointIndex < pointCount; pointIndex += 1) {
    const point = useStructurePoints ? null : fallbackPoints[pointIndex];
    const coordinateOffset = useStructurePoints ? pointIndex * 4 : 0;
    const deltaX = (useStructurePoints ? coordinates[coordinateOffset] : point[0]) - center[0];
    const deltaY = (useStructurePoints ? coordinates[coordinateOffset + 1] : point[1]) - center[1];
    const deltaZ = (useStructurePoints ? coordinates[coordinateOffset + 2] : point[2]) - center[2];
    const radius = useStructurePoints ? coordinates[coordinateOffset + 3] : 0;
    projections[pointIndex * 3] = deltaX * cameraDirection[0] + deltaY * cameraDirection[1] + deltaZ * cameraDirection[2] + radius;
    projections[pointIndex * 3 + 1] = Math.abs(deltaX * right[0] + deltaY * right[1] + deltaZ * right[2]) + radius;
    projections[pointIndex * 3 + 2] = Math.abs(deltaX * principalAxis[0] + deltaY * principalAxis[1] + deltaZ * principalAxis[2]) + radius;
  }
  return {
    center,
    cameraDirection,
    principalAxis,
    horizontalSupport: buildSupportHull(projections, 1),
    verticalSupport: buildSupportHull(projections, 2),
    padding: useStructurePoints ? PREVIEW_STRUCTURE_PADDING : 0,
  };
}

function frameStructureWithMargin(canvas3d, frame, targetViewport) {
  const camera = canvas3d?.camera;
  const bounds = canvas3d?.boundingSphereVisible;
  const viewport = targetViewport?.width > 0 && targetViewport?.height > 0
    ? targetViewport
    : camera?.viewport;
  const boundsMargin = PREVIEW_CANVAS_MARGIN;
  if (!camera || !bounds?.radius || !frame || !viewport || viewport.width <= boundsMargin * 2 || viewport.height <= boundsMargin * 2) return;

  const snapshot = camera.getSnapshot();
  const focalLength = viewport.height / (2 * Math.tan(snapshot.fov / 2));
  const availableHalfWidth = viewport.width / 2 - boundsMargin;
  const availableHalfHeight = viewport.height / 2 - boundsMargin;
  const horizontalSlope = focalLength / availableHalfWidth;
  const verticalSlope = focalLength / availableHalfHeight;
  let distance = Math.max(
    supportDistance(frame.horizontalSupport, horizontalSlope) + frame.padding * (1 + horizontalSlope),
    supportDistance(frame.verticalSupport, verticalSlope) + frame.padding * (1 + verticalSlope),
    bounds.radius * 1e-4,
  );
  if (!frame.horizontalSupport.length && !frame.verticalSupport.length) {
    const halfFov = Math.atan(Math.min(availableHalfWidth, availableHalfHeight) / focalLength);
    distance = bounds.radius / Math.sin(halfFov);
  }
  const position = frame.cameraDirection.map((coordinate, index) => frame.center[index] + coordinate * distance);
  camera.setState({ position, target: [...frame.center], up: frame.principalAxis, radius: bounds.radius }, 0);
}

function waitForCanvasCommit(canvas3d) {
  if (!canvas3d) return Promise.reject(new Error('Mol* no pudo preparar el renderizador.'));
  const isCommitted = () => canvas3d.boundingSphereVisible.radius > 0 && canvas3d.commitQueueSize.value === 0;
  if (isCommitted()) return Promise.resolve();

  return new Promise((resolve, reject) => {
    let subscription;
    let settled = false;
    const timeout = window.setTimeout(() => finish(new Error('Mol* no terminó de renderizar la estructura.')), 10000);
    function finish(error) {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      subscription?.unsubscribe();
      if (error) reject(error);
      else resolve();
    }
    subscription = canvas3d.commited.subscribe(() => {
      if (isCommitted()) finish();
    });
    if (isCommitted()) finish();
  });
}

function waitForNextFrame() {
  return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}

function publishedStructure(run) {
  const artifact = preferredStructureArtifact(run);
  return artifact
    ? { id: artifact.id, format: structureFormat(artifact), label: artifactDisplayName(artifact) }
    : null;
}

let snapshotRenderQueue = Promise.resolve();

function enqueueSnapshotRender(render) {
  const queued = snapshotRenderQueue.catch(() => {}).then(render);
  snapshotRenderQueue = queued.catch(() => {});
  return queued;
}

function snapshotCacheKey(run, structure) {
  const projectId = run?.configuration?.project_id ?? run?.project_id;
  const ownerId = run?.configuration?.owner_id ?? run?.owner_id;
  if (!projectId && !ownerId) return '';
  const scope = [projectId, ownerId].filter(Boolean).join(':');
  return `v${PREVIEW_SNAPSHOT_VERSION}:${scope}:${structure.id}`;
}

async function captureHighResolutionSnapshot(viewer, canvas3d, targetViewport) {
  const screenshot = viewer?.plugin?.helpers?.viewportScreenshot;
  const viewport = targetViewport?.width > 0 && targetViewport?.height > 0
    ? targetViewport
    : canvas3d?.camera?.viewport;
  if (!screenshot || !viewport?.width || !viewport?.height) {
    throw new Error('Mol* no pudo preparar la captura de la estructura.');
  }

  const width = 1024;
  screenshot.behaviors.values.next({
    ...screenshot.values,
    resolution: {
      name: 'custom',
      params: { width, height: Math.max(128, Math.round(width * viewport.height / viewport.width)) },
    },
    format: { name: 'png', params: {} },
    axes: { name: 'off', params: {} },
    transparent: false,
  });
  const imageData = await screenshot.getImageDataUri();
  const imageResponse = await fetch(imageData);
  if (!imageResponse.ok) throw new Error('No se pudo guardar la captura de la estructura.');
  return imageResponse.blob();
}

export default function ProteinStructurePreview({ run, label }) {
  const hostRef = useRef(null);
  const viewerRef = useRef(null);
  const imageUrlRef = useRef('');
  const [imageUrl, setImageUrl] = useState('');
  const [state, setState] = useState('loading');
  const structure = useMemo(() => publishedStructure(run), [run]);
  const cacheProjectId = run?.configuration?.project_id ?? run?.project_id;
  const cacheOwnerId = run?.configuration?.owner_id ?? run?.owner_id;

  useEffect(() => {
    if (!structure || !hostRef.current) {
      setImageUrl('');
      setState('unavailable');
      return undefined;
    }

    let disposed = false;
    let generationStarted = false;
    let observer;
    const cacheKey = snapshotCacheKey(run, structure);
    const previewElement = hostRef.current.parentElement;

    function releaseImageUrl() {
      if (!imageUrlRef.current) return;
      URL.revokeObjectURL(imageUrlRef.current);
      imageUrlRef.current = '';
    }

    async function generateSnapshot() {
      if (generationStarted || disposed) return;
      generationStarted = true;
      observer?.disconnect();
      setState('generating');

      try {
        const image = await enqueueSnapshotRender(async () => {
          if (disposed) return null;
          const structureLease = acquireStructureUrl(
            structure.id,
            () => getArtifactObjectUrl(structure.id),
          );
          let viewer;
          try {
            const [{ Viewer }, loadedUrl] = await Promise.all([
              import('molstar/lib/apps/viewer/app'),
              structureLease.promise,
            ]);
            if (disposed || !hostRef.current) return null;
            viewer = await Viewer.create(hostRef.current, {
              layoutIsExpanded: false,
              layoutShowControls: false,
              layoutShowRemoteState: false,
              layoutShowSequence: false,
              layoutShowLog: false,
              layoutShowLeftPanel: false,
              viewportShowControls: false,
              viewportShowReset: false,
              viewportShowScreenshotControls: false,
              viewportShowExpand: false,
              viewportShowToggleFullscreen: false,
              viewportShowSettings: false,
              viewportShowSelectionMode: false,
              viewportShowAnimation: false,
              viewportShowTrajectoryControls: false,
              viewportBackgroundColor: '#f3f4f4',
              pixelScale: 1,
              resolutionMode: 'auto',
            });
            if (disposed) return null;
            viewerRef.current = viewer;
            const canvas3d = viewer.plugin.canvas3d;
            canvas3d?.setProps({
              ...getZoomOptimizedCanvas3dProps(),
              camera: { helper: { axes: { name: 'off', params: {} } } },
            });
            await viewer.loadStructureFromUrl(loadedUrl, structure.format, false, { label: structure.label });
            await waitForCanvasCommit(canvas3d);
            if (disposed) return null;
            if (!canvas3d?.boundingSphereVisible?.radius || canvas3d.commitQueueSize.value !== 0) {
              throw new Error('Mol* no terminó de preparar la estructura.');
            }
            const previewBounds = previewElement?.getBoundingClientRect();
            const previewViewport = {
              width: previewBounds?.width ?? 0,
              height: previewBounds?.height ?? 0,
            };
            const coordinates = collectStructurePoints(viewer);
            const frame = prepareStructureFrame(coordinates, canvas3d?.boundingSphereVisible);
            frameStructureWithMargin(canvas3d, frame, previewViewport);
            canvas3d.requestDraw?.();
            await waitForNextFrame();
            await waitForNextFrame();
            return await captureHighResolutionSnapshot(viewer, canvas3d, previewViewport);
          } finally {
            if (viewerRef.current === viewer) viewerRef.current = null;
            viewer?.dispose?.();
            hostRef.current?.replaceChildren();
            structureLease.release();
          }
        });
        if (disposed || !image) return;
        if (cacheKey) await writeProteinPreviewSnapshot(cacheKey, image);
        if (disposed) return;
        releaseImageUrl();
        imageUrlRef.current = URL.createObjectURL(image);
        setImageUrl(imageUrlRef.current);
        setState('ready');
      } catch {
        if (!disposed) setState('error');
      }
    }

    async function loadCachedSnapshot() {
      releaseImageUrl();
      setImageUrl('');
      setState('loading');
      try {
        const cachedImage = cacheKey ? await readProteinPreviewSnapshot(cacheKey) : null;
        if (disposed) return;
        if (cachedImage) {
          imageUrlRef.current = URL.createObjectURL(cachedImage);
          setImageUrl(imageUrlRef.current);
          setState('ready');
          return;
        }

        setState('pending');
        if (!previewElement || typeof IntersectionObserver === 'undefined') {
          generateSnapshot();
          return;
        }
        observer = new IntersectionObserver((entries) => {
          if (entries.some((entry) => entry.isIntersecting)) generateSnapshot();
        }, { rootMargin: '120px' });
        observer.observe(previewElement);
      } catch {
        if (!disposed) setState('error');
      }
    }

    loadCachedSnapshot();
    return () => {
      disposed = true;
      observer?.disconnect();
      viewerRef.current?.dispose?.();
      viewerRef.current = null;
      releaseImageUrl();
    };
  }, [cacheOwnerId, cacheProjectId, structure?.format, structure?.id, structure?.label]);

  return (
    <div class="protein-structure-preview" aria-label={`Vista 3D de ${label}`}>
      {imageUrl && <img class="protein-preview-image" src={imageUrl} alt={`Estructura de ${label}`} decoding="async" />}
      <div
        ref={hostRef}
        class={`protein-preview-renderer ${state === 'generating' ? 'is-generating' : ''} ${state === 'ready' || state === 'error' || state === 'unavailable' ? 'is-disposed' : ''}`.trim()}
        aria-hidden="true"
      />
      {state !== 'ready' && (
        <div class="protein-preview-state" role="status" aria-live="polite">
          {state === 'loading' ? 'Preparando vista…'
            : state === 'generating' ? 'Generando imagen…'
              : state === 'pending' ? 'Vista pendiente'
                : state === 'error' ? 'No se pudo generar'
                  : 'Sin estructura'}
        </div>
      )}
    </div>
  );
}
