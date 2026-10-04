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
  const { forecast, cache, isConnected, isStale, error } = useRealtimeTelemetry(patientId);

  return (
    <TimeProvider>
      <div className="flex h-screen w-screen overflow-hidden bg-bg text-[13px] leading-[20px] text-ink">
        {/* Rail */}
        <NavigationRail />
        <PatientWorkspace
          patientId={patientId}
          forecast={forecast}
          cache={cache}
          isConnected={isConnected}
          isStale={isStale}
          error={error}
        />
      </div>
    </TimeProvider>
  );
}
