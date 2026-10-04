import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { TimeScrubber } from '../src/components/digital-twin/TimeScrubber';
import { TimeProvider, useTime } from '../src/components/digital-twin/TimeContext';

const TestComponent = () => {
   const { asOf } = useTime();
   return (
     <div>
       <div data-testid="asOf">{asOf || 'none'}</div>
       <input data-testid="test-input" />
       <TimeScrubber cache={{ patientId: 'test', cgm: [], risk: [], alerts: [], dataQuality: [] }} asOf="2026-10-04T12:00:00.000Z" />
     </div>
   );
};

describe('F10 & F11: Keyboard Timeline', () => {
  it('handles shortcuts correctly when focused on scrubber', () => {
    render(
      <TimeProvider>
        <TestComponent />
      </TimeProvider>
    );

    const scrubber = screen.getByRole('slider');
    scrubber.focus();
    
    // Left arrow = 5m back
    fireEvent.keyDown(scrubber, { key: 'ArrowLeft' });
    expect(screen.getByTestId('asOf').textContent).toBe('2026-10-04T11:55:00.000Z');

    // Right arrow + Shift = 1h forward (will cap at 12:00)
    fireEvent.keyDown(scrubber, { key: 'ArrowRight', shiftKey: true });
    expect(screen.getByTestId('asOf').textContent).toBe('2026-10-04T12:00:00.000Z');
    
    // L = Latest (anchor time)
    fireEvent.keyDown(scrubber, { key: 'L' });
    expect(screen.getByTestId('asOf').textContent).toBe('none');
    
    // Space play/pause (just ensure it doesn't crash)
    fireEvent.keyDown(scrubber, { key: ' ' });
  });

  it('F11: ignores shortcuts when input is focused', () => {
    render(
      <TimeProvider>
        <TestComponent />
      </TimeProvider>
    );

    const input = screen.getByTestId('test-input');
    input.focus();
    
    fireEvent.keyDown(screen.getByRole('slider'), { key: 'ArrowLeft' });
    
    // Should NOT have changed because activeElement is input
    expect(screen.getByTestId('asOf').textContent).toBe('none');
  });
});
