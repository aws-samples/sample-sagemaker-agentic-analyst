import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { resolveIdcUserIdByEmail, resolveIdcGroups } from '@agentic-analyst/datazone-auth';
import { CloudTrailClient, StartQueryCommand, GetQueryResultsCommand, QueryStatus } from '@aws-sdk/client-cloudtrail';
import { env } from '@/lib/env';

export const maxDuration = 60;

const SECURITY_AUDITORS_GROUP = 'security-auditors';

const POLL_INTERVAL_MS = 1000;
const MAX_POLL_ATTEMPTS = 55;

export async function GET() {
  await getSession(); // 認証チェック
  if (!env.CLOUDTRAIL_EVENT_DATA_STORE_ID) {
    return NextResponse.json({ error: 'CLOUDTRAIL_EVENT_DATA_STORE_ID not configured' }, { status: 500 });
  }
  const eventDataStoreId = env.CLOUDTRAIL_EVENT_DATA_STORE_ID.split('/').pop() ?? env.CLOUDTRAIL_EVENT_DATA_STORE_ID;
  return NextResponse.json({ eventDataStoreId });
}

export async function POST(req: Request) {
  try {
    const session = await getSession();
    const { sql } = await req.json();

    if (!sql || typeof sql !== 'string') {
      return NextResponse.json({ error: 'sql is required' }, { status: 400 });
    }
    if (!env.IDC_IDENTITY_STORE_ID) {
      return NextResponse.json({ error: 'IDC_IDENTITY_STORE_ID not configured' }, { status: 500 });
    }
    if (!env.CLOUDTRAIL_EVENT_DATA_STORE_ID) {
      return NextResponse.json({ error: 'CLOUDTRAIL_EVENT_DATA_STORE_ID not configured' }, { status: 500 });
    }

    // 認可: security-auditors グループのみ許可（Policy Engineと同一ポリシー）
    const authorized = await isSecurityAuditor(env.IDC_IDENTITY_STORE_ID, session.email, env.AWS_REGION);
    if (!authorized) {
      return NextResponse.json({ error: 'このAPIはドメイン管理者のみ使用できます' }, { status: 403 });
    }

    // Event Data Store IDを抽出（ARNの場合はUUID部分のみ）
    const eventDataStoreId = env.CLOUDTRAIL_EVENT_DATA_STORE_ID.split('/').pop() ?? env.CLOUDTRAIL_EVENT_DATA_STORE_ID;

    // プレースホルダーを実際のEvent Data Store IDに置換
    const normalizedSql = sql
      .replace(/<EVENT_DATA_STORE_ID>/g, eventDataStoreId)
      .replace(/FROM\s+events\b/gi, `FROM ${eventDataStoreId}`)
      .replace(/FROM\s+cloudtrail_events\b/gi, `FROM ${eventDataStoreId}`);

    const cloudtrail = new CloudTrailClient({ region: env.AWS_REGION });

    const startResult = await cloudtrail.send(new StartQueryCommand({ QueryStatement: normalizedSql }));
    const queryId = startResult.QueryId;
    if (!queryId) {
      return NextResponse.json({ error: 'Failed to start CloudTrail query' }, { status: 500 });
    }

    // ポーリングで完了を待つ
    for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
      const resultsResponse = await cloudtrail.send(new GetQueryResultsCommand({ QueryId: queryId }));
      const status = resultsResponse.QueryStatus;

      if (status === QueryStatus.FINISHED) {
        const rawRows = resultsResponse.QueryResultRows ?? [];
        if (rawRows.length === 0) return NextResponse.json({ columns: [], rows: [] });

        // CloudTrail Lake結果: 各行は [{"colName": "value"}, ...] の配列
        const columns = rawRows[0].map((kv) => Object.keys(kv)[0] ?? '');
        const rows = rawRows.map((row) => {
          const record: Record<string, string> = {};
          row.forEach((kv) => {
            const k = Object.keys(kv)[0];
            if (k) record[k] = Object.values(kv)[0] ?? '';
          });
          return record;
        });
        return NextResponse.json({ columns, rows });
      }

      if (status === QueryStatus.FAILED || status === QueryStatus.CANCELLED) {
        return NextResponse.json({ error: `Query ${status}` }, { status: 500 });
      }

      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }

    return NextResponse.json({ error: 'Query execution timed out' }, { status: 504 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    const name = error instanceof Error ? error.name : 'UnknownError';
    console.error('CloudTrail query API error:', name, message);
    return NextResponse.json({ error: `${name}: ${message}` }, { status: 500 });
  }
}

async function isSecurityAuditor(identityStoreId: string, email: string, region: string): Promise<boolean> {
  const userId = await resolveIdcUserIdByEmail(identityStoreId, email, region);
  const groups = await resolveIdcGroups(identityStoreId, userId, region);
  return groups.some((g) => g === SECURITY_AUDITORS_GROUP);
}
