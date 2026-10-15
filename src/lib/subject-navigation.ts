import { SubjectSchema } from './zod-schemas';

export const LAST_SUBJECT_KEY = 'glucose-twin:last-viewed-subject:v1';
export interface SubjectReference {
  subjectId: string | null;
  error: string | null;
}

export function validSubjectId(value: unknown): string | null {
  const result = SubjectSchema.shape.subject_id.safeParse(value);
  return result.success ? result.data : null;
}

export function subjectFromPath(pathname: string): string | null {
  const match = /^\/patients\/([^/]+)\/?$/.exec(pathname);
  if (!match) return null;
  try {
    return validSubjectId(decodeURIComponent(match[1]));
  } catch {
    return null;
  }
}

export function readLastSubject(): SubjectReference {
  if (typeof window === 'undefined') return { subjectId: null, error: null };
  try {
    const value = window.localStorage.getItem(LAST_SUBJECT_KEY);
    if (value == null) return { subjectId: null, error: null };
    const subjectId = validSubjectId(value);
    return { subjectId, error: subjectId ? null : 'The saved subject reference is invalid. Select a subject from Cohort.' };
  } catch {
    return { subjectId: null, error: 'Browser storage is unavailable. Select a subject from Cohort to open Workspace.' };
  }
}

// Only call after a matching subject's response has passed the frontend contract.
// This remembers navigation context, never a scientific result or model input.
export function rememberReceivedSubject(value: unknown): SubjectReference {
  const subjectId = validSubjectId(value);
  if (!subjectId) return { subjectId: null, error: 'The subject reference could not be saved because it is invalid.' };
  try {
    window.localStorage.setItem(LAST_SUBJECT_KEY, subjectId);
    return { subjectId, error: null };
  } catch {
    return { subjectId, error: 'Browser storage is unavailable. The last-viewed subject could not be saved; the current Workspace remains available.' };
  }
}
