'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Activity, Users, UserRound, FileText } from 'lucide-react';
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
        <span className="brand-mark"><Activity size={18} aria-hidden="true" /></span>
        <span>Glucose<span className="brand-secondary">Twin</span></span>
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
