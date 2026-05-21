/**
 * Shared icon primitives used across Sidebar, ChatPanel, etc.
 *
 * Scope: only icons that are either (a) duplicated in ≥2 places with the
 * same underlying path, or (b) represent a canonical brand concept like a
 * canvas node type. Context-specific icons (e.g. 18×18 FloatingToolbar
 * glyphs, 12×12 CanvasNodeView badges) intentionally stay inline because
 * their path data has been tuned for that context.
 */
import type { CanvasNode } from '../../types';

interface IconProps {
  size?: number;
  className?: string;
  strokeWidth?: number;
}

export const SettingsIcon = ({ size = 16, className, strokeWidth = 1.35 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
    <path
      d="M8 10.4a2.4 2.4 0 100-4.8 2.4 2.4 0 000 4.8z"
      stroke="currentColor"
      strokeWidth={strokeWidth}
    />
    <path
      d="M8 1.9l1.05 1.35 1.7.2.55 1.6 1.45.9-.45 1.65.45 1.65-1.45.9-.55 1.6-1.7.2L8 14.1l-1.05-1.35-1.7-.2-.55-1.6-1.45-.9.45-1.65-.45-1.65 1.45-.9.55-1.6 1.7-.2L8 1.9z"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export const CheckIcon = ({ size = 14, className, strokeWidth = 1.6 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
    <path d="M3.5 8.2l2.7 2.7 6.3-6.4" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const RefreshIcon = ({ size = 14, className, strokeWidth = 1.35 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
    <path d="M13 7a5 5 0 00-8.7-3.35L3 5" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
    <path d="M3 3v2h2" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
    <path d="M3 9a5 5 0 008.7 3.35L13 11" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
    <path d="M13 13v-2h-2" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** Sparkles icon — used for reply-style / prompt customization entry. */
export const SparklesIcon = ({ size = 16, className, strokeWidth = 1.3 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
    <path
      d="M6 2.5l1 2.5 2.5 1-2.5 1L6 9.5 5 7 2.5 6 5 5 6 2.5z"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinejoin="round"
    />
    <path
      d="M11.5 8.5l.75 1.75L14 11l-1.75.75L11.5 13.5l-.75-1.75L9 11l1.75-.75L11.5 8.5z"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinejoin="round"
    />
  </svg>
);

export const TrashIcon = ({ size = 14, className, strokeWidth = 1.3 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
    <path d="M3 4.5h10" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" />
    <path d="M6.2 4.5V3.2h3.6v1.3" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
    <path d="M5 6.3l.45 6.2A1.5 1.5 0 006.95 14h2.1a1.5 1.5 0 001.5-1.5L11 6.3" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" />
  </svg>
);

export const PencilIcon = ({ size = 14, className, strokeWidth = 1.3 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
    <path
      d="M11.2 2.8l2 2-7.4 7.4-2.5.5.5-2.5 7.4-7.4z"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M9.8 4.2l2 2"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
    />
  </svg>
);


export const CloseIcon = ({ size = 16, className, strokeWidth = 1.3 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
    <path
      d="M4 4l8 8M12 4l-8 8"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
    />
  </svg>
);

/** Plus / add (+). Canonical 16×16 path. */
export const PlusIcon = ({ size = 16, className, strokeWidth = 1.5 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
    <path
      d="M8 3v10M3 8h10"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
    />
  </svg>
);

/** Right-pointing chevron (›). Used for expand/collapse. */
export const ChevronRightIcon = ({ size = 10, className, strokeWidth = 1.8 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
    <path
      d="M6 4l4 4-4 4"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/** Workspace card icon — a bordered card with two lines inside. */
export const WorkspaceIcon = ({ size = 14, className, strokeWidth = 1.3 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
    <rect
      x="2"
      y="2"
      width="12"
      height="12"
      rx="2"
      stroke="currentColor"
      strokeWidth={strokeWidth}
    />
    <path d="M5 6h6M5 9h4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
  </svg>
);


/** Arrow leaving a tray — export current workspace. */
export const ExportIcon = ({ size = 14, className, strokeWidth = 1.3 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
    <path d="M8 10V3" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" />
    <path d="M5.5 5.5L8 3l2.5 2.5" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
    <path d="M3 9v3.5A1.5 1.5 0 004.5 14h7a1.5 1.5 0 001.5-1.5V9" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" />
  </svg>
);

/** Arrow entering a tray — import a workspace export. */
export const ImportIcon = ({ size = 14, className, strokeWidth = 1.3 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
    <path d="M8 3v7" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" />
    <path d="M5.5 7.5L8 10l2.5-2.5" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
    <path d="M3 9v3.5A1.5 1.5 0 004.5 14h7a1.5 1.5 0 001.5-1.5V9" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" />
  </svg>
);

interface FolderIconProps extends IconProps {
  open?: boolean;
}

/** Folder icon with optional open (filled) variant. */
export const FolderIcon = ({ size = 14, className, strokeWidth = 1.2, open = false }: FolderIconProps) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
    {open ? (
      <path
        d="M2 5.5A1.5 1.5 0 013.5 4H6l1.5 1.5h5A1.5 1.5 0 0114 7v4.5a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 11.5v-6z"
        fill="currentColor"
        opacity="0.15"
        stroke="currentColor"
        strokeWidth={strokeWidth}
      />
    ) : (
      <path
        d="M2 4.5A1.5 1.5 0 013.5 3H6l1.5 1.5h5A1.5 1.5 0 0114 6v5.5a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 11.5v-7z"
        stroke="currentColor"
        strokeWidth={strokeWidth}
      />
    )}
  </svg>
);

/** Simple person / agent silhouette. Used as the assistant avatar. */
export const AvatarIcon = ({ size = 16, className, strokeWidth = 1.3 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
    <circle cx="8" cy="6" r="3" stroke="currentColor" strokeWidth={strokeWidth} />
    <path
      d="M4 14c0-2.2 1.8-4 4-4s4 1.8 4 4"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
    />
  </svg>
);

/** Three horizontal lines representing a list entry. */
export const ListLinesIcon = ({ size = 14, className }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 14 14" fill="none" className={className}>
    <path
      d="M4 3.5h6M4 7h4M4 10.5h5"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
    />
  </svg>
);

/** Landscape / image attachment icon. */
export const ImageIcon = ({ size = 16, className, strokeWidth = 1.3 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
    <rect
      x="2.5"
      y="3"
      width="11"
      height="10"
      rx="2"
      stroke="currentColor"
      strokeWidth={strokeWidth}
    />
    <circle cx="6" cy="6.2" r="1.1" stroke="currentColor" strokeWidth="1.15" />
    <path
      d="M3.2 11.3L6.1 8.6a1 1 0 011.35-.02l1.1 1 1.45-1.45a1 1 0 011.42.02l1.38 1.45"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

interface NodeTypeIconProps {
  type: CanvasNode['type'];
  size?: number;
  className?: string;
}

/**
 * Canonical 16×16 icon for a canvas node type. Used anywhere that
 * surfaces the node's type (sidebar Layers, future contexts).
 */
export const NodeTypeIcon = ({ type, size = 14, className }: NodeTypeIconProps) => {
  switch (type) {
    case 'file':
      return (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
          <path
            d="M4 2h5l3 3v9H4V2z"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
          <path
            d="M9 2v3h3"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case 'terminal':
      return (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
          <rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
          <path
            d="M5 7l2 1.5L5 10"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path d="M9 10h2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      );
    case 'frame':
      // Four corner brackets — conveys "container / crop frame"
      return (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
          <path
            d="M3 6V4a1 1 0 011-1h2M10 3h2a1 1 0 011 1v2M13 10v2a1 1 0 01-1 1h-2M6 13H4a1 1 0 01-1-1v-2"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
          />
        </svg>
      );
    case 'group':
      return (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
          <rect
            x="2.5"
            y="3"
            width="11"
            height="10"
            rx="2"
            stroke="currentColor"
            strokeWidth="1.25"
            strokeDasharray="2 2"
          />
          <path
            d="M5 6h6M5 10h6"
            stroke="currentColor"
            strokeWidth="1.15"
            strokeLinecap="round"
          />
        </svg>
      );
    case 'agent':
      // Pulse waveform matching the Pulse Canvas brand mark
      return (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
          <path
            d="M2 8H6L7 5L8 12L9 4L10 8H14"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case 'text':
      // Serif-style "A" drawn as a capital letter glyph to read as "text"
      return (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
          <path
            d="M3 3h10M8 3v10M6 13h4"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
          />
        </svg>
      );
    case 'iframe':
      // Globe — evokes "web page"
      return (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
          <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.3" />
          <path
            d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12"
            stroke="currentColor"
            strokeWidth="1.1"
            strokeLinecap="round"
          />
        </svg>
      );
    case 'image':
      return <ImageIcon size={size} className={className} />;
    case 'mindmap':
      // Root node on the left with three children branching to the right
      return (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
          <circle cx="4" cy="8" r="1.6" stroke="currentColor" strokeWidth="1.2" />
          <circle cx="12" cy="3.5" r="1.4" stroke="currentColor" strokeWidth="1.2" />
          <circle cx="12" cy="8" r="1.4" stroke="currentColor" strokeWidth="1.2" />
          <circle cx="12" cy="12.5" r="1.4" stroke="currentColor" strokeWidth="1.2" />
          <path
            d="M5.6 8L10.6 3.7M5.6 8H10.6M5.6 8L10.6 12.3"
            stroke="currentColor"
            strokeWidth="1.1"
            strokeLinecap="round"
          />
        </svg>
      );
    default:
      return (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
          <rect
            x="2"
            y="2"
            width="12"
            height="12"
            rx="2"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeDasharray="2 2"
          />
        </svg>
      );
  }
};
