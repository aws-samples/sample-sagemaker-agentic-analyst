import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { DataZoneClient, ListProjectsCommand } from '@aws-sdk/client-datazone';
import { resolveIdcUserIdByEmail } from '@agentic-analyst/datazone-auth';
import { env } from '@/lib/env';

export interface ProjectInfo {
  projectId: string;
  projectName: string;
}

/**
 * Cognitoメールアドレスからユーザーが所属するプロジェクト一覧を返す。
 */
export async function GET() {
  try {
    const session = await getSession();

    if (!env.DATAZONE_DOMAIN_ID) {
      return NextResponse.json({ error: 'DATAZONE_DOMAIN_ID not configured' }, { status: 500 });
    }
    if (!env.IDC_IDENTITY_STORE_ID) {
      return NextResponse.json({ error: 'IDC_IDENTITY_STORE_ID not configured' }, { status: 500 });
    }

    const idcUserId = await resolveIdcUserIdByEmail(env.IDC_IDENTITY_STORE_ID, session.email, env.AWS_REGION);

    const dz = new DataZoneClient({ region: env.AWS_REGION });
    const projectsRes = await dz.send(
      new ListProjectsCommand({
        domainIdentifier: env.DATAZONE_DOMAIN_ID,
        userIdentifier: idcUserId,
        maxResults: 50,
      }),
    );

    const results: ProjectInfo[] = (projectsRes.items ?? []).map((p) => ({
      projectId: p.id!,
      projectName: p.name!,
    }));

    return NextResponse.json(results);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('Projects API error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
