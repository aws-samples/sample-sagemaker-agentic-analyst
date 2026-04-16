import { getSession } from '@/lib/auth';
import { AppShell } from './AppShell';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  return <AppShell email={session.email}>{children}</AppShell>;
}
