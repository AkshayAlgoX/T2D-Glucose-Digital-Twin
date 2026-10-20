import React from 'react';
import { act, renderHook, waitFor, render, screen, within } from '@testing-library/react';
import { TextDecoder } from 'node:util';
import source from './fixtures/risk-audit-forecast.json';
import { useRealtimeTelemetry } from '../src/hooks/useRealtimeTelemetry';
import { checkInvariants } from '../src/lib/invariants';
import { RiskPanel } from '../src/components/digital-twin/RiskPanel';
import { RiskStrip } from '../src/components/digital-twin/RiskStrip';
import type { ForecastResponse } from '../src/types/forecast-response';

// Captured synthetic service response. Variants below are test-only transport cases.
const fixture = () => JSON.parse(JSON.stringify(source)) as ForecastResponse;
const id = source.subject.subject_id;
const otherId = '123e4567-e89b-12d3-a456-426614174000';

describe('Risk source fidelity', () => {
  it('does not rewrite a contract-valid uncalibrated zero', () => {
    const p = fixture();
    p.spike_risk!.calibrated = false;
    p.spike_risk!.probability_120m = 0;
    p.spike_risk!.cumulative.forEach(point => { point.p = 0; });
    const before = JSON.stringify(p);
    checkInvariants(p);
    expect(JSON.stringify(p)).toBe(before);
  });
});

describe('Forecast stream consistency', () => {
  const originalFetch = global.fetch;
  const originalDecoder = global.TextDecoder;
  let deliver: (result: {done: boolean; value?: Uint8Array}) => void;
  let reader: {read: jest.Mock; cancel: jest.Mock};
  beforeEach(() => {
    global.TextDecoder = TextDecoder as typeof global.TextDecoder;
    reader = {read: jest.fn(() => new Promise(resolve => {deliver = resolve;})), cancel: jest.fn()};
    global.fetch = jest.fn().mockResolvedValue({ok: true, body: {getReader: () => reader}});
  });
  afterEach(() => { global.fetch = originalFetch; global.TextDecoder = originalDecoder; });
  async function send(p: ForecastResponse) {
    const event = {event: 'forecast.updated', event_id: p.as_of, subject_id: p.subject.subject_id, emitted_at: p.generated_at, payload: p};
    await act(async () => { deliver({done: false, value: new Uint8Array(Buffer.from('data: '+JSON.stringify(event)+'\n\n'))}); });
  }

  it('updates headline source, cumulative source and history coherently on every committed render', async () => {
    const states: ReturnType<typeof useRealtimeTelemetry>[] = [];
    const {result} = renderHook(() => { const state=useRealtimeTelemetry(id); states.push(state); return state; });
    await waitFor(() => expect(reader.read).toHaveBeenCalled());
    const first=fixture();
    await send(first);
    const next=fixture(); next.as_of='2026-09-28T12:15:00Z'; next.current.measured_at=next.as_of;
    next.spike_risk!.probability_120m=.746; next.spike_risk!.cumulative[23].p=.746;
    await send(next);
    expect(result.current.cache.risk).toEqual([{t:first.as_of,p:.598},{t:next.as_of,p:.746}]);
    for(const state of states.filter(s=>s.forecast)) {
      const p=state.forecast!;
      expect(state.cache.risk.at(-1)).toEqual({t:p.as_of,p:p.spike_risk!.probability_120m});
      expect(p.spike_risk!.cumulative[23].p).toBe(p.spike_risk!.probability_120m);
    }
    await act(async()=>{deliver({done:true});});
    expect(result.current.forecast?.as_of).toBe(next.as_of);
    expect(result.current.isConnected).toBe(false);
  });

  it('never exposes the previous subject forecast under a newly selected subject', async () => {
    const states: {id:string; state:ReturnType<typeof useRealtimeTelemetry>}[]=[];
    const {rerender}=renderHook(({subjectId})=>{const state=useRealtimeTelemetry(subjectId);states.push({id:subjectId,state});return state;},{initialProps:{subjectId:id}});
    await waitFor(()=>expect(reader.read).toHaveBeenCalled());
    await send(fixture());
    await act(async()=>{rerender({subjectId:otherId});});
    for(const {id:requested,state} of states.filter(s=>s.id===otherId)) {
      expect(state.forecast).toBeNull();
      expect(state.cache.patientId).toBe(requested);
      expect(state.cache.risk).toEqual([]);
    }
  });

  it('keeps received history historical when the newest forecast has no risk', async () => {
    const {result}=renderHook(()=>useRealtimeTelemetry(id));
    await waitFor(()=>expect(reader.read).toHaveBeenCalled());
    await send(fixture());
    const next=fixture();next.as_of='2026-09-28T12:15:00Z';next.current.measured_at=next.as_of;
    next.spike_risk=null;next.forecast=null;next.data_quality.status='insufficient';
    await send(next);
    expect(result.current.forecast?.spike_risk).toBeNull();
    expect(result.current.forecast?.as_of).toBe(next.as_of);
    expect(result.current.cache.risk).toEqual([{t:source.as_of,p:.598}]);
  });
});

describe('Risk labels and independently served values',()=>{
  it('uses one decimal consistently, preserves history rows and labels different anchors',()=>{
    const p=fixture();p.as_of='2026-09-28T12:15:00Z';
    p.spike_risk!.probability_120m=.746;p.spike_risk!.cumulative[23].p=.746;
    const cache={patientId:id,cgm:[],alerts:[],dataQuality:[],risk:[{t:source.as_of,p:.598},{t:'2026-09-28T12:05:00Z',p:.609}]};
    const {container}=render(<><RiskPanel forecast={p}/><RiskStrip forecast={p} cache={cache}/></>);
    expect(container.querySelector('.risk-estimate')).toHaveTextContent('74.6%');
    expect(container.querySelector('.cumulative-summary')).toHaveTextContent('By 120 min74.6%');
    expect(container.querySelector('.risk-as-of time')).toHaveAttribute('dateTime',p.as_of);
    expect(container.querySelector('.cumulative-as-of time')).toHaveAttribute('dateTime',p.as_of);
    const rows=within(screen.getByRole('table',{name:/Received observations/})).getAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(rows[1]).toHaveTextContent('59.8%');expect(rows[1].querySelector('time')).toHaveAttribute('dateTime',source.as_of);
    expect(rows[2]).toHaveTextContent('60.9%');expect(rows[2].querySelector('time')).toHaveAttribute('dateTime',cache.risk[1].t);
    expect(container.querySelector('.history-time-labels')).toHaveTextContent('Latest recorded 12:05 UTC');
  });

  it('does not force equality between independently supplied contract fields',()=>{
    const p=fixture();p.spike_risk!.probability_120m=.6;p.spike_risk!.cumulative[23].p=.746;
    const {container}=render(<><RiskPanel forecast={p}/><RiskStrip forecast={p}/></>);
    expect(container.querySelector('.risk-estimate')).toHaveTextContent('60.0%');
    expect(container.querySelector('.cumulative-summary')).toHaveTextContent('By 120 min74.6%');
  });

  it('renders operational spike definition disclosure', () => {
    const p = fixture();
    const { container } = render(<RiskPanel forecast={p} />);
    const disclosure = container.querySelector('.spike-definition');
    expect(disclosure).toBeInTheDocument();
    expect(disclosure?.textContent).toContain('How is a spike defined?');
    expect(disclosure?.textContent).toContain('50 mg/dL');
    expect(disclosure?.textContent).toContain('180 mg/dL');
    expect(disclosure?.textContent).toContain('15 minutes');
  });

  it('falls back to peak trajectory value when spike_risk.peak_mg_dl is null (low risk state)', () => {
    const p = fixture();
    p.spike_risk!.peak_mg_dl = null as any;
    p.forecast = {
      horizon_min: 120,
      points: [
        { offset_min: 15, p50: 120 },
        { offset_min: 30, p50: 135 },
        { offset_min: 45, p50: 125 },
      ] as any,
    };
    render(<RiskPanel forecast={p} />);
    const peakRow = screen.getByText('Median at peak').closest('tr');
    expect(within(peakRow!).getByText('135')).toBeInTheDocument();
  });
});
