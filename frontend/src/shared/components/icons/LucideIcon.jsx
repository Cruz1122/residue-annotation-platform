import {
  Activity,
  Atom,
  Box,
  ChartColumn,
  CircleCheck,
  CircleDot,
  CircleX,
  Clock,
  Download,
  Dna,
  Eye,
  FileText,
  FlaskConical,
  Folder,
  Gauge,
  Info,
  Layers3,
  Network,
  RotateCcw,
  RotateCw,
  Route,
  ScanSearch,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Tag,
  Waves,
  Workflow,
  Zap,
} from 'lucide-preact';

const ICONS = {
  activity: Activity,
  atom: Atom,
  box: Box,
  'chart-column': ChartColumn,
  'circle-check': CircleCheck,
  'circle-dot': CircleDot,
  'circle-x': CircleX,
  clock: Clock,
  download: Download,
  dna: Dna,
  eye: Eye,
  'file-text': FileText,
  'flask-conical': FlaskConical,
  folder: Folder,
  gauge: Gauge,
  info: Info,
  'layers-3': Layers3,
  network: Network,
  'rotate-ccw': RotateCcw,
  'rotate-cw': RotateCw,
  route: Route,
  'scan-search': ScanSearch,
  search: Search,
  'shield-check': ShieldCheck,
  'sliders-horizontal': SlidersHorizontal,
  sparkles: Sparkles,
  tag: Tag,
  waves: Waves,
  workflow: Workflow,
  zap: Zap,
};

export default function LucideIcon({ name = 'circle-dot', className = '', label }) {
  const Icon = ICONS[name] ?? CircleDot;

  return (
    <span
      class={`icon-slot ${className}`.trim()}
      aria-hidden={label ? undefined : 'true'}
    >
      <Icon
        class="lucide-icon"
        size="100%"
        strokeWidth={1.8}
        aria-hidden={label ? undefined : 'true'}
        aria-label={label ?? undefined}
      />
    </span>
  );
}
