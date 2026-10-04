import React from 'react';
import { render, screen } from '@testing-library/react';
import { RiskPanel } from '../src/components/digital-twin/RiskPanel';

describe('Opus Audit - RiskPanel & Waterfall', () => {
  it('handles null risk gracefully', () => {
    const forecast = {
      spike_risk: { probability_120m: null }
    };
    render(<RiskPanel forecast={forecast} />);
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('computes waterfall arithmetic exactly', () => {
    const forecast = {
      current: { value_mg_dl: 100 },
      drivers: [
        { label_key: 'Meal', impact_mg_dl: 40 },
        { label_key: 'Insulin', impact_mg_dl: -10 }
      ],
      spike_risk: { peak_mg_dl: { p50: 150 } }
    };
    // 100 + 40 - 10 = 130. Peak is 150. Residual must be +20.
    render(<RiskPanel forecast={forecast} />);
    expect(screen.getByText('+20')).toBeInTheDocument();
    expect(screen.getByText('Residual')).toBeInTheDocument();
  });

  it('maps alert states without exposing raw message keys', () => {
    const forecast = {
      alert: { state: 'watch', message_key: 'RAW_SYSTEM_KEY_123' },
      spike_risk: { probability_120m: 0.9 }
    };
    render(<RiskPanel forecast={forecast} />);
    expect(screen.queryByText('RAW_SYSTEM_KEY_123')).not.toBeInTheDocument();
    expect(screen.getByText('Risk Watch')).toBeInTheDocument();
  });
});
