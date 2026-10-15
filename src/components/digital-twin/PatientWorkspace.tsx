import React, { useState, useSyncExternalStore } from 'react';
import { ArrowUpRight, Radio, ShieldCheck, UserRound, Activity, Database, ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { SubjectIdentifier } from './SubjectIdentifier';
import { ForecastCanvas } from './ForecastCanvas';
import { ScenarioEditor } from './ScenarioEditor';
import { RiskPanel } from './RiskPanel';
import { RiskStrip } from './RiskStrip';
import { TimeScrubber } from './TimeScrubber';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { formatTime, formatDate, formatPct } from '@/lib/formatters/date';
import type { ForecastResponse, MedClass } from '@/types/forecast-response';
import type { SubjectStore } from '@/lib/types';

const compactContextQuery = '(max-width: 640px)';
function subscribeToContextLayout(onChange: () => void) {
  if (typeof window.matchMedia !== 'function') return () => {};
  const query = window.matchMedia(compactContextQuery);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}
function compactContext() {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(compactContextQuery).matches;
}
const serverContext = () => false;

export interface PatientWorkspaceProps {
  patientId: string;
  forecast: ForecastResponse | null;
  cache: SubjectStore;
  isConnected: boolean;
  isStale: boolean;
  error?: Error | null;
}

const medicationClassLabels: Record<MedClass, string> = {
  metformin: 'Metformin',
  sglt2i: 'SGLT2 inhibitor',
  glp1_ra: 'GLP-1 receptor agonist',
  dpp4i: 'DPP-4 inhibitor',
  sulfonylurea: 'Sulfonylurea',
  tzd: 'Thiazolidinedione (TZD)',
  basal_insulin: 'Basal insulin',
  prandial_insulin: 'Prandial insulin',
  corticosteroid: 'Corticosteroid',
};

function ClinicalContext({ patientId, forecast }: Pick<PatientWorkspaceProps, 'patientId' | 'forecast'>) {
  const ehr = forecast?.ehr_context;
  const twin = forecast?.twin_state;
  const fields: Array<[string, string | number, string?]> = [
    ['Age', ehr?.age_years != null ? ehr.age_years + ' years' : '—'],
    ['Sex', ehr?.sex ?? '—'],
    ['BMI', ehr?.bmi ?? '—'],
    ['HbA1c', ehr?.hba1c_pct != null ? ehr.hba1c_pct + '%' : '—'],
    ['eGFR', ehr?.egfr != null ? ehr.egfr + ' mL/min/1.73 m²' : '—', 'context-egfr'],
    ['Diabetes duration', typeof ehr?.t2d_duration_years === 'number' && Number.isFinite(ehr.t2d_duration_years) && ehr.t2d_duration_years >= 0
      ? `${ehr.t2d_duration_years} ${ehr.t2d_duration_years === 1 ? 'year' : 'years'}` : 'Unavailable'],
    ['Medication classes (EHR)', ehr?.med_classes == null ? 'Unavailable'
      : ehr.med_classes.length === 0 ? 'None listed'
      : ehr.med_classes.map(med => medicationClassLabels[med]).join(', '), 'context-medications'],
  ];
  return (
    <aside className="clinical-panel panel" aria-label="Patient Identity">
      <div className="identity-section">
        <div className="identity-mark"><UserRound size={21} aria-hidden="true" /><strong>{forecast?.subject?.simulator?.param_set_id ?? 'Subject'}</strong></div>
        <span className="status-badge">{forecast?.subject?.synthetic ? 'Synthetic subject' : 'Metadata pending'}</span>
        <SubjectIdentifier key={patientId} subjectId={patientId} label={forecast?.subject?.simulator?.param_set_id} />
        <p className="fine-print">{forecast?.subject?.cohort ?? 'Awaiting cohort metadata'}</p>
      </div>
      <section className="clinical-context" aria-labelledby="clinical-heading">
        <h2 id="clinical-heading" className="panel-heading"><Activity size={15} aria-hidden="true" />Clinical Context</h2>
        {!forecast ? (
          <dl className="clinical-fields" aria-label="Loading clinical context" aria-busy="true">
            <div><dt>Age</dt><dd><span className="skeleton skeleton-field" aria-hidden="true" /></dd></div>
            <div><dt>Sex</dt><dd><span className="skeleton skeleton-field-sm" aria-hidden="true" /></dd></div>
            <div><dt>BMI</dt><dd><span className="skeleton skeleton-field-sm" aria-hidden="true" /></dd></div>
            <div><dt>HbA1c</dt><dd><span className="skeleton skeleton-field" aria-hidden="true" /></dd></div>
            <div className="context-egfr"><dt>eGFR</dt><dd><span className="skeleton skeleton-field-lg" aria-hidden="true" /></dd></div>
            <div><dt>Diabetes duration</dt><dd><span className="skeleton skeleton-field" aria-hidden="true" /></dd></div>
            <div className="context-medications"><dt>Medication classes (EHR)</dt><dd><span className="skeleton skeleton-field-lg" aria-hidden="true" /></dd></div>
          </dl>
        ) : (
          <dl className="clinical-fields">
            {fields.map(([label, value, className]) => <div key={label} className={className}><dt>{label}</dt><dd>{value}</dd></div>)}
          </dl>
        )}
        {!forecast ? (
          <p className="fine-print"><span className="skeleton skeleton-text" aria-hidden="true" /></p>
        ) : !ehr ? (
          <p className="fine-print">EHR context has not been received.</p>
        ) : (
          <details className="context-details"><summary>Context provenance</summary><p className="fine-print">HbA1c reference date: {ehr.hba1c_date && Number.isFinite(Date.parse(ehr.hba1c_date)) ? <time dateTime={ehr.hba1c_date}>{formatDate(ehr.hba1c_date)}</time> : 'Unavailable'}. Date assigned to synthetic cohort start, not a clinical measurement date. EHR-derived context, not a clinical assessment.</p></details>
        )}
      </section>
      {twin && <section className="twin-context" aria-labelledby="twin-heading">
        <h2 id="twin-heading" className="panel-heading">Physiological state</h2>
        <dl className="clinical-fields">
          <div><dt>Insulin sensitivity</dt><dd>{twin.insulin_sensitivity_rel?.toFixed(2) ?? '—'}<small> relative</small></dd></div>
          <div><dt>Beta-cell function</dt><dd>{twin.beta_cell_rel?.toFixed(2) ?? '—'}<small> relative</small></dd></div>
          <div><dt>Carbs on board</dt><dd>{twin.carbs_on_board_g != null ? twin.carbs_on_board_g + ' g' : '—'}</dd></div>
        </dl>
        {twin.unannounced_meal && <details className="context-details"><summary>Model estimate details</summary><p className="fine-print">Unannounced-meal heuristic: {formatPct(twin.unannounced_meal.probability, 0)}. This is a model estimate.</p></details>}
      </section>}
    </aside>
  );
}

function DataAvailability({ forecast, cache }: Pick<PatientWorkspaceProps, 'forecast' | 'cache'>) {
  const quality = forecast?.data_quality;
  const received = cache?.cgm?.length ?? 0;
  return (
    <section className="data-availability panel" aria-labelledby="availability-heading">
      <div className="section-heading"><h2 id="availability-heading"><Database size={15} aria-hidden="true" />Data coverage</h2><span className="fine-print">Observable inputs</span></div>
      {!forecast ? (
        <dl className="coverage-metrics" aria-busy="true" aria-label="Loading data coverage">
          <div><dt>CGM · past 6 hours</dt><dd><span className="skeleton skeleton-coverage-val" aria-hidden="true" /></dd></div>
          <div><dt>Reading staleness</dt><dd><span className="skeleton skeleton-coverage-val" aria-hidden="true" /></dd></div>
          <div><dt>Received observations</dt><dd><span className="skeleton skeleton-coverage-val" aria-hidden="true" /></dd></div>
        </dl>
      ) : (
        <dl className="coverage-metrics">
          <div><dt>CGM · past 6 hours</dt><dd>{quality?.cgm_coverage_6h_pct != null ? formatPct(quality.cgm_coverage_6h_pct / 100, 1) : '—'}</dd></div>
          <div><dt>Reading staleness</dt><dd>{quality?.staleness_min != null ? quality.staleness_min + ' min' : '—'}</dd></div>
          <div><dt>Received observations</dt><dd>{received}</dd></div>
        </dl>
      )}
      <div className="availability-row"><span className="availability-label">CGM / EHR</span><span>{!forecast ? <span className="skeleton skeleton-badge-line" aria-hidden="true" /> : `${forecast?.current?.value_mg_dl != null ? 'CGM received' : 'CGM pending'} · ${forecast?.ehr_context ? 'EHR received' : 'EHR pending'}`}</span></div>
      <div className="availability-row"><span className="availability-label">Meals · Activity · Heart rate · Sleep</span><span>Not exposed by this stream</span></div>
      <p className="fine-print">Unavailable streams are not zero measurements. The chart contains observations received during this connection.</p>
      {!!quality?.reasons?.length && <p className="quality-reasons">Reported quality flags: {quality.reasons.map(reason => reason.replace(/_/g, ' ')).join(' · ')}</p>}
    </section>
  );
}

export function PatientWorkspace({ patientId, forecast, cache, isConnected, isStale, error }: PatientWorkspaceProps) {
  const compact = useSyncExternalStore(subscribeToContextLayout, compactContext, serverContext);
  const [contextExpanded, setContextExpanded] = useState(false);
  const fallback = forecast?.model?.fallback_used;
  const mode = !forecast ? 'Awaiting model' : fallback === 'twin_only' ? 'Physics baseline' : fallback === 'persistence' ? 'Persistence fallback' : fallback === 'xgboost' ? 'XGBoost fallback' : 'PR-TFT + physiological twin';
  return (
    <main id="main-content" className="workspace-page">
      <div className="workspace-breadcrumb"><Link href="/cohort"><ArrowLeft size={13} aria-hidden="true" />Cohort</Link><span>/</span><span>Patient workspace</span></div>
      <header className="workspace-heading">
        <div><div className="eyebrow">Patient workspace</div><h1>{forecast?.subject?.simulator?.param_set_id ?? 'Glucose trajectory'}</h1><p>Personalized forecasting from observable clinical and sensor context.</p></div>
        <div className="workspace-status" role="status"><span className={'status-badge ' + (isConnected && !isStale ? 'status-connected' : '')}><Radio size={12} aria-hidden="true" />{isConnected ? 'Synthetic stream connected' : 'Disconnected'}</span>{isStale && <span className="status-badge status-watch">Stale</span>}</div>
      </header>
      {error && <div role="alert" className="workspace-error"><strong>{error.message === 'patient-not-found' ? 'Patient Not Found' : error.message === 'contract-invalid' ? 'Contract Invalid (Malformed Data)' : 'Service Unavailable'}</strong><p>{error.message === 'contract-invalid' ? 'The received stream failed contract validation.' : 'The subject stream could not be loaded. No missing values have been substituted.'}</p></div>}
      <details className="patient-context" open={!compact || contextExpanded}>
        <summary onClick={event => { if (compact) { event.preventDefault(); setContextExpanded(value => !value); } }}>
          <span>Patient context</span><span>Clinical & physiological data</span>
        </summary>
        <ClinicalContext patientId={patientId} forecast={forecast} />
      </details>
      <div className="workspace-grid">
        <section className="trajectory-panel panel" aria-labelledby="trajectory-heading">
          <div className="trajectory-header">
            <div><span className="eyebrow">Observed + predicted</span><h2 id="trajectory-heading">Glucose trajectory</h2></div>
            <span className="status-badge"><ArrowUpRight size={13} aria-hidden="true" />{forecast?.forecast?.horizon_min ?? '—'} min horizon</span>
          </div>
          {!forecast ? (
            <div className="current-summary" aria-busy="true" aria-label="Loading glucose summary">
              <div><span className="eyebrow">Current glucose</span><div className="current-glucose"><span className="skeleton skeleton-glucose-value" aria-hidden="true" /></div></div>
              <div className="forecast-metadata"><span className="skeleton skeleton-meta-line" aria-hidden="true" /><span className="skeleton skeleton-meta-line" style={{ width: '130px' }} aria-hidden="true" /></div>
            </div>
          ) : (
            <div className="current-summary">
              <div><span className="eyebrow">Current glucose</span><div className="current-glucose">{forecast.current?.value_mg_dl ?? '—'}<span>mg/dL</span></div></div>
              <div className="forecast-metadata"><span>Trend: {forecast.current?.trend_arrow?.replace(/_/g, ' ') ?? 'unavailable'}</span><span>{forecast.as_of ? <>Forecast as of <time dateTime={forecast.as_of}>{formatDate(forecast.as_of) + ' · ' + formatTime(forecast.as_of) + ' UTC'}</time></> : 'Awaiting forecast timestamp'}</span></div>
            </div>
          )}
          <div className="chart-frame"><ErrorBoundary fallbackText="Forecast Canvas Error"><ForecastCanvas forecast={forecast} cache={cache} isStale={isStale} /></ErrorBoundary></div>
          <div className="model-caption"><span>{mode}</span><span>Data quality: {forecast?.data_quality?.status === 'ok' ? 'OK' : forecast?.data_quality?.status === 'degraded' ? 'Degraded' : forecast?.data_quality?.status === 'insufficient' ? 'Insufficient data' : 'Unavailable'}</span></div>
        </section>

        <aside className="insights-panel panel" aria-label="Risk and model contributions">
        <ErrorBoundary fallbackText="Risk Panel Error"><RiskPanel forecast={forecast} /></ErrorBoundary>
        </aside>
        <div className="workspace-support">
          <ErrorBoundary fallbackText="Risk history unavailable"><RiskStrip forecast={forecast} cache={cache} isLoading={!forecast && !error} /></ErrorBoundary>
          <DataAvailability forecast={forecast} cache={cache} />
        </div>
      </div>
      <div className="workspace-limitations" aria-label="Prototype limitations">
        <ScenarioEditor patientId={patientId} currentForecast={forecast} />
        <TimeScrubber cache={cache} asOf={forecast?.as_of} />
      </div>
      <footer className="research-footer"><ShieldCheck size={15} aria-hidden="true" /><span>Research Only (Not for clinical decisions)</span><span>Synthetic data · no clinical validation claimed</span></footer>
    </main>
  );
}
