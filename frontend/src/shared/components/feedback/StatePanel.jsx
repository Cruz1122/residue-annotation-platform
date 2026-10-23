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
  icon = DEFAULT_ICONS[kind],
  eyebrow = '',
  title,
  description = '',
  meta = '',
  compact = false,
  fill = false,
  className = '',
  children = undefined,
}) {
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
      {icon && <PackIcon name={icon} kind="ui" className="state-panel-icon" />}
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
