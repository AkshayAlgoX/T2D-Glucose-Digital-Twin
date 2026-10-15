import React from 'react';
import { render, screen } from '@testing-library/react';
import { TimeScrubber } from '../src/components/digital-twin/TimeScrubber';

describe('Unavailable pinned-time replay', () => {
  it('reports replay as unavailable and exposes no slider or replay buttons', () => {
    render(<TimeScrubber asOf="2026-10-04T12:00:00Z" />);
    expect(screen.getByText('Pinned-time replay unavailable')).toBeInTheDocument();
    expect(screen.queryByRole('slider')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
  it('remains honest before any timestamp or history is received', () => {
    render(<TimeScrubber />);
    expect(screen.getByRole('region', { name: 'Pinned-time replay' })).toBeInTheDocument();
    expect(screen.getByText(/ordinary synthetic stream remains available/)).toBeInTheDocument();
  });
});
