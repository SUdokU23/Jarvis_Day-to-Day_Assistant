import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { ArrowUp, AudioLines, Bot, LoaderCircle, MessageSquare, Mic, PanelLeft, Plus, Settings, X } from 'lucide-react';
import Markdown from 'react-markdown';

const initialConversation = { id: 'initial', title: 'New conversation', messages: [] };

async function unavailablePrompt() {
  return { success: false, error: { message: 'The local prompt service is not configured yet.' } };
}

export default function App({ sendPrompt = unavailablePrompt }) {
  const [conversations, setConversations] = useState([initialConversation]);
  const [activeId, setActiveId] = useState(initialConversation.id);
  const [drafts, setDrafts] = useState({});
  const [requests, setRequests] = useState({});
  const [sidebarOpen, setSidebarOpen] = useState(() => !window.matchMedia('(max-width: 720px)').matches);
  const [sidebarWidth, setSidebarWidth] = useState(280);
  const history = useRef(null);
  const composer = useRef(null);
  const settings = useRef(null);
  const menu = useRef(null);
  const dismiss = useRef(null);
  const resize = useRef(null);
  const sidebarId = useId();
  const active = conversations.find(({ id }) => id === activeId);
  const draft = drafts[activeId] ?? '';
  const request = requests[activeId];

  useEffect(() => {
    const narrow = window.matchMedia('(max-width: 720px)');
    const syncSidebar = () => setSidebarOpen(!narrow.matches);
    narrow.addEventListener('change', syncSidebar);
    return () => narrow.removeEventListener('change', syncSidebar);
  }, []);

  useLayoutEffect(() => {
    const input = composer.current;
    input.style.height = 'auto';
    input.style.height = `${input.scrollHeight}px`;
  }, [draft]);

  useLayoutEffect(() => {
    history.current.scrollTop = history.current.scrollHeight;
  }, [activeId, active.messages, request]);

  function selectConversation(id) {
    setActiveId(id);
    if (window.matchMedia('(max-width: 720px)').matches) setSidebarOpen(false);
    composer.current.focus();
  }

  function newConversation() {
    const id = crypto.randomUUID();
    setConversations((all) => [{ ...initialConversation, id }, ...all]);
    selectConversation(id);
  }

  function toggleSidebar() {
    if (sidebarOpen) {
      setSidebarOpen(false);
      requestAnimationFrame(() => menu.current.focus());
    } else {
      setSidebarOpen(true);
      requestAnimationFrame(() => dismiss.current?.focus());
    }
  }

  function changeSidebarWidth(width) {
    setSidebarWidth(Math.min(380, Math.max(220, width)));
  }

  function appendExchange(id, prompt, output) {
    const messages = [
      { id: crypto.randomUUID(), role: 'user', content: prompt },
      { id: crypto.randomUUID(), role: 'assistant', content: output },
    ];
    setConversations((all) => all.map((conversation) => {
      if (conversation.id !== id) return conversation;
      return {
        ...conversation,
        title: conversation.messages.length === 0 ? prompt.slice(0, 60) : conversation.title,
        messages: [...conversation.messages, ...messages],
      };
    }));
  }

  async function submit(event) {
    event.preventDefault();
    const prompt = draft.trim();
    if (!prompt || request?.pending) return;
    const id = activeId;
    setRequests((all) => ({ ...all, [id]: { pending: true, prompt } }));
    try {
      const result = await sendPrompt(prompt);
      if (!result.success) {
        setRequests((all) => ({ ...all, [id]: { error: result.error.message } }));
        return;
      }
      appendExchange(id, prompt, result.data.output);
      setDrafts((all) => all[id] === draft ? { ...all, [id]: '' } : all);
      setRequests((all) => ({ ...all, [id]: null }));
    } catch {
      setRequests((all) => ({ ...all, [id]: { error: 'The request failed. Try again.' } }));
    }
  }

  return (
    <div className="shell" onKeyDown={(event) => {
      if (event.key === 'Escape' && !settings.current.open && sidebarOpen && window.matchMedia('(max-width: 720px)').matches) toggleSidebar();
    }} style={{ '--sidebar-width': `${sidebarWidth}px` }}>
      {sidebarOpen && (
        <aside className="sidebar" id={sidebarId} aria-label="Chat sidebar">
          <div className="sidebar-header">
            <span className="brand"><AudioLines size={22} aria-hidden="true" /> Jarvis</span>
            <button ref={dismiss} className="icon-button" type="button" onClick={toggleSidebar} aria-label="Hide sidebar"><PanelLeft size={19} /></button>
          </div>
          <button className="new-chat" type="button" onClick={newConversation}><Plus size={18} /> New chat</button>
          <nav className="conversation-list" aria-label="Conversations">
            <h2>Conversations</h2>
            {conversations.map(({ id, title }) => (
              <button key={id} type="button" aria-current={id === activeId ? 'true' : undefined} onClick={() => selectConversation(id)}>
                <MessageSquare size={16} aria-hidden="true" /><span>{title}</span>
              </button>
            ))}
          </nav>
          <div className="sidebar-footer">
            <ul className="services" aria-label="Local service status">
              {['n8n', 'Ollama'].map((service) => <li key={service}><span>{service}</span><span className="badge">Unknown</span></li>)}
            </ul>
            <button className="settings-button" type="button" onClick={() => settings.current.showModal()}><Settings size={18} /> Settings</button>
          </div>
          <div
            className="sidebar-resize"
            role="separator"
            aria-label="Sidebar width"
            aria-orientation="vertical"
            aria-controls={sidebarId}
            aria-valuemin={220}
            aria-valuemax={380}
            aria-valuenow={sidebarWidth}
            tabIndex={0}
            onPointerDown={(event) => {
              if (event.button !== 0 || !event.isPrimary) return;
              resize.current = { x: event.clientX, width: sidebarWidth };
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              if (event.currentTarget.hasPointerCapture(event.pointerId) && resize.current) {
                changeSidebarWidth(resize.current.width + event.clientX - resize.current.x);
              }
            }}
            onLostPointerCapture={() => { resize.current = null; }}
            onKeyDown={(event) => {
              const widths = { ArrowLeft: sidebarWidth - 16, ArrowRight: sidebarWidth + 16, Home: 220, End: 380 };
              if (!Object.hasOwn(widths, event.key)) return;
              event.preventDefault();
              changeSidebarWidth(widths[event.key]);
            }}
          />
        </aside>
      )}
      <main className="chat">
        <header className="chat-header">
          <button ref={menu} className="icon-button sidebar-toggle" type="button" onClick={toggleSidebar} aria-label={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'} aria-expanded={sidebarOpen} aria-controls={sidebarOpen ? sidebarId : undefined}>
            {sidebarOpen ? <X size={20} /> : <PanelLeft size={20} />}
          </button>
          <span>{active.title}</span>
        </header>
        <div ref={history} className="history" role="log" aria-label="Chat history" tabIndex={0}>
          <div className="messages">
            {active.messages.length === 0 && !request?.pending && (
              <section className="welcome">
                <div className="welcome-icon"><AudioLines size={31} aria-hidden="true" /></div>
                <h1>How can I help?</h1>
                <p>Start a conversation with Jarvis.</p>
              </section>
            )}
            {active.messages.map((message) => (
              <article key={message.id} className={`message ${message.role}`} aria-label={message.role === 'user' ? 'You' : 'Jarvis'}>
                {message.role === 'user' ? message.content : <>
                  <Bot size={20} aria-hidden="true" />
                  <div className="markdown"><Markdown skipHtml disallowedElements={['a', 'img']} unwrapDisallowed>{message.content}</Markdown></div>
                </>}
              </article>
            ))}
            {request?.pending && <article className="message user" aria-label="You">{request.prompt}</article>}
            {request?.pending && <p className="pending" role="status"><LoaderCircle size={18} aria-hidden="true" /> Waiting for Jarvis…</p>}
          </div>
        </div>
        <form className="composer-area" onSubmit={submit}>
          {request?.error && <p className="request-error" role="alert">{request.error}</p>}
          <div className="composer">
            <textarea
              ref={composer}
              rows={1}
              value={draft}
              aria-label="Message Jarvis"
              placeholder="Message Jarvis"
              onChange={(event) => {
                const value = event.target.value;
                setDrafts((all) => ({ ...all, [activeId]: value }));
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
                event.preventDefault();
                event.currentTarget.form.requestSubmit();
              }}
            />
            <span className="mic-control">
              <button className="icon-button" type="button" disabled aria-label="Microphone (coming soon)"><Mic size={19} /></button>
              <small>Coming soon</small>
            </span>
            <button className="send-button" type="submit" disabled={!draft.trim() || request?.pending} aria-label="Send message"><ArrowUp size={21} /></button>
          </div>
        </form>
      </main>
      <dialog ref={settings} className="settings-dialog" aria-labelledby="settings-title">
        <h2 id="settings-title">Settings</h2>
        <p>Local service settings will be available when the services are connected.</p>
        <form method="dialog"><button className="new-chat" type="submit">Close</button></form>
      </dialog>
    </div>
  );
}
