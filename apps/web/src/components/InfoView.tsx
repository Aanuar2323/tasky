import { useMemo } from 'react';
import { SectionFilesGrid } from './SectionFilesGrid';

export function InfoView({
  projectId,
  projectName,
  areaName,
  areaId,
}: {
  projectId: string;
  projectName: string;
  areaName: string;
  areaId: string;
}) {
  const rootPath = useMemo(() => `ai/layer2/areas/${areaId}`, [areaId]);

  return (
    <div className="h-full overflow-auto p-4">
      <div className="mx-auto mb-4 max-w-5xl rounded-[24px] px-5 py-4" style={{ background: 'oklch(100% 0 0 / 0.7)', border: '1px solid var(--ui-line)' }}>
        <div className="ui-label mb-1">Info</div>
        <div className="text-sm text-[color:var(--ui-muted)]">
          Proyecto: <span className="font-semibold text-[color:var(--ui-text)]">{projectName}</span>
        </div>
        <div className="mt-1 text-sm text-[color:var(--ui-muted)]">
          Área: <span className="font-semibold text-[color:var(--ui-text)]">{areaName}</span>
        </div>
        <div className="mt-1 text-xs text-[color:var(--ui-muted)]">
          Archivos visibles solo de esta sección. No hay navegación entre carpetas.
        </div>
      </div>

      <div className="mx-auto h-[70vh] max-w-5xl overflow-hidden rounded-[28px] ui-panel">
        <SectionFilesGrid
          projectId={projectId}
          rootPath={rootPath}
          title="Contexto del área"
          description="Agregar / Descargar / Eliminar archivos de contexto del área activa"
        />
      </div>
    </div>
  );
}
