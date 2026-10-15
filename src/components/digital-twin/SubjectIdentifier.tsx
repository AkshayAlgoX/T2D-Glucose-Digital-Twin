'use client';

import React, { useEffect, useId, useRef, useState } from 'react';
import { Check, Copy, ChevronDown } from 'lucide-react';

/** Delay in milliseconds before the copied-success feedback resets to the copy icon. */
const RESET_DELAY_MS = 1750;

/** Compact presentation only: destinations and clipboard always use the full ID. */
export function SubjectIdentifier({ subjectId, label }: { subjectId: string; label?: string }) {
  const panelId = useId();
  const [expanded, setExpanded] = useState(false);
  const [feedback, setFeedback] = useState<{ id: string; state: 'copying' | 'copied' | 'failed' } | null>(null);
  const epoch = useRef(0);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setExpanded(false);
    setFeedback(null);
    epoch.current += 1;
    return () => {
      epoch.current += 1;
      if (resetTimer.current !== null) {
        clearTimeout(resetTimer.current);
        resetTimer.current = null;
      }
    };
  }, [subjectId]);

  const state = feedback?.id === subjectId ? feedback.state : null;
  const compact = subjectId.length > 20 ? `${subjectId.slice(0, 8)}…${subjectId.slice(-4)}` : subjectId;
  const name = label || subjectId;

  function scheduleReset() {
    if (resetTimer.current !== null) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => {
      resetTimer.current = null;
      setFeedback(null);
    }, RESET_DELAY_MS);
  }

  async function copy() {
    const requestEpoch = epoch.current;
    setFeedback({ id: subjectId, state: 'copying' });
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(subjectId);
      if (epoch.current === requestEpoch) {
        setFeedback({ id: subjectId, state: 'copied' });
        scheduleReset();
      }
    } catch {
      if (epoch.current === requestEpoch) {
        setFeedback({ id: subjectId, state: 'failed' });
        setExpanded(true);
        // Do not schedule a reset for 'failed' — leave message visible for user to act on.
      }
    }
  }

  const isTruncated = subjectId.length > 20;

  return <div className="subject-id-control">
    <div className="subject-id-actions">
      {isTruncated ? (
        <button type="button" className="identifier-toggle" aria-expanded={expanded} aria-controls={panelId}
          aria-label={`${expanded ? 'Hide' : 'Show'} full subject ID for ${name}`} title={subjectId} onClick={() => setExpanded(value => !value)}>
          <code aria-hidden="true">{compact}</code><ChevronDown size={12} aria-hidden="true" />
        </button>
      ) : (
        <code className="identifier-static">{subjectId}</code>
      )}
      <button type="button" className="copy-identifier" aria-label={`Copy full subject ID for ${name}`} title="Copy full subject ID" disabled={state === 'copying'} onClick={copy}>
        {state === 'copied' ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
      </button>
    </div>
    {isTruncated && <code id={panelId} className="full-subject-id" hidden={!expanded}>{subjectId}</code>}
    <span className="copy-feedback" role="status">{state === 'copying' ? 'Copying…' : state === 'copied' ? 'Copied full ID' : state === 'failed' ? 'Could not copy. Select the full ID above to copy manually.' : ''}</span>
  </div>;
}
