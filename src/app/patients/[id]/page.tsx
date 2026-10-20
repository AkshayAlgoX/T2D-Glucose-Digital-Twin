'use client';

import React from 'react';
import { useParams } from 'next/navigation';
import { useRealtimeTelemetry } from '@/hooks/useRealtimeTelemetry';
import { useReplayHold } from '@/hooks/useReplayHold';
import { TimeProvider } from '@/components/digital-twin/TimeContext';
import { NavigationRail } from "@/components/digital-twin/NavigationRail";
import { PatientWorkspace } from '@/components/digital-twin/PatientWorkspace';

export default function PatientDashboard() {
  const params = useParams();
  const patientId = Array.isArray(params?.id) ? params.id[0] : (params?.id as string) || '';
  const live = useRealtimeTelemetry(patientId);
  const { isConnected, isStale, error, connectionStatus, retryCount, retry } = live;
  // Opens held on the replay's opening forecast (08:00 UTC on the first morning), the moment the home page shows.
  const view = useReplayHold(live.forecast, live.cache, patientId);
  const { forecast, cache } = view;

  return (
    <TimeProvider>
      <div className="app-shell">
        {/* Rail */}
        <NavigationRail active="patient" selectedSubjectId={!error && forecast?.subject?.subject_id === patientId ? patientId : null} />
        <PatientWorkspace
          patientId={patientId}
          forecast={forecast}
          cache={cache}
          isConnected={isConnected}
          isStale={isStale}
          error={error}
          connectionStatus={connectionStatus}
          retryCount={retryCount}
          onRetry={retry}
          replay={{ paused: view.paused, settling: view.settling, onPause: view.pause, onResume: view.resume }}
        />
      </div>
    </TimeProvider>
  );
}
