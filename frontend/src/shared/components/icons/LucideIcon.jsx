import {
  Activity,
  ArrowLeft,
  Atom,
  Box,
  ChartColumn,
  CircleCheck,
  CircleDot,
  CircleSlash,
  CircleX,
  Clock,
  Download,
  Dna,
  Eye,
  EyeOff,
  FileText,
  FlaskConical,
  Folder,
  Gauge,
  Hash,
  Info,
  KeyRound,
  Layers3,
  LoaderCircle,
  LockKeyhole,
  LogIn,
  LogOut,
  Mail,
  MailCheck,
  Network,
  Plus,
  RotateCcw,
  RotateCw,
  Route,
  ScanSearch,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Tag,
  Tags,
  Upload,
  UserRound,
  UserRoundCog,
  UserRoundPlus,
  UsersRound,
  Waves,
  Workflow,
  Zap,
} from 'lucide-preact';

const ICONS = {
  activity: Activity,
  'arrow-left': ArrowLeft,
  atom: Atom,
  box: Box,
  'chart-column': ChartColumn,
  'circle-check': CircleCheck,
  'circle-dot': CircleDot,
  'circle-slash': CircleSlash,
  'circle-x': CircleX,
  clock: Clock,
  download: Download,
  dna: Dna,
  eye: Eye,
  'eye-off': EyeOff,
  'file-text': FileText,
  'flask-conical': FlaskConical,
  folder: Folder,
  gauge: Gauge,
  hash: Hash,
  info: Info,
  'key-round': KeyRound,
  'layers-3': Layers3,
  'loader-circle': LoaderCircle,
  'lock-keyhole': LockKeyhole,
  'log-in': LogIn,
  'log-out': LogOut,
  mail: Mail,
  'mail-check': MailCheck,
  network: Network,
  plus: Plus,
  'rotate-ccw': RotateCcw,
  'rotate-cw': RotateCw,
  route: Route,
  'scan-search': ScanSearch,
  search: Search,
  'shield-check': ShieldCheck,
  'sliders-horizontal': SlidersHorizontal,
  sparkles: Sparkles,
  tag: Tag,
  tags: Tags,
  upload: Upload,
  'user-round': UserRound,
  'user-round-cog': UserRoundCog,
  'user-round-plus': UserRoundPlus,
  'users-round': UsersRound,
  waves: Waves,
  workflow: Workflow,
  zap: Zap,
};

/**
 * @param {{ name?: string, className?: string, label?: string }} props
 */
export default function LucideIcon({ name = 'circle-dot', className = '', label = undefined }) {
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
