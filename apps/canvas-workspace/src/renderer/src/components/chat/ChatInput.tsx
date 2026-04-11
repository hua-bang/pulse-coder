import type { ClipboardEventHandler, KeyboardEventHandler, ReactNode, RefObject } from 'react';

interface ChatInputProps {
  loading: boolean;
  input: string;
  editableRef: RefObject<HTMLDivElement>;
  mentionPopup?: ReactNode;
  onInput: () => void;
  onKeyDown: KeyboardEventHandler<HTMLDivElement>;
  onPaste: ClipboardEventHandler<HTMLDivElement>;
  onSend: () => Promise<boolean>;
  onAbort: () => Promise<void>;
}

export const ChatInput = ({
  loading,
  input,
  editableRef,
  mentionPopup,
  onInput,
  onKeyDown,
  onPaste,
  onSend,
  onAbort,
}: ChatInputProps) => (
  <div className="chat-input-container">
    {mentionPopup}
    <div className={`chat-input-box${loading ? ' chat-input-box--generating' : ''}`}>
      <div
        ref={editableRef}
        className="chat-input"
        contentEditable={true}
        role="textbox"
        data-placeholder={loading ? 'Generating… you can type your next message' : 'Ask anything...'}
        onInput={onInput}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
      />
      <div className="chat-input-footer">
        <div className="chat-input-footer-left">
          {loading && (
            <div className="chat-generating-indicator" aria-live="polite">
              <div className="chat-loading-dot" />
              <div className="chat-loading-dot" />
              <div className="chat-loading-dot" />
              <span className="chat-generating-label">Generating…</span>
            </div>
          )}
        </div>
        {loading ? (
          <button
            className="chat-send-btn chat-send-btn--stop"
            onClick={() => void onAbort()}
            title="Stop generating"
            aria-label="Stop generating"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <rect x="3" y="3" width="8" height="8" rx="1.5" fill="currentColor" />
            </svg>
          </button>
        ) : (
          <button
            className={`chat-send-btn${input.trim() ? ' chat-send-btn--active' : ''}`}
            onClick={() => void onSend()}
            disabled={!input.trim()}
            title="Send message"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M8 12V4M8 4l-3.5 3.5M8 4l3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
      </div>
    </div>
  </div>
);
