import { useState } from 'preact/hooks';
import { ApiError, getArtifactBlob } from '@shared/api/client';
import LucideIcon from '@shared/components/icons/LucideIcon.jsx';
import './artifact-download.css';

interface AuthenticatedArtifactLinkProps {
  id: string;
  filename?: string;
  mediaType?: string;
}

export default function AuthenticatedArtifactLink({
  id,
  filename,
  mediaType,
}: AuthenticatedArtifactLinkProps) {
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [error, setError] = useState('');
  const artifactName = filename ?? id;

  const download = async () => {
    setState('loading');
    setError('');
    try {
      const objectUrl = URL.createObjectURL(await getArtifactBlob(id));
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = artifactName;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      setState('idle');
    } catch (requestError) {
      setError(requestError instanceof ApiError ? requestError.message : 'No se pudo descargar el artefacto.');
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
        title={`Descargar ${artifactName}`}
      >
        <LucideIcon name="file-text" />
        <span class="artifact-download-name">{state === 'loading' ? 'Descargando…' : artifactName}</span>
        {mediaType && <span class="artifact-download-type">{mediaType}</span>}
        <LucideIcon name="download" />
      </button>
      {state === 'error' && <small role="alert">{error}</small>}
    </span>
  );
}
