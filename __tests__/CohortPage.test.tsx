import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import CohortPage from '../src/app/cohort/page';

jest.mock('next/navigation', () => ({ usePathname: () => '/cohort' }));

// Explicit unit-test subject directory; not application data or evaluation evidence.
const subjects = [
  { subject_id: '11111111-1111-4111-8111-111111111111', patient_id: 'UNIT-1', group: 'Type 2', split: 'train' },
  { subject_id: '22222222-2222-4222-8222-222222222222', patient_id: 'UNIT-2', group: 'Healthy', split: 'val' },
];

describe('Cohort directory and Workspace entry', () => {
  const originalFetch = global.fetch;
  beforeEach(() => {
    window.localStorage.clear();
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => subjects });
  });
  afterEach(() => { global.fetch = originalFetch; jest.restoreAllMocks(); });

  it('links every Open workspace action to its own returned subject', async () => {
    render(<CohortPage />);
    expect(await screen.findByRole('link', { name: 'Open subject UNIT-1' })).toHaveAttribute('href', '/patients/' + subjects[0].subject_id);
    expect(screen.getByRole('link', { name: 'Open subject UNIT-2' })).toHaveAttribute('href', '/patients/' + subjects[1].subject_id);
    expect(screen.getByRole('main')).toHaveClass('cohort-page');
    expect(screen.getByRole('region', { name: 'Subject directory' })).toHaveAttribute('id', 'subject-directory');
    // Rows carry the readable ID only; the full hash and copy controls live in the Workspace header.
    expect(screen.queryByRole('button', { name: /copy/i })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Workspace' })).toHaveAttribute('href', '/cohort#subject-directory');
  });

  it('offers the validation demonstration subject only when the service serves it as a validation subject', async () => {
    const p17 = { subject_id: '33333333-3333-4333-8333-333333333333', patient_id: 'P0017', group: 'Type 2', split: 'val' };
    jest.mocked(global.fetch).mockResolvedValueOnce({ ok: true, json: async () => [...subjects, p17] } as Response);
    const { unmount } = render(<CohortPage />);
    const entry = await screen.findByRole('region', { name: /P0017 · Type 2 · val split/ });
    expect(entry).toHaveTextContent('Start here');
    expect(screen.getByRole('link', { name: /Open P0017/ })).toHaveAttribute('href', '/patients/' + p17.subject_id);
    unmount();
    jest.mocked(global.fetch).mockResolvedValueOnce({ ok: true, json: async () => [...subjects, { ...p17, split: 'test' }] } as Response);
    render(<CohortPage />);
    await screen.findByRole('link', { name: 'Open subject UNIT-1' });
    expect(screen.queryByText('Start here · demonstration subject')).not.toBeInTheDocument();
  });

  it('keeps search results linked to the matching subject', async () => {
    render(<CohortPage />);
    await screen.findByRole('link', { name: 'Open subject UNIT-1' });
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search subjects' }), { target: { value: 'UNIT-2' } });
    expect(screen.queryByRole('link', { name: 'Open subject UNIT-1' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open subject UNIT-2' })).toHaveAttribute('href', '/patients/' + subjects[1].subject_id);
  });

  it('shows a backend failure rather than substituting a directory', async () => {
    jest.mocked(global.fetch).mockRejectedValueOnce(new Error('Backend unavailable'));
    render(<CohortPage />);
    expect(await screen.findByRole('heading', { name: 'Subject service unavailable' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open subject UNIT-1' })).not.toBeInTheDocument();
  });

  it('combines group, partition, and trimmed search without changing subject destinations', async () => {
    render(<CohortPage />);
    await screen.findByRole('link', { name: 'Open subject UNIT-1' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Group' }), { target: { value: 'Healthy' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Partition' }), { target: { value: 'val' } });
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '  unit-2  ' } });
    expect(screen.getByRole('link', { name: 'Open subject UNIT-2' })).toHaveAttribute('href', '/patients/' + subjects[1].subject_id);
    expect(screen.queryByRole('link', { name: 'Open subject UNIT-1' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(screen.getByRole('link', { name: 'Open subject UNIT-1' })).toBeInTheDocument();
  });

  it('paginates returned subjects and resets to the first result when filtering', async () => {
    jest.mocked(global.fetch).mockResolvedValueOnce({ ok: true, json: async () => Array.from({ length: 25 }, (_, i) => ({ ...subjects[0], subject_id: `subject-${i}`, patient_id: `UNIT-${i}` })) } as Response);
    render(<CohortPage />);
    await screen.findByRole('link', { name: 'Open subject UNIT-0' });
    expect(screen.getAllByRole('link', { name: /Open subject/ })).toHaveLength(12);
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(screen.getByRole('link', { name: 'Open subject UNIT-24' })).toHaveAttribute('href', '/patients/subject-24');
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'UNIT-0' } });
    expect(screen.getByRole('link', { name: 'Open subject UNIT-0' })).toBeInTheDocument();
    expect(screen.getByText('Page 1 of 1')).toBeInTheDocument();
  });

  it('rejects malformed metadata and can retry the real request', async () => {
    jest.mocked(global.fetch).mockResolvedValueOnce({ ok: true, json: async () => [{ subject_id: 'invalid', group: 12 }] } as Response);
    render(<CohortPage />);
    await screen.findByRole('heading', { name: 'Subject service unavailable' });
    fireEvent.click(screen.getByRole('button', { name: 'Retry connection' }));
    expect(await screen.findByRole('link', { name: 'Open subject UNIT-1' })).toBeInTheDocument();
  });
});

describe('Group and Partition filter dropdowns — accessibility and filter behavior', () => {
  const originalFetch = global.fetch;
  beforeEach(() => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => subjects });
  });
  afterEach(() => { global.fetch = originalFetch; jest.restoreAllMocks(); });

  it('renders Group and Partition as accessible combobox controls with visible labels', async () => {
    render(<CohortPage />);
    await screen.findByRole('link', { name: 'Open subject UNIT-1' });
    const groupSelect = screen.getByRole('combobox', { name: 'Group' });
    const partitionSelect = screen.getByRole('combobox', { name: 'Partition' });
    expect(groupSelect).toBeInTheDocument();
    expect(partitionSelect).toBeInTheDocument();
    // Verify semantics: native select with combobox role is accessible by keyboard
    expect(groupSelect.tagName.toLowerCase()).toBe('select');
    expect(partitionSelect.tagName.toLowerCase()).toBe('select');
  });

  it('Group select carries the filter-controls class ancestor so CSS rule applies', async () => {
    const { container } = render(<CohortPage />);
    await screen.findByRole('link', { name: 'Open subject UNIT-1' });
    const groupSelect = screen.getByRole('combobox', { name: 'Group' });
    // The select must be inside an element with the filter-controls class for the dropdown CSS to target it
    expect(container.querySelector('.filter-controls select')).toBe(groupSelect);
    expect(container.querySelector('.filter-controls select[aria-label]') ?? container.querySelector('.filter-controls select')).toBeTruthy();
  });

  it('filters subjects by group and partition correctly and preserves subject link destinations', async () => {
    render(<CohortPage />);
    await screen.findByRole('link', { name: 'Open subject UNIT-1' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Group' }), { target: { value: 'Type 2' } });
    expect(screen.getByRole('link', { name: 'Open subject UNIT-1' })).toHaveAttribute('href', '/patients/' + subjects[0].subject_id);
    expect(screen.queryByRole('link', { name: 'Open subject UNIT-2' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: 'Partition' }), { target: { value: 'val' } });
    // No subjects match Type2+val → empty state
    expect(screen.queryByRole('link', { name: /Open subject/ })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: 'Group' }), { target: { value: '' } });
    // Resetting group with partition=val → UNIT-2 matches
    expect(screen.getByRole('link', { name: 'Open subject UNIT-2' })).toHaveAttribute('href', '/patients/' + subjects[1].subject_id);
  });

  it('select elements are not disabled and respond to change events', async () => {
    render(<CohortPage />);
    await screen.findByRole('link', { name: 'Open subject UNIT-1' });
    const groupSelect = screen.getByRole('combobox', { name: 'Group' });
    expect(groupSelect).not.toBeDisabled();
    // Verify it accepts changes (filtering behavior check)
    fireEvent.change(groupSelect, { target: { value: 'Healthy' } });
    expect(screen.queryByRole('link', { name: 'Open subject UNIT-1' })).not.toBeInTheDocument();
  });

  it('does not suppress :focus-visible on the select elements', async () => {
    // Regression: the CSS rule .filter-controls select:focus-visible must NOT set outline:none
    // We verify this by checking no style attribute suppresses outline on the selects.
    const { container } = render(<CohortPage />);
    await screen.findByRole('link', { name: 'Open subject UNIT-1' });
    const selects = container.querySelectorAll<HTMLSelectElement>('.filter-controls select');
    expect(selects.length).toBeGreaterThanOrEqual(2);
    selects.forEach(sel => {
      // No inline style should set outline: none (global CSS may use outline, tested by integration)
      expect(sel.style.outline).not.toBe('none');
      expect(sel.style.outline).not.toBe('0');
    });
  });

  it('displays skeleton rows while the subject directory request is pending and keeps controls stable', async () => {
    let resolveFetch: (val: any) => void = () => {};
    global.fetch = jest.fn().mockReturnValue(new Promise(resolve => { resolveFetch = resolve; }));

    const { container } = render(<CohortPage />);

    // Heading, search, and filters are stable and visible while loading
    expect(screen.getByRole('heading', { name: 'Patient cohort' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Subject directory' })).toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: 'Search subjects' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Group' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Partition' })).toBeInTheDocument();

    // Skeletons are displayed
    expect(container.querySelector('.directory-loading')).toBeInTheDocument();
    expect(container.querySelectorAll('.directory-loading-row').length).toBe(12);
    expect(container.querySelectorAll('.skeleton').length).toBeGreaterThan(10);

    // Resolving fetch replaces skeletons with actual data
    resolveFetch({ ok: true, json: async () => subjects });
    expect(await screen.findByRole('link', { name: 'Open subject UNIT-1' })).toBeInTheDocument();
    expect(container.querySelector('.directory-loading')).not.toBeInTheDocument();
    expect(container.querySelectorAll('.directory-loading-row').length).toBe(0);
  });

  it('does not display skeletons for local search or filtering', async () => {
    const { container } = render(<CohortPage />);
    await screen.findByRole('link', { name: 'Open subject UNIT-1' });

    // Perform local filtering
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search subjects' }), { target: { value: 'NONEXISTENT' } });
    expect(screen.getByRole('heading', { name: 'No matching subjects' })).toBeInTheDocument();
    // No skeletons should be used for instant filtering
    expect(container.querySelector('.directory-loading')).not.toBeInTheDocument();
  });
});
