/** @type {import('next').NextConfig} */
const nextConfig = {
  // Hide the development status indicator; compile/runtime errors remain visible.
  devIndicators: false,
  images: {
    unoptimized: true,
  },
  // src/lib/landing.ts reads these evidence files at request time with a parameterised path (marked
  // turbopackIgnore so the whole repository, including model weights and synthetic CSVs, is not traced).
  // List them here so deployments still ship exactly what those reads need.
  outputFileTracingIncludes: {
    '/': ['./docs/evidence/validation_ceiling_results.json', './docs/evidence/event_eval/validation_event_report.json'],
    '/evidence': [
      './docs/evidence/validation_ceiling_results.json',
      './docs/evidence/jump_experiment/results.json',
      './docs/evidence/event_eval/validation_event_report.json',
      './backend/synthetic_v2/validation/validation_report.json',
      './docs/evidence/real_data/results.json',
      './runs/pr_tft_ablation_arm_d/run_manifest.json',
      './runs/pr_tft_ablation_arm_d/evaluation_report.json',
    ],
  },
  // The Evidence page reads only the two JSON files above from the run folder; never ship its model weights.
  outputFileTracingExcludes: {
    '/evidence': ['./runs/**/*.npz', './runs/**/*.ckpt', './backend/synthetic_v2/**/*.csv'],
  },
};

export default nextConfig;
