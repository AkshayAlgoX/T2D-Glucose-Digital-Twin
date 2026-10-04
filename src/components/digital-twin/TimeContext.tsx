import React, { createContext, useContext, useState, useEffect } from 'react';

export const TimeContext = createContext<any>(null);

export function TimeProvider({ children }: { children: React.ReactNode }) {
  const [asOf, setAsOf] = useState<string | null>(null); // null means live
  
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Basic keyboard handling for asOf
      if (e.key === 'L' || e.key === 'l') {
        setAsOf(null); // Latest
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  return (
    <TimeContext.Provider value={{ asOf, setAsOf }}>
      {children}
    </TimeContext.Provider>
  );
}

export function useTime() {
  return useContext(TimeContext);
}
