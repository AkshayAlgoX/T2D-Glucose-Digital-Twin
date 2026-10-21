'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, Search, Users, ChevronLeft, ChevronRight, RotateCcw } from 'lucide-react';
import { NavigationRail } from '@/components/digital-twin/NavigationRail';

const DEMO_PATIENT_ID = 'P0017';

interface SubjectSummary {
  subject_id: string;
  patient_id?: string;
  group?: string;
  split?: string;
  ehr?: { age_years?: number; sex?: string; bmi?: number; hba1c_pct?: number; on_medication?: boolean };
}

// Ordinal by glycaemic status, so the composition bar reads left (healthy) to right (diagnosed).
const GROUP_ORDER = ['Healthy', 'Prediabetes', 'Type 2'];
const num = (v: unknown, d = 1) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : '—');

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
        <header className="workspace-heading cohort-heading"><div><span className="eyebrow">Synthetic cohort</span><h1>Patient cohort</h1><p>Each synthetic subject has an EHR record plus CGM and wearable streams, and opens as its own digital twin. The cohort spans healthy, prediabetes and Type 2 so the model learns the full range; the demonstration focuses on Type 2. The sealed test partition is not served.</p></div><span className="status-badge"><Users size={14} aria-hidden="true" />{state === 'ready' ? subjects.length + ' subjects' : 'Subject directory'}</span></header>
        {state === 'ready' && demo && <section className="demo-entry panel" aria-labelledby="demo-entry-heading">
          <div className="demo-entry-copy">
            <span className="eyebrow">Start here · designated demonstration subject</span>
            <h2 id="demo-entry-heading">{demo.patient_id} · {demo.group} · validation split</h2>
            <p>Opens at 08:00 on the first morning: the night, waking and a logged breakfast in CGM, heart rate, HRV, steps, sleep and the meal log; a 2-hour forecast built from a physiology model plus a learned adjustment; and a live What-If for meals and activity.</p>
            <p className="demo-entry-note">Chosen from the validation split, so the network was not trained on this subject. It was used for tuning and calibration, so it is not an independent test either. Training-split subjects are in-sample.</p>
          </div>
          {demo.ehr && <dl className="demo-entry-facts">
            <div><dt>Age</dt><dd>{demo.ehr.age_years ?? '—'}</dd></div>
            <div><dt>BMI</dt><dd>{num(demo.ehr.bmi)}</dd></div>
            <div><dt>HbA1c</dt><dd>{num(demo.ehr.hba1c_pct)}%</dd></div>
          </dl>}
          <Link prefetch={false} href={'/patients/' + encodeURIComponent(demo.subject_id)} className="demo-entry-link">Open {demo.patient_id}<ArrowRight size={15} aria-hidden="true" /></Link>
        </section>}
        {state === 'loading' && <div className="cohort-summary summary-loading" aria-hidden="true">{Array.from({ length: 4 }, (_, index) => <div key={index}><span className="skeleton skeleton-label" /><span className="skeleton skeleton-number" /><span className="skeleton skeleton-label" /></div>)}</div>}
        {state === 'ready' && subjects.length > 0 && <section className="cohort-composition panel" aria-label="Cohort composition">
          <div className="composition-head"><span className="composition-total">{subjects.length}</span><span>served subjects by glycaemic status</span></div>
          <div className="composition-bar" role="img" aria-label={groups.map(name => `${name} ${subjects.filter(subject => subject.group === name).length}`).join(', ')}>
            {[...groups].sort((a, b) => GROUP_ORDER.indexOf(a) - GROUP_ORDER.indexOf(b)).map(name => {
              const n = subjects.filter(subject => subject.group === name).length;
              return <span key={name} className="composition-segment" data-group={name} style={{ flexGrow: n }} />;
            })}
          </div>
          <dl className="composition-legend">
            {[...groups].sort((a, b) => GROUP_ORDER.indexOf(a) - GROUP_ORDER.indexOf(b)).map(name => <div key={name}><dt><i data-group={name} aria-hidden="true" />{name}</dt><dd>{subjects.filter(subject => subject.group === name).length}</dd></div>)}
            {splits.map(name => <div key={'split-' + name} className="composition-split"><dt>{name === 'val' ? 'Validation split' : name === 'train' ? 'Training split' : name + ' split'}</dt><dd>{subjects.filter(subject => subject.split === name).length}</dd></div>)}
          </dl>
        </section>}
        <section id="subject-directory" className="panel cohort-directory" aria-labelledby="directory-heading">
          <div className="directory-toolbar"><div><h2 id="directory-heading">Subject directory</h2><p className="fine-print">Partition labels describe the recorded model split. Training subjects are in-sample, and neither partition is independent validation.</p></div><label className="subject-search"><Search size={15} aria-hidden="true" /><span className="sr-only">Search subjects</span><input type="search" value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} placeholder="Search ID, group or partition" /></label></div>
          <div className="directory-filters">
            <div className="filter-controls"><label>Group<select value={group} onChange={event => { setGroup(event.target.value); setPage(0); }}><option value="">All groups</option>{groups.map(name => <option key={name}>{name}</option>)}</select></label>
            <label>Partition<select value={split} onChange={event => { setSplit(event.target.value); setPage(0); }}><option value="">All partitions</option>{splits.map(name => <option key={name}>{name}</option>)}</select></label>
            {(query || group || split) && <button className="text-button" onClick={resetFilters}>Clear filters</button>}</div>
            <span className="result-count" role="status">{state === 'ready' ? `${filtered.length} matching ${filtered.length === 1 ? 'subject' : 'subjects'}` : 'Directory pending'}</span>
          </div>
          {state === 'loading' && <div className="directory-loading" role="status"><span className="sr-only">Loading subject directory. Waiting for the existing backend service.</span><div aria-hidden="true"><div className="directory-loading-header" /><div>{Array.from({ length: pageSize }, (_, index) => <div className="directory-loading-row" key={index}><div><span className="skeleton skeleton-label" /><span className="skeleton skeleton-id" /></div><span className="skeleton skeleton-label" /><span className="skeleton skeleton-label" /><span className="skeleton skeleton-label" /></div>)}</div></div></div>}
          {state === 'error' && <div className="empty-state" role="status"><h3>Subject service unavailable</h3><p>The directory could not be loaded. No demonstration patients have been substituted.</p><button className="secondary-button" onClick={() => setAttempt(value => value + 1)}><RotateCcw size={14} aria-hidden="true" />Retry connection</button></div>}
          {state === 'ready' && !filtered.length && <div className="empty-state"><h3>{query || group || split ? 'No matching subjects' : 'No subjects returned'}</h3><p>{query || group || split ? 'Try another identifier, group, or partition.' : 'Connect the existing backend to view its subject directory.'}</p></div>}
          {state === 'ready' && !!filtered.length && <>
            <div className="directory-table-wrap"><table className="directory-table">
              <caption className="sr-only">Synthetic subjects with their recorded group, observable EHR summary and partition</caption>
              <thead><tr><th scope="col">Subject</th><th scope="col">Group</th><th scope="col">Age · sex</th><th scope="col">BMI</th><th scope="col">HbA1c</th><th scope="col">Partition</th><th scope="col"><span className="sr-only">Workspace</span></th></tr></thead>
              <tbody>{visible.map(subject => <tr key={subject.subject_id} className={subject.patient_id === DEMO_PATIENT_ID ? 'is-demo' : undefined}>
                <th scope="row"><div className="directory-identity"><strong>{subject.patient_id ?? 'Synthetic subject'}</strong>{subject.patient_id === DEMO_PATIENT_ID && <span className="demo-tag">Demo</span>}</div></th>
                <td><span className="group-label" data-group={subject.group}>{subject.group ?? 'Group unspecified'}</span></td>
                <td className="numeric" data-label="Age">{subject.ehr?.age_years ?? '—'}{subject.ehr?.sex ? ` · ${subject.ehr.sex === 'male' ? 'M' : subject.ehr.sex === 'female' ? 'F' : subject.ehr.sex}` : ''}</td>
                <td className="numeric" data-label="BMI">{num(subject.ehr?.bmi)}</td>
                <td className="numeric" data-label="HbA1c">{subject.ehr?.hba1c_pct != null ? `${num(subject.ehr.hba1c_pct)}%` : '—'}</td>
                <td><span className="partition-label" data-split={subject.split}>{subject.split === 'val' ? 'Validation' : subject.split === 'train' ? 'Training · in-sample' : subject.split ?? 'Unspecified'}</span></td>
                <td><Link prefetch={false} href={'/patients/' + encodeURIComponent(subject.subject_id)} className="subject-open" aria-label={'Open subject ' + (subject.patient_id ?? subject.subject_id)}>Open<ArrowRight size={14} aria-hidden="true" /></Link></td>
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
