import React from 'react';
import { render, screen } from '@testing-library/react';
import EvidencePage from '../src/app/evidence/page';
import fs from 'fs/promises';
import crypto from 'crypto';

jest.mock('fs/promises', () => ({
  readFile: jest.fn()
}));

jest.mock('next/navigation', () => ({
  usePathname: () => '/evidence'
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
      'patient_cgm_telemetry.csv': 'd'.repeat(64)
    }
  },
  checkpoint: {
    name: 'epoch=03.ckpt',
    path: 'checkpoints/stage2_observed-epoch=03-val_loss=0.2255.ckpt',
    sha256: 'b'.repeat(64)
  }
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
      'patient_cgm_telemetry.csv': 'd'.repeat(64)
    }
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
          width_80_conformal_mg_dl: { estimate: 37.30 }
        },
        twin_only: {
          rmse_30: { estimate: 15.24, ci_95: [14.30, 16.16] },
          rmse_60: { estimate: 23.23, ci_95: [21.76, 24.64] },
          rmse_120: { estimate: 28.64, ci_95: [26.67, 30.51] },
          mae_30: { estimate: 9.53 },
          mae_60: { estimate: 14.24 },
          mae_120: { estimate: 19.17 },
          mard_30: { estimate: 7.92 },
          mard_60: { estimate: 11.27 },
          mard_120: { estimate: 15.26 }
        },
        persistence: {
          rmse_30: { estimate: 21.64, ci_95: [20.44, 22.79] },
          rmse_60: { estimate: 36.05, ci_95: [33.85, 38.13] },
          rmse_120: { estimate: 48.36, ci_95: [45.06, 51.46] },
          mae_30: { estimate: 14.34 },
          mae_60: { estimate: 23.44 },
          mae_120: { estimate: 32.93 },
          mard_30: { estimate: 11.47 },
          mard_60: { estimate: 18.93 },
          mard_120: { estimate: 28.21 }
        }
      },
      paired_comparisons: {
        pr_minus_persistence_rmse_30: { diff: -9.28, ci_95: [-10.05, -8.43], relative_reduction_pct: 42.87, draws: 10000, negative_draws: 10000 },
        pr_minus_twin_rmse_30: { diff: -2.88, ci_95: [-3.37, -2.38], relative_reduction_pct: 18.90, draws: 10000, negative_draws: 10000 },
        pr_minus_persistence_rmse_60: { diff: -16.53, ci_95: [-17.77, -15.17], relative_reduction_pct: 45.84, draws: 10000, negative_draws: 10000 },
        pr_minus_twin_rmse_60: { diff: -3.71, ci_95: [-4.27, -3.15], relative_reduction_pct: 15.96, draws: 10000, negative_draws: 10000 },
        pr_minus_persistence_rmse_120: { diff: -23.33, ci_95: [-25.31, -21.23], relative_reduction_pct: 48.24, draws: 10000, negative_draws: 10000 },
        pr_minus_twin_rmse_120: { diff: -3.61, ci_95: [-4.44, -2.81], relative_reduction_pct: 12.61, draws: 10000, negative_draws: 10000 }
      },
      patient_pairwise_wins: {
        '30min': {
          pr_vs_persistence: { wins_count: 44, n_patients: 44, win_fraction: 1.0, exact_binomial_ci_95: [0.92, 1.0] },
          pr_vs_twin: { wins_count: 44, n_patients: 44, win_fraction: 1.0, exact_binomial_ci_95: [0.92, 1.0] }
        },
        '60min': {
          pr_vs_persistence: { wins_count: 44, n_patients: 44, win_fraction: 1.0, exact_binomial_ci_95: [0.92, 1.0] },
          pr_vs_twin: { wins_count: 44, n_patients: 44, win_fraction: 1.0, exact_binomial_ci_95: [0.92, 1.0] }
        },
        '120min': {
          pr_vs_persistence: { wins_count: 44, n_patients: 44, win_fraction: 1.0, exact_binomial_ci_95: [0.92, 1.0] },
          pr_vs_twin: { wins_count: 41, n_patients: 44, win_fraction: 0.93182, exact_binomial_ci_95: [0.813, 0.986] }
        },
        sampling_assumption: 'Independent Bernoulli trials across the 44 subjects'
      },
      subgroups: {
        'Healthy': { n_patients: 15, n_anchors_eligible: 18486, n_evaluable_30: 18372, n_evaluable_60: 18367, n_evaluable_120: 18339, rmse_30: 12.30, rmse_60: 19.31, rmse_120: 23.46 },
        'Prediabetes': { n_patients: 19, n_anchors_eligible: 23485, n_evaluable_30: 23325, n_evaluable_60: 23318, n_evaluable_120: 23306, rmse_30: 12.58, rmse_60: 19.87, rmse_120: 25.41 },
        'Type 2': { n_patients: 10, n_anchors_eligible: 12310, n_evaluable_30: 12223, n_evaluable_60: 12221, n_evaluable_120: 12204, rmse_30: 12.03, rmse_60: 19.18, rmse_120: 26.55 }
      },
      calibration_resubstitution_diagnostics: {
        brier_score_raw: 0.165,
        brier_score_calibrated: 0.0703,
        at_risk_anchors: 47629,
        threshold_evaluations: {
          '0.35': { threshold: 0.35, label: 'Evaluated 0.35', sensitivity: 0.6303, precision: 0.5868, alert_rate_pct: 14.2 },
          '0.60': { threshold: 0.60, label: 'High threshold diagnostic', sensitivity: 0.2987, precision: 0.745, alert_rate_pct: 5.3 }
        }
      },
      gate3_realism_status: {
        status: 'FAILED',
        acceptance_threshold: '<= 0.65',
        historical_auroc: 0.932031,
        duration_corrected_auroc: 0.928974
      },
      patient_level_distribution: {
        '60min': { min: 14.22, p25: 17.32, median: 18.86, p75: 20.74, max: 27.13, iqr: 3.42 },
        '120min': { min: 15.51, p25: 20.96, median: 24.96, p75: 28.31, max: 32.98, iqr: 7.35 }
      }
    }
  }
};

describe('EvidencePage', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    process.env.ARTIFACTS_DIR = '/mock/artifacts';
  });

  it('renders "Not yet evaluated" when artifacts are absent (ENOENT) and does not show benchmark tables', async () => {
    const error: any = new Error('ENOENT: no such file');
    error.code = 'ENOENT';
    (fs.readFile as jest.Mock).mockRejectedValue(error);

    const Component = await EvidencePage();
    render(Component);

    expect(screen.getByText('Not yet evaluated')).toBeInTheDocument();
    expect(screen.getByText('Evaluation unavailable')).toBeInTheDocument();
    // Benchmark tables must NEVER appear beside an absent artifact
    expect(screen.queryByText('Matched Baseline Comparisons & Patient-Clustered Uncertainty')).not.toBeInTheDocument();
    expect(screen.queryByText('PR-TFT (Arm D)')).not.toBeInTheDocument();
    // Historical baseline reference remains visible as a separate, fixed record
    expect(screen.getByText('Historical Development Reference (18-Subject Partition)')).toBeInTheDocument();
  });

  it('renders "Invalid or incomplete evaluation artifacts" when JSON is malformed and does not show benchmark tables', async () => {
    (fs.readFile as jest.Mock).mockResolvedValue(Buffer.from('{ "invalid": json'));

    const Component = await EvidencePage();
    render(Component);

    expect(screen.getByText('Invalid or incomplete evaluation artifacts')).toBeInTheDocument();
    expect(screen.getByText('Evaluation unavailable')).toBeInTheDocument();
    expect(screen.queryByText('Matched Baseline Comparisons & Patient-Clustered Uncertainty')).not.toBeInTheDocument();
  });

  it('renders "Invalid or incomplete evaluation artifacts" when required fields are missing', async () => {
    (fs.readFile as jest.Mock).mockImplementation(async (filePath) => {
      if (filePath.endsWith('run_manifest.json')) return Buffer.from(MANIFEST_STRING);
      if (filePath.endsWith('evaluation_report.json')) return Buffer.from(JSON.stringify({ provenance: {} }));
      throw new Error('Not found');
    });

    const Component = await EvidencePage();
    render(Component);

    expect(screen.getByText('Invalid or incomplete evaluation artifacts')).toBeInTheDocument();
    expect(screen.queryByText('Matched Baseline Comparisons & Patient-Clustered Uncertainty')).not.toBeInTheDocument();
  });

  it('renders "Invalid or incomplete evaluation artifacts" when metric is NaN, null, or Infinity', async () => {
    const invalidReport = JSON.parse(JSON.stringify(FULL_BENCHMARK_REPORT));
    invalidReport.populations.primary.models.pr_tft.rmse_60.estimate = NaN;

    (fs.readFile as jest.Mock).mockImplementation(async (filePath) => {
      if (filePath.endsWith('run_manifest.json')) return Buffer.from(MANIFEST_STRING);
      if (filePath.endsWith('evaluation_report.json')) return Buffer.from(JSON.stringify(invalidReport));
      throw new Error('Not found');
    });

    const Component = await EvidencePage();
    render(Component);

    expect(screen.getByText('Invalid or incomplete evaluation artifacts')).toBeInTheDocument();
    expect(screen.queryByText('Matched Baseline Comparisons & Patient-Clustered Uncertainty')).not.toBeInTheDocument();
  });

  it('renders error state when a primary horizon is missing (e.g. missing rmse_30 in pr_tft)', async () => {
    const incompleteReport = JSON.parse(JSON.stringify(FULL_BENCHMARK_REPORT));
    delete incompleteReport.populations.primary.models.pr_tft.rmse_30;

    (fs.readFile as jest.Mock).mockImplementation(async (filePath) => {
      if (filePath.endsWith('run_manifest.json')) return Buffer.from(MANIFEST_STRING);
      if (filePath.endsWith('evaluation_report.json')) return Buffer.from(JSON.stringify(incompleteReport));
      throw new Error('Not found');
    });

    const Component = await EvidencePage();
    render(Component);

    expect(screen.getByText('Invalid or incomplete evaluation artifacts')).toBeInTheDocument();
    expect(screen.queryByText('Matched Baseline Comparisons & Patient-Clustered Uncertainty')).not.toBeInTheDocument();
  });

  it('renders error state when confidence interval bounds are inverted (low > high)', async () => {
    const invalidReport = JSON.parse(JSON.stringify(FULL_BENCHMARK_REPORT));
    invalidReport.populations.primary.models.pr_tft.rmse_60.ci_95 = [25.0, 15.0];

    (fs.readFile as jest.Mock).mockImplementation(async (filePath) => {
      if (filePath.endsWith('run_manifest.json')) return Buffer.from(MANIFEST_STRING);
      if (filePath.endsWith('evaluation_report.json')) return Buffer.from(JSON.stringify(invalidReport));
      throw new Error('Not found');
    });

    const Component = await EvidencePage();
    render(Component);

    expect(screen.getByText('Invalid or incomplete evaluation artifacts')).toBeInTheDocument();
    expect(screen.queryByText('Matched Baseline Comparisons & Patient-Clustered Uncertainty')).not.toBeInTheDocument();
  });

  it('renders error state on denominator mismatch in subgroups (evaluable rows > eligible anchors)', async () => {
    const invalidReport = JSON.parse(JSON.stringify(FULL_BENCHMARK_REPORT));
    invalidReport.populations.primary.subgroups.Healthy.n_evaluable_60 = 25000;
    invalidReport.populations.primary.subgroups.Healthy.n_anchors_eligible = 18486;

    (fs.readFile as jest.Mock).mockImplementation(async (filePath) => {
      if (filePath.endsWith('run_manifest.json')) return Buffer.from(MANIFEST_STRING);
      if (filePath.endsWith('evaluation_report.json')) return Buffer.from(JSON.stringify(invalidReport));
      throw new Error('Not found');
    });

    const Component = await EvidencePage();
    render(Component);

    expect(screen.getByText('Invalid or incomplete evaluation artifacts')).toBeInTheDocument();
    expect(screen.queryByText('Matched Baseline Comparisons & Patient-Clustered Uncertainty')).not.toBeInTheDocument();
  });

  it('renders error state when patient wins count exceeds total patients', async () => {
    const invalidReport = JSON.parse(JSON.stringify(FULL_BENCHMARK_REPORT));
    invalidReport.populations.primary.patient_pairwise_wins['30min'].pr_vs_persistence.wins_count = 50;
    invalidReport.populations.primary.patient_pairwise_wins['30min'].pr_vs_persistence.n_patients = 44;

    (fs.readFile as jest.Mock).mockImplementation(async (filePath) => {
      if (filePath.endsWith('run_manifest.json')) return Buffer.from(MANIFEST_STRING);
      if (filePath.endsWith('evaluation_report.json')) return Buffer.from(JSON.stringify(invalidReport));
      throw new Error('Not found');
    });

    const Component = await EvidencePage();
    render(Component);

    expect(screen.getByText('Invalid or incomplete evaluation artifacts')).toBeInTheDocument();
    expect(screen.queryByText('Matched Baseline Comparisons & Patient-Clustered Uncertainty')).not.toBeInTheDocument();
  });

  it('renders error state when comparator denominators mismatch in patient wins', async () => {
    const invalidReport = JSON.parse(JSON.stringify(FULL_BENCHMARK_REPORT));
    invalidReport.populations.primary.patient_pairwise_wins['30min'].pr_vs_persistence.n_patients = 44;
    invalidReport.populations.primary.patient_pairwise_wins['30min'].pr_vs_twin.n_patients = 40;

    (fs.readFile as jest.Mock).mockImplementation(async (filePath) => {
      if (filePath.endsWith('run_manifest.json')) return Buffer.from(MANIFEST_STRING);
      if (filePath.endsWith('evaluation_report.json')) return Buffer.from(JSON.stringify(invalidReport));
      throw new Error('Not found');
    });

    const Component = await EvidencePage();
    render(Component);

    expect(screen.getByText('Invalid or incomplete evaluation artifacts')).toBeInTheDocument();
    expect(screen.queryByText('Matched Baseline Comparisons & Patient-Clustered Uncertainty')).not.toBeInTheDocument();
  });

  it('renders provenance-mismatch error state when a non-checkpoint manifest field is altered while checkpoint hash matches', async () => {
    const alteredManifest = {
      ...BASE_MANIFEST,
      runtime_s: 99999.9 // Non-checkpoint field changed!
    };
    const alteredManifestBytes = Buffer.from(JSON.stringify(alteredManifest, null, 2));

    (fs.readFile as jest.Mock).mockImplementation(async (filePath) => {
      if (filePath.endsWith('run_manifest.json')) return alteredManifestBytes;
      if (filePath.endsWith('evaluation_report.json')) return Buffer.from(JSON.stringify(FULL_BENCHMARK_REPORT));
      throw new Error('Not found');
    });

    const Component = await EvidencePage();
    render(Component);

    expect(screen.getByText('Evaluation artifact provenance mismatch')).toBeInTheDocument();
    expect(screen.getByText('Evaluation unavailable')).toBeInTheDocument();
    // Benchmark tables must NOT appear beside mismatched artifact
    expect(screen.queryByText('Matched Baseline Comparisons & Patient-Clustered Uncertainty')).not.toBeInTheDocument();
    expect(screen.queryByText('Patient-Level Pairwise Win Rates (Exact Clopper-Pearson Binomial Intervals)')).not.toBeInTheDocument();
  });

  it('renders error state and excludes benchmark tables when checkpoint hash mismatches', async () => {
    const mismatchedManifest = {
      ...BASE_MANIFEST,
      checkpoint: { ...BASE_MANIFEST.checkpoint, sha256: 'f'.repeat(64) }
    };
    const mismatchedBytes = Buffer.from(JSON.stringify(mismatchedManifest, null, 2));

    (fs.readFile as jest.Mock).mockImplementation(async (filePath) => {
      if (filePath.endsWith('run_manifest.json')) return mismatchedBytes;
      if (filePath.endsWith('evaluation_report.json')) return Buffer.from(JSON.stringify(FULL_BENCHMARK_REPORT));
      throw new Error('Not found');
    });

    const Component = await EvidencePage();
    render(Component);

    expect(screen.getByText('Evaluation artifact provenance mismatch')).toBeInTheDocument();
    expect(screen.getByText('Evaluation unavailable')).toBeInTheDocument();
    expect(screen.queryByText('Matched Baseline Comparisons & Patient-Clustered Uncertainty')).not.toBeInTheDocument();
  });

  it('renders error state and excludes benchmark tables when run_id mismatches', async () => {
    const mismatchedManifest = {
      ...BASE_MANIFEST,
      run_id: 'different-run-id'
    };
    const mismatchedBytes = Buffer.from(JSON.stringify(mismatchedManifest, null, 2));

    (fs.readFile as jest.Mock).mockImplementation(async (filePath) => {
      if (filePath.endsWith('run_manifest.json')) return mismatchedBytes;
      if (filePath.endsWith('evaluation_report.json')) return Buffer.from(JSON.stringify(FULL_BENCHMARK_REPORT));
      throw new Error('Not found');
    });

    const Component = await EvidencePage();
    render(Component);

    expect(screen.getByText('Evaluation artifact provenance mismatch')).toBeInTheDocument();
    expect(screen.getByText('Evaluation unavailable')).toBeInTheDocument();
    expect(screen.queryByText('Matched Baseline Comparisons & Patient-Clustered Uncertainty')).not.toBeInTheDocument();
  });

  it('renders verified benchmark tables when full evaluation artifact and manifest are perfectly valid', async () => {
    (fs.readFile as jest.Mock).mockImplementation(async (filePath) => {
      if (filePath.endsWith('run_manifest.json')) return Buffer.from(MANIFEST_STRING);
      if (filePath.endsWith('evaluation_report.json')) return Buffer.from(JSON.stringify(FULL_BENCHMARK_REPORT));
      throw new Error('Not found');
    });

    const Component = await EvidencePage();
    render(Component);

    expect(screen.queryByText('Not yet evaluated')).not.toBeInTheDocument();
    expect(screen.queryByText('Invalid or incomplete evaluation artifacts')).not.toBeInTheDocument();
    expect(screen.queryByText('Evaluation artifact provenance mismatch')).not.toBeInTheDocument();

    expect(screen.getByText('Matched Baseline Comparisons & Patient-Clustered Uncertainty')).toBeInTheDocument();
    expect(screen.getAllByText('PR-TFT (Arm D)').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Patient-Level Pairwise Win Rates (Exact Clopper-Pearson Binomial Intervals)')).toBeInTheDocument();
    expect(screen.getByText('Subgroup Robustness Across Clinical Strata')).toBeInTheDocument();
    expect(screen.getByText('Historical Development Reference (18-Subject Partition)')).toBeInTheDocument();

    // Verify unsupported language is completely absent
    expect(screen.queryByText(/Rule of Three/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/p < 0\.0003/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/sensitivity collapse/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/development validation ceiling/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/catastrophic individual outliers/i)).not.toBeInTheDocument();
  });
});
