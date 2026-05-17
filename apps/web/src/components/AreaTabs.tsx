type Area = { id: string; name: string };

export function AreaTabs({
  areas,
  activeId,
  onSelect,
  onAdd,
}: {
  areas: Area[];
  activeId: string;
  onSelect: (id: string) => void;
  onAdd: () => void;
}) {
  return (
    <div className="flex items-center gap-2 overflow-x-auto px-3 py-2">
      {areas.map((a) => {
        const active = a.id === activeId;
        return (
          <button
            key={a.id}
            onClick={() => onSelect(a.id)}
            className={
              'shrink-0 rounded-2xl border px-4 py-2 text-sm font-semibold transition ' +
              (active
                ? 'border-ink-900/30 bg-ink-900 text-white shadow-sm'
                : 'border-ink-900/15 bg-white text-ink-900 hover:bg-ink-50')
            }
          >
            {a.name}
          </button>
        );
      })}

      <button
        onClick={onAdd}
        className="shrink-0 rounded-2xl border border-ink-900/15 bg-white px-4 py-2 text-sm font-semibold text-ink-900 hover:bg-ink-50"
        title="Add area"
      >
        +
      </button>
    </div>
  );
}
