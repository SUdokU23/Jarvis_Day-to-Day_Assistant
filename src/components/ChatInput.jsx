import { useLayoutEffect, useRef } from 'react';
import { ArrowUp, Mic } from 'lucide-react';

export default function ChatInput({ inputRef, draft, pending, error, onChange, onSubmit }) {
  const composing = useRef(false);

  useLayoutEffect(() => {
    const input = inputRef.current;
    input.style.height = 'auto';
    input.style.height = `${input.scrollHeight}px`;
  }, [draft, inputRef]);

  return (
    <form className="composer-area" onSubmit={onSubmit}>
      {error && <p className="request-error" role="alert">{error}</p>}
      <div className="composer">
        <textarea
          ref={inputRef}
          rows={1}
          value={draft}
          aria-label="Message Jarvis"
          placeholder="Message Jarvis"
          onChange={(event) => onChange(event.target.value)}
          onCompositionStart={() => { composing.current = true; }}
          onCompositionEnd={() => { composing.current = false; }}
          onBlur={() => { composing.current = false; }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.shiftKey || composing.current || event.nativeEvent.isComposing) return;
            event.preventDefault();
            event.currentTarget.form.requestSubmit();
          }}
        />
        <span className="mic-control">
          <button className="icon-button" type="button" disabled aria-label="Microphone (coming soon)"><Mic size={19} /></button>
          <small>Coming soon</small>
        </span>
        <button className="send-button" type="submit" disabled={!draft.trim() || pending} aria-label="Send message"><ArrowUp size={21} /></button>
      </div>
    </form>
  );
}
