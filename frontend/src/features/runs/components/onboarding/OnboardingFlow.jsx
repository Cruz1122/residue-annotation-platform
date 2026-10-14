import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import LucideIcon from '@shared/components/icons/LucideIcon.jsx';
import { withViewTransition } from '@shared/lib/transition.js';
import { StatusNotice } from '@features/auth/components/AuthFrame';
import { ApiError, createProtein, createRun, uploadInput } from '@shared/api/client';
import '@features/runs/styles/onboarding.css';

const VALID_AA = new Set('ACDEFGHIKLMNPQRSTVWY'.split(''));
const FASTA_EXTENSIONS = /\.(fasta|fa|faa|fas|fna)$/i;
const STRUCTURE_EXTENSIONS = /\.(pdb|cif|mmcif)$/i;
const RESIDUE_NAMES = {
  A: 'ALA', C: 'CYS', D: 'ASP', E: 'GLU', F: 'PHE', G: 'GLY', H: 'HIS', I: 'ILE',
  K: 'LYS', L: 'LEU', M: 'MET', N: 'ASN', P: 'PRO', Q: 'GLN', R: 'ARG', S: 'SER',
  T: 'THR', V: 'VAL', W: 'TRP', Y: 'TYR',
};

function parseFasta(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const headers = lines.filter((line) => line.trim().startsWith('>'));
  if (headers.length > 1) return { error: 'Solo se admite un registro FASTA por archivo.' };
  const sequence = lines
    .filter((line) => !line.trim().startsWith('>'))
    .join('')
    .replace(/\s+/g, '')
    .toUpperCase();
  if (!sequence) return { error: 'El archivo FASTA no contiene una secuencia.' };
  const invalid = [...new Set(sequence.split('').filter((symbol) => !VALID_AA.has(symbol)))];
  if (invalid.length) {
    return { error: `Símbolo de aminoácido no permitido: ${invalid.join(', ')}.` };
  }
  return { sequence };
}

const THREE_TO_ONE = {
  ALA: 'A', ARG: 'R', ASN: 'N', ASP: 'D', CYS: 'C', GLN: 'Q', GLU: 'E', GLY: 'G',
  HIS: 'H', ILE: 'I', LEU: 'L', LYS: 'K', MET: 'M', MSE: 'M', PHE: 'F', PRO: 'P',
  SER: 'S', THR: 'T', TRP: 'W', TYR: 'Y', VAL: 'V',
};

function parsePdbSequence(text) {
  const residues = [];
  const seen = new Set();
  let chain = null;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!line.startsWith('ATOM') && !line.startsWith('HETATM')) continue;
    if (line.slice(12, 16).trim() !== 'CA') continue;
    const one = THREE_TO_ONE[line.slice(17, 20).trim().toUpperCase()];
    if (!one) continue;
    const chainId = line.slice(21, 22);
    if (chain === null) chain = chainId;
    if (chainId !== chain) continue;
    const key = `${chainId}:${line.slice(22, 27)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    residues.push(one);
  }
  if (!residues.length) {
    return { error: 'No se pudo extraer la secuencia del PDB (no se encontraron átomos CA).' };
  }
  return { sequence: residues.join(''), chain };
}

function UploadCard({ kind, label, icon, accept, state, onFile }) {
  const inputRef = useRef(null);
  const loading = state.status === 'loading';
  const done = state.status === 'done';

  const openPicker = () => {
    if (!loading) inputRef.current?.click();
  };

  const handleFile = (file) => {
    if (!file || loading) return;
    onFile(kind, file);
  };

  return (
    <div class="upload-option">
      <button
        class={`upload-card ${loading ? 'is-loading' : ''} ${done ? 'is-done' : ''}`}
        type="button"
        disabled={loading}
        aria-label={`Adjuntar archivo ${label}`}
        onClick={openPicker}
        onDragOver={(event) => {
          if (loading) return;
          event.preventDefault();
          event.currentTarget.classList.add('dragging');
        }}
        onDragLeave={(event) => event.currentTarget.classList.remove('dragging')}
        onDrop={(event) => {
          if (loading) return;
          event.preventDefault();
          event.currentTarget.classList.remove('dragging');
          handleFile(event.dataTransfer?.files?.[0]);
        }}
      >
        <span class="upload-icon"><LucideIcon name={icon} /></span>
        <span class="upload-hover-label">Adjunta tu {label}</span>
        <span class="upload-progress" aria-hidden="true">
          <span class="upload-progress-fill" style={{ width: `${state.progress}%` }} />
        </span>
      </button>
      <div class="upload-label">{label}</div>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        hidden
        onChange={(event) => handleFile(event.currentTarget.files?.[0])}
      />
    </div>
  );
}

function VariantSequence({ residues, variantsRef, onSelect, buttonRefs }) {
  const rows = useMemo(() => {
    const rowSize = 25;
    const result = [];
    for (let start = 0; start < residues.length; start += rowSize) {
      result.push(residues.slice(start, start + rowSize).map((residue, offset) => ({ residue, index: start + offset })));
    }
    return result;
  }, [residues]);

  return (
    <div class="variant-sequence" onClick={(event) => {
      const button = event.target.closest?.('[data-variant-index]');
      if (button) onSelect(Number(button.dataset.variantIndex));
    }}>
      {rows.map((row) => {
        const first = row[0].residue.authSeqId;
        const last = row[row.length - 1].residue.authSeqId;
        return (
          <div class="variant-seq-row" key={first}>
            <span class="variant-seq-pos">{first}</span>
            <div class="variant-residues">
              {row.map(({ residue, index }) => (
                <button
                  key={index}
                  ref={(node) => { if (node) buttonRefs.current[index] = node; }}
                  class="variant-residue-button"
                  type="button"
                  data-variant-index={index}
                  aria-pressed="false"
                  title={`${residue.compId} ${residue.authSeqId}`}
                >
                  {residue.one}
                </button>
              ))}
            </div>
            <span class="variant-seq-pos">{last}</span>
          </div>
        );
      })}
    </div>
  );
}

export default function OnboardingFlow() {
  const [step, setStep] = useState(1);
  const [selectedIndex, setSelectedIndex] = useState(null);
  const [upload, setUpload] = useState({
    pdb: { status: 'idle', progress: 0, name: null, file: null, sequence: '' },
    fasta: { status: 'idle', progress: 0, name: null, file: null, text: null, sequence: '' },
  });
  const [hasVariants, setHasVariants] = useState(false);
  const [state, setState] = useState('idle');
  const [error, setError] = useState('');
  const [blockedRun, setBlockedRun] = useState(null);
  const variantsRef = useRef(new Map());
  const buttonRefs = useRef([]);
  const altInputRef = useRef(null);
  const swapTimerRef = useRef(null);
  const showingMutantRef = useRef(false);
  const selectedIndexRef = useRef(null);

  const sequence = upload.fasta.status === 'done' ? upload.fasta.sequence : upload.pdb.sequence;
  const residues = useMemo(
    () => sequence.split('').map((one, index) => ({
      one,
      compId: RESIDUE_NAMES[one] ?? one,
      authSeqId: index + 1,
    })),
    [sequence],
  );
  const ready = sequence.length > 0;
  const submitting = state === 'submitting';
  const selectedResidue = selectedIndex === null ? null : residues[selectedIndex] ?? null;

  const resetFasta = () => {
    setUpload((current) => ({
      ...current,
      fasta: { status: 'idle', progress: 0, name: null, file: null, text: null, sequence: '' },
    }));
  };

  const resetPdb = () => {
    setUpload((current) => ({
      ...current,
      pdb: { status: 'idle', progress: 0, name: null, file: null, sequence: '' },
    }));
  };

  const loadFasta = async (file) => {
    if (!FASTA_EXTENSIONS.test(file.name || '')) {
      setError('Selecciona un archivo FASTA (.fasta, .fa, .faa, .fas o .fna).');
      return;
    }
    setError('');
    setUpload((current) => ({
      ...current,
      fasta: { status: 'loading', progress: 10, name: file.name, file, text: null, sequence: '' },
    }));
    let text;
    try {
      text = await file.text();
    } catch {
      setError('No se pudo leer el archivo FASTA.');
      resetFasta();
      return;
    }
    const parsed = parseFasta(text);
    if (parsed.error) {
      setError(parsed.error);
      resetFasta();
      return;
    }
    variantsRef.current.clear();
    selectedIndexRef.current = null;
    setSelectedIndex(null);
    setHasVariants(false);
    setUpload((current) => ({
      ...current,
      fasta: { status: 'done', progress: 100, name: file.name, file, text, sequence: parsed.sequence },
    }));
  };

  const loadStructure = async (file) => {
    if (!STRUCTURE_EXTENSIONS.test(file.name || '')) {
      setError('Selecciona una estructura PDB o mmCIF.');
      return;
    }
    setError('');
    setUpload((current) => ({
      ...current,
      pdb: { status: 'loading', progress: 10, name: file.name, file, sequence: '' },
    }));
    if (!/\.pdb$/i.test(file.name || '')) {
      // mmCIF se adjunta como estructura; la secuencia debe venir del FASTA.
      setUpload((current) => ({
        ...current,
        pdb: { status: 'done', progress: 100, name: file.name, file, sequence: '' },
      }));
      if (upload.fasta.status !== 'done') {
        setError('Para mmCIF adjunta también un FASTA (o usa un PDB).');
      }
      return;
    }
    let text;
    try {
      text = await file.text();
    } catch {
      setError('No se pudo leer el archivo PDB.');
      resetPdb();
      return;
    }
    const parsed = parsePdbSequence(text);
    setUpload((current) => ({
      ...current,
      pdb: { status: 'done', progress: 100, name: file.name, file, sequence: parsed.sequence ?? '' },
    }));
    if (parsed.error && upload.fasta.status !== 'done') setError(parsed.error);
  };

  const handleFile = (kind, file) => {
    if (kind === 'pdb') loadStructure(file);
    else loadFasta(file);
  };

  const showVariants = () => {
    if (!ready) return;
    withViewTransition(() => setStep(2));
  };

  const setVariantButtonState = (index, alt) => {
    const button = buttonRefs.current[index];
    if (!button) return;
    button.classList.toggle('has-variant', Boolean(alt));
    button.classList.remove('showing-mutant');
    button.textContent = residues[index].one;
  };

  const updateSelectedVariant = (rawValue) => {
    if (selectedIndex === null) return;
    const value = String(rawValue || '').toUpperCase().replace(/[^ACDEFGHIKLMNPQRSTVWY]/g, '').slice(0, 1);
    const residue = residues[selectedIndex];
    if (value && VALID_AA.has(value) && value !== residue.one) {
      variantsRef.current.set(selectedIndex, {
        index: selectedIndex,
        ref: residue.one,
        alt: value,
        aa_position: residue.authSeqId,
        aa_ref: residue.one,
        aa_alt: value,
        label: `${residue.one}${residue.authSeqId}${value}`,
      });
    } else {
      variantsRef.current.delete(selectedIndex);
    }
    setVariantButtonState(selectedIndex, value && value !== residue.one ? value : '');
    setHasVariants(variantsRef.current.size > 0);
    if (altInputRef.current) {
      altInputRef.current.value = value;
      altInputRef.current.classList.toggle('valid', Boolean(value && value !== residue.one));
    }
  };

  // La selección se aplica directo en el DOM: la lista de residuos no se
  // vuelve a renderizar al cambiar de posición (evita el lag con cadenas largas).
  const selectResidue = useCallback((index) => {
    if (!Number.isInteger(index)) return;
    const previous = selectedIndexRef.current;
    if (previous !== null && previous !== index) {
      const previousButton = buttonRefs.current[previous];
      if (previousButton) {
        previousButton.classList.remove('selected');
        previousButton.setAttribute('aria-pressed', 'false');
      }
    }
    const button = buttonRefs.current[index];
    if (button) {
      button.classList.add('selected');
      button.setAttribute('aria-pressed', 'true');
    }
    selectedIndexRef.current = index;
    setSelectedIndex(index);
    const stored = variantsRef.current.get(index)?.alt ?? '';
    queueMicrotask(() => {
      if (!altInputRef.current) return;
      altInputRef.current.value = stored;
      altInputRef.current.classList.toggle('valid', Boolean(stored));
      altInputRef.current.focus();
    });
  }, []);

  useEffect(() => {
    if (step !== 2) return undefined;
    const tick = () => {
      showingMutantRef.current = !showingMutantRef.current;
      for (const variant of variantsRef.current.values()) {
        const button = buttonRefs.current[variant.index];
        if (!button) continue;
        button.textContent = showingMutantRef.current ? variant.alt : variant.ref;
        button.classList.toggle('showing-mutant', showingMutantRef.current);
      }
    };
    swapTimerRef.current = window.setInterval(tick, 2000);
    return () => window.clearInterval(swapTimerRef.current);
  }, [step]);

  const variantSequence = useMemo(() => (
    <VariantSequence
      residues={residues}
      variantsRef={variantsRef}
      onSelect={selectResidue}
      buttonRefs={buttonRefs}
    />
  ), [residues, selectResidue]);

  const submit = async () => {
    if (!ready || submitting) return;
    setState('submitting');
    setError('');
    setBlockedRun(null);
    try {
      const protein = upload.fasta.status === 'done'
        ? await createProtein({ fasta: upload.fasta.text, aliases: [] })
        : await createProtein({ sequence, aliases: [] });
      const uploadIds = [];
      if (upload.fasta.file) uploadIds.push((await uploadInput(upload.fasta.file, 'fasta')).id);
      if (upload.pdb.file) uploadIds.push((await uploadInput(upload.pdb.file, 'structure')).id);
      const variants = [...variantsRef.current.values()]
        .map(({ aa_position, aa_ref, aa_alt }) => ({ aa_position, aa_ref, aa_alt }))
        .sort((a, b) => a.aa_position - b.aa_position);
      const run = await createRun({ protein_id: protein.id, variants, upload_ids: uploadIds });
      window.location.assign(`/proteins/${encodeURIComponent(protein.id)}/progress/?run=${encodeURIComponent(run.id)}`);
    } catch (requestError) {
      setState('error');
      if (requestError instanceof ApiError && requestError.status === 409) {
        setBlockedRun(
          requestError.activeRunId && requestError.activeProteinId
            ? { runId: requestError.activeRunId, proteinId: requestError.activeProteinId }
            : null,
        );
        setError('Ya tienes una corrida activa. Ábrela para ver el progreso o cancelarla.');
        return;
      }
      setBlockedRun(null);
      setError(requestError instanceof ApiError
        ? requestError.message
        : 'No se pudo crear la proteína y su corrida. Revisa la conexión e inténtalo de nuevo.');
    }
  };

  return (
    <main class="auth-page onboarding-page" aria-label="Carga de proteína">
      <h1 class={`onboarding-title${step === 1 ? '' : ' is-variants'}`}>{step === 1 ? '¡Ingresa tu proteína!' : 'Seleccionar variantes'}</h1>
      {step === 1 ? (
        <>
          <div class="upload-options">
            <UploadCard kind="pdb" label="PDB" icon="atom" accept=".pdb,.cif,.mmcif,chemical/x-pdb" state={upload.pdb} onFile={handleFile} />
            <UploadCard kind="fasta" label="FASTA" icon="dna" accept=".fasta,.fa,.faa,.fas,.fna,text/plain" state={upload.fasta} onFile={handleFile} />
          </div>
          {error && <StatusNotice kind="error">{error}</StatusNotice>}
          <button class="auth-button onboarding-action" type="button" disabled={!ready} onClick={showVariants}>
            ¡Estoy listo!
          </button>
        </>
      ) : (
        <>
          <p class="onboarding-subtitle">Opcional · selecciona posiciones y cambia el aminoácido mutante. Los cambios persisten automáticamente.</p>

          <section class="variant-stage" aria-label="Cadena completa para seleccionar variantes">
            <header class="variant-sequence-head">
              <strong>Cadena A</strong>
              <span>{residues.length.toLocaleString('es-CO')} residuos · selecciona una posición</span>
            </header>
            {variantSequence}
          </section>

          <div class="variant-compose">
            <div class="variant-selection">
              <span>Residuo seleccionado</span>
              <strong>{selectedResidue ? `${selectedResidue.one}${selectedResidue.authSeqId}` : 'Ninguno'}</strong>
            </div>
            <span class="variant-compose-arrow" aria-hidden="true">→</span>
            <label class={`variant-alt-field ${selectedResidue ? '' : 'disabled'}`}>
              <span>Aminoácido mutante</span>
              <input
                ref={altInputRef}
                class="variant-mutant"
                type="text"
                maxLength={1}
                inputMode="text"
                autoComplete="off"
                spellCheck={false}
                aria-label="Aminoácido mutante"
                placeholder="X"
                disabled={!selectedResidue}
                onInput={(event) => updateSelectedVariant(event.currentTarget.value)}
              />
            </label>
          </div>

          {error && (
            <StatusNotice kind="error">
              {error}
              {blockedRun && (
                <>
                  {' '}
                  <a href={`/proteins/${encodeURIComponent(blockedRun.proteinId)}/progress/?run=${encodeURIComponent(blockedRun.runId)}`}>Abrir la corrida activa</a>
                </>
              )}
            </StatusNotice>
          )}
          <button class="auth-button onboarding-action" type="button" disabled={submitting} onClick={submit}>
            {submitting ? 'Creando corrida…' : hasVariants ? 'Continuar' : 'Omitir y continuar'}
          </button>
        </>
      )}
    </main>
  );
}
