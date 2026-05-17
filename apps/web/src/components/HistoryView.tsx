import { useState } from 'react';
import { SectionFilesGrid } from './SectionFilesGrid';

export function HistoryView({
  projectId,
  areaId,
  refreshKey,
}: {
  projectId: string;
  areaId: string;
  refreshKey: number;
}) {
  const [tab, setTab] = useState<'tasks' | 'files'>('tasks');

  return (
    <div className="h-full overflow-auto p-4">
      <div className="mx-auto mb-4 max-w-5xl flex gap-2">
        <button
          onClick={() => setTab('tasks')}
          className={
            'rounded-2xl px-4 py-2 text-sm font-semibold transition ' +
            (tab === 'tasks'
              ? 'bg-[color:var(--ui-accent)] text-white'
              : 'bg-white border border-[color:var(--ui-line)] text-[color:var(--ui-text)] hover:bg-[color:var(--ui-accent-soft)]')
          }
        >
          Tareas completadas
        </button>
        <button
          onClick={() => setTab('files')}
          className={
            'rounded-2xl px-4 py-2 text-sm font-semibold transition ' +
            (tab === 'files'
              ? 'bg-[color:var(--ui-accent)] text-white'
              : 'bg-white border border-[color:var(--ui-line)] text-[color:var(--ui-text)] hover:bg-[color:var(--ui-accent-soft)]')
          }
        >
          Archivos generados
        </button>
      </div>

      {tab === 'tasks' ? (
        <div className="mx-auto h-[65vh] max-w-5xl overflow-hidden rounded-[28px] ui-panel">
          <SectionFilesGrid
            key={refreshKey}
            projectId={projectId}
            rootPath="tasks/history"
            title="Tareas completadas"
            description="Tareas movidas a historial"
          />
        </div>
      ) : (
        <div className="mx-auto h-[65vh] max-w-5xl overflow-hidden rounded-[28px] ui-panel">
          <SectionFilesGrid
            key={`${refreshKey}-${areaId}`}
            projectId={projectId}
            rootPath={`history/areas/${areaId}/files`}
            title="Archivos generados"
            description="Archivos XLSX, DOCX, PPTX, PNG agregados a historial"
          />
        </div>
      )}
    </div>
  );
}
