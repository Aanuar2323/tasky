export type PanelTab = 'info' | 'history' | 'rules';

export function InfoHistoryTabs({
  tab,
  onChange,
}: {
  tab: PanelTab;
  onChange: (t: PanelTab) => void;
}) {
  const items: { id: PanelTab; label: string }[] = [
    { id: 'info', label: 'Info' },
    { id: 'history', label: 'Historial' },
    { id: 'rules', label: 'Rules' },
  ];

  return (
    <div className="overflow-hidden rounded-2xl border border-ink-900/20 bg-white shadow-sm">
      {items.map((i, idx) => {
        const active = i.id === tab;
        const last = idx === items.length - 1;
        return (
          <button
            key={i.id}
            onClick={() => onChange(i.id)}
            className={
              'flex w-full items-center justify-center px-2 py-5 text-sm font-semibold transition ' +
              (active
                ? 'bg-ink-900 text-white'
                : 'bg-white text-ink-900 hover:bg-ink-50') +
              (last ? '' : ' border-b border-ink-900/20')
            }
          >
            {i.label}
          </button>
        );
      })}
    </div>
  );
}
