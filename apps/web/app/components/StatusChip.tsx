import type { ChatStatus } from "../types/chat";

export default function StatusChip({ status }: { status: ChatStatus }) {
  return (
    <div className="status-chip" data-phase={status.phase} role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span>{status.label}</span>
    </div>
  );
}
