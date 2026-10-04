import React from 'react';
import { render, screen } from '@testing-library/react';
import { ScenarioEditor } from '../src/components/digital-twin/ScenarioEditor';

describe('ScenarioEditor', () => {
  it('renders stub without crashing', () => {
    render(<ScenarioEditor patientId="123" />);
    expect(screen.getByText(/Simulation/)).toBeInTheDocument();
  });
});
