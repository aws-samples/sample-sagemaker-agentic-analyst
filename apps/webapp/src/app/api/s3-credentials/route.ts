import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { getProjectCredentials } from '@/lib/project-credentials';
import { resolveProjectEnvironments } from '@/lib/environment-resolver';
import { env } from '@/lib/env';

export const maxDuration = 60;

/**
 * プロジェクトロールの一時認証情報を返す。
 * StorageBrowser の credentialsProvider から呼ばれる。
 *
 * jwt-bearerグラントは同一jtiのID Tokenを拒否するため、毎回forceRefreshする。
 */
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const projectId = searchParams.get('projectId');

    if (!projectId) {
      return NextResponse.json({ error: 'projectId is required' }, { status: 400 });
    }

    if (!env.DATAZONE_DOMAIN_ID) {
      return NextResponse.json({ error: 'DATAZONE_DOMAIN_ID not configured' }, { status: 500 });
    }
    if (!env.IDC_APPLICATION_ARN) {
      return NextResponse.json({ error: 'IDC_APPLICATION_ARN not configured' }, { status: 500 });
    }

    const session = await getSession(true);

    // projectId から Tooling環境IDを解決
    const envs = await resolveProjectEnvironments(env.DATAZONE_DOMAIN_ID, projectId, env.AWS_REGION);
    const credentials = await getProjectCredentials(
      env.DATAZONE_DOMAIN_ID,
      envs.toolingEnvironmentId,
      session.idToken,
      env.AWS_REGION,
      env.IDC_APPLICATION_ARN,
    );

    return NextResponse.json({
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken,
      expiration: credentials.expiration,
      accountId: env.AWS_ACCOUNT_ID,
      region: env.AWS_REGION,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    const name = error instanceof Error ? error.name : 'UnknownError';
    console.error('S3 credentials API error:', name, message);

    if (message.includes('not a member') || message.includes('not permitted')) {
      return NextResponse.json({ error: message }, { status: 403 });
    }
    return NextResponse.json({ error: `${name}: ${message}` }, { status: 500 });
  }
}
