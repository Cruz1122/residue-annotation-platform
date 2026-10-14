import type { ComponentChildren } from 'preact';
import LucideIcon from '@shared/components/icons/LucideIcon.jsx';

interface AuthFrameProps {
  children: ComponentChildren;
  footer?: ComponentChildren;
  title: string;
  wide?: boolean;
}

export function AuthFrame({ children, footer, title, wide = false }: AuthFrameProps) {
  return (
    <main class={`auth-page${wide ? ' auth-page-wide' : ''}`}>
      <section class="auth-surface" aria-labelledby="auth-title">
        <header class="auth-header">
          <h1 id="auth-title">{title}</h1>
        </header>

        <div class="auth-content">{children}</div>

        {footer && <footer class="auth-footer">{footer}</footer>}
      </section>
    </main>
  );
}

interface StatusNoticeProps {
  children: ComponentChildren;
  kind?: 'error' | 'info' | 'success';
}

export function StatusNotice({ children, kind = 'info' }: StatusNoticeProps) {
  const icon = kind === 'error' ? 'circle-x' : kind === 'success' ? 'circle-check' : 'info';

  return (
    <div class={`auth-notice auth-notice-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      <LucideIcon name={icon} />
      <div>{children}</div>
    </div>
  );
}

interface LoadingStateProps {
  label?: string;
}

export function LoadingState({ label = 'Cargando…' }: LoadingStateProps) {
  return (
    <div class="auth-loading" role="status" aria-live="polite">
      <LucideIcon name="loader-circle" className="auth-spin" />
      <span>{label}</span>
    </div>
  );
}

