import { z } from 'zod';

export const GlucoseMgDlSchema = z.number().min(20).max(600);
export const ProbabilitySchema = z.number().min(0).max(1);
export const OffsetMinSchema = z.number().int().min(5).max(120);

export const SubjectSchema = z.object({
  subject_id: z.string().uuid(),
  synthetic: z.literal(true),
  cohort: z.string().optional(),
  simulator: z.object({
    version: z.string(),
    seed: z.number().int(),
    param_set_id: z.string()
  }).optional()
}).strict();

export const ModelInfoSchema = z.object({
  name: z.string(),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  run_id: z.string(),
  trained_at: z.string().datetime({ offset: true }).optional(),
  simulator_version: z.string().optional(),
  calibration_id: z.string().optional(),
  alert_policy_version: z.string(),
  fallback_used: z.enum(['xgboost', 'twin_only', 'persistence']).nullable().optional()
}).strict();

export const DataQualitySchema = z.object({
  status: z.enum(['ok', 'degraded', 'insufficient']),
  cgm_coverage_6h_pct: z.number().min(0).max(100),
  last_cgm_at: z.string().datetime({ offset: true }),
  staleness_min: z.number().int().min(0),
  sensor_day: z.number().int().min(0).max(15).optional(),
  in_warmup: z.boolean().optional(),
  ood_score: z.number().min(0).optional(),
  reasons: z.array(z.enum([
    'cgm_gap', 'stale_data', 'sensor_warmup', 'sensor_day1', 
    'compression_low_suspected', 'ood_subject', 'no_recent_meal_logs', 'twin_not_calibrated'
  ])).optional()
}).strict();

export const CurrentGlucoseSchema = z.object({
  value_mg_dl: GlucoseMgDlSchema.nullable(),
  flag: z.enum(['in_range', 'LOW', 'HIGH']),
  measured_at: z.string().datetime({ offset: true }),
  trend_mg_dl_per_min: z.number().nullable().optional(),
  trend_arrow: z.enum(['rising_fast', 'rising', 'rising_slow', 'flat', 'falling_slow', 'falling', 'falling_fast', 'unknown'])
}).strict();

export const QuantilePointSchema = z.object({
  offset_min: OffsetMinSchema,
  t: z.string().datetime({ offset: true }),
  p05: GlucoseMgDlSchema,
  p10: GlucoseMgDlSchema,
  p25: GlucoseMgDlSchema,
  p50: GlucoseMgDlSchema,
  p75: GlucoseMgDlSchema,
  p90: GlucoseMgDlSchema,
  p95: GlucoseMgDlSchema,
  twin_p50: GlucoseMgDlSchema.optional()
}).strict().refine(data => {
  return data.p05 <= data.p10 && data.p10 <= data.p25 && data.p25 <= data.p50 && 
         data.p50 <= data.p75 && data.p75 <= data.p90 && data.p90 <= data.p95;
}, { message: "Quantiles must be monotonically increasing" });

export const ForecastSchema = z.object({
  units: z.literal('mg/dL'),
  step_min: z.literal(5),
  horizon_min: z.literal(120),
  conformal_adjusted: z.boolean().optional(),
  points: z.array(QuantilePointSchema).length(24)
}).strict();

export const SpikeRiskSchema = z.object({
  probability_120m: ProbabilitySchema,
  tier: z.enum(['low', 'elevated', 'high']),
  calibrated: z.boolean(),
  spike_in_progress: z.boolean(),
  definition: z.object({
    threshold_mg_dl: z.number(),
    min_rise_mg_dl: z.number(),
    rise_window_min: z.number().int(),
    persistence_min: z.number().int()
  }).strict(),
  cumulative: z.array(z.object({
    offset_min: OffsetMinSchema,
    p: ProbabilitySchema
  }).strict()).length(24),
  onset_offset_min: z.object({
    p25: z.number().int(),
    p50: z.number().int(),
    p75: z.number().int()
  }).strict().nullable().optional(),
  peak_mg_dl: z.object({
    p50: GlucoseMgDlSchema,
    p90: GlucoseMgDlSchema
  }).strict().nullable().optional(),
  time_to_peak_min: z.number().int().nullable().optional()
}).strict();

export const AlertSchema = z.object({
  state: z.enum(['none', 'watch', 'warning']),
  alert_id: z.string().uuid().nullable().optional(),
  since: z.string().datetime({ offset: true }).nullable().optional(),
  suppressed_until: z.string().datetime({ offset: true }).nullable().optional(),
  message_key: z.string().nullable().optional()
}).strict();

export const DriverSchema = z.object({
  feature_key: z.string(),
  label_key: z.string(),
  direction: z.enum(['raises', 'lowers']),
  impact_mg_dl: z.number(),
  source: z.enum(['twin', 'residual', 'both']).optional()
}).strict();

export const TwinStateSchema = z.object({
  insulin_sensitivity_rel: z.number().min(0).optional(),
  beta_cell_rel: z.number().min(0).optional(),
  carbs_on_board_g: z.number().min(0).optional(),
  insulin_on_board_u: z.number().min(0).nullable().optional(),
  unannounced_meal: z.object({
    probability: ProbabilitySchema,
    estimated_carbs_g: z.number().nullable().optional(),
    estimated_at: z.string().datetime({ offset: true }).nullable().optional()
  }).strict().optional(),
  last_calibrated_at: z.string().datetime({ offset: true }).optional()
}).strict();

export const MedClassSchema = z.enum([
  'metformin', 'sglt2i', 'glp1_ra', 'dpp4i', 'sulfonylurea', 
  'tzd', 'basal_insulin', 'prandial_insulin', 'corticosteroid'
]);

export const EhrContextSchema = z.object({
  age_years: z.number().int().min(18).max(110),
  sex: z.enum(['female', 'male', 'other', 'unknown']),
  bmi: z.number().min(12).max(80),
  hba1c_pct: z.number().min(4).max(18),
  hba1c_date: z.string(),
  t2d_duration_years: z.number().min(0).optional(),
  egfr: z.number().min(0).nullable().optional(),
  med_classes: z.array(MedClassSchema).optional()
}).strict();

export const ProblemSchema = z.object({
  type: z.string().optional(),
  title: z.string(),
  status: z.number().int().optional(),
  detail: z.string().optional(),
  code: z.string()
});

export const ForecastResponseSchema = z.object({
  schema_version: z.literal('1.0.0'),
  request_id: z.string().uuid(),
  generated_at: z.string().datetime({ offset: true }),
  as_of: z.string().datetime({ offset: true }),
  subject: SubjectSchema,
  model: ModelInfoSchema,
  data_quality: DataQualitySchema,
  current: CurrentGlucoseSchema,
  forecast: ForecastSchema.nullable(),
  spike_risk: SpikeRiskSchema.nullable(),
  alert: AlertSchema,
  drivers: z.array(DriverSchema).max(8).optional(),
  scenarios: z.array(z.unknown()).max(4).optional(),
  twin_state: TwinStateSchema.optional(),
  ehr_context: EhrContextSchema.optional(),
  intended_use: z.literal('research_only_not_for_clinical_decisions'),
  warnings: z.array(ProblemSchema).optional()
}).strict();

export const StreamEventSchema = z.object({
  event: z.enum(['forecast.updated', 'alert.raised', 'alert.cleared', 'data_quality.changed', 'twin.recalibrated']),
  event_id: z.string(),
  subject_id: z.string().uuid(),
  emitted_at: z.string().datetime({ offset: true }),
  payload: z.unknown()
}).strict();

export const ForecastRequestSchema = z.object({
  schema_version: z.literal('1.0.0'),
  request_id: z.string().uuid(),
  subject_id: z.string().uuid(),
  as_of: z.string().datetime({ offset: true }).optional(),
  include: z.array(z.enum(['drivers', 'scenarios', 'twin_state', 'ehr_context', 'twin_overlay'])).optional(),
  scenarios: z.array(z.object({
    scenario_id: z.string().regex(/^[a-z0-9_-]{1,32}$/),
    label: z.string().max(60).optional(),
    inputs: z.array(z.unknown()).min(1).max(6) // ScenarioInput is complex, any for now
  })).max(4).optional(),
  alert_policy_version: z.string().optional()
}).strict();

export const TwinCardSchema = z.object({
  schema_version: z.literal('1.0.0'),
  subject_id: z.string().uuid(),
  synthetic: z.literal(true),
  calibrated_at: z.string().datetime({ offset: true }),
  calibration_stage: z.enum(['ehr_prior', 'nightly_map', 'adapter_finetuned']),
  parameters: z.array(z.object({
    key: z.enum(['insulin_sensitivity_rel', 'beta_cell_rel', 'first_phase_rel', 'egp_basal_mg_per_min', 't_max_min', 'tau_isf_min', 'dawn_amplitude']),
    value: z.number(),
    unit: z.string(),
    ci80: z.tuple([z.number(), z.number()]),
    prior_value: z.number()
  }).strict()).min(1),
  history: z.array(z.object({
    date: z.string(),
    insulin_sensitivity_rel: z.number(),
    beta_cell_rel: z.number()
  }).strict()).max(180).optional(),
  fit_quality: z.object({
    rmse_60m_14d_mg_dl: z.number().optional(),
    coverage_80_pct_14d: z.number().min(0).max(100).optional()
  }).strict().optional()
}).strict();
