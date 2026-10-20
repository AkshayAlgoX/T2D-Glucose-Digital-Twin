import React from 'react';
import fs from 'fs';
import path from 'path';
import { render, screen, act } from '@testing-library/react';
import { PatientWorkspace } from '../src/components/digital-twin/PatientWorkspace';
import { ForecastCanvas } from '../src/components/digital-twin/ForecastCanvas';
import { RiskPanel } from '../src/components/digital-twin/RiskPanel';
import { RiskStrip } from '../src/components/digital-twin/RiskStrip';
import { TimeProvider } from '../src/components/digital-twin/TimeContext';
import type { ForecastResponse } from '../src/types/forecast-response';
import type { SubjectStore } from '../src/lib/types';

// Fixture factory for unit tests
function validForecastFixture(): ForecastResponse {
  const asOf = '2026-10-04T12:00:00Z';
  return {
    schema_version: '1.0.0',
    request_id: 'req-skeleton-test',
    generated_at: asOf,
    as_of: asOf,
    subject: { subject_id: 'P-SKELETON-001', synthetic: true, simulator: { param_set_id: 'SIM-001' } },
    intended_use: 'research_only_not_for_clinical_decisions',
    model: { name: 'hybrid_v1', version: '1.0', fallback_used: null, run_id: 'test-run', alert_policy_version: 'v1' },
    data_quality: { status: 'ok', cgm_coverage_6h_pct: 98.5, staleness_min: 0, last_cgm_at: asOf, reasons: [] },
    current: { value_mg_dl: 115, flag: 'in_range', measured_at: asOf, trend_arrow: 'flat' },
    alert: { state: 'none' },
    spike_risk: {
      probability_120m: 0.18,
      tier: 'low',
      calibrated: true,
      spike_in_progress: false,
      definition: { threshold_mg_dl: 180, min_rise_mg_dl: 0, rise_window_min: 0, persistence_min: 0 },
      time_to_peak_min: 60,
      peak_mg_dl: { p50: 135, p90: 155 },
      cumulative: [{ offset_min: 30, p: 0.05 }, { offset_min: 60, p: 0.12 }, { offset_min: 120, p: 0.18 }],
    },
    drivers: [
      { feature_key: 'meal', label_key: 'Recent Meal', direction: 'raises', impact_mg_dl: 12, source: 'twin' },
      { feature_key: 'baseline', label_key: 'Baseline Return', direction: 'lowers', impact_mg_dl: -8, source: 'both' },
    ],
    forecast: {
      units: 'mg/dL',
      step_min: 5,
      horizon_min: 120,
      conformal_adjusted: true,
      points: [
        { offset_min: 5, t: '2026-10-04T12:05:00Z', p05: 100, p10: 105, p25: 110, p50: 115, p75: 120, p90: 125, p95: 130 },
        { offset_min: 10, t: '2026-10-04T12:10:00Z', p05: 102, p10: 107, p25: 112, p50: 118, p75: 123, p90: 128, p95: 133 },
      ],
    },
    twin_state: {
      insulin_sensitivity_rel: 0.85,
      beta_cell_rel: 0.90,
      carbs_on_board_g: 15,
    },
    ehr_context: {
      age_years: 54,
      sex: 'female',
      bmi: 26.2,
      hba1c_pct: 6.8,
      hba1c_date: '2026-09-15',
      egfr: 92,
    },
  };
}

describe('Workspace Loading Skeletons and Lifecycle', () => {
  const emptyCache: SubjectStore = { patientId: 'P-SKELETON-001', cgm: [], risk: [], alerts: [], dataQuality: [] };

  it('renders appropriately sized skeletons across Workspace panels before the first valid forecast arrives', () => {
    const { container } = render(
      <TimeProvider>
        <PatientWorkspace
          patientId="P-SKELETON-001"
          forecast={null}
          cache={emptyCache}
          isConnected={false}
          isStale={false}
          error={null}
        />
      </TimeProvider>
    );

    // 1. Patient identity already available
    expect(screen.getByText('P-SKELETON-001')).toBeInTheDocument();
    expect(screen.getByText('Metadata pending')).toBeInTheDocument();

    // 2. Navigation breadcrumb & Research disclaimer remain visible
    expect(screen.getByRole('link', { name: /Cohort/ })).toBeInTheDocument();
    expect(screen.getByText(/Research Only \(Not for clinical decisions\)/)).toBeInTheDocument();

    // 3. Glucose summary skeleton
    expect(container.querySelector('.skeleton-glucose-value')).toBeInTheDocument();
    expect(container.querySelector('.skeleton-meta-line')).toBeInTheDocument();

    // 4. Glucose trajectory chart skeleton
    expect(container.querySelector('.skeleton-chart')).toBeInTheDocument();
    expect(container.querySelector('.skeleton-chart-grid')).toBeInTheDocument();

    // 5. Clinical context skeletons
    expect(container.querySelector('.skeleton-field')).toBeInTheDocument();
    expect(container.querySelector('.skeleton-field-sm')).toBeInTheDocument();
    expect(container.querySelector('.skeleton-field-lg')).toBeInTheDocument();

    // 6. Risk summary skeletons
    expect(container.querySelector('.skeleton-risk-value')).toBeInTheDocument();
    expect(container.querySelector('.skeleton-risk-alert')).toBeInTheDocument();
    expect(container.querySelector('.skeleton-meter-bar')).toBeInTheDocument();

    // 7. Model contributions skeletons
    expect(container.querySelector('.skeleton-contributions')).toBeInTheDocument();
    expect(container.querySelectorAll('.skeleton-row').length).toBe(4);

    // 8. Risk history skeleton
    expect(container.querySelector('.skeleton-risk-strip')).toBeInTheDocument();
    expect(container.querySelector('.skeleton-history-bar')).toBeInTheDocument();

    // 9. Data coverage skeletons
    expect(container.querySelectorAll('.skeleton-coverage-val').length).toBe(3);
    expect(container.querySelector('.skeleton-badge-line')).toBeInTheDocument();

    // No fabricated prediction numbers should be shown
    expect(screen.queryByText('mg/dL')).not.toBeInTheDocument();
  });

  it('replaces all skeletons with real content immediately when the first forecast arrives', () => {
    const fixture = validForecastFixture();
    const populatedCache: SubjectStore = {
      patientId: 'P-SKELETON-001',
      cgm: [{ t: fixture.as_of, value: 115, trend: 'flat' }],
      risk: [{ t: fixture.as_of, p: 0.18 }],
      alerts: [],
      dataQuality: [],
    };

    const { container, rerender } = render(
      <TimeProvider>
        <PatientWorkspace
          patientId="P-SKELETON-001"
          forecast={null}
          cache={emptyCache}
          isConnected={false}
          isStale={false}
          error={null}
        />
      </TimeProvider>
    );

    // Verify skeletons exist initially
    expect(container.querySelector('.skeleton-chart')).toBeInTheDocument();
    expect(container.querySelector('.skeleton-risk-value')).toBeInTheDocument();

    // Re-render when first forecast arrives
    rerender(
      <TimeProvider>
        <PatientWorkspace
          patientId="P-SKELETON-001"
          forecast={fixture}
          cache={populatedCache}
          isConnected={true}
          isStale={false}
          error={null}
        />
      </TimeProvider>
    );

    // All skeletons must be gone
    expect(container.querySelector('.skeleton-chart')).not.toBeInTheDocument();
    expect(container.querySelector('.skeleton-risk-value')).not.toBeInTheDocument();
    expect(container.querySelector('.skeleton-contributions')).not.toBeInTheDocument();
    expect(container.querySelector('.skeleton-risk-strip')).not.toBeInTheDocument();
    expect(container.querySelector('.skeleton-glucose-value')).not.toBeInTheDocument();
    expect(container.querySelector('.skeleton-field')).not.toBeInTheDocument();

    // Real values are displayed
    expect(screen.getAllByText('115').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('18.0%').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Recent Meal')).toBeInTheDocument();
    expect(screen.getByText('+12')).toBeInTheDocument();
    expect(screen.getByText('54 years')).toBeInTheDocument();
    expect(screen.getByText('female')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /Glucose forecast chart/ })).toBeInTheDocument();
  });

  it('does not replace the populated dashboard with skeletons on subsequent stream updates', () => {
    const fixture1 = validForecastFixture();
    const populatedCache: SubjectStore = {
      patientId: 'P-SKELETON-001',
      cgm: [{ t: fixture1.as_of, value: 115, trend: 'flat' }],
      risk: [{ t: fixture1.as_of, p: 0.18 }],
      alerts: [],
      dataQuality: [],
    };

    const { container, rerender } = render(
      <TimeProvider>
        <PatientWorkspace
          patientId="P-SKELETON-001"
          forecast={fixture1}
          cache={populatedCache}
          isConnected={true}
          isStale={false}
          error={null}
        />
      </TimeProvider>
    );

    // No skeletons on populated dashboard
    expect(container.querySelectorAll('.skeleton').length).toBe(0);

    // Stream update arrives (new forecast value)
    const fixture2: ForecastResponse = {
      ...fixture1,
      current: { value_mg_dl: 122, flag: 'in_range', measured_at: '2026-10-04T12:05:00Z', trend_arrow: 'forty_five_up' },
    };

    rerender(
      <TimeProvider>
        <PatientWorkspace
          patientId="P-SKELETON-001"
          forecast={fixture2}
          cache={populatedCache}
          isConnected={true}
          isStale={false}
          error={null}
        />
      </TimeProvider>
    );

    // Skeletons must NOT flash or appear on subsequent stream events
    expect(container.querySelectorAll('.skeleton').length).toBe(0);
    expect(screen.getAllByText('122').length).toBeGreaterThanOrEqual(1);
  });

  it('preserves existing populated results during disconnect or stream failure', () => {
    const fixture = validForecastFixture();
    const populatedCache: SubjectStore = {
      patientId: 'P-SKELETON-001',
      cgm: [{ t: fixture.as_of, value: 115, trend: 'flat' }],
      risk: [{ t: fixture.as_of, p: 0.18 }],
      alerts: [],
      dataQuality: [],
    };

    const { container, rerender } = render(
      <TimeProvider>
        <PatientWorkspace
          patientId="P-SKELETON-001"
          forecast={fixture}
          cache={populatedCache}
          isConnected={true}
          isStale={false}
          error={null}
        />
      </TimeProvider>
    );

    // Connection drops (stream error while already populated)
    rerender(
      <TimeProvider>
        <PatientWorkspace
          patientId="P-SKELETON-001"
          forecast={fixture}
          cache={populatedCache}
          isConnected={false}
          isStale={false}
          error={new Error('unavailable')}
        />
      </TimeProvider>
    );

    // Error alert is shown
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('Service Unavailable')).toBeInTheDocument();
    expect(screen.getByText('Disconnected')).toBeInTheDocument();

    // Existing valid results are preserved — NOT replaced with skeletons
    expect(container.querySelectorAll('.skeleton').length).toBe(0);
    expect(screen.getAllByText('115').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('18.0%').length).toBeGreaterThanOrEqual(1);
  });

  it('suppresses ghost skeletons and displays workspace unavailable card on initial stream failure', () => {
    const { container } = render(
      <TimeProvider>
        <PatientWorkspace
          patientId="P-SKELETON-001"
          forecast={null}
          cache={emptyCache}
          isConnected={false}
          isStale={false}
          error={new Error('patient-not-found')}
        />
      </TimeProvider>
    );

    // Error alert is shown
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('Patient Not Found')).toBeInTheDocument();

    // Skeletons are completely suppressed (no ghost skeletons)
    expect(container.querySelectorAll('.skeleton').length).toBe(0);

    // Clean empty state card with Return to Cohort Directory link
    expect(screen.getByText('Workspace unavailable')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Return to the cohort/i })).toBeInTheDocument();
  });

  it('verifies reduced-motion CSS rules for skeletons in globals.css', () => {
    const cssContent = fs.readFileSync(path.join(process.cwd(), 'src/app/globals.css'), 'utf8');

    // Skeletons must have prefers-reduced-motion rule disabling animation
    expect(cssContent).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\.skeleton\s*\{[\s\S]*?animation:\s*none/);
    // Non-animated solid background provided for comprehension without motion
    expect(cssContent).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\.skeleton\s*\{[\s\S]*?background:/);
  });

  it('renders reusable Skeleton primitive with accessible aria-hidden property', () => {
    const { Skeleton } = require('../src/components/ui/skeleton');
    const { container } = render(<Skeleton className="custom-skeleton" data-testid="test-skeleton" />);
    const el = container.querySelector('[data-testid="test-skeleton"]');
    expect(el).toBeInTheDocument();
    expect(el).toHaveClass('skeleton');
    expect(el).toHaveClass('custom-skeleton');
    expect(el).toHaveAttribute('aria-hidden', 'true');
  });

  it('verifies EvidencePage determines missing report synchronously without manufacturing skeletons', async () => {
    const EvidencePage = (await import('../src/app/evidence/page')).default;
    // When artifactsDir is non-existent, EvidencePage renders "Not yet evaluated" without skeletons
    process.env.ARTIFACTS_DIR = path.join(process.cwd(), 'nonexistent-artifacts-dir');
    const element = await EvidencePage();
    const { container } = render(element);

    expect(screen.getByText('Not yet evaluated')).toBeInTheDocument();
    expect(screen.getByText('Evaluation unavailable')).toBeInTheDocument();
    // No artificial loading skeletons manufactured
    expect(container.querySelectorAll('.skeleton').length).toBe(0);
    delete process.env.ARTIFACTS_DIR;
  });

  it('verifies globals.css focus rules eliminate doubled rings on dropdowns and search', () => {
    const cssContent = fs.readFileSync(path.join(process.cwd(), 'src/app/globals.css'), 'utf8');

    // select:focus-visible should use outline-offset: 0 to prevent doubled ring
    expect(cssContent).toMatch(/\.filter-controls\s+select:focus-visible\s*\{[^}]*outline-offset:\s*0/);
    // subject-search:focus-within should match with outline-offset: 0
    expect(cssContent).toMatch(/\.subject-search:focus-within\s*\{[^}]*outline-offset:\s*0/);
  });
});
