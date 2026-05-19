/**
 * Per-agent brand mark. Each glyph is sized inside a 16×16 viewBox so it
 * can be dropped into pills, tabs, info strips, or saved-config rows with
 * consistent visual weight.
 */
export const AgentIcon = ({ id, size = 14 }: { id: string; size?: number }) => {
  switch (id) {
    case 'claude-code':
      return (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <g stroke="#e07b3f" strokeWidth="1.4" strokeLinecap="round">
            <path d="M8 1.5v13" />
            <path d="M1.5 8h13" />
            <path d="M3.4 3.4l9.2 9.2" />
            <path d="M12.6 3.4l-9.2 9.2" />
          </g>
        </svg>
      );
    case 'codex':
      return (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M8 1.5l5.6 3v6.9L8 14.5l-5.6-3.1V4.5L8 1.5z"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinejoin="round"
          />
          <path
            d="M2.6 4.7L8 7.8l5.4-3.1M8 7.8v6.6"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
        </svg>
      );
    case 'pulse-coder':
      return (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M1.5 8h2.2l1.6-4 2 8 1.6-5 1.4 3h4.2"
            stroke="#6366f1"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    default:
      return (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.3" />
          <path d="M8 5v3l2 1.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      );
  }
};

