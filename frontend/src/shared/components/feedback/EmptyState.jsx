import LucideIcon from '@shared/components/icons/LucideIcon.jsx';
import './empty-state.css';

export default function EmptyState({ icon = 'scan-search', title, description = '', className = '', children = undefined }) {
  return (
    <div class={`empty-state ${className}`.trim()} role="status">
      <LucideIcon name={icon} className="empty-state-icon" />
      <p class="empty-state-title">{title}</p>
      {description && <p class="empty-state-description">{description}</p>}
      {children && <div class="empty-state-action">{children}</div>}
    </div>
  );
}
