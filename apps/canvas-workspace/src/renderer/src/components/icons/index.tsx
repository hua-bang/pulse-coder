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

/** Close / cancel (×). Canonical 16×16 path. */
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
