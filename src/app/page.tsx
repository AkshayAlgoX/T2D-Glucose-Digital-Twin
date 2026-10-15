import { redirect } from 'next/navigation';

// There is no landing page: the cohort list is the entry point.
export default function Home() {
  redirect('/cohort');
}
