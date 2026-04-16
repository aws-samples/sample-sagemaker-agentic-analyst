import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { ProjectAthenaClient } from '@/lib/athena-client';
import { resolveProjectEnvironments } from '@/lib/environment-resolver';
import { env } from '@/lib/env';

export const maxDuration = 60;

export async function POST(req: Request) {
  try {
    // jwt-bearerグラントは同一jtiのID Tokenを拒否するため、毎回新しいトークンを取得
    const session = await getSession(true);
    const { sql, projectId } = await req.json();

    if (!sql || typeof sql !== 'string') {
      return NextResponse.json({ error: 'sql is required' }, { status: 400 });
    }
    if (!projectId || typeof projectId !== 'string') {
      return NextResponse.json({ error: 'projectId is required' }, { status: 400 });
    }

    const datazoneDomainId = env.DATAZONE_DOMAIN_ID;
    if (!datazoneDomainId) {
      return NextResponse.json({ error: 'DATAZONE_DOMAIN_ID not configured' }, { status: 500 });
    }

    // projectId から環境情報を解決
    const envs = await resolveProjectEnvironments(datazoneDomainId, projectId, env.AWS_REGION);
    const database = envs.glueDBName;
    if (!database) {
      return NextResponse.json(
        { error: 'Lakehouse Database environment not found for this project. Athena queries are not available.' },
        { status: 400 },
      );
    }

    console.log(
      `Query API: user=${session.email}, domainId=${datazoneDomainId}, projectId=${projectId}, db=${database}`,
    );
    const client = new ProjectAthenaClient({
      datazoneDomainId,
      environmentId: envs.toolingEnvironmentId,
      database,
      idToken: session.idToken,
    });
    const result = await client.executeQuery(sql);

    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    const name = error instanceof Error ? error.name : 'UnknownError';
    console.error('Query API error:', name, message, error);

    if (message.includes('not a member') || message.includes('not permitted')) {
      return NextResponse.json({ error: message }, { status: 403 });
    }
    return NextResponse.json({ error: `${name}: ${message}` }, { status: 500 });
  }
}
