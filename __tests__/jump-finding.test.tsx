import { render, screen } from '@testing-library/react';
import path from 'path';
import { readJumpExperiment } from '../src/lib/landing';
import { JumpFinding } from '../src/components/figure/EvidenceFigures';

describe('Isolated-step finding: read from the committed pre-registered result, never applied', () => {
  it('reads the committed results and states the decision', async () => {
    const data = await readJumpExperiment(path.join(process.cwd(), 'docs/evidence/jump_experiment/results.json'));
    expect(data).not.toBeNull();
    expect(data!.validation.n).toBe(880);
    expect(data!.validation.original.share_isolated_step_gt_20).toBe(0.198);
    render(<JumpFinding data={data!} />);
    expect(screen.getByTestId('jump-finding')).toHaveTextContent('In 19.8% of 880 sampled validation forecasts');
    expect(screen.getByTestId('jump-finding')).toHaveTextContent('recorded, not applied');
    expect(screen.getByRole('table')).toHaveTextContent('R3 repair');
  });

  it('is absent when the artifact is missing or malformed', async () => {
    expect(await readJumpExperiment('/nonexistent/results.json')).toBeNull();
  });
});
