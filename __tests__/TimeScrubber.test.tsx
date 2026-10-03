import React from 'react';
import { render, screen } from '@testing-library/react';
import { TimeScrubber } from '../src/components/digital-twin/TimeScrubber';
import { TimeProvider } from '../src/components/digital-twin/TimeContext';

describe('TimeScrubber', () => {
  it('renders slider without crashing', () => {
    render(
      <TimeProvider>
        <TimeScrubber />
      </TimeProvider>
    );
    expect(screen.getByRole('slider')).toBeInTheDocument();
  });
});
