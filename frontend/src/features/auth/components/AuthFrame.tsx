import type { ComponentChildren } from 'preact';
import PackIcon from '@shared/components/icons/PackIcon.jsx';
import StatePanel from '@shared/components/feedback/StatePanel.jsx';

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
          <a class="auth-brand" href="/" aria-label="Residue Annotation Platform">Residue Annotation Platform</a>
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
      <PackIcon name={icon} kind="ui" />
      <div>{children}</div>
    </div>
  );
}

interface LoadingStateProps {
  label?: string;
}

export function LoadingState({ label = 'Cargando…' }: LoadingStateProps) {
  return (
    <StatePanel kind="loading" compact title={label} className="auth-loading" />
  );
}
