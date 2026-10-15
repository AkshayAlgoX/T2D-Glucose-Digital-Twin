import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { usePathname } from 'next/navigation';
import { NavigationRail } from '../src/components/digital-twin/NavigationRail';
import { LAST_SUBJECT_KEY } from '../src/lib/subject-navigation';

jest.mock('next/navigation', () => ({ usePathname: jest.fn() }));

describe('Shared research navigation', () => {
  const firstSubject = '11111111-1111-4111-8111-111111111111';
  const secondSubject = '22222222-2222-4222-8222-222222222222';
  beforeEach(() => window.localStorage.clear());
  afterEach(() => { jest.clearAllMocks(); jest.restoreAllMocks(); });

  it.each([
    ['/cohort', 'Cohort'],
    ['/patients/11111111-1111-4111-8111-111111111111', 'Workspace'],
    ['/evidence', 'Evidence'],
  ])('marks exactly the current section on %s', (pathname, label) => {
    jest.mocked(usePathname).mockReturnValue(pathname);
    render(<NavigationRail />);
    const navigation = screen.getByRole('navigation', { name: 'Main navigation' });
    expect(Array.from(navigation.querySelectorAll('.navigation-link'), item => item.textContent?.trim()))
      .toEqual(['Cohort', 'Workspace', 'Evidence']);
    const active = navigation.querySelectorAll('[aria-current="page"]');
    expect(active).toHaveLength(1);
    expect(active[0]).toHaveTextContent(label);
    expect(within(navigation).getByRole('link', { name: 'Cohort' })).toHaveAttribute('href', '/cohort');
    expect(within(navigation).getByRole('link', { name: 'Evidence' })).toHaveAttribute('href', '/evidence');
    expect(screen.getByRole('link', { name: 'Skip to main content' })).toHaveAttribute('href', '#main-content');
    expect(screen.getByText('Research prototype')).toBeInTheDocument();
    const workspace = within(navigation).getByRole('link', { name: 'Workspace' });
    expect(workspace).toHaveAttribute('href', label === 'Workspace' ? '/patients/' + firstSubject : '/cohort#subject-directory');
    expect(within(navigation).queryByRole('button', { name: 'Workspace' })).not.toBeInTheDocument();
    if (label !== 'Workspace') expect(workspace).toHaveAccessibleDescription('Select a subject from the Cohort directory to open Workspace.');
  });

  it('does not falsely mark Cohort active on the design fixture page', () => {
    jest.mocked(usePathname).mockReturnValue('/design-review');
    render(<NavigationRail />);
    expect(screen.getByRole('navigation').querySelector('[aria-current]')).toBeNull();
  });

  it('respects the page-provided active item while route state is unavailable', () => {
    jest.mocked(usePathname).mockReturnValue(null);
    render(<NavigationRail active="evidence" />);
    expect(screen.getByRole('link', { name: 'Evidence' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Cohort' })).not.toHaveAttribute('aria-current');
    // Workspace requires a selected subject; never insert a fabricated patient URL.
    expect(screen.getByRole('link', { name: 'Workspace' })).toHaveAttribute('href', '/cohort#subject-directory');
  });

  it('reopens a received subject after navigation and a fresh navigation-component mount', () => {
    jest.mocked(usePathname).mockReturnValue('/patients/' + firstSubject);
    const { unmount } = render(<NavigationRail active="patient" selectedSubjectId={firstSubject} />);
    expect(window.localStorage.getItem(LAST_SUBJECT_KEY)).toBe(firstSubject);
    unmount();
    jest.mocked(usePathname).mockReturnValue('/evidence');
    render(<NavigationRail active="evidence" />);
    expect(screen.getByRole('link', { name: 'Workspace' })).toHaveAttribute('href', '/patients/' + firstSubject);
    expect(screen.getByRole('link', { name: 'Evidence' })).toHaveAttribute('aria-current', 'page');
  });

  it('prefers the current route over an older remembered subject without saving an unverified visit', () => {
    window.localStorage.setItem(LAST_SUBJECT_KEY, firstSubject);
    jest.mocked(usePathname).mockReturnValue('/patients/' + secondSubject);
    render(<NavigationRail active="patient" />);
    expect(screen.getByRole('link', { name: 'Workspace' })).toHaveAttribute('href', '/patients/' + secondSubject);
    expect(window.localStorage.getItem(LAST_SUBJECT_KEY)).toBe(firstSubject);
  });

  it('rejects corrupt or unsafe stored references with a visible explanation', () => {
    window.localStorage.setItem(LAST_SUBJECT_KEY, 'javascript:alert(1)');
    jest.mocked(usePathname).mockReturnValue('/cohort');
    render(<NavigationRail />);
    expect(screen.getByRole('link', { name: 'Workspace' })).toHaveAttribute('href', '/cohort#subject-directory');
    expect(screen.getByRole('status')).toHaveTextContent('The saved subject reference is invalid.');
  });

  it('reports unavailable storage and keeps the directory fallback usable', () => {
    jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Storage blocked'); });
    jest.mocked(usePathname).mockReturnValue('/evidence');
    render(<NavigationRail />);
    expect(screen.getByRole('status')).toHaveTextContent('Browser storage is unavailable.');
    expect(screen.getByRole('link', { name: 'Workspace' })).toHaveAttribute('href', '/cohort#subject-directory');
  });

  it('reports a failed preference write while preserving the current Workspace link', () => {
    jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Quota exceeded'); });
    jest.mocked(usePathname).mockReturnValue('/patients/' + firstSubject);
    render(<NavigationRail active="patient" selectedSubjectId={firstSubject} />);
    expect(screen.getByRole('status')).toHaveTextContent('The last-viewed subject could not be saved');
    expect(screen.getByRole('link', { name: 'Workspace' })).toHaveAttribute('href', '/patients/' + firstSubject);
  });
});
