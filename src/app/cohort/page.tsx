'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';

export default function CohortPage() {
  const [subjects, setSubjects] = useState<any[]>([]);

  useEffect(() => {
    fetch('/api/subjects').then(r => r.json()).then(data => {
      setSubjects(Array.isArray(data) ? data : []);
    });
  }, []);

  return (
    <div className="p-8 max-w-4xl mx-auto">
      <h1 className="text-2xl mb-4 font-semibold">Patient Cohort</h1>
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-line text-left">
            <th className="py-2 text-ink-2 font-medium">Subject ID</th>
          </tr>
        </thead>
        <tbody>
          {subjects.map(s => (
            <tr key={s.subject_id} className="border-b border-line hover:bg-surface-2 transition-colors">
              <td className="py-2">
                <Link href={`/patients/${s.subject_id}`} className="text-accent hover:underline font-mono">
                  {s.subject_id}
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
