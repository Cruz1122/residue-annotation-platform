import { useState } from 'preact/hooks';
import { getArtifactBlob } from '@shared/api/client';
import { userErrorMessage } from '@shared/lib/error-presentation';
import './artifact-download.css';

interface AuthenticatedArtifactLinkProps {
  id: string;
  filename?: string;
  label?: string;
  mediaType?: string;
}

export default function AuthenticatedArtifactLink({
  id,
  filename,
  label,
  mediaType,
}: AuthenticatedArtifactLinkProps) {
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [error, setError] = useState('');
  const artifactName = filename ?? id;
  const displayName = label ?? artifactName;

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
        {mediaType && <span class="artifact-download-type">{mediaType}</span>}
        <span class="artifact-download-action">Descargar</span>
      </button>
      {state === 'error' && <small role="alert">{error}</small>}
    </span>
  );
}
