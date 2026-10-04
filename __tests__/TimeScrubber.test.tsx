import React from 'react';
import { render, screen } from '@testing-library/react';
import { TimeScrubber } from '../src/components/digital-twin/TimeScrubber';
import { TimeProvider } from '../src/components/digital-twin/TimeContext';

describe('TimeScrubber', () => {
  it('renders slider without crashing', () => {
    render(
      <TimeProvider>
        <TimeScrubber asOf="2026-10-04T12:00:00Z" />
      </TimeProvider>
    );
    expect(screen.getByRole('slider')).toBeInTheDocument();
  });
});

  it('never renders a rect with a negative width', () => {
    // Render the scrubber
    const { container } = render(
      <TimeProvider>
        <TimeScrubber />
      </TimeProvider>
    );
    // Find all SVG rects
    const rects = container.querySelectorAll('rect');
    rects.forEach(rect => {
      const width = parseFloat(rect.getAttribute('width') || '0');
      expect(width).toBeGreaterThanOrEqual(0);
    });
  });
