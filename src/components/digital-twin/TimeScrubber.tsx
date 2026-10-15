import React from 'react';
import { History } from 'lucide-react';
import type { SubjectStore } from '@/lib/types';

// Pinned-time replay is not safely bounded by the current stream proxy.
// Keep this informational until the transport is independently verified.
export function TimeScrubber(_props: { cache?: SubjectStore; asOf?: string }) {
  return (
    <section className="replay-unavailable" aria-label="Pinned-time replay">
      <History size={16} aria-hidden="true" />
      <div><strong>Pinned-time replay unavailable</strong><span>Timeline navigation is disabled in this build. The ordinary synthetic stream remains available.</span></div>
      <span className="status-badge">Unavailable</span>
    </section>
  );
}
