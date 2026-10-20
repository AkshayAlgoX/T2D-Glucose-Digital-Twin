'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowUpRight, Search, Users, ChevronLeft, ChevronRight, RotateCcw, Database } from 'lucide-react';
import { SubjectIdentifier } from '@/components/digital-twin/SubjectIdentifier';
import { NavigationRail } from '@/components/digital-twin/NavigationRail';

const DEMO_PATIENT_ID = 'P0017';

interface SubjectSummary {
  subject_id: string;
  patient_id?: string;
  group?: string;
  split?: string;
}

export default function CohortPage() {
  const [subjects, setSubjects] = useState<SubjectSummary[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState('');
  const [split, setSplit] = useState('');
  const [page, setPage] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const pageSize = 12;

  useEffect(() => {
    const controller = new AbortController();
    setState('loading');
    fetch('/api/subjects', { signal: controller.signal }).then(async response => {
      if (response.ok === false) throw new Error('Subject service unavailable');
      const data: unknown = await response.json();
      if (!Array.isArray(data)) throw new Error('Invalid subject list');
      const valid = data.every(subject => subject && typeof subject.subject_id === 'string' && subject.subject_id.trim() &&
        ['patient_id', 'group', 'split'].every(key => subject[key] == null || typeof subject[key] === 'string'));
      if (!valid) throw new Error('Invalid subject list');
      if (controller.signal.aborted) return;
      setSubjects(data);
      setState('ready');
    }).catch(error => {
      if (!controller.signal.aborted && error.name !== 'AbortError') setState('error');
    });
    return () => controller.abort();
  }, [attempt]);

  const groups = [...new Set(subjects.map(subject => subject.group).filter((value): value is string => !!value))].sort();
  const splits = [...new Set(subjects.map(subject => subject.split).filter((value): value is string => !!value))].sort();
  const filtered = subjects.filter(subject =>
    (!group || subject.group === group) && (!split || subject.split === split) &&
    [subject.subject_id, subject.patient_id, subject.group, subject.split].some(value => value?.toLowerCase().includes(query.trim().toLowerCase())));
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pageCount - 1);
  const visible = filtered.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  const resetFilters = () => { setQuery(''); setGroup(''); setSplit(''); setPage(0); };
  // Validation-split Type 2 demonstration subject, shown only if the service actually serves it.
  const demo = subjects.find(subject => subject.patient_id === DEMO_PATIENT_ID && subject.split === 'val');

  return (
    <div className="app-shell">
      <NavigationRail active="cohort" />
      <main id="main-content" className="overview-page cohort-page">
        <header className="workspace-heading"><div><span className="eyebrow">Research workspace</span><h1>Patient cohort</h1><p>Each synthetic subject has an EHR record plus CGM and wearable streams, and opens as a digital twin workspace. The sealed test partition is not served.</p></div><span className="status-badge"><Users size={14} aria-hidden="true" />{state === 'ready' ? subjects.length + ' subjects' : 'Subject directory'}</span></header>
        {state === 'ready' && demo && <section className="demo-entry panel" aria-labelledby="demo-entry-heading">
          <div>
            <span className="eyebrow">Start here · demonstration subject</span>
            <h2 id="demo-entry-heading">{demo.patient_id} · {demo.group} · {demo.split} split</h2>
            <p>Six hours of synthetic CGM, heart-rate, HRV, sleep and meal-log history; a 2-hour forecast built from a physiology model plus a learned adjustment; and a live What-If for meals and activity.</p>
          </div>
          <Link prefetch={false} href={'/patients/' + encodeURIComponent(demo.subject_id)} className="demo-entry-link">Open {demo.patient_id} <ArrowUpRight size={15} aria-hidden="true" /></Link>
        </section>}
        {state === 'loading' && <div className="cohort-summary summary-loading" aria-hidden="true">{Array.from({ length: 4 }, (_, index) => <div key={index}><span className="skeleton skeleton-label" /><span className="skeleton skeleton-number" /><span className="skeleton skeleton-label" /></div>)}</div>}
        {state === 'ready' && <section className="cohort-summary" aria-label="Cohort composition">
          <div className="cohort-total"><span className="summary-icon"><Database size={20} aria-hidden="true" /></span><div><span className="eyebrow">Available subjects</span><strong>{subjects.length}</strong><span className="summary-description">Synthetic research cohort</span></div></div>
          {groups.map(name => <div key={name}><span className="eyebrow">{name}</span><strong>{subjects.filter(subject => subject.group === name).length}</strong><span className="summary-description">Recorded group</span></div>)}
        </section>}
        <section id="subject-directory" className="panel cohort-directory" aria-labelledby="directory-heading">
          <div className="directory-toolbar"><div><h2 id="directory-heading">Subject directory</h2><p className="fine-print">Partition labels describe the recorded model split; they are not evidence of independent validation.</p></div><label className="subject-search"><Search size={15} aria-hidden="true" /><span className="sr-only">Search subjects</span><input type="search" value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} placeholder="Search ID or group" /></label></div>
          <div className="directory-filters">
            <div className="filter-controls"><label>Group<select value={group} onChange={event => { setGroup(event.target.value); setPage(0); }}><option value="">All groups</option>{groups.map(name => <option key={name}>{name}</option>)}</select></label>
            <label>Partition<select value={split} onChange={event => { setSplit(event.target.value); setPage(0); }}><option value="">All partitions</option>{splits.map(name => <option key={name}>{name}</option>)}</select></label>
            {(query || group || split) && <button className="text-button" onClick={resetFilters}>Clear filters</button>}</div>
            <span className="result-count" role="status">{state === 'ready' ? `${filtered.length} matching ${filtered.length === 1 ? 'subject' : 'subjects'}` : 'Directory pending'}</span>
          </div>
          <p className="directory-guidance">Select a subject below to open Workspace. When available, Workspace navigation returns to your last-viewed subject.</p>
          {state === 'loading' && <div className="directory-loading" role="status"><span className="sr-only">Loading subject directory. Waiting for the existing backend service.</span><div aria-hidden="true"><div className="directory-loading-header" /><div>{Array.from({ length: pageSize }, (_, index) => <div className="directory-loading-row" key={index}><div><span className="skeleton skeleton-label" /><span className="skeleton skeleton-id" /></div><span className="skeleton skeleton-label" /><span className="skeleton skeleton-label" /><span className="skeleton skeleton-label" /></div>)}</div></div></div>}
          {state === 'error' && <div className="empty-state" role="status"><h3>Subject service unavailable</h3><p>The directory could not be loaded. No demonstration patients have been substituted.</p><button className="secondary-button" onClick={() => setAttempt(value => value + 1)}><RotateCcw size={14} aria-hidden="true" />Retry connection</button></div>}
          {state === 'ready' && !filtered.length && <div className="empty-state"><h3>{query || group || split ? 'No matching subjects' : 'No subjects returned'}</h3><p>{query || group || split ? 'Try another identifier, group, or partition.' : 'Connect the existing backend to view its subject directory.'}</p></div>}
          {state === 'ready' && !!filtered.length && <>
            <div className="directory-table-wrap"><table className="directory-table">
              <caption className="sr-only">Synthetic subjects and their recorded group and partition</caption>
              <thead><tr><th scope="col">Subject</th><th scope="col">Group</th><th scope="col">Partition</th><th scope="col"><span className="sr-only">Workspace</span></th></tr></thead>
              <tbody>{visible.map(subject => <tr key={subject.subject_id}>
                <th scope="row"><div className="directory-identity"><span className="subject-avatar" aria-hidden="true"><Users size={16} /></span><div><strong>{subject.patient_id ?? 'Synthetic subject'}</strong><SubjectIdentifier subjectId={subject.subject_id} label={subject.patient_id} /></div></div></th>
                <td><span className="group-label" data-group={subject.group}>{subject.group ?? 'Group unspecified'}</span></td>
                <td><span className="partition-label">{subject.split ?? 'Unspecified'}</span></td>
                <td><Link prefetch={false} href={'/patients/' + encodeURIComponent(subject.subject_id)} className="subject-open" aria-label={'Open subject ' + (subject.patient_id ?? subject.subject_id)}>Open workspace <ArrowUpRight size={15} aria-hidden="true" /></Link></td>
              </tr>)}</tbody>
            </table></div>
            <div className="directory-pagination"><span>Showing {currentPage * pageSize + 1}–{Math.min((currentPage + 1) * pageSize, filtered.length)} of {filtered.length}</span><div><button className="icon-button" aria-label="Previous page" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}><ChevronLeft size={16} /></button><span>Page {currentPage + 1} of {pageCount}</span><button className="icon-button" aria-label="Next page" disabled={currentPage + 1 === pageCount} onClick={() => setPage(currentPage + 1)}><ChevronRight size={16} /></button></div></div>
          </>}

        </section>
        <footer className="research-footer">Research Only (Not for clinical decisions)<span>Synthetic cohort · existing model artifacts</span></footer>
      </main>
    </div>
  );
}
