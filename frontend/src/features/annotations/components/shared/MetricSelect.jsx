import { useEffect, useRef, useState } from 'preact/hooks';

export default function MetricSelect({ id, label, options, value, onChange, disabled = false }) {
  const rootRef = useRef(null);
  const triggerRef = useRef(null);
  const optionRefs = useRef([]);
  const [open, setOpen] = useState(false);
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
  const [activeIndex, setActiveIndex] = useState(selectedIndex);
  const selected = options[selectedIndex] ?? options[0];

  useEffect(() => {
    setActiveIndex(selectedIndex);
  }, [options, selectedIndex]);

  useEffect(() => {
    if (!open) return undefined;
    const handleOutside = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', handleOutside);
    return () => document.removeEventListener('pointerdown', handleOutside);
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    if (open) optionRefs.current[activeIndex]?.focus();
  }, [activeIndex, open]);

  if (!selected) return null;

  const openAt = (index) => {
    if (disabled) return;
    setActiveIndex(index);
    setOpen(true);
  };
  const choose = (option) => {
    if (disabled) return;
    onChange(option.value);
    setOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  };
  const handleTriggerKeyDown = (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openAt(event.key === 'ArrowUp' ? Math.max(0, selectedIndex - 1) : selectedIndex);
    }
  };
  const handleOptionKeyDown = (event, index) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      choose(options[index]);
      return;
    }
    const navigation = {
      ArrowDown: Math.min(options.length - 1, index + 1),
      ArrowUp: Math.max(0, index - 1),
      Home: 0,
      End: options.length - 1,
    };
    if (navigation[event.key] !== undefined) {
      event.preventDefault();
      setActiveIndex(navigation[event.key]);
    }
  };

  return (
    <div class="frustration-method-select" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        class="frustration-select-trigger"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${id}-options`}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={handleTriggerKeyDown}
      >
        <span>{selected.label}</span>
        <span aria-hidden="true">⌄</span>
      </button>
      {open && (
        <div id={`${id}-options`} class="frustration-select-options" role="listbox" aria-label={label}>
          {options.map((option, index) => (
            <button
              ref={(node) => { optionRefs.current[index] = node; }}
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              class={option.value === value ? 'is-selected' : ''}
              onClick={() => choose(option)}
              onFocus={() => setActiveIndex(index)}
              onKeyDown={(event) => handleOptionKeyDown(event, index)}
            >
              <span>{option.label}</span>
              {option.value === value && <span aria-hidden="true">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
