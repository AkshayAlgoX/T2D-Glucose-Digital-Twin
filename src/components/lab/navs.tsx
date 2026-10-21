import React from 'react';

export function NavA({ here }: { here: 'home' | 'workspace' }) {
  return (
    <header className="a-nav">
      <span className="a-brand"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M1 13 L6 13 L8 6 L11 16 L13 9 L19 9" /></svg>GLUCOSE TWIN</span>
      <nav><a aria-current={here === 'workspace' ? 'page' : undefined}>Workspace</a><a>Cohort</a><a>Evidence</a></nav>
      <span className="a-env">RESEARCH PROTOTYPE · SYNTHETIC DATA</span>
    </header>
  );
}


export function NavB({ here }: { here: 'home' | 'workspace' }) {
  return (
    <header className="b-nav">
      <span className="b-brand">Glucose Twin<em>A research instrument for type 2 diabetes</em></span>
      <nav><a aria-current={here === 'workspace' ? 'page' : undefined}>Workspace</a><a>Cohort</a><a>Evidence</a></nav>
      <span className="b-env">Research prototype · synthetic data</span>
    </header>
  );
}

export function NavC({ here }: { here: 'home' | 'workspace' }) {
  return (
    <header className="c-nav">
      <span className="c-brand"><span className="c-logo" aria-hidden="true"><i /><i /></span>Glucose Twin</span>
      <nav><a aria-current={here === 'workspace' ? 'page' : undefined}>Workspace</a><a>Cohort</a><a>Evidence</a></nav>
      <span className="c-env">Research prototype</span>
    </header>
  );
}
