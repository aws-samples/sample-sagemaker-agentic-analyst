/**
 * cloudtrail_query Tool Lambda
 *
 * Gateway Lambda Targetとして呼び出される。
 * CloudTrail Lakeへのセキュリティログ検索を実行する。
 * dg-corp-adminのみがPolicy Engine（Cedarポリシー）で許可されている。
 * Lambda実行ロールの権限で実行する。
 */

import type { Context } from 'aws-lambda';
import {
  CloudTrailClient,
  StartQueryCommand,
  GetQueryResultsCommand,
  type QueryStatus,
} from '@aws-sdk/client-cloudtrail';
import { type ToolResponse, successResponse, errorResponse } from '../lib/types';
import { env } from '../lib/env';

interface CloudtrailQueryEvent {
  query?: string;
}

const POLL_INTERVAL_MS = 1000;
const MAX_POLL_ATTEMPTS = 60;

export async function handler(event: CloudtrailQueryEvent, _context: Context): Promise<ToolResponse> {
  const query = event.query;
  if (!query) return errorResponse(-32602, 'Missing required parameter: query');

  try {
    const cloudtrail = new CloudTrailClient({ region: env.AWS_REGION });

    const startResult = await cloudtrail.send(new StartQueryCommand({ QueryStatement: query }));
    const queryId = startResult.QueryId;
    if (!queryId) return errorResponse(-32001, 'Failed to start CloudTrail query');

    let status: QueryStatus | undefined;
    for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
      const resultsResponse = await cloudtrail.send(new GetQueryResultsCommand({ QueryId: queryId }));
      status = resultsResponse.QueryStatus;

      if (status === 'FINISHED') {
        return successResponse(JSON.stringify({ rows: resultsResponse.QueryResultRows ?? [] }));
      }
      if (status === 'FAILED' || status === 'CANCELLED') {
        return errorResponse(-32001, `Query ${status}`);
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }

    return errorResponse(-32001, 'Query execution timed out');
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('cloudtrail_query error:', message);
    return errorResponse(-32001, message);
  }
}
