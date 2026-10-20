import { useCallback, useEffect, useState } from 'react';

/**
 * Holds the workspace on the opening forecast of the replay.
 *
 * The stream sends its catch-up history as a rapid burst, then one reading every few seconds. While
 * held, the view follows the burst and freezes on its last forecast once the stream has been quiet
 * for `quietMs`; the stream keeps running underneath. Resuming shows the live replay again.
 * Nothing is interpolated or substituted: the frozen view is a forecast the backend sent.
 */
export function useReplayHold<F extends { as_of?: string } | null, C>(forecast: F, cache: C, subjectKey: string, quietMs = 1500) {
  const [held, setHeld] = useState(true);
  const [snapshot, setSnapshot] = useState<{ forecast: F; cache: C } | null>(null);

  // A different subject starts its own replay, held again on its own opening forecast.
  useEffect(() => { setHeld(true); setSnapshot(null); }, [subjectKey]);

  useEffect(() => {
    if (!held || snapshot || !forecast) return;
    const timer = setTimeout(() => setSnapshot({ forecast, cache }), quietMs);
    return () => clearTimeout(timer);
  }, [held, snapshot, forecast, cache, quietMs]);

  const resume = useCallback(() => { setHeld(false); setSnapshot(null); }, []);
  const pause = useCallback(() => { setSnapshot(forecast ? { forecast, cache } : null); setHeld(true); }, [forecast, cache]);

  const frozen = held && snapshot != null;
  return {
    forecast: frozen ? snapshot.forecast : forecast,
    cache: frozen ? snapshot.cache : cache,
    /** True once the view is frozen on a forecast; false while catching up or following the live replay. */
    paused: frozen,
    /** True while the opening burst is still arriving and the view will freeze when it settles. */
    settling: held && !snapshot,
    pause,
    resume,
  };
}
