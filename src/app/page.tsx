import React from 'react';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { NavigationRail } from '@/components/digital-twin/NavigationRail';
import { DEMO_SUBJECT_ID, readLandingEvidence } from '@/lib/landing';
import { readHeroForecast } from '@/lib/hero';
import { HeroForecast } from '@/components/landing/HeroForecast';
import { ErrorCurve } from '@/components/figure/ErrorCurve';

export const dynamic = 'force-dynamic';

/** Figure 2: the pipeline, drawn in the same colours as the figure grammar. A schematic, not data. */
function PipelineSchematic() {
  const box = (x: number, y: number, w: number, h: number, title: string, lines: string[], tone: 'in' | 'twin' | 'net' | 'out', n?: string) => {
    const stroke = { in: '#7b838c', twin: '#b9461a', net: '#00766a', out: '#2443c4' }[tone];
    return (
      <g>
        <rect x={x} y={y} width={w} height={h} rx={2} fill="#ffffff" stroke={stroke} strokeWidth={tone === 'in' ? 1 : 1.5} />
        <rect x={x} y={y} width={w} height={3} fill={stroke} />
        {n && <><circle cx={x + 22} cy={y + 26} r={9} fill={stroke} /><text x={x + 22} y={y + 30} textAnchor="middle" fill="#fff" fontSize={12.5} fontWeight={600}>{n}</text></>}
        <text x={x + (n ? 38 : 14)} y={y + 30} fill="#111418" fontSize={14} fontWeight={600}>{title}</text>
        {lines.map((l, i) => <text key={l} x={x + 14} y={y + 54 + i * 18} fill="#3a4048" fontSize={13}>{l}</text>)}
      </g>
    );
  };
  const arrow = (x1: number, y1: number, x2: number, y2: number) => (
    <g stroke="#565d66" strokeWidth={1.25} fill="none"><path d={`M${x1} ${y1} L${x2 - 6} ${y2}`} /><path d={`M${x2 - 8} ${y2 - 4} L${x2} ${y2} L${x2 - 8} ${y2 + 4}`} /></g>
  );
  return (
    <svg viewBox="0 0 640 300" role="img" aria-labelledby="pipeline-title pipeline-desc">
      <title id="pipeline-title">How the twin turns a patient record and wearable streams into a forecast</title>
      <desc id="pipeline-desc">EHR record and wearable streams feed a physiology twin; a learned model adjusts the twin; the result is a two-hour glucose forecast with uncertainty, a spike risk and a what-if.</desc>
      {box(4, 20, 172, 104, 'EHR record', ['Age · BMI · HbA1c', 'eGFR · diagnosis', 'Medication classes'], 'in')}
      {box(4, 150, 172, 132, 'Wearable streams', ['CGM every 5 min', 'Heart rate · HRV', 'Steps · sleep', 'Meal log'], 'in')}
      {box(226, 20, 182, 122, 'Physiology twin', ['Glucose–insulin equations', 'fitted to this patient', '(Bergman model + UKF)'], 'twin', '1')}
      {box(226, 160, 182, 122, 'Learned adjustment', ['A neural network adds', 'what the equations', 'miss (PR-TFT)'], 'net', '2')}
      {box(458, 70, 178, 160, '2-hour forecast', ['Median with 50, 80 and', '90% bands', 'Calibrated onset risk', 'Backend what-if for', 'meals and activity'], 'out', '3')}
      {arrow(176, 72, 226, 80)}
      {arrow(176, 216, 226, 222)}
      {arrow(176, 92, 226, 206)}
      {arrow(317, 142, 317, 160)}
      {arrow(408, 80, 458, 130)}
      {arrow(408, 222, 458, 176)}
    </svg>
  );
}

export default async function Home() {
  const [evidence, hero] = await Promise.all([readLandingEvidence(), readHeroForecast()]);
  return (
    <div className="app-shell">
      <NavigationRail />
      <main id="main-content" className="landing fig-home">
        <section className="home-hero" aria-labelledby="landing-title">
          <div className="home-copy">
            <p className="fig-section-label">Digital twin · type 2 diabetes</p>
            <h1 id="landing-title">A glucose forecast you can take apart.</h1>
            <p className="home-why">Physiology equations set the shape. A neural network corrects what they miss. The bands show how sure it is.</p>
            <p className="home-dek home-dek-short">Glucose Twin forecasts a synthetic patient&apos;s next two hours of glucose and shows what each forecast is made of: physiology, a learned correction, and uncertainty.</p>
            <p className="home-dek home-dek-long">Glucose Twin forecasts a synthetic patient&apos;s next two hours of glucose from their EHR record and wearable streams. It shows how much of each forecast comes from a physiology model fitted to the patient, how much from a learned correction, how uncertain it is, and how a meal or some activity would change it.</p>
            <div className="landing-actions">
              <Link href={`/patients/${DEMO_SUBJECT_ID}`} className="landing-cta">Open the demo twin · P0017 <ArrowRight size={16} aria-hidden="true" /></Link>
              <span className="landing-secondary">
                <Link href="/cohort" className="landing-link">Browse the cohort</Link>
                <Link href="/evidence" className="landing-link">Read the evidence</Link>
              </span>
            </div>
            <p className="landing-boundary">Synthetic data only, and not a medical device. Results are development-validation diagnostics, not clinical validation. The realism gate failed, and we publish that result.</p>
          </div>
          {hero ? <HeroForecast data={hero} /> : (
            <figure className="landing-diagram" data-testid="hero-unavailable">
              <PipelineSchematic />
              <figcaption>The live forecast could not be read from the backend, so none is shown. This is a schematic of the pipeline, not data.</figcaption>
            </figure>
          )}
        </section>

        <section className="home-how" aria-labelledby="how-heading">
          <div className="home-section-head">
            <h2 id="how-heading">How the forecast is built</h2>
            <p>Three parts, numbered the same way on every chart in the product.</p>
          </div>
          <ol className="home-steps">
            <li className="n-twin"><b className="n">1</b><div><h3>A physiology twin</h3><p>Glucose–insulin equations, fitted to the patient&apos;s EHR record and kept in step with each CGM reading by a Kalman filter, set the shape of the forecast.</p></div></li>
            <li className="n-adj"><b className="n">2</b><div><h3>A learned adjustment</h3><p>A neural network, trained on synthetic patients, adds what the equations miss. On the charts it is the hatched wedge between the twin and the forecast.</p></div></li>
            <li className="n-final"><b className="n">3</b><div><h3>A forecast with its uncertainty</h3><p>The median with 50, 80 and 90% bands, a separate calibrated onset risk, and a what-if that re-runs the backend for a meal or some activity.</p></div></li>
          </ol>
          {hero && <figure className="landing-diagram">
            <PipelineSchematic />
            <figcaption><b>Figure 2.</b> The pipeline. A schematic, not data.</figcaption>
          </figure>}
        </section>

        <section className="home-evidence-section" aria-labelledby="evidence-heading">
          <div className="home-section-head">
            <h2 id="evidence-heading">Evidence at a glance</h2>
            <p>From the committed evaluation artifact. <Link href="/evidence">Full evidence and limitations</Link></p>
          </div>
          {evidence ? (<div className="home-evidence-grid">
            {evidence.progression && <div className="home-error-figure">
              <p className="fig-caption"><b>Figure 3.</b> Forecast error at every horizon on the 44-patient synthetic validation split. The hatched wedge is the error the learned adjustment removes from the physiology twin.</p>
              <div className="ec-wide"><ErrorCurve data={evidence.progression} id="home-ec" /></div>
              <div className="ec-narrow"><ErrorCurve data={evidence.progression} id="home-ec-n" compact /></div>
            </div>}
            <dl className="landing-evidence" data-testid="landing-evidence">
              <div><dt>60-min forecast error (RMSE)</dt><dd><span className="num">{evidence.rmse60.hybrid.toFixed(2)}</span> mg/dL<small>vs {evidence.rmse60.twin.toFixed(2)} physiology twin alone · {evidence.rmse60.persistence.toFixed(2)} persistence</small></dd></div>
              <div><dt>Evaluated on</dt><dd><span className="num">{evidence.patients}</span> synthetic patients<small>Development-validation split; also used for calibration</small></dd></div>
              <div className="failed"><dt>Realism gate (Gate 3)</dt><dd>{evidence.gate3.status}<small>Discriminator AUROC {evidence.gate3.auroc.toFixed(3)}; target {evidence.gate3.threshold.replace('<=', '≤')}. A classifier can still tell our synthetic data from an independent mock-real generator&apos;s, itself synthetic, so realism is not established.</small></dd></div>
            </dl>
          </div>) : (
            <p className="landing-boundary" data-testid="landing-evidence-missing">The evaluation artifact could not be read, so no metrics are shown. See the Evidence page.</p>
          )}
        </section>
        <footer className="research-footer"><span>Research Only (Not for clinical decisions)</span><span>Synthetic data · no clinical validation claimed</span></footer>
      </main>
    </div>
  );
}
