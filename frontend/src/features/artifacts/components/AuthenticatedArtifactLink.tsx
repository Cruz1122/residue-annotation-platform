import { useState } from 'preact/hooks';
import { getArtifactBlob } from '@shared/api/client';
import { userErrorMessage } from '@shared/lib/error-presentation';
import {
  artifactDisplayName,
  artifactDownloadFilename,
  artifactDownloadFormat,
  artifactFormatLabel,
} from '@features/artifacts/artifact-display.js';
import type { Artifact } from '@shared/types/domain';
import './artifact-download.css';

interface AuthenticatedArtifactLinkProps {
  id: string;
  artifact?: Artifact;
  filename?: string;
  label?: string;
  mediaType?: string;
  formatLabel?: string;
  downloadFormat?: 'original' | 'xlsx';
}

export default function AuthenticatedArtifactLink({
  id,
  artifact,
  filename,
  label,
  mediaType,
  formatLabel,
  downloadFormat,
}: AuthenticatedArtifactLinkProps) {
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [error, setError] = useState('');
  const resolvedArtifact = artifact ?? { id, artifact_type: '', media_type: mediaType ?? '' } as Artifact;
  const downloadArtifact = {
    ...resolvedArtifact,
    media_type: mediaType ?? resolvedArtifact.media_type,
    download_format: downloadFormat ?? resolvedArtifact.download_format,
    download_filename: filename ?? resolvedArtifact.download_filename,
  };
  const artifactName = artifactDownloadFilename(downloadArtifact);
  const displayName = label ?? artifactDisplayName(downloadArtifact);
  const displayFormat = formatLabel ?? artifactFormatLabel(downloadArtifact);
  const exportFormat = artifactDownloadFormat(downloadArtifact);

  const download = async () => {
    setState('loading');
    setError('');
    try {
      const objectUrl = URL.createObjectURL(await getArtifactBlob(id, exportFormat));
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = artifactName;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      setState('idle');
    } catch (requestError) {
      setError(userErrorMessage(requestError, 'No se pudo descargar el artefacto.'));
      setState('error');
    }
  };

  return (
    <span class="authenticated-artifact">
      <button
        class="artifact-download-link"
        type="button"
        onClick={download}
        disabled={state === 'loading'}
        title={`Descargar ${displayName}`}
      >
        <span class="artifact-download-name">{state === 'loading' ? 'Descargando…' : displayName}</span>
        <span class="artifact-download-type">{displayFormat}</span>
        <span class="artifact-download-action">Descargar</span>
      </button>
      {state === 'error' && <small role="alert">{error}</small>}
    </span>
  );
}
