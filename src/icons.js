import {
  createIcons,
  LayoutDashboard,
  Users,
  User,
  BarChart3,
  Settings,
  ShieldCheck,
  Lock,
  LogOut,
  Sun,
  Moon,
  Search,
  X,
  Check,
  FileSpreadsheet,
  Zap,
  ArrowUpDown,
  Filter,
  Phone,
  MessageSquare,
  Globe,
  MapPin,
  AlertCircle,
  Database,
  Cloud,
  KeyRound,
  ExternalLink,
  SlidersHorizontal,
  RefreshCw,
  Trash2,
  Plus,
  Download,
  Upload,
  CheckCircle2,
  XCircle,
  Briefcase,
  Layers,
  Sparkles,
  UserCheck,
  Building2,
  ChevronDown
} from 'lucide';

const ALL_ICONS = {
  LayoutDashboard,
  Users,
  User,
  BarChart3,
  Settings,
  ShieldCheck,
  Lock,
  LogOut,
  Sun,
  Moon,
  Search,
  X,
  Check,
  FileSpreadsheet,
  Zap,
  ArrowUpDown,
  Filter,
  Phone,
  MessageSquare,
  Globe,
  MapPin,
  AlertCircle,
  Database,
  Cloud,
  KeyRound,
  ExternalLink,
  SlidersHorizontal,
  RefreshCw,
  Trash2,
  Plus,
  Download,
  Upload,
  CheckCircle2,
  XCircle,
  Briefcase,
  Layers,
  Sparkles,
  UserCheck,
  Building2,
  ChevronDown
};

/**
 * Initializes Lucide icons across the document
 * Replaces any <i data-lucide="..."> or <span data-lucide="..."> with clean SVG vectors
 */
export function initIcons() {
  try {
    createIcons({
      icons: ALL_ICONS,
      attrs: {
        'stroke-width': 1.8,
        class: 'lucide-icon'
      }
    });
  } catch (e) {
    console.warn('Error initializing icons:', e);
  }
}
