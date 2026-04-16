import { redirect } from 'next/navigation';
import { env } from '@/lib/env';

export const dynamic = 'force-dynamic';

export default function SignOutCompletePage() {
  if (env.IDC_PORTAL_URL) {
    redirect(`${env.IDC_PORTAL_URL}#/signout`);
  }
  redirect('/sign-in');
}
