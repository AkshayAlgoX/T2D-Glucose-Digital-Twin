'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Users, UserRound, FileText } from 'lucide-react';
import { readLastSubject, rememberReceivedSubject, subjectFromPath, validSubjectId } from '@/lib/subject-navigation';

export function NavigationRail({ active, selectedSubjectId }: { active?: 'cohort' | 'patient' | 'evidence'; selectedSubjectId?: string | null }) {
  const pathname = usePathname?.() ?? '';
  const [rememberedSubject, setRememberedSubject] = useState<string | null>(null);
  const [referenceError, setReferenceError] = useState<string | null>(null);
  useEffect(() => {
    const reference = selectedSubjectId != null ? rememberReceivedSubject(selectedSubjectId) : readLastSubject();
    setRememberedSubject(reference.subjectId);
    setReferenceError(reference.error);
  }, [pathname, selectedSubjectId]);
  const selected = validSubjectId(selectedSubjectId) ?? subjectFromPath(pathname) ?? rememberedSubject;
  const workspaceHref = selected ? '/patients/' + encodeURIComponent(selected) : '/cohort#subject-directory';
  const workspaceHint = selected ? 'Open the current or last-viewed subject Workspace.' : 'Select a subject from the Cohort directory to open Workspace.';
  const current = active ?? (pathname.startsWith('/patients/') ? 'patient'
    : pathname === '/evidence' || pathname.startsWith('/evidence/') ? 'evidence'
    : pathname === '/cohort' || pathname.startsWith('/cohort/') ? 'cohort' : undefined);

  return (
    <><header className="app-navigation">
      <a href="#main-content" className="skip-navigation">Skip to main content</a>
      <Link href="/" className="app-brand" aria-label="Glucose Twin home">
        <span className="brand-mark" aria-hidden="true"><svg viewBox="0 0 28 28" width="28" height="28"><path d="M5 19 L11 15 L14 9" className="bm-obs" /><path d="M14 9 C17 5 20 6 23 11 L23 15 C20 10 17 10 14 9 Z" className="bm-wedge" /><path d="M14 9 C17 5 20 6 23 11" className="bm-twin" /><path d="M14 9 C17 10 20 10 23 15" className="bm-fc" /><circle cx="14" cy="9" r="1.8" className="bm-now" /></svg></span>
        <span>Glucose<span className="brand-secondary">Twin</span></span><span className="brand-descriptor">a research instrument for type 2 diabetes</span>
      </Link>
      <nav aria-label="Main navigation" className="navigation-links">
        <Link href="/cohort" className="navigation-link" aria-current={current === 'cohort' ? 'page' : undefined}>
          <Users size={15} aria-hidden="true" /> Cohort
        </Link>
        <Link href={workspaceHref} className="navigation-link" aria-current={current === 'patient' ? 'page' : undefined} aria-describedby="workspace-navigation-hint" title={workspaceHint}>
          <UserRound size={15} aria-hidden="true" /> Workspace
        </Link>
        <Link href="/evidence" className="navigation-link" aria-current={current === 'evidence' ? 'page' : undefined}>
          <FileText size={15} aria-hidden="true" /> Evidence
        </Link>
        <span id="workspace-navigation-hint" className="sr-only">{workspaceHint}</span>
      </nav>
      <span className="navigation-environment"><span className="environment-mark" aria-hidden="true" />Research prototype</span>
    </header>{referenceError && <div className="navigation-notice" role="status">{referenceError}</div>}</>
  );
}
