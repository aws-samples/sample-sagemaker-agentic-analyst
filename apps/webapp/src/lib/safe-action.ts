import { runWithAmplifyServerContext } from '@/lib/amplifyServerUtils';
import { getCurrentUser } from 'aws-amplify/auth/server';
import { createSafeActionClient, DEFAULT_SERVER_ERROR_MESSAGE } from 'next-safe-action';
import { cookies } from 'next/headers';

export class MyCustomError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MyCustomError';
  }
}

const actionClient = createSafeActionClient({
  handleServerError(e) {
    console.error('Action error:', e.message);

    if (e instanceof MyCustomError) {
      return e.message;
    }

    return DEFAULT_SERVER_ERROR_MESSAGE;
  },
});

export const authActionClient = actionClient.use(async ({ next }) => {
  const currentUser = await runWithAmplifyServerContext({
    nextServerContext: { cookies },
    operation: (contextSpec) => getCurrentUser(contextSpec),
  });

  if (!currentUser) {
    throw new Error('Session is not valid!');
  }

  return next({ ctx: { userId: currentUser.userId } });
});
