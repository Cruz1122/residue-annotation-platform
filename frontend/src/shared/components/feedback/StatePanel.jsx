import PackIcon from '@shared/components/icons/PackIcon.jsx';
import './state-panel.css';

const DEFAULT_ICONS = {
  loading: 'loader-circle',
  waiting: 'clock',
  warning: 'triangle-alert',
  empty: 'box',
  error: 'circle-x',
  success: 'circle-check',
};

const DEFAULT_TITLES = {
  loading: 'Cargando',
  waiting: 'En espera',
  warning: 'Atención',
  empty: 'Sin resultados',
  error: 'No se pudo completar la solicitud',
  success: 'Completado',
};

/**
 * @param {{
 *   kind?: 'loading' | 'waiting' | 'warning' | 'empty' | 'error' | 'success',
 *   icon?: string,
 *   eyebrow?: string,
 *   title?: import('preact').ComponentChildren,
 *   description?: import('preact').ComponentChildren,
 *   meta?: import('preact').ComponentChildren,
 *   compact?: boolean,
 *   fill?: boolean,
 *   className?: string,
 *   children?: import('preact').ComponentChildren,
 * }} props
 */
export default function StatePanel({
  kind = 'empty',
  icon,
  eyebrow = '',
  title = DEFAULT_TITLES[kind],
  description = '',
  meta = '',
  compact = false,
  fill = false,
  className = '',
  children = undefined,
}) {
  const stateIcon = icon || DEFAULT_ICONS[kind] || 'info';
  const classes = [
    'state-panel',
    `state-panel-${kind}`,
    compact && 'state-panel-compact',
    fill && 'state-panel-fill',
    className,
  ].filter(Boolean).join(' ');

  return (
    <div
      class={classes}
      role={kind === 'error' ? 'alert' : 'status'}
      aria-live={kind === 'loading' || kind === 'waiting' ? 'polite' : undefined}
    >
      <PackIcon name={stateIcon} kind="ui" className="state-panel-icon" />
      <div class="state-panel-copy">
        {eyebrow && <p class="state-panel-eyebrow">{eyebrow}</p>}
        {title && <p class="state-panel-title">{title}</p>}
        {description && <p class="state-panel-description">{description}</p>}
        {meta && <p class="state-panel-meta">{meta}</p>}
      </div>
      {children && <div class="state-panel-actions">{children}</div>}
    </div>
  );
}
