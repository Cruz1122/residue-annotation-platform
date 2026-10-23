import PackIcon from './PackIcon.jsx';

/**
 * @param {{ name?: string, className?: string, label?: string }} props
 */
export default function StageIcon({ name = 'protein_identity', className = '', label = undefined }) {
  return <PackIcon name={name} kind="stage" className={className} label={label} />;
}
