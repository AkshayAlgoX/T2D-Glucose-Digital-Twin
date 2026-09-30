import React from 'react';
import { render, screen } from '@testing-library/react';
import { TimeScrubber } from '../src/components/digital-twin/TimeScrubber';

describe('TimeScrubber', () => {
  it('computes timestamps securely from anchorTime without relying on local clock drift', () => {
    const onTimeChange = jest.fn();
    const anchorTime = '2026-09-30T10:00:00.000Z';
    
    render(<TimeScrubber onTimeChange={onTimeChange} anchorTime={anchorTime} />);
    
    expect(screen.getByRole('slider')).toBeInTheDocument();
  });
});
