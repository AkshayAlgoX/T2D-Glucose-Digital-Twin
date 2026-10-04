import React from 'react';
import { render, screen } from '@testing-library/react';
import EvidencePage from '../src/app/evidence/page';
import fs from 'fs/promises';
import path from 'path';

// Mock fs to control artifact presence
jest.mock('fs/promises', () => ({
  readFile: jest.fn()
}));

jest.mock('next/navigation', () => ({
  usePathname: () => '/evidence'
}));

describe('EvidencePage', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    process.env.ARTIFACTS_DIR = '/mock/artifacts';
  });

  it('renders "Not yet evaluated" when artifacts are absent', async () => {
    (fs.readFile as jest.Mock).mockRejectedValue(new Error('ENOENT: no such file'));
    
    const Component = await EvidencePage();
    render(Component);
    
    expect(screen.getByText('Not yet evaluated')).toBeInTheDocument();
    expect(screen.queryByText('Provenance')).not.toBeInTheDocument();
  });

  it('renders provenance hashes and metrics when artifacts are present', async () => {
    const mockManifest = {
      run_id: 'test-run-123',
      checkpoint: { name: 'epoch=10.ckpt' }
    };
    
    const mockReport = {
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

    (fs.readFile as jest.Mock).mockImplementation(async (filePath) => {
      if (filePath.endsWith('run_manifest.json')) return JSON.stringify(mockManifest);
      if (filePath.endsWith('evaluation_report.json')) return JSON.stringify(mockReport);
      throw new Error('Not found');
    });

    const Component = await EvidencePage();
    render(Component);

    // Verify it doesn't invent "Not yet evaluated"
    expect(screen.queryByText('Not yet evaluated')).not.toBeInTheDocument();
    
    // Verify provenance is sourced from artifacts (never hardcoded)
    expect(screen.getByText('test-run-123')).toBeInTheDocument();
    expect(screen.getByText('abc123hash')).toBeInTheDocument();
    expect(screen.getByText('def456hash')).toBeInTheDocument();
    expect(screen.getByText('ghi789hash')).toBeInTheDocument();

    // Verify metrics are parsed
    expect(screen.getByText('12.345')).toBeInTheDocument();
    expect(screen.getByText('18.765')).toBeInTheDocument();
    expect(screen.getByText('0.823')).toBeInTheDocument();
  });
});
