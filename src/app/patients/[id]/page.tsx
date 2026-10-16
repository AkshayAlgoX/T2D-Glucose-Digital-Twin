'use client';

import React from 'react';
import { useParams } from 'next/navigation';
import { useRealtimeTelemetry } from '@/hooks/useRealtimeTelemetry';
import { TimeProvider } from '@/components/digital-twin/TimeContext';
import { NavigationRail } from "@/components/digital-twin/NavigationRail";
import { PatientWorkspace } from '@/components/digital-twin/PatientWorkspace';

export default function PatientDashboard() {
  const params = useParams();
  const patientId = Array.isArray(params?.id) ? params.id[0] : (params?.id as string) || '';
  const { forecast, cache, isConnected, isStale, error, connectionStatus, retryCount, retry } = useRealtimeTelemetry(patientId);

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
        />
      </div>
    </TimeProvider>
  );
}
