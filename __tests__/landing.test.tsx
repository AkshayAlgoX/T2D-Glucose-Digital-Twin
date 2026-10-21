import React from 'react';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { render, screen } from '@testing-library/react';
import Home from '../src/app/page';
import { DEMO_SUBJECT_ID, readLandingEvidence } from '../src/lib/landing';

jest.mock('next/navigation', () => ({ usePathname: () => '/' }));

const artifact = path.join(__dirname, '..', 'docs', 'evidence', 'validation_ceiling_results.json');

describe('landing evidence', () => {
  it('reads the headline numbers from the committed evidence artifact', async () => {
    const raw = JSON.parse(fs.readFileSync(artifact, 'utf8'));
    const e = await readLandingEvidence(artifact);
    expect(e).not.toBeNull();
    expect(e!.rmse60.hybrid).toBe(raw.matched_baselines_and_uncertainty['60min'].pr_tft.rmse);
    expect(e!.rmse60.twin).toBe(raw.matched_baselines_and_uncertainty['60min'].twin_only.rmse);
    expect(e!.rmse60.persistence).toBe(raw.matched_baselines_and_uncertainty['60min'].persistence.rmse);
    expect(e!.patients).toBe(raw.cohort_scope.n_patients);
    expect(e!.gate3.status).toBe('FAILED');
  });

  it('returns null rather than inventing numbers when the artifact is missing or malformed', async () => {
    expect(await readLandingEvidence(path.join(os.tmpdir(), 'does-not-exist.json'))).toBeNull();
    const bad = path.join(os.tmpdir(), `landing-bad-${process.pid}.json`);
    fs.writeFileSync(bad, JSON.stringify({ matched_baselines_and_uncertainty: { '60min': { pr_tft: { rmse: 'x' } } } }));
    expect(await readLandingEvidence(bad)).toBeNull();
    fs.unlinkSync(bad);
  });
});

describe('landing page', () => {
  it('routes straight to the validation demonstration subject and shows the failed realism gate', async () => {
    render(await Home());
    expect(screen.getByRole('link', { name: /Open the demo twin · P0017/ })).toHaveAttribute('href', `/patients/${DEMO_SUBJECT_ID}`);
    expect(screen.getByTestId('landing-evidence')).toHaveTextContent('FAILED');
    expect(screen.getByText(/Synthetic patients only/)).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /How the twin turns a patient record/ })).toBeInTheDocument();
  });
});
