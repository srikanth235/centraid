// The memories strip (main Photos view only, per the build prompt — never in
// search/select). Pure view; `memories` is already the fully-derived list
// (see buildMemories() in app.jsx) of `{ key, title, sub, coverUri, onOpen }`.
export function MemoriesStrip({ memories }) {
  if (memories.length === 0) return null;
  return (
    <div className="ph-memories">
      <div className="ph-section-label">Memories</div>
      <div className="ph-memories-strip">
        {memories.map((m) => (
          <button
            key={m.key}
            type="button"
            className="ph-memory-card"
            style={m.coverUri ? { backgroundImage: `url(${m.coverUri})` } : undefined}
            onClick={m.onOpen}
          >
            <span className="ph-memory-scrim" />
            <span className="ph-memory-text">
              <span className="ph-memory-title">{m.title}</span>
              <span className="ph-memory-sub">{m.sub}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
