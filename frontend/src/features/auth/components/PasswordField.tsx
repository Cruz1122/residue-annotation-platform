import { useState } from 'preact/hooks';
import LucideIcon from '@shared/components/icons/LucideIcon.jsx';

interface PasswordFieldProps {
  autoComplete: string;
  describedBy?: string;
  disabled?: boolean;
  id: string;
  label: string;
  maxLength?: number;
  minLength?: number;
  name: string;
  onInput: (value: string) => void;
  placeholder?: string;
  value: string;
}

export function PasswordField({
  autoComplete,
  describedBy,
  disabled = false,
  id,
  label,
  maxLength = 128,
  minLength,
  name,
  onInput,
  placeholder,
  value,
}: PasswordFieldProps) {
  const [visible, setVisible] = useState(false);

  return (
    <label class="auth-field" for={id}>
      <span>{label}</span>
      <span class="auth-input-wrap">
        <input
          id={id}
          name={name}
          type={visible ? 'text' : 'password'}
          value={value}
          onInput={(event) => onInput(event.currentTarget.value)}
          autoComplete={autoComplete}
          aria-describedby={describedBy}
          placeholder={placeholder}
          minLength={minLength}
          maxLength={maxLength}
          disabled={disabled}
          required
        />
        <button
          class="auth-input-action"
          type="button"
          onClick={() => setVisible((current) => !current)}
          aria-label={visible ? `Ocultar ${label.toLowerCase()}` : `Mostrar ${label.toLowerCase()}`}
          aria-pressed={visible}
          disabled={disabled}
        >
          <LucideIcon name={visible ? 'eye-off' : 'eye'} />
        </button>
      </span>
    </label>
  );
}

