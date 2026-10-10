import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import LucideIcon from '@shared/components/icons/LucideIcon.jsx';
import { RESIDUES } from '@features/proteins/data/protein.js';
import { writeSession } from '@shared/lib/session.js';
import { withViewTransition } from '@shared/lib/transition.js';
import '@features/runs/styles/onboarding.css';

const VALID_AA = new Set('ACDEFGHIKLMNPQRSTVWY'.split(''));

function UploadCard({ kind, label, icon, accept, state, onStart }) {
  const inputRef = useRef(null);
  const loading = state.status === 'loading';
  const done = state.status === 'done';

  const openPicker = () => {
    if (!loading) inputRef.current?.click();
  };

  const handleFile = (file) => {
    if (!file || loading) return;
    onStart(kind, file);
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

function VariantSequence({ selectedIndex, variantsRef, onSelect, buttonRefs }) {
  const rows = useMemo(() => {
    const rowSize = 25;
    const result = [];
    for (let start = 0; start < RESIDUES.length; start += rowSize) {
      result.push(RESIDUES.slice(start, start + rowSize).map((residue, offset) => ({ residue, index: start + offset })));
    }
    return result;
  }, []);

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
              {row.map(({ residue, index }) => {
                const variant = variantsRef.current.get(index);
                return (
                  <button
                    key={index}
                    ref={(node) => { if (node) buttonRefs.current[index] = node; }}
                    class={`variant-residue-button ${selectedIndex === index ? 'selected' : ''} ${variant ? 'has-variant' : ''}`}
                    type="button"
                    data-variant-index={index}
                    aria-pressed={selectedIndex === index ? 'true' : 'false'}
                    title={`${residue.compId} ${residue.authSeqId}`}
                  >
                    {residue.one}
                  </button>
                );
              })}
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
    pdb: { status: 'idle', progress: 0, name: null },
    fasta: { status: 'idle', progress: 0, name: null },
  });
  const [hasVariants, setHasVariants] = useState(false);
  const variantsRef = useRef(new Map());
  const buttonRefs = useRef([]);
  const altInputRef = useRef(null);
  const swapTimerRef = useRef(null);
  const showingMutantRef = useRef(false);

  const ready = upload.pdb.status === 'done' || upload.fasta.status === 'done';
  const selectedResidue = selectedIndex === null ? null : RESIDUES[selectedIndex];

  const startMockUpload = (kind, file) => {
    const valid = kind === 'pdb'
      ? /\.pdb$/i.test(file.name || '')
      : /\.(fasta|fa|faa|fas|fna)$/i.test(file.name || '');
    if (!valid) return;

    setUpload((current) => ({
      ...current,
      [kind]: { status: 'loading', progress: 4, name: file.name },
    }));

    const checkpoints = [12, 24, 39, 57, 72, 86, 96, 100];
    let index = 0;
    const timer = window.setInterval(() => {
      const progress = checkpoints[index++] ?? 100;
      setUpload((current) => ({
        ...current,
        [kind]: { ...current[kind], progress, status: progress >= 100 ? 'done' : 'loading' },
      }));
      if (progress >= 100) window.clearInterval(timer);
    }, 175);
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
    button.textContent = RESIDUES[index].one;
  };

  const updateSelectedVariant = (rawValue) => {
    if (selectedIndex === null) return;
    const value = String(rawValue || '').toUpperCase().replace(/[^ACDEFGHIKLMNPQRSTVWY]/g, '').slice(0, 1);
    const residue = RESIDUES[selectedIndex];
    if (value && VALID_AA.has(value)) {
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
    setVariantButtonState(selectedIndex, value);
    setHasVariants(variantsRef.current.size > 0);
    if (altInputRef.current) {
      altInputRef.current.value = value;
      altInputRef.current.classList.toggle('valid', Boolean(value));
    }
  };

  const selectResidue = (index) => {
    if (!Number.isInteger(index)) return;
    setSelectedIndex(index);
    const stored = variantsRef.current.get(index)?.alt ?? '';
    queueMicrotask(() => {
      if (!altInputRef.current) return;
      altInputRef.current.value = stored;
      altInputRef.current.classList.toggle('valid', Boolean(stored));
      altInputRef.current.focus();
    });
  };

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

  const persist = () => {
    writeSession({
      uploaded: {
        pdb: upload.pdb.status === 'done' ? upload.pdb.name : null,
        fasta: upload.fasta.status === 'done' ? upload.fasta.name : null,
      },
      variants: Array.from(variantsRef.current.values()),
      runStartedAt: Date.now(),
    });
  };

  return (
    <section class="onboarding-shell" aria-label="Carga de proteína">
      <div class="onboarding-inner">
        {step === 1 ? (
          <div class="onboarding-step onboarding-step-upload">
            <h1>¡Ingresa tu proteína!</h1>
            <p class="onboarding-subtitle">Adjunta o arrastra los archivos correspondientes</p>
            <div class="upload-options">
              <UploadCard kind="pdb" label="PDB" icon="atom" accept=".pdb,chemical/x-pdb" state={upload.pdb} onStart={startMockUpload} />
              <UploadCard kind="fasta" label="FASTA" icon="dna" accept=".fasta,.fa,.faa,.fas,.fna,text/plain" state={upload.fasta} onStart={startMockUpload} />
            </div>
            <button class={`onboarding-ready ${ready ? 'visible' : ''}`} type="button" disabled={!ready} onClick={showVariants}>
              ¡Estoy listo!
            </button>
          </div>
        ) : (
          <div class="onboarding-step onboarding-step-variants">
            <h1>Seleccionar variantes</h1>
            <p class="onboarding-subtitle">Opcional · selecciona posiciones y cambia el aminoácido mutante. Los cambios persisten automáticamente.</p>

            <section class="variant-stage" aria-label="Cadena completa para seleccionar variantes">
              <header class="variant-sequence-head">
                <strong>Cadena A</strong>
                <span>860 residuos · selecciona una posición</span>
              </header>
              <VariantSequence
                selectedIndex={selectedIndex}
                variantsRef={variantsRef}
                onSelect={selectResidue}
                buttonRefs={buttonRefs}
              />
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

            <a class="onboarding-ready visible" href="/proteins/" onClick={persist}>
              {hasVariants ? 'Continuar' : 'Omitir y continuar'}
            </a>
          </div>
        )}
      </div>
    </section>
  );
}
