import React from 'react';
import { NavigationRail } from "@/components/digital-twin/NavigationRail";

export default function EvidencePage() {
  return (
    <div className="flex h-screen w-screen bg-bg text-[13px] leading-[20px] text-ink">
      <NavigationRail />
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-[24px] font-medium text-ink-2 mb-2">Evidence & Validation</h1>
          <p className="text-ink-3 max-w-md mx-auto">
            This module provides full transparency into model performance,
            clinical validation results, out-of-distribution (OOD) monitoring,
            and safety bounds.
          </p>
        </div>
      </div>
    </div>
  );
}
