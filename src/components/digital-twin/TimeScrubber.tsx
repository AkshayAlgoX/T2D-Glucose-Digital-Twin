'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import * as SliderPrimitive from '@radix-ui/react-slider';
import { Play, Pause, FastForward, RotateCcw, Clock } from 'lucide-react';
import { format, addSeconds, subHours, addHours } from 'date-fns';

// -----------------------------------------------------------------------------
// Constants & Types
// -----------------------------------------------------------------------------

const RANGE_PAST_HOURS = 24;
const RANGE_FUTURE_HOURS = 2;

// Calculate in seconds relative to "NOW" (0)
const MIN_SEC = -1 * RANGE_PAST_HOURS * 3600;
const MAX_SEC = RANGE_FUTURE_HOURS * 3600;
const TOTAL_SEC = MAX_SEC - MIN_SEC;

export interface TimeScrubberProps {
  /** 
   * Fired when the timestamp changes. 
   * In a real app, wrap the parent state in `useTransition` or a Zustand store 
   * to avoid blocking the React render tree during fast scrubbing.
   */
  onTimeChange: (isoTimestamp: string) => void;
  className?: string;
}

// -----------------------------------------------------------------------------
// Component
// -----------------------------------------------------------------------------

export function TimeScrubber({ onTimeChange, className = '' }: TimeScrubberProps) {
  // Local state for the slider to ensure 60fps buttery smooth dragging
  // without waiting for the parent component to re-render.
  const [offsetSec, setOffsetSec] = useState<number>(0); // 0 = NOW
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState<number>(10); // 1x, 10x, 60x

  // Refs for animation loop
  const requestRef = useRef<number>();
  const previousTimeRef = useRef<number>();
  
  // Memoize the absolute base time so "NOW" doesn't constantly drift during a session
  const anchorDate = useRef(new Date());

  // ---------------------------------------------------------------------------
  // State Syncing
  // ---------------------------------------------------------------------------
  
  const broadcastTime = useCallback((currentOffset: number) => {
    const targetDate = addSeconds(anchorDate.current, currentOffset);
    onTimeChange(targetDate.toISOString());
  }, [onTimeChange]);

  const handleSliderChange = (value: number[]) => {
    const newOffset = value[0];
    setOffsetSec(newOffset);
    // When dragging manually, broadcast immediately (parent should debounce if needed)
    broadcastTime(newOffset);
  };

  // ---------------------------------------------------------------------------
  // Playback Engine
  // ---------------------------------------------------------------------------
  
  const animate = useCallback((time: number) => {
    if (previousTimeRef.current !== undefined) {
      const deltaTimeMs = time - previousTimeRef.current;
      
      setOffsetSec((prev) => {
        // Calculate how many simulation seconds passed based on real MS + speed multiplier
        const simulatedSecondsPassed = (deltaTimeMs / 1000) * playbackSpeed;
        const nextOffset = prev + simulatedSecondsPassed;

        // Auto-pause if we reach the end of the AI forecast
        if (nextOffset >= MAX_SEC) {
          setIsPlaying(false);
          broadcastTime(MAX_SEC);
          return MAX_SEC;
        }

        // Throttle React state broadcasts to roughly 10fps to save CPU 
        // while the local slider handle moves at 60fps
        if (Math.floor(nextOffset) % 5 === 0) {
          broadcastTime(nextOffset);
        }

        return nextOffset;
      });
    }
    
    previousTimeRef.current = time;
    if (isPlaying) {
      requestRef.current = requestAnimationFrame(animate);
    }
  }, [isPlaying, playbackSpeed, broadcastTime]);

  useEffect(() => {
    if (isPlaying) {
      requestRef.current = requestAnimationFrame(animate);
    } else {
      // Reset previous time so it doesn't jump when resuming
      previousTimeRef.current = undefined;
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
    }
    return () => {
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
    };
  }, [isPlaying, animate]);

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  
  const togglePlay = () => setIsPlaying(!isPlaying);
  
  const cycleSpeed = () => {
    setPlaybackSpeed(prev => prev === 1 ? 10 : prev === 10 ? 60 : prev === 60 ? 600 : 1);
  };

  const resetToNow = () => {
    setIsPlaying(false);
    setOffsetSec(0);
    broadcastTime(0);
  };

  // Formatting for the UI display
  const currentDate = addSeconds(anchorDate.current, offsetSec);
  const isFuture = offsetSec > 0;
  
  // Calculate percentage for gradient background
  const percentage = ((offsetSec - MIN_SEC) / TOTAL_SEC) * 100;

  return (
    <div className={`fixed bottom-6 left-1/2 -translate-x-1/2 w-[90%] max-w-4xl z-50 ${className}`}>
      <div className="bg-slate-900/90 backdrop-blur-md border border-slate-700 p-4 rounded-2xl shadow-2xl flex flex-col gap-3">
        
        {/* Top Row: Info & Controls */}
        <div className="flex items-center justify-between px-2">
          
          {/* Time Display */}
          <div className="flex flex-col w-32">
            <span className={`text-[10px] uppercase font-bold tracking-wider ${isFuture ? 'text-indigo-400' : 'text-slate-400'}`}>
              {isFuture ? 'AI Forecast' : 'Historical'}
            </span>
            <span className="text-white font-mono font-medium tracking-tight">
              {format(currentDate, "MMM dd, HH:mm:ss")}
            </span>
          </div>

          {/* Media Controls */}
          <div className="flex items-center gap-4">
            <button 
              onClick={resetToNow}
              className="text-slate-400 hover:text-white transition-colors"
              title="Reset to Now"
            >
              <RotateCcw className="w-4 h-4" />
            </button>
            
            <button 
              onClick={togglePlay}
              className="bg-white text-slate-900 p-2 rounded-full hover:bg-slate-200 transition-transform active:scale-95"
            >
              {isPlaying ? <Pause className="w-5 h-5 fill-current" /> : <Play className="w-5 h-5 fill-current translate-x-[1px]" />}
            </button>

            <button 
              onClick={cycleSpeed}
              className="flex items-center gap-1 text-slate-400 hover:text-white transition-colors text-xs font-bold font-mono w-12"
              title="Playback Speed"
            >
              <FastForward className="w-4 h-4" />
              {playbackSpeed}x
            </button>
          </div>

          {/* Spacer to balance the flex layout */}
          <div className="w-32 flex justify-end">
             {offsetSec === 0 && (
                <span className="flex items-center text-xs font-medium text-emerald-400">
                  <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse mr-2" /> Live
                </span>
             )}
          </div>
        </div>

        {/* Bottom Row: The Slider Timeline */}
        <div className="px-2 pt-2 pb-1 relative">
          {/* Tick Marks (Now line) */}
          <div 
             className="absolute top-0 bottom-0 w-px bg-indigo-500/50 z-0 pointer-events-none" 
             style={{ left: `${(Math.abs(MIN_SEC) / TOTAL_SEC) * 100}%` }}
          />
          <div 
             className="absolute -top-3 text-[9px] text-indigo-400 font-bold z-0 pointer-events-none" 
             style={{ left: `calc(${(Math.abs(MIN_SEC) / TOTAL_SEC) * 100}% - 12px)` }}
          >
            NOW
          </div>

          <SliderPrimitive.Root
            className="relative flex items-center select-none touch-none w-full h-5 group cursor-pointer"
            value={[offsetSec]}
            min={MIN_SEC}
            max={MAX_SEC}
            step={1}
            onValueChange={handleSliderChange}
          >
            <SliderPrimitive.Track className="bg-slate-700/50 relative grow rounded-full h-2 overflow-hidden">
              <SliderPrimitive.Range 
                className="absolute bg-indigo-500 rounded-full h-full" 
              />
            </SliderPrimitive.Track>
            <SliderPrimitive.Thumb 
              className="block w-4 h-4 bg-white shadow-[0_0_10px_rgba(255,255,255,0.5)] rounded-full border-2 border-indigo-500 transition-transform focus:outline-none focus:ring-4 focus:ring-indigo-500/30 group-hover:scale-125" 
            />
          </SliderPrimitive.Root>
          
          <div className="flex justify-between mt-1 px-1">
            <span className="text-[10px] text-slate-500 font-medium">-24h</span>
            <span className="text-[10px] text-slate-500 font-medium">+2h</span>
          </div>
        </div>

      </div>
    </div>
  );
}
