import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import StatePanel from '@shared/components/feedback/StatePanel.jsx';
import {
  findSequenceChain,
  getPublishedFrustratometerValue,
  extractBioEmuTarArtifacts,
  latestBioEmuRunWithTopology,
  parseBioEmuMetadata,
  parseConformerMetrics,
  parseFrameIndex,
  parsePdbSummary,
  resolveBioEmuArtifacts,
  validatePdbSequenceCompatibility,
} from '@features/annotations/bioemu-presentation.js';
import { createBioEmuPlayback } from '@features/annotations/bioemu-playback.js';
import { AA_NAMES } from '@features/annotations/viewer-presentation.js';
import { getArtifactBlob, getProtein, getRun, listRuns } from '@shared/api/client';
import { userErrorMessage } from '@shared/lib/error-presentation';
import BioEmuControls from './BioEmuControls.jsx';
import BioEmuPanel from './BioEmuPanel.jsx';
import BioEmuStructure from './BioEmuStructure.jsx';
import '@features/annotations/styles/frustration-comparison.css';
import '@features/annotations/styles/topology.css';
import '@features/annotations/styles/bioemu.css';
import 'molstar/build/viewer/molstar.css';

function selectedResidueFor(chain, position) {
  if (!Number.isInteger(position) || !chain?.residues?.[position - 1]) return null;
  const residue = chain.residues[position - 1];
  return {
    position,
    aminoAcid: residue.residueCode,
    label: `${AA_NAMES[residue.residueName] ?? residue.residueName} ${position}`,
    pdbId: `${residue.authSequenceId}${residue.insertionCode || ''}`,
  };
}

function formatBytes(value) {
  if (!Number.isFinite(value) || value < 0) return '';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toLocaleString('es-CO', { maximumFractionDigits: 1 })} KB`;
  return `${(value / (1024 * 1024)).toLocaleString('es-CO', { maximumFractionDigits: 1 })} MB`;
}

function SequenceStrip({ chain, selectedPosition, onSelect, selectable }) {
  if (!chain?.residues?.length) {
    return <StatePanel kind="empty" compact title="Secuencia no disponible" description="topology.pdb no contiene una secuencia de residuos reconocible." />;
  }
  return (
      <div class="frustration-sequence-scroll" role="group" aria-label={`Secuencia del PDB relajado, cadena ${chain.chainId || 'sin identificador'}, ${chain.residues.length} residuos`}>
        <div class="frustration-sequence-track">
          {chain.residues.map((residue, index) => {
            const position = index + 1;
            const selected = position === selectedPosition;
            const boundary = position === selectedPosition;
            return (
              <button
                key={`${chain.chainId}-${residue.authSequenceId}-${residue.insertionCode}`}
                type="button"
                class={`frustration-sequence-residue bioemu-sequence-residue ${selected ? 'is-selected' : ''}`}
                style={{ '--structural-color': '#b8c3c7', '--sequence-color': '#b8c3c7' }}
                onClick={() => onSelect(position)}
                data-position={position}
                aria-pressed={selected}
                aria-label={`${residue.residueCode}${position}, cadena ${chain.chainId || 'sin identificador'}, residuo PDB ${residue.authSequenceId}${residue.insertionCode}`}
                title={`${residue.residueCode}${position} · cadena ${chain.chainId || 'sin identificador'} · residuo PDB ${residue.authSequenceId}${residue.insertionCode}`}
                disabled={!selectable}
              >
                <span class="frustration-sequence-position">{position % 10 === 0 || boundary ? position : ''}</span>
                <span>{residue.residueCode}</span>
              </button>
            );
          })}
        </div>
      </div>
  );
}

export default function BioEmuView({ proteinId }) {
  const [loadState, setLoadState] = useState('loading');
  const [pageError, setPageError] = useState('');
  const [emptyTitle, setEmptyTitle] = useState('Sin artefactos disponibles');
  const [protein, setProtein] = useState(null);
  const [run, setRun] = useState(null);
  const [metadata, setMetadata] = useState(null);
  const [frameIndex, setFrameIndex] = useState([]);
  const [metrics, setMetrics] = useState([]);
  const [structureSummary, setStructureSummary] = useState(null);
  const [pdbText, setPdbText] = useState('');
  const [xtcBytes, setXtcBytes] = useState(null);
  const [compatibilityError, setCompatibilityError] = useState('');
  const [trajectoryIssue, setTrajectoryIssue] = useState(null);
  const [trajectoryLoadStatus, setTrajectoryLoadStatus] = useState('preparing');
  const [phase, setPhase] = useState('Preparando conformeros');
  const [transferProgress, setTransferProgress] = useState(null);
  const [frameCount, setFrameCount] = useState(null);
  const [currentIndex, setCurrentIndex] = useState(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(4);
  const [loop, setLoop] = useState(false);
  const [controller, setController] = useState(null);
  const controllerRef = useRef(null);
  const [trajectoryReady, setTrajectoryReady] = useState(null);
  const [selectedPosition, setSelectedPosition] = useState(null);
  const [structureReady, setStructureReady] = useState(false);

  const requestedRunId = typeof window === 'undefined' ? '' : new URLSearchParams(window.location.search).get('run') ?? '';

  useEffect(() => {
    const abortController = new AbortController();
    let active = true;
    const isActive = () => active && !abortController.signal.aborted;
    const loadArtifact = (artifact, progress) => getArtifactBlob(artifact.id, 'original', {
      signal: abortController.signal,
      onProgress: progress,
    });

    async function load() {
      try {
        setLoadState('loading');
        setPageError('');
        setEmptyTitle('Sin artefactos disponibles');
        setPhase('Preparando conformeros');
        setProtein(null);
        setRun(null);
        setMetadata(null);
        setFrameIndex([]);
        setMetrics([]);
        setStructureSummary(null);
        setPdbText('');
        setXtcBytes(null);
        setCompatibilityError('');
        setTrajectoryIssue(null);
        setTrajectoryLoadStatus('preparing');
        setTransferProgress(null);
        setFrameCount(null);
        setCurrentIndex(null);
        setTrajectoryReady(null);
        setStructureReady(false);
        const [nextProtein, runResult] = await Promise.all([
          getProtein(proteinId),
          requestedRunId ? getRun(requestedRunId) : listRuns(200, 0).then((runs) => {
            return latestBioEmuRunWithTopology(runs, proteinId);
          }),
        ]);
        if (!isActive()) return;
        setProtein(nextProtein);
        if (!runResult) {
          setRun(null);
          setPageError('No hay una corrida de BioEmu publicada para esta proteína.');
          setEmptyTitle('Sin corrida de BioEmu');
          setLoadState('empty');
          return;
        }
        if (runResult.protein_id !== proteinId) {
          setPageError('La corrida seleccionada pertenece a otra proteína.');
          setLoadState('error');
          return;
        }
        setRun(runResult);
        const artifacts = resolveBioEmuArtifacts(runResult);
        if (!artifacts.topology && !artifacts.finalDirectory) {
          setPageError('La corrida no publicó topology.pdb ni un directorio final de BioEmu que pueda contenerlo.');
          setEmptyTitle('Topología no disponible');
          setLoadState('empty');
          return;
        }

        setPhase('Cargando topología');
        let lastProgressUpdate = 0;
        const reportProgress = (progress) => {
          const now = Date.now();
          if (isActive() && (progress.complete || now - lastProgressUpdate >= 150)) {
            lastProgressUpdate = now;
            setTransferProgress(progress);
          }
        };
        const initialRequests = [];
        if (artifacts.topology) initialRequests.push(['topology', loadArtifact(artifacts.topology)]);
        else initialRequests.push(['archive', getArtifactBlob(artifacts.finalDirectory.id, 'original', { signal: abortController.signal, onProgress: reportProgress })]);
        if (artifacts.metadata) initialRequests.push(['metadata', loadArtifact(artifacts.metadata)]);
        if (artifacts.frameIndex) initialRequests.push(['frameIndex', loadArtifact(artifacts.frameIndex)]);
        const settledInitial = await Promise.all(initialRequests.map(async ([key, promise]) => [key, await Promise.allSettled([promise]).then((result) => result[0])]));
        if (!isActive()) return;
        const initialResults = new Map(settledInitial);
        const topologyResult = initialResults.get('topology');
        const archiveResult = initialResults.get('archive');
        let archiveBlob = archiveResult?.status === 'fulfilled' ? archiveResult.value : null;
        let archiveMembers = archiveBlob ? await extractBioEmuTarArtifacts(archiveBlob) : {};
        if (topologyResult?.status === 'rejected' && artifacts.finalDirectory && !archiveBlob) {
          archiveBlob = await getArtifactBlob(artifacts.finalDirectory.id, 'original', {
            signal: abortController.signal,
            onProgress: reportProgress,
          });
          if (!isActive()) return;
          archiveMembers = await extractBioEmuTarArtifacts(archiveBlob);
        }
        if (topologyResult?.status === 'rejected' && !archiveMembers.topology) throw topologyResult.reason;
        if (!topologyResult && archiveResult?.status === 'rejected') throw archiveResult.reason;
        const topologyBlob = topologyResult?.status === 'fulfilled'
          ? topologyResult.value
          : archiveMembers.topology?.blob;
        if (!topologyBlob) {
          setPageError('El directorio final publicado no contiene un archivo topology.pdb reconocible.');
          setEmptyTitle('Topología no disponible');
          setLoadState('empty');
          return;
        }
        const nextPdbText = await topologyBlob.text();
        const metadataResult = initialResults.get('metadata');
        const frameIndexResult = initialResults.get('frameIndex');
        const metadataText = metadataResult?.status === 'fulfilled'
          ? await metadataResult.value.text()
          : archiveMembers.metadata ? await archiveMembers.metadata.blob.text() : null;
        const frameIndexText = frameIndexResult?.status === 'fulfilled'
          ? await frameIndexResult.value.text()
          : archiveMembers.frameIndex ? await archiveMembers.frameIndex.blob.text() : null;
        let nextMetadata = parseBioEmuMetadata(metadataText);
        let nextFrameIndex = parseFrameIndex(frameIndexText, artifacts.frameIndex?.media_type ?? archiveMembers.frameIndex?.mediaType);
        const nextSummary = parsePdbSummary(nextPdbText);
        let nextSequenceError = validatePdbSequenceCompatibility(nextProtein.sequence, nextSummary, nextMetadata);
        if (!isActive()) return;
        setPdbText(nextPdbText);
        setMetadata(nextMetadata);
        setFrameIndex(nextFrameIndex);
        setStructureSummary(nextSummary);
        setCompatibilityError(nextSequenceError);
        setPhase(nextSequenceError ? 'Verificando compatibilidad' : 'Cargando topología');
        setStructureReady(true);

        if (!artifacts.trajectory && !archiveMembers.trajectory && !artifacts.finalDirectory) {
          setTrajectoryLoadStatus('missing');
          setPhase('Sin trayectoria disponible');
          setLoadState('ready');
          return;
        }
        if (nextSequenceError) {
          setTrajectoryLoadStatus('incompatible');
          setPhase('Trayectoria incompatible');
          setLoadState('ready');
          return;
        }

        if (!artifacts.trajectory && !archiveMembers.trajectory && artifacts.finalDirectory && !archiveBlob) {
          setTrajectoryLoadStatus('loading');
          setPhase('Cargando trayectoria');
          setLoadState('ready');
          try {
            archiveBlob = await getArtifactBlob(artifacts.finalDirectory.id, 'original', {
              signal: abortController.signal,
              onProgress: reportProgress,
            });
            if (!isActive()) return;
            archiveMembers = await extractBioEmuTarArtifacts(archiveBlob);
            if (!nextMetadata && archiveMembers.metadata) {
              nextMetadata = parseBioEmuMetadata(await archiveMembers.metadata.blob.text());
              setMetadata(nextMetadata);
              nextSequenceError = validatePdbSequenceCompatibility(nextProtein.sequence, nextSummary, nextMetadata);
              if (nextSequenceError) {
                setCompatibilityError(nextSequenceError);
                setTrajectoryLoadStatus('incompatible');
                setPhase('Trayectoria incompatible');
                setLoadState('ready');
                return;
              }
            }
            if (!nextFrameIndex.length && archiveMembers.frameIndex) {
              nextFrameIndex = parseFrameIndex(await archiveMembers.frameIndex.blob.text(), archiveMembers.frameIndex.mediaType);
              setFrameIndex(nextFrameIndex);
            }
          } catch (error) {
            if (!isActive()) return;
            setTrajectoryIssue({ state: 'error', message: userErrorMessage(error, 'No se pudo leer el directorio final publicado por BioEmu.') });
            setTrajectoryLoadStatus('error');
            setPhase('Error al cargar');
            setLoadState('ready');
            return;
          }
        }
        const trajectoryArtifact = artifacts.trajectory;
        const trajectoryFromArchive = archiveMembers.trajectory?.blob;
        if (!trajectoryArtifact && !trajectoryFromArchive) {
          setTrajectoryLoadStatus('missing');
          setPhase('Sin trayectoria disponible');
          setLoadState('ready');
          return;
        }

        setTrajectoryLoadStatus('loading');
        setPhase('Cargando trayectoria');
        setLoadState('ready');
        const metricsRequest = artifacts.conformerMetrics && artifacts.conformerMetrics.size <= 5 * 1024 * 1024
          ? loadArtifact(artifacts.conformerMetrics)
          : Promise.resolve(null);
        const trajectoryRequest = trajectoryArtifact
          ? loadArtifact(trajectoryArtifact, reportProgress)
          : Promise.resolve(trajectoryFromArchive);
        const [trajectoryResult, metricsResult] = await Promise.allSettled([trajectoryRequest, metricsRequest]);
        if (!isActive()) return;
        if (trajectoryResult.status === 'rejected') {
          setTrajectoryIssue({ state: 'error', message: userErrorMessage(trajectoryResult.reason, 'No se pudo preparar samples.xtc.') });
          setTrajectoryLoadStatus('error');
          setPhase('Error al cargar');
          setLoadState('ready');
          return;
        }
        let nextXtcBytes;
        try {
          nextXtcBytes = new Uint8Array(await trajectoryResult.value.arrayBuffer());
        } catch {
          setTrajectoryIssue({ state: 'error', message: 'No se pudieron preparar los bytes de samples.xtc para Mol*.' });
          setTrajectoryLoadStatus('error');
          setPhase('Error al cargar');
          return;
        }
        if (!isActive()) return;
        setXtcBytes(nextXtcBytes);
        setTrajectoryLoadStatus('ready');
        if (metricsResult.status === 'fulfilled' && metricsResult.value) {
          setMetrics(parseConformerMetrics(await metricsResult.value.text(), artifacts.conformerMetrics.media_type));
        }
        setPhase('Verificando compatibilidad');
        setLoadState('ready');
      } catch (error) {
        if (!isActive()) return;
        setPageError(userErrorMessage(error, 'No se pudieron leer los artefactos publicados por BioEmu.'));
        setLoadState('error');
      }
    }

    void load();
    return () => {
      active = false;
      abortController.abort();
    };
  }, [proteinId, requestedRunId]);

  const sequenceChain = useMemo(() => (
    findSequenceChain(structureSummary, protein?.sequence)
      ?? structureSummary?.chains?.[0]
      ?? null
  ), [structureSummary, protein?.sequence]);
  const sequenceCompatible = !compatibilityError && Boolean(findSequenceChain(structureSummary, protein?.sequence));
  const selectedResidue = useMemo(() => selectedResidueFor(sequenceChain, selectedPosition), [sequenceChain, selectedPosition]);
  const selectedMetric = useMemo(() => {
    if (trajectoryIssue?.state === 'selection-error') return null;
    if (!selectedResidue || !Number.isInteger(currentIndex) || !Number.isInteger(frameCount)) return null;
    return getPublishedFrustratometerValue(metrics, currentIndex, selectedResidue.position, selectedResidue.aminoAcid, frameCount);
  }, [metrics, currentIndex, frameCount, selectedResidue, trajectoryIssue?.state]);

  useEffect(() => {
    if (!frameCount || !trajectoryReady) {
      controllerRef.current = null;
      setController(null);
      setPlaying(false);
      return undefined;
    }
    const nextController = createBioEmuPlayback({
      frameCount,
      applyIndex: trajectoryReady.applyFrame,
      maxInterpolationSteps: trajectoryReady.maxInterpolationSteps,
      onError: (error) => {
        const selectionError = /selección actual dejó de corresponder/i.test(String(error?.message ?? ''));
        handleTrajectoryIssue(selectionError
          ? { state: 'selection-error', message: 'El residuo seleccionado dejó de corresponder con topology.pdb.' }
          : { state: 'error', message: 'Mol* no pudo actualizar las coordenadas del conformero. La reproducción se detuvo.' });
      },
      initialIndex: 0,
      speed,
      loop,
      onIndex: setCurrentIndex,
      onPlaying: setPlaying,
    });
    controllerRef.current = nextController;
    setController(nextController);
    setCurrentIndex(0);
    return () => {
      nextController.dispose();
      if (controllerRef.current === nextController) controllerRef.current = null;
    };
  }, [frameCount, trajectoryReady]);

  const handleTrajectoryReady = useCallback((result) => {
    setTrajectoryReady(result);
    setFrameCount(result.frameCount);
    setCurrentIndex(0);
    setTrajectoryIssue(null);
    setPhase('Listo');
  }, []);

  const handleTrajectoryIssue = useCallback((issue) => {
    setTrajectoryIssue(issue);
    if (issue.state === 'trajectory-missing') {
      setTrajectoryLoadStatus('missing');
      setPhase('Sin trayectoria disponible');
    } else if (issue.state === 'incompatible') {
      setTrajectoryLoadStatus('incompatible');
      setPhase('Trayectoria incompatible');
      setFrameCount(null);
      setCurrentIndex(null);
    } else if (issue.state === 'error') {
      setTrajectoryLoadStatus('error');
      setPhase('Error al cargar');
      setFrameCount(null);
      setCurrentIndex(null);
    } else if (issue.state === 'selection-error') {
      setPhase('Selección no disponible');
      controllerRef.current?.pause();
      setPlaying(false);
    }
  }, []);

  const toggleResidue = (position) => {
    if (!sequenceCompatible || !Number.isInteger(position)) return;
    setSelectedPosition((current) => current === position ? null : position);
  };

  const onStructurePick = (position) => {
    if (!sequenceCompatible || !Number.isInteger(position)) return;
    setSelectedPosition((current) => current === position ? null : position);
  };

  if (loadState === 'loading') {
    const progress = transferProgress?.total
      ? `${formatBytes(transferProgress.loaded)} / ${formatBytes(transferProgress.total)}`
      : transferProgress ? `${formatBytes(transferProgress.loaded)} recibidos` : '';
    return <section class="frustration-page"><StatePanel kind="loading" fill title={phase} description="Leyendo una sola vez la topología, la trayectoria y los metadatos publicados." meta={progress} /></section>;
  }
  if (loadState === 'error') {
    return <section class="frustration-page"><StatePanel kind="error" fill title="No se pudieron preparar los conformeros" description={pageError} /></section>;
  }
  if (loadState === 'empty') {
    return <section class="frustration-page"><StatePanel kind="empty" fill title={emptyTitle} description={pageError} /></section>;
  }
  if (!structureReady || !pdbText) {
    return <section class="frustration-page"><StatePanel kind="empty" fill title="Topología no disponible" description={pageError || 'No se encontró topology.pdb para esta corrida.'} /></section>;
  }

  const stateLabel = trajectoryIssue?.state === 'selection-error'
    ? 'Selección no disponible'
    : trajectoryIssue?.state === 'incompatible' || compatibilityError
    ? 'Trayectoria incompatible'
    : trajectoryIssue?.state === 'error'
      ? 'Error al cargar'
      : Number.isInteger(frameCount)
        ? (playing ? 'Reproduciendo' : 'Pausado')
        : trajectoryLoadStatus === 'loading'
          ? phase
          : trajectoryIssue?.state === 'error'
            ? 'Error al cargar'
            : trajectoryLoadStatus === 'incompatible' || compatibilityError
              ? 'Trayectoria incompatible'
              : 'Sin trayectoria disponible';
  return (
    <section class="frustration-page bioemu-page" aria-label="Conformeros BioEmu">
      <div class="frustration-chain-card bioemu-sequence-card">
        <SequenceStrip chain={sequenceChain} selectedPosition={selectedPosition} onSelect={toggleResidue} selectable={sequenceCompatible} />
      </div>

      <div class="frustration-workspace topology-workspace bioemu-workspace">
        <article class="frustration-method-card bioemu-visual-card">
          <header class="frustration-method-head topology-method-head">
            <h2>Conformeros BioEmu</h2>
          </header>
          <div class="bioemu-viewer-region">
            {trajectoryLoadStatus === 'loading' && (
              <StatePanel
                kind="loading"
                compact
                title="Cargando trayectoria"
                description="Descargando samples.xtc una sola vez antes de preparar la estructura molecular."
                meta={transferProgress?.total
                  ? `${formatBytes(transferProgress.loaded)} / ${formatBytes(transferProgress.total)}`
                  : transferProgress ? `${formatBytes(transferProgress.loaded)} recibidos` : ''}
                className="frustration-viewport-state"
              />
            )}
            {structureReady && trajectoryLoadStatus !== 'loading' && (
              <BioEmuStructure
                pdbText={pdbText}
                xtcBytes={xtcBytes}
                metadata={metadata}
                frameIndex={frameIndex}
                selectedPosition={selectedPosition}
                sequenceChain={sequenceChain}
                compatibilityError={compatibilityError}
                externalIssue={trajectoryIssue}
                onPick={onStructurePick}
                onTrajectoryReady={handleTrajectoryReady}
                onTrajectoryIssue={handleTrajectoryIssue}
              />
            )}
          </div>
          <BioEmuControls
            frameCount={frameCount}
            currentIndex={currentIndex}
            playing={playing}
            speed={speed}
            loop={loop}
            controller={controller}
            disabled={Boolean(compatibilityError || ['incompatible', 'error', 'selection-error'].includes(trajectoryIssue?.state))}
            onSpeedChange={(value) => { setSpeed(value); controller?.setSpeed(value); }}
            onLoopChange={(value) => { setLoop(value); controller?.setLoop(value); }}
          />
        </article>

        <BioEmuPanel
          run={run}
          protein={protein}
          metadata={metadata}
          structureSummary={structureSummary}
          frameCount={frameCount}
          currentIndex={currentIndex}
          stateLabel={stateLabel}
          frameIndex={frameIndex}
          metric={selectedMetric}
          selectedResidue={selectedResidue}
          publishedMetricsAvailable={metrics.length > 0 && metrics.length === frameCount}
        />
      </div>
    </section>
  );
}
