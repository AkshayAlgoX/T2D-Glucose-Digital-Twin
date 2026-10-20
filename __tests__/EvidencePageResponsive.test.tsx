import React from 'react';
import { render, screen } from '@testing-library/react';
import EvidencePage from '../src/app/evidence/page';
import fs from 'fs/promises';
import crypto from 'crypto';

jest.mock('fs/promises', () => ({
  readFile: jest.fn(),
}));

jest.mock('next/navigation', () => ({
  usePathname: () => '/evidence',
}));

function sha256(content: string | Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

const BASE_MANIFEST = {
  run_id: 'test-run-123',
  run_kind: 'full',
  runtime_s: 11053.3,
  preflight: {
    data_sha256: {
      'patients_ehr.csv': 'c'.repeat(64),
      'patient_cgm_telemetry.csv': 'd'.repeat(64),
    },
  },
  checkpoint: {
    name: 'epoch=03.ckpt',
    path: 'checkpoints/stage2_observed-epoch=03-val_loss=0.2255.ckpt',
    sha256: 'b'.repeat(64),
  },
};

const MANIFEST_STRING = JSON.stringify(BASE_MANIFEST, null, 2);
const MANIFEST_SHA = sha256(MANIFEST_STRING);

const FULL_BENCHMARK_REPORT = {
  schema: 'pr_tft_evaluation/v1',
  run_id: 'test-run-123',
  provenance: {
    run_manifest_sha256: MANIFEST_SHA,
    checkpoint_sha256: 'b'.repeat(64),
    data_sha256: {
      'patients_ehr.csv': 'c'.repeat(64),
      'patient_cgm_telemetry.csv': 'd'.repeat(64),
    },
  },
  populations: {
    primary: {
      name: 'Validation Split',
      models: {
        pr_tft: {
          rmse_30: { estimate: 12.36, ci_95: [11.89, 12.84] },
          rmse_60: { estimate: 19.53, ci_95: [18.56, 20.48] },
          rmse_120: { estimate: 25.03, ci_95: [23.67, 26.27] },
          mae_30: { estimate: 8.43 },
          mae_60: { estimate: 12.43 },
          mae_120: { estimate: 16.76 },
          mard_30: { estimate: 7.22 },
          mard_60: { estimate: 10.16 },
          mard_120: { estimate: 13.66 },
          coverage_80_conformal: { estimate: 0.800 },
          width_80_conformal_mg_dl: { estimate: 37.30 },
        },
        twin_only: {
          rmse_30: { estimate: 15.24, ci_95: [14.30, 16.16] },
          rmse_60: { estimate: 23.23, ci_95: [21.76, 24.64] },
          rmse_120: { estimate: 28.64, ci_95: [26.67, 30.51] },
        },
        persistence: {
          rmse_30: { estimate: 21.64, ci_95: [20.44, 22.79] },
          rmse_60: { estimate: 36.05, ci_95: [33.85, 38.13] },
          rmse_120: { estimate: 48.36, ci_95: [45.06, 51.46] },
        },
      },
      paired_comparisons: {
        pr_minus_persistence_rmse_30: { diff: -9.28, ci_95: [-10.05, -8.43], relative_reduction_pct: 42.87, draws: 10000, negative_draws: 10000 },
        pr_minus_twin_rmse_30: { diff: -2.88, ci_95: [-3.37, -2.38], relative_reduction_pct: 18.90, draws: 10000, negative_draws: 10000 },
        pr_minus_persistence_rmse_60: { diff: -16.53, ci_95: [-17.77, -15.17], relative_reduction_pct: 45.84, draws: 10000, negative_draws: 10000 },
        pr_minus_twin_rmse_60: { diff: -3.71, ci_95: [-4.27, -3.15], relative_reduction_pct: 15.96, draws: 10000, negative_draws: 10000 },
        pr_minus_persistence_rmse_120: { diff: -23.33, ci_95: [-25.31, -21.23], relative_reduction_pct: 48.24, draws: 10000, negative_draws: 10000 },
        pr_minus_twin_rmse_120: { diff: -3.61, ci_95: [-4.44, -2.81], relative_reduction_pct: 12.61, draws: 10000, negative_draws: 10000 },
      },
      patient_pairwise_wins: {
        '30min': {
          pr_vs_persistence: { wins_count: 44, n_patients: 44, win_fraction: 1.0, exact_binomial_ci_95: [0.92, 1.0] },
          pr_vs_twin: { wins_count: 44, n_patients: 44, win_fraction: 1.0, exact_binomial_ci_95: [0.92, 1.0] },
        },
        '60min': {
          pr_vs_persistence: { wins_count: 44, n_patients: 44, win_fraction: 1.0, exact_binomial_ci_95: [0.92, 1.0] },
          pr_vs_twin: { wins_count: 44, n_patients: 44, win_fraction: 1.0, exact_binomial_ci_95: [0.92, 1.0] },
        },
        '120min': {
          pr_vs_persistence: { wins_count: 44, n_patients: 44, win_fraction: 1.0, exact_binomial_ci_95: [0.92, 1.0] },
          pr_vs_twin: { wins_count: 41, n_patients: 44, win_fraction: 0.93182, exact_binomial_ci_95: [0.813, 0.986] },
        },
        sampling_assumption: 'Independent Bernoulli trials across the 44 subjects',
      },
      subgroups: {
        Healthy: { n_patients: 15, n_anchors_eligible: 18486, n_evaluable_30: 18372, n_evaluable_60: 18367, n_evaluable_120: 18339, rmse_30: 12.30, rmse_60: 19.31, rmse_120: 23.46 },
        Prediabetes: { n_patients: 19, n_anchors_eligible: 23485, n_evaluable_30: 23325, n_evaluable_60: 23318, n_evaluable_120: 23306, rmse_30: 12.58, rmse_60: 19.87, rmse_120: 25.41 },
        'Type 2': { n_patients: 10, n_anchors_eligible: 12310, n_evaluable_30: 12223, n_evaluable_60: 12221, n_evaluable_120: 12204, rmse_30: 12.03, rmse_60: 19.18, rmse_120: 26.55 },
      },
      calibration_resubstitution_diagnostics: {
        brier_score_raw: 0.165,
        brier_score_calibrated: 0.0703,
        at_risk_anchors: 47629,
        threshold_evaluations: {
          '0.35': { threshold: 0.35, label: 'Evaluated 0.35', sensitivity: 0.6303, precision: 0.5868, alert_rate_pct: 14.2 },
          '0.60': { threshold: 0.60, label: 'High threshold diagnostic', sensitivity: 0.2987, precision: 0.745, alert_rate_pct: 5.3 },
        },
      },
      gate3_realism_status: {
        status: 'FAILED',
        acceptance_threshold: '<= 0.65',
        historical_auroc: 0.932031,
        duration_corrected_auroc: 0.928974,
      },
    },
  },
};

describe('EvidencePage Responsive & Accessibility Audit', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    process.env.ARTIFACTS_DIR = '/mock/artifacts';
    (fs.readFile as jest.Mock).mockImplementation(async (filePath) => {
      if (filePath.endsWith('run_manifest.json')) return Buffer.from(MANIFEST_STRING);
      if (filePath.endsWith('evaluation_report.json')) return Buffer.from(JSON.stringify(FULL_BENCHMARK_REPORT));
      throw new Error('Not found');
    });
  });

  it('provides accessible landmarks, table labeling, and col scopes for mobile screen readers', async () => {
    const Component = await EvidencePage();
    const { container } = render(Component);

    // Main landmark and heading hierarchy
    const main = screen.getByRole('main');
    expect(main).toHaveAttribute('id', 'main-content');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Evidence & validation');

    // Generalization banner region
    const banner = screen.getByRole('region', { name: 'Generalization Boundary Disclosure' });
    expect(banner).toBeInTheDocument();

    // Table accessibility
    const table = screen.getByRole('table', { name: 'Matched baseline forecast comparisons across prediction horizons' });
    expect(table).toBeInTheDocument();
    expect(table.parentElement).toHaveClass('evidence-table-container');

    // Column headers
    const colHeaders = screen.getAllByRole('columnheader');
    expect(colHeaders.length).toBe(7);
    colHeaders.forEach((th) => {
      expect(th).toHaveAttribute('scope', 'col');
    });

    // Check all images have meaningful alt text
    const images = container.querySelectorAll('img');
    expect(images.length).toBe(5);
    images.forEach((img) => {
      expect(img).toHaveAttribute('alt');
      expect(img.getAttribute('alt')?.length).toBeGreaterThan(5);
    });

    // Check semantic collapsible disclosure
    const details = container.querySelector('details.reproducibility-details');
    expect(details).toBeInTheDocument();
    const summary = details?.querySelector('summary.reproducibility-summary');
    expect(summary).toBeInTheDocument();
  });
});
