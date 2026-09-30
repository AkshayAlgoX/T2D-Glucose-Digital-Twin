'use client';

import React, { useState, useEffect } from 'react';
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { 
  BellRing, 
  Activity, 
  Utensils, 
  TrendingUp, 
  TrendingDown, 
  CheckCircle2, 
  Smartphone,
  Info
} from "lucide-react";

// -----------------------------------------------------------------------------
// Mock Data & Interfaces
// -----------------------------------------------------------------------------

interface PatientState {
  currentGlucose: number;
  trend: 'rising' | 'falling' | 'stable';
  riskTier: 'low' | 'elevated' | 'high';
  projectedPeak: number;
}

// -----------------------------------------------------------------------------
// Main Component
// -----------------------------------------------------------------------------

export default function MobileCompanionPage() {
  const [data, setData] = useState<PatientState | null>(null);
  const [preventativeDelta, setPreventativeDelta] = useState<number | null>(null);
  const [isMealLogged, setIsMealLogged] = useState(false);

  // ---------------------------------------------------------------------------
  // Lifecycle & Mock API Calls
  // ---------------------------------------------------------------------------
  
  useEffect(() => {
    // 1. Fetch current patient status (Mocked)
    const mockState: PatientState = {
      currentGlucose: 142,
      trend: 'rising',
      riskTier: 'high',
      projectedPeak: 215,
    };
    
    // Simulate network delay
    setTimeout(() => setData(mockState), 800);

    // 2. Proactively simulate a "15-minute walk" scenario against the AI 
    // backend to fetch the preventative delta.
    if (mockState.riskTier === 'high' || mockState.riskTier === 'elevated') {
      simulatePreventativeAction();
    }
  }, []);

  const simulatePreventativeAction = async () => {
    // In production, this fires a stateless POST to /api/forecast 
    // with scenario: { type: 'ACTIVITY', duration: 15, intensity: 'moderate' }
    
    // Mocking the response delta (e.g., a walk lowers the peak by 28 mg/dL)
    setTimeout(() => {
      setPreventativeDelta(28); 
    }, 1500);
  };

  const handleLogMeal = () => {
    setIsMealLogged(true);
    setTimeout(() => setIsMealLogged(false), 3000);
  };

  // ---------------------------------------------------------------------------
  // Renderers
  // ---------------------------------------------------------------------------

  if (!data) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-slate-50">
        <div className="animate-pulse flex flex-col items-center">
          <Smartphone className="w-10 h-10 text-slate-300 mb-4" />
          <p className="text-slate-400 font-medium">Syncing with Digital Twin...</p>
        </div>
      </div>
    );
  }

  const isRiskHigh = data.riskTier === 'high' || data.riskTier === 'elevated';

  return (
    <div className="min-h-screen bg-[#F2F2F7] pb-12 font-sans selection:bg-indigo-100">
      
      {/* iOS Status Bar Area (Mock) */}
      <div className="h-12 w-full bg-[#F2F2F7]" />

      <main className="max-w-md mx-auto px-5 space-y-6">
        
        {/* Header */}
        <header className="flex justify-between items-end mb-2">
          <div>
            <p className="text-sm font-semibold text-slate-500 uppercase tracking-wide">Today</p>
            <h1 className="text-3xl font-bold text-black tracking-tight">Summary</h1>
          </div>
          <div className="w-10 h-10 rounded-full bg-slate-200 overflow-hidden border-2 border-white shadow-sm">
            {/* User Avatar Placeholder */}
            <img src="https://api.dicebear.com/7.x/notionists/svg?seed=Felix" alt="Profile" />
          </div>
        </header>

        {/* Primary Glucose Metric Card */}
        <Card className="rounded-[24px] border-none shadow-sm bg-white overflow-hidden">
          <CardContent className="p-6">
            <div className="flex justify-between items-start">
              <div className="flex items-center text-red-500 font-semibold mb-1 text-sm">
                <Activity className="w-4 h-4 mr-1.5" />
                Glucose
              </div>
              <span className="text-xs font-medium text-slate-400">Just now</span>
            </div>
            
            <div className="mt-2 flex items-baseline gap-2">
              <h2 className="text-6xl font-bold tracking-tighter text-slate-900">
                {data.currentGlucose}
              </h2>
              <span className="text-xl font-semibold text-slate-400">mg/dL</span>
            </div>

            <div className="mt-4 flex items-center gap-2">
              {data.trend === 'rising' ? (
                <div className="flex items-center text-amber-600 bg-amber-50 px-2.5 py-1 rounded-lg text-sm font-semibold">
                  <TrendingUp className="w-4 h-4 mr-1.5" /> Rising Fast
                </div>
              ) : (
                <div className="flex items-center text-slate-600 bg-slate-100 px-2.5 py-1 rounded-lg text-sm font-semibold">
                  <TrendingDown className="w-4 h-4 mr-1.5" /> Stable
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Proactive Push Notification Alert (Conditionally Rendered) */}
        {isRiskHigh && preventativeDelta !== null && (
          <div className="animate-in slide-in-from-bottom-4 fade-in duration-500">
            <Card className="rounded-[24px] border-none shadow-lg bg-gradient-to-br from-red-500 to-rose-600 text-white overflow-hidden relative">
              <div className="absolute top-0 right-0 p-4 opacity-20">
                <BellRing className="w-24 h-24 rotate-12" />
              </div>
              <CardContent className="p-6 relative z-10">
                <div className="flex items-center gap-2 mb-3 opacity-90 text-sm font-semibold uppercase tracking-wider">
                  <Info className="w-4 h-4" /> Predictive Alert
                </div>
                <h3 className="text-xl font-bold leading-tight mb-2">
                  High glucose risk detected.
                </h3>
                <p className="text-red-100 font-medium leading-relaxed mb-5">
                  Your digital twin forecasts a peak of {data.projectedPeak} mg/dL soon. A 15-minute walk right now will lower your peak by <span className="text-white font-bold bg-white/20 px-1.5 rounded">{preventativeDelta} mg/dL</span>.
                </p>
                
                <Button 
                  className="w-full bg-white text-red-600 hover:bg-slate-50 font-bold rounded-xl h-12 shadow-sm"
                  onClick={() => alert("Activity logged via HealthKit integration!")}
                >
                  <Activity className="w-5 h-5 mr-2" /> Start 15m Walk
                </Button>
              </CardContent>
            </Card>
          </div>
        )}

        {/* Quick Actions Grid */}
        <div className="grid grid-cols-2 gap-4">
          <button 
            onClick={handleLogMeal}
            className={`flex flex-col items-center justify-center gap-3 p-6 rounded-[24px] border-none shadow-sm transition-all duration-300 ${
              isMealLogged ? 'bg-green-50 text-green-600' : 'bg-white text-slate-700 hover:bg-slate-50'
            }`}
          >
            {isMealLogged ? (
              <>
                <CheckCircle2 className="w-8 h-8" />
                <span className="font-semibold">Logged!</span>
              </>
            ) : (
              <>
                <Utensils className="w-8 h-8 text-indigo-500" />
                <span className="font-semibold text-sm">Log Meal</span>
              </>
            )}
          </button>

          <button className="flex flex-col items-center justify-center gap-3 p-6 bg-white rounded-[24px] border-none shadow-sm hover:bg-slate-50 text-slate-700 transition-colors">
            <Droplets className="w-8 h-8 text-blue-500" />
            <span className="font-semibold text-sm">Log Insulin</span>
          </button>
        </div>

      </main>
    </div>
  );
}
