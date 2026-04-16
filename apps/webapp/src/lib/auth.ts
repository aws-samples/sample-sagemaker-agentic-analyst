import { cookies } from 'next/headers';
import { fetchAuthSession } from 'aws-amplify/auth/server';
import { runWithAmplifyServerContext } from '@/lib/amplifyServerUtils';

export async function getSession(forceRefresh = false) {
  const session = await runWithAmplifyServerContext({
    nextServerContext: { cookies },
    operation: (contextSpec) => fetchAuthSession(contextSpec, { forceRefresh }),
  });
  if (session.userSub == null || session.tokens?.idToken == null || session.tokens?.accessToken == null) {
    throw new Error('session not found');
  }
  const userId = session.userSub;
  const email = session.tokens.idToken.payload.email;
  if (typeof email != 'string') {
    throw new Error(`invalid email ${userId}.`);
  }

  return {
    userId,
    email,
    accessToken: session.tokens.accessToken.toString(),
    idToken: session.tokens.idToken.toString(),
  };
}
