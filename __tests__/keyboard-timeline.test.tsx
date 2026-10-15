import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { TimeScrubber } from '../src/components/digital-twin/TimeScrubber';
import { TimeProvider, useTime } from '../src/components/digital-twin/TimeContext';

function TestComponent() {
  const { asOf } = useTime();
  return <div><div data-testid="asOf">{asOf || 'none'}</div><input aria-label="Test input" /><TimeScrubber asOf="2026-10-04T12:00:00Z" /></div>;
}

describe('Disabled replay keyboard safety', () => {
  it('offers no focusable timeline navigation and cannot pin a time via arrow keys', () => {
    render(<TimeProvider><TestComponent /></TimeProvider>);
    const region = screen.getByRole('region', { name: 'Pinned-time replay' });
    expect(screen.queryByRole('slider')).not.toBeInTheDocument();
    expect(region).not.toHaveAttribute('tabindex');
    fireEvent.keyDown(region, { key: 'ArrowLeft' });
    fireEvent.keyDown(region, { key: 'ArrowRight', shiftKey: true });
    expect(screen.getByTestId('asOf')).toHaveTextContent('none');
  });
  it('leaves typing in an input independent of unavailable timeline navigation', () => {
    render(<TimeProvider><TestComponent /></TimeProvider>);
    const input = screen.getByRole('textbox', { name: 'Test input' });
    input.focus();
    fireEvent.keyDown(input, { key: 'ArrowLeft' });
    expect(screen.getByTestId('asOf')).toHaveTextContent('none');
    expect(input).toHaveFocus();
  });
});
