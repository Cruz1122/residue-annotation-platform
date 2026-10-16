import LucideIcon from '@shared/components/icons/LucideIcon.jsx';
import './empty-state.css';

export default function EmptyState({
  icon,
  label,
  title,
  copy,
  description = '',
  className = '',
  children = undefined,
}) {
  const heading = title ?? label;
  const body = copy ?? description;

  return (
    <div class={`empty-state ${className}`.trim()} role="status">
      {icon && <LucideIcon name={icon} className="empty-state-icon" />}
      {label && title && <p class="empty-state-label">{label}</p>}
      {heading && <p class="empty-state-title">{heading}</p>}
      {body && <p class="empty-state-description">{body}</p>}
      {children && <div class="empty-state-action">{children}</div>}
    </div>
  );
}
