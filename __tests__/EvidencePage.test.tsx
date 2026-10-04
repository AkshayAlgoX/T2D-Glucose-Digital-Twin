import React from 'react';
import { render, screen } from '@testing-library/react';
import EvidencePage from '../src/app/evidence/page';
import fs from 'fs/promises';

jest.mock('fs/promises', () => ({
  readFile: jest.fn()
}));

jest.mock('next/navigation', () => ({
  usePathname: () => '/evidence'
}));

const VALID_MANIFEST = {
  run_id: 'test-run-123',
  checkpoint: { name: 'epoch=10.ckpt' }
};

const VALID_REPORT = {
  provenance: {
    run_manifest_sha256: 'abc123hash',
    checkpoint_sha256: 'def456hash',
    data_sha256: 'ghi789hash'
  },
  populations: {
    primary: {
      models: {
        pr_tft: {
          rmse_60: { estimate: 12.345 },
          rmse_120: { estimate: 18.765 },
          coverage_80_conformal: { estimate: 0.823 }
        }
      }
    }
  }
};

describe('EvidencePage', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    process.env.ARTIFACTS_DIR = '/mock/artifacts';
  });

  it('renders "Not yet evaluated" when artifacts are absent (ENOENT)', async () => {
    const error: any = new Error('ENOENT: no such file');
    error.code = 'ENOENT';
    (fs.readFile as jest.Mock).mockRejectedValue(error);
    
    const Component = await EvidencePage();
    render(Component);
    
    expect(screen.getByText('Not yet evaluated')).toBeInTheDocument();
  });

  it('renders "Invalid or incomplete evaluation artifacts" when JSON is malformed', async () => {
    (fs.readFile as jest.Mock).mockResolvedValue('{ "invalid": json');
    
    const Component = await EvidencePage();
    render(Component);
    
    expect(screen.getByText('Invalid or incomplete evaluation artifacts')).toBeInTheDocument();
  });

  it('renders "Invalid or incomplete evaluation artifacts" when required fields are missing', async () => {
    (fs.readFile as jest.Mock).mockImplementation(async (filePath) => {
      if (filePath.endsWith('run_manifest.json')) return JSON.stringify(VALID_MANIFEST);
      if (filePath.endsWith('evaluation_report.json')) return JSON.stringify({ provenance: {} }); // Missing populations
      throw new Error('Not found');
    });
    
    const Component = await EvidencePage();
    render(Component);
    
    expect(screen.getByText('Invalid or incomplete evaluation artifacts')).toBeInTheDocument();
  });

  it('renders "Invalid or incomplete evaluation artifacts" when metric is NaN or Infinity', async () => {
    const invalidReport = JSON.parse(JSON.stringify(VALID_REPORT));
    invalidReport.populations.primary.models.pr_tft.rmse_60.estimate = NaN; // Zod should catch this

    (fs.readFile as jest.Mock).mockImplementation(async (filePath) => {
      if (filePath.endsWith('run_manifest.json')) return JSON.stringify(VALID_MANIFEST);
      if (filePath.endsWith('evaluation_report.json')) {
         // JSON.stringify turns NaN into null. Let's return a string with null
         return JSON.stringify(invalidReport);
      }
      throw new Error('Not found');
    });
    
    const Component = await EvidencePage();
    render(Component);
    
    expect(screen.getByText('Invalid or incomplete evaluation artifacts')).toBeInTheDocument();
  });

  it('renders provenance hashes and metrics when artifacts are perfectly valid', async () => {
    (fs.readFile as jest.Mock).mockImplementation(async (filePath) => {
      if (filePath.endsWith('run_manifest.json')) return JSON.stringify(VALID_MANIFEST);
      if (filePath.endsWith('evaluation_report.json')) return JSON.stringify(VALID_REPORT);
      throw new Error('Not found');
    });

    const Component = await EvidencePage();
    render(Component);

    expect(screen.queryByText('Not yet evaluated')).not.toBeInTheDocument();
    expect(screen.queryByText('Invalid or incomplete evaluation artifacts')).not.toBeInTheDocument();
    
    expect(screen.getByText('test-run-123')).toBeInTheDocument();
    expect(screen.getByText('abc123hash')).toBeInTheDocument();
    expect(screen.getByText('def456hash')).toBeInTheDocument();
    expect(screen.getByText('ghi789hash')).toBeInTheDocument();
    expect(screen.getByText('12.345')).toBeInTheDocument();
    expect(screen.getByText('18.765')).toBeInTheDocument();
    expect(screen.getByText('0.823')).toBeInTheDocument();
  });
});
