import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { fetchAuthSession } from 'aws-amplify/auth/server';
import { runWithAmplifyServerContext } from '@/lib/amplifyServerUtils';
import { env } from '@/lib/env';

const AGENTCORE_ENDPOINT = env.AGENTCORE_ENDPOINT || `https://bedrock-agentcore.${env.AWS_REGION}.amazonaws.com`;

function buildRuntimeUrl(): string | undefined {
  if (!env.AGENTCORE_RUNTIME_ARN) return undefined;
  const escapedArn = encodeURIComponent(env.AGENTCORE_RUNTIME_ARN);
  return `${AGENTCORE_ENDPOINT}/runtimes/${escapedArn}/invocations?qualifier=DEFAULT`;
}

export async function GET(request: Request) {
  try {
    const forceRefresh = new URL(request.url).searchParams.get('forceRefresh') === 'true';
    const session = await runWithAmplifyServerContext({
      nextServerContext: { cookies },
      operation: (contextSpec) => fetchAuthSession(contextSpec, { forceRefresh }),
    });

    if (session.tokens?.accessToken == null) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    return NextResponse.json({
      accessToken: session.tokens.accessToken.toString(),
      idToken: session.tokens.idToken?.toString(),
      runtimeUrl: buildRuntimeUrl(),
    });
  } catch (error) {
    console.error('Error fetching Cognito token:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
