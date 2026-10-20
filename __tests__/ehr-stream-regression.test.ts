/** @jest-environment node */
import { NextRequest } from 'next/server';
import { GET } from '../src/app/api/patients/[id]/stream/route';
import { ForecastResponseSchema, StreamEventSchema } from '../src/lib/zod-schemas';
import { createSafeSSETransformStream } from '../src/lib/sse-parser';

const subjectId = '123e4567-e89b-12d3-a456-426614174000';
const timestamp = '2026-10-04T12:00:00Z';

function forecastWithEhr() {
  return {
    schema_version: '1.0.0',
    request_id: subjectId,
    generated_at: timestamp,
    as_of: timestamp,
    subject: { subject_id: subjectId, synthetic: true },
    model: { name: 'tft', version: '1.0.0', run_id: 'fixture', alert_policy_version: '1.0' },
    data_quality: {
      status: 'ok', cgm_coverage_6h_pct: 100, last_cgm_at: timestamp, staleness_min: 0,
    },
    current: { value_mg_dl: 110, flag: 'in_range', measured_at: timestamp, trend_arrow: 'flat' },
    forecast: {
      units: 'mg/dL', step_min: 5, horizon_min: 120,
      points: Array.from({ length: 24 }, (_, i) => ({
        offset_min: (i + 1) * 5,
        t: new Date(Date.parse(timestamp) + (i + 1) * 300000).toISOString(),
        p05: 90, p10: 95, p25: 100, p50: 110, p75: 120, p90: 125, p95: 130,
      })),
    },
    spike_risk: null,
    alert: { state: 'none' },
    ehr_context: {
      age_years: 58, sex: 'female', bmi: 27.4, hba1c_pct: 7.2,
      hba1c_date: '2026-09-28', t2d_duration_years: 4.5, egfr: 90,
      med_classes: ['metformin', 'sglt2i'],
    },
    intended_use: 'research_only_not_for_clinical_decisions',
  };
}

describe('EHR stream proxy URL', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, BACKEND_URL: 'http://127.0.0.1:8001' };
    delete process.env.PR_TFT_SERVICE_TOKEN;
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response('', {
      headers: { 'Content-Type': 'text/event-stream' },
    }));
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  it('defaults to speed=60 and the encoded drivers,twin_state,ehr_context,twin_overlay list', async () => {
    const request = new NextRequest(`http://localhost/api/patients/${subjectId}/stream`);
    const response = await GET(request, { params: Promise.resolve({ id: subjectId }) });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith(
      `http://127.0.0.1:8001/v1/subjects/${subjectId}/stream?speed=60&include=drivers%2Ctwin_state%2Cehr_context%2Ctwin_overlay`,
      expect.objectContaining({ signal: request.signal }),
    );
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('');
  });

  it('preserves encoded as_of together with the default include list', async () => {
    const request = new NextRequest(
      `http://localhost/api/patients/${subjectId}/stream?as_of=2026-10-04T17%3A30%3A00%2B05%3A30`,
    );
    const response = await GET(request, { params: Promise.resolve({ id: subjectId }) });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith(
      `http://127.0.0.1:8001/v1/subjects/${subjectId}/stream?speed=60&include=drivers%2Ctwin_state%2Cehr_context%2Ctwin_overlay&as_of=2026-10-04T17%3A30%3A00%2B05%3A30`,
      expect.objectContaining({ signal: request.signal }),
    );
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('');
  });

  it('forwards custom speed and encoded custom include together', async () => {
    const request = new NextRequest(
      `http://localhost/api/patients/${subjectId}/stream?speed=300&include=ehr_context%2Ctwin_overlay`,
    );
    const response = await GET(request, { params: Promise.resolve({ id: subjectId }) });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith(
      `http://127.0.0.1:8001/v1/subjects/${subjectId}/stream?speed=300&include=ehr_context%2Ctwin_overlay`,
      expect.objectContaining({ signal: request.signal }),
    );
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('');
  });

  it('forwards the configured service token as Bearer authorization', async () => {
    process.env.PR_TFT_SERVICE_TOKEN = 'test-service-token';
    const request = new NextRequest(`http://localhost/api/patients/${subjectId}/stream`);
    const response = await GET(request, { params: Promise.resolve({ id: subjectId }) });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith(
      `http://127.0.0.1:8001/v1/subjects/${subjectId}/stream?speed=60&include=drivers%2Ctwin_state%2Cehr_context%2Ctwin_overlay`,
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: 'text/event-stream',
          Authorization: 'Bearer test-service-token',
        }),
        signal: request.signal,
      }),
    );
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('');
  });

  it('propagates invalid-include status 422 with the proxy generic error body', async () => {
    jest.mocked(global.fetch).mockResolvedValueOnce(new Response(
      JSON.stringify({ detail: 'Invalid include: unsupported_field' }),
      { status: 422, headers: { 'Content-Type': 'application/json' } },
    ));
    const request = new NextRequest(
      `http://localhost/api/patients/${subjectId}/stream?include=unsupported_field`,
    );
    const response = await GET(request, { params: Promise.resolve({ id: subjectId }) });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith(
      `http://127.0.0.1:8001/v1/subjects/${subjectId}/stream?speed=60&include=unsupported_field`,
      expect.objectContaining({ signal: request.signal }),
    );
    expect(response.status).toBe(422);
    await expect(response.text()).resolves.toBe('Backend error or no body');
  });

  it.each([
    ['ehr_context', 'ehr_context'],
    ['ehr_context,twin_overlay', 'ehr_context%2Ctwin_overlay'],
    ['drivers%2Ctwin_state', 'drivers%2Ctwin_state'],
  ] as const)('forwards explicit include=%s without appending defaults or double encoding', async (query, encoded) => {
    const request = new NextRequest(
      `http://localhost/api/patients/${subjectId}/stream?include=${query}`,
    );
    const response = await GET(request, { params: Promise.resolve({ id: subjectId }) });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith(
      `http://127.0.0.1:8001/v1/subjects/${subjectId}/stream?speed=60&include=${encoded}`,
      expect.objectContaining({ signal: request.signal }),
    );
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('');
  });
});

describe('ForecastResponseSchema EHR context', () => {
  it('accepts and preserves valid EHR fields', () => {
    const payload = forecastWithEhr();
    expect(ForecastResponseSchema.parse(payload).ehr_context).toEqual(payload.ehr_context);
  });

  it('accepts explicitly unknown eGFR and an empty medication list', () => {
    const payload = forecastWithEhr();
    const ehr = { ...payload.ehr_context, egfr: null, med_classes: [] };
    expect(ForecastResponseSchema.parse({ ...payload, ehr_context: ehr }).ehr_context).toEqual(ehr);
  });

  it.each([
    ['missing required age', { age_years: undefined }],
    ['noninteger age', { age_years: 58.5 }],
    ['age below minimum', { age_years: 17 }],
    ['invalid sex', { sex: 'invalid' }],
    ['BMI above maximum', { bmi: 81 }],
    ['HbA1c below minimum', { hba1c_pct: 3.9 }],
    ['nonstring HbA1c date', { hba1c_date: 20260928 }],
    ['negative diabetes duration', { t2d_duration_years: -1 }],
    ['negative eGFR', { egfr: -1 }],
    ['string eGFR', { egfr: '90' }],
    ['unknown medication class', { med_classes: ['unsupported_medication'] }],
    ['unexpected EHR key', { unexpected_field: true }],
  ] as const)('rejects %s within ehr_context', (_label, invalidFields) => {
    const payload = forecastWithEhr();
    const result = ForecastResponseSchema.safeParse({
      ...payload, ehr_context: { ...payload.ehr_context, ...invalidFields },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.length).toBeGreaterThan(0);
      expect(result.error.issues.every(issue => issue.path[0] === 'ehr_context')).toBe(true);
    }
  });
});

describe('SSE parser EHR preservation', () => {
  it('preserves the complete valid forecast.updated event across chunk boundaries', async () => {
    const payload = forecastWithEhr();
    const event = {
      event: 'forecast.updated', event_id: '000001-forecast', subject_id: subjectId,
      emitted_at: timestamp, payload,
    };
    // Establish validity explicitly: the parser also forwards some invalid envelopes unchanged.
    expect(StreamEventSchema.safeParse(event).success).toBe(true);
    expect(ForecastResponseSchema.safeParse(payload).success).toBe(true);

    const wire = `id: ${event.event_id}\nevent: forecast.updated\ndata: ${JSON.stringify(event)}\n\n`;
    const split = wire.indexOf('ehr_context') + 5;
    const encoder = new TextEncoder();
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(wire.slice(0, split)));
        controller.enqueue(encoder.encode(wire.slice(split)));
        controller.close();
      },
    });
    const output = await new Response(source.pipeThrough(createSafeSSETransformStream())).text();

    const blocks = output.split(/\r?\n\r?\n/).filter(block => block.trim());
    expect(blocks).toHaveLength(1);
    const lines = blocks[0].split(/\r?\n/);
    expect(lines.filter(line => line.startsWith('event:')).map(line => line.slice(6).trim()))
      .toEqual(['forecast.updated']);
    expect(lines.filter(line => line.startsWith('id:')).map(line => line.slice(3).trim()))
      .toEqual([event.event_id]);
    const data = lines.filter(line => line.startsWith('data:'))
      .map(line => line.replace(/^data: ?/, '')).join('\n');
    const preserved = StreamEventSchema.parse(JSON.parse(data));
    expect(preserved).toEqual(event);
    expect(preserved.subject_id).toBe(subjectId);
    const preservedPayload = ForecastResponseSchema.parse(preserved.payload);
    expect(preservedPayload.subject).toEqual(payload.subject);
    expect(preservedPayload.forecast).toEqual(payload.forecast);
    expect(preservedPayload.ehr_context).toEqual(payload.ehr_context);
  });
});
