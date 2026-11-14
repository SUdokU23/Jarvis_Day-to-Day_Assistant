import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

function App() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 p-8 text-slate-100">
      <section className="max-w-xl rounded-3xl border border-slate-700 bg-slate-900 p-10">
        <p className="mb-4 text-sm font-semibold uppercase tracking-widest text-teal-300">Local desktop assistant</p>
        <h1 className="mb-5 text-5xl font-semibold">Jarvis</h1>
        <p className="text-lg leading-relaxed text-slate-300">Your workspace is ready. Conversations and local services are coming next.</p>
        <p className="mt-8 text-sm text-slate-400">Desktop foundation · {window.jarvis?.platform ?? 'Browser preview'}</p>
      </section>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<React.StrictMode><App /></React.StrictMode>);
