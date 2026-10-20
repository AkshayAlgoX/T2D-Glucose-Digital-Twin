import React from 'react';
import Link from 'next/link';
import { ArrowRight, BookOpenCheck, Users } from 'lucide-react';
import { NavigationRail } from '@/components/digital-twin/NavigationRail';
import { DEMO_SUBJECT_ID, readLandingEvidence } from '@/lib/landing';
import { readHeroForecast } from '@/lib/hero';
import { HeroForecast } from '@/components/landing/HeroForecast';

export const dynamic = 'force-dynamic';

function PipelineSchematic() {
  const box = (x: number, y: number, w: number, h: number, title: string, lines: string[], tone: 'in' | 'twin' | 'net' | 'out') => {
    const stroke = { in: '#8f9ca8', twin: '#56a64b', net: '#6f82f0', out: '#e9eef2' }[tone];
    return (
      <g>
        <rect x={x} y={y} width={w} height={h} rx={10} fill="#161e26" stroke={stroke} strokeOpacity={tone === 'in' ? 0.6 : 0.9} />
        <text x={x + 14} y={y + 24} fill="#e9eef2" fontSize={13.5} fontWeight={600}>{title}</text>
        {lines.map((l, i) => <text key={l} x={x + 14} y={y + 44 + i * 17} fill="#b5c0ca" fontSize={12}>{l}</text>)}
      </g>
    );
  };
  const arrow = (x1: number, y1: number, x2: number, y2: number) => (
    <g stroke="#8f9ca8" strokeWidth={1.5} fill="none"><path d={`M${x1} ${y1} L${x2 - 6} ${y2}`} /><path d={`M${x2 - 8} ${y2 - 4} L${x2} ${y2} L${x2 - 8} ${y2 + 4}`} /></g>
  );
  return (
    <svg viewBox="0 0 620 300" role="img" aria-labelledby="pipeline-title pipeline-desc">
      <title id="pipeline-title">How the twin turns a patient record and wearable streams into a forecast</title>
      <desc id="pipeline-desc">EHR record and wearable streams feed a physiology twin; a learned model adjusts the twin; the result is a two-hour glucose forecast with uncertainty, a spike risk and a what-if.</desc>
      {box(10, 20, 170, 100, 'EHR record', ['Age · BMI · HbA1c', 'eGFR · diagnosis', 'Medication classes'], 'in')}
      {box(10, 150, 170, 130, 'Wearable streams', ['CGM every 5 min', 'Heart rate · HRV', 'Steps · Sleep', 'Meal log'], 'in')}
      {box(225, 20, 170, 120, '① Physiology twin', ['Glucose–insulin equations', 'tuned to this patient', '(Bergman model + UKF)'], 'twin')}
      {box(225, 160, 170, 120, '② Learned adjustment', ['A neural network adds', 'what the equations', 'miss (PR-TFT)'], 'net')}
      {box(440, 70, 170, 160, '③ 2-hour forecast', ['Median + P10–P90', 'and P05–P95 bands', 'Calibrated spike risk', 'Backend what-if', 'for meals & activity'], 'out')}
      {arrow(180, 70, 225, 80)}
      {arrow(180, 215, 225, 220)}
      {arrow(180, 90, 225, 210)}
      {arrow(310, 140, 310, 160)}
      {arrow(395, 80, 440, 130)}
      {arrow(395, 220, 440, 175)}
    </svg>
  );
}

export default async function Home() {
  const [evidence, hero] = await Promise.all([readLandingEvidence(), readHeroForecast()]);
  return (
    <div className="app-shell">
      <NavigationRail />
      <main id="main-content" className="landing">
        <section className="landing-hero" aria-labelledby="landing-title">
          <div>
            <span className="eyebrow">Digital twin · Type 2 diabetes · research prototype</span>
            <h1 id="landing-title">See a patient&apos;s next two hours of glucose before they happen, and test a change to the plan.</h1>
            <p className="landing-audience">For a care team asking two questions after a meal: will this patient&apos;s glucose go above 180 mg/dL in the next two hours, and which change to the plan could matter?</p>
            <p className="landing-lead">
              Glucose Twin combines a synthetic patient&apos;s EHR record with continuous glucose and wearable streams.
              A physiology model sets the shape of the forecast, and a neural network learns what the physiology misses.
            </p>
            <div className="landing-actions">
              <Link href={`/patients/${DEMO_SUBJECT_ID}`} className="landing-cta">Open the demo twin · P0017 <ArrowRight size={16} aria-hidden="true" /></Link>
              <Link href="/cohort" className="landing-link"><Users size={16} aria-hidden="true" /> Browse the cohort</Link>
              <Link href="/evidence" className="landing-link"><BookOpenCheck size={16} aria-hidden="true" /> Read the evidence</Link>
            </div>
            <p className="landing-boundary">
              Synthetic data only, and not a medical device. Results are development-validation diagnostics, not clinical validation. The realism gate failed, and we publish that result.
            </p>
          </div>
          {hero ? <HeroForecast data={hero} /> : (
            <figure className="landing-diagram panel stage" data-testid="hero-unavailable">
              <PipelineSchematic />
              <figcaption>The live forecast could not be read from the backend, so none is shown. This is a schematic of the pipeline, not data.</figcaption>
            </figure>
          )}
        </section>

        <section className="landing-how" aria-labelledby="how-heading">
          <div className="landing-how-copy">
            <h2 id="how-heading" className="landing-section-title">How the twin works · what you can do in five minutes</h2>
            <ol className="landing-steps">
              <li><span className="step-num">01</span><div><h3>Read the record and the streams</h3><p>P0017&apos;s EHR summary and the night and morning before 08:00: CGM and the heart rate, HRV, steps, sleep and meal log the model actually read, on one time axis.</p></div></li>
              <li><span className="step-num">02</span><div><h3>See how the forecast is built</h3><p>The physiology twin&apos;s estimate, plus the learned adjustment, equals the final forecast with its uncertainty bands, at any horizon up to two hours.</p></div></li>
              <li><span className="step-num">03</span><div><h3>Ask &ldquo;what if?&rdquo;</h3><p>Add a meal or some activity and the backend re-forecasts from the same moment, beside the physiology twin&apos;s own response. Medication changes are refused rather than guessed.</p></div></li>
            </ol>
          </div>
          <ol className="pipeline-mobile stage" aria-label="How the forecast is built">
            <li><span>Inputs</span>EHR record, CGM every 5 min, heart rate, HRV, steps, sleep, meal log</li>
            <li className="twin"><span>① Physiology twin</span>Glucose–insulin equations tuned to this patient</li>
            <li className="net"><span>② Learned adjustment</span>A neural network adds what the equations miss</li>
            <li className="out"><span>③ 2-hour forecast</span>Median with uncertainty bands, onset risk and a backend what-if</li>
          </ol>
          {hero && <figure className="landing-diagram panel stage">
            <PipelineSchematic />
            <figcaption>A schematic of the pipeline, not data.</figcaption>
          </figure>}
        </section>

        <h2 className="landing-section-title">Evidence at a glance</h2>
        {evidence ? (
          <dl className="landing-evidence panel" data-testid="landing-evidence">
            <div><dt>60-min forecast error (RMSE)</dt><dd>{evidence.rmse60.hybrid.toFixed(2)} mg/dL<small>vs {evidence.rmse60.twin.toFixed(2)} physiology twin alone · {evidence.rmse60.persistence.toFixed(2)} persistence</small></dd></div>
            <div><dt>Evaluated on</dt><dd>{evidence.patients} synthetic patients<small>Development-validation split; also used for calibration</small></dd></div>
            <div className="failed"><dt>Realism gate (Gate 3)</dt><dd>{evidence.gate3.status}<small>Discriminator AUROC {evidence.gate3.auroc.toFixed(3)}; target {evidence.gate3.threshold.replace('<=', '≤')}. A classifier can still tell our synthetic data from an independent mock-real generator&apos;s, itself synthetic, so realism is not established.</small></dd></div>
          </dl>
        ) : (
          <p className="landing-boundary" data-testid="landing-evidence-missing">The evaluation artifact could not be read, so no metrics are shown. See the Evidence page.</p>
        )}
        <footer className="research-footer"><span>Research Only (Not for clinical decisions)</span><span>Synthetic data · no clinical validation claimed</span></footer>
      </main>
    </div>
  );
}
