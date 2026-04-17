/**
 * time-series-forecast Tool Lambda
 *
 * Gateway Lambda Target として呼び出される。
 * フロー:
 *   1. SQL を Athena で実行（DZ 認証フロー: data-access と同じ）
 *   2. 結果の ts / y / item_id カラムを抽出し、等間隔化（欠損補完）
 *   3. SageMaker InvokeEndpoint で Chronos-2 に予測依頼
 *   4. サマリ（統計量）＋ full 配列（p10/p50/p90）を LLM / Code Interpreter に返す
 *
 * なぜ S3 artifact を使わないか: summarize.ts のヘッダコメント参照。
 */

import {
  AthenaClient,
  StartQueryExecutionCommand,
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
} from '@aws-sdk/client-athena';
import { SageMakerRuntimeClient, InvokeEndpointCommand } from '@aws-sdk/client-sagemaker-runtime';
import { redeemAndGetProjectCredentials, resolveProjectEnvironments } from '@agentic-analyst/datazone-auth';
import type { Context } from 'aws-lambda';
import {
  type ToolResponse,
  getProjectIdFromHeaders,
  getIdcAccessTokenFromHeaders,
  successResponse,
  errorResponse,
} from '../lib/types';
import { env } from '../lib/env';
import { fillSeries, type FillPolicy } from './fill';
import { parseRowsToSeries } from './parse';
import { summarize, type ChronosResponse } from './summarize';

const REGION = env.AWS_REGION;
const POLL_INTERVAL_MS = 500;
const ATHENA_MAX_POLL = 120;
const CHRONOS_MAX_CONTEXT = 8192;
const MIN_OBSERVATIONS = 5;
const WARN_OBSERVATIONS = 30;
const MAX_SERIES = 100; // ADR 0001: AgentCore Gateway 6MB 上限に対する事前防御

interface ForecastEvent {
  query?: string;
  freq?: string;
  prediction_length?: number;
  fill_missing_policy?: FillPolicy;
}

// --- DZ 認証キャッシュ（data-access と同パターン） ---
let credsCache: {
  key: string;
  creds: Awaited<ReturnType<typeof redeemAndGetProjectCredentials>>;
  expiresAt: number;
} | null = null;

async function getCachedProjectCredentials(domainId: string, environmentId: string, idcAccessToken: string) {
  const key = `${environmentId}:${idcAccessToken.slice(-16)}`;
  const now = Date.now();
  if (credsCache && credsCache.key === key && credsCache.expiresAt > now + 60_000) {
    return credsCache.creds;
  }
  const creds = await redeemAndGetProjectCredentials(domainId, environmentId, idcAccessToken, REGION);
  credsCache = { key, creds, expiresAt: creds.expiration ? new Date(creds.expiration).getTime() : now + 14 * 60_000 };
  return creds;
}

async function runAthenaQuery(
  athena: AthenaClient,
  query: string,
  database: string,
  workgroup: string,
): Promise<{ columns: string[]; rows: Record<string, string>[] }> {
  const startResult = await athena.send(
    new StartQueryExecutionCommand({
      QueryString: query,
      WorkGroup: workgroup,
      QueryExecutionContext: { Database: database },
    }),
  );
  const queryExecutionId = startResult.QueryExecutionId;
  if (!queryExecutionId) throw new Error('Failed to start query execution');

  let state: string | undefined;
  for (let i = 0; i < ATHENA_MAX_POLL; i++) {
    const execResult = await athena.send(new GetQueryExecutionCommand({ QueryExecutionId: queryExecutionId }));
    state = execResult.QueryExecution?.Status?.State;
    if (state === 'SUCCEEDED') break;
    if (state === 'FAILED' || state === 'CANCELLED') {
      throw new Error(`Query ${state}: ${execResult.QueryExecution?.Status?.StateChangeReason ?? 'Unknown error'}`);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  if (state !== 'SUCCEEDED') throw new Error('Query execution timed out');

  const resultsResponse = await athena.send(new GetQueryResultsCommand({ QueryExecutionId: queryExecutionId }));
  const rawRows = resultsResponse.ResultSet?.Rows ?? [];
  const columns = rawRows[0]?.Data?.map((d) => d.VarCharValue ?? '') ?? [];
  const rows = rawRows.slice(1).map((row) => {
    const obj: Record<string, string> = {};
    row.Data?.forEach((d, i) => {
      obj[columns[i]] = d.VarCharValue ?? '';
    });
    return obj;
  });
  return { columns, rows };
}

export async function handler(event: ForecastEvent, context: Context): Promise<ToolResponse> {
  try {
    const query = event.query;
    const freq = event.freq;
    const predictionLength = event.prediction_length;
    const fillPolicy: FillPolicy = event.fill_missing_policy ?? 'zero';

    if (!query) return errorResponse(-32602, 'Missing required parameter: query');
    if (!freq) return errorResponse(-32602, 'Missing required parameter: freq');
    if (!predictionLength || predictionLength < 1 || predictionLength > 1024) {
      return errorResponse(-32602, 'prediction_length must be between 1 and 1024');
    }

    const endpointName = env.CHRONOS_ENDPOINT_NAME;
    if (!endpointName) return errorResponse(-32001, 'CHRONOS_ENDPOINT_NAME is not configured');

    const projectId = getProjectIdFromHeaders(context);
    const idcAccessToken = getIdcAccessTokenFromHeaders(context);
    if (!projectId || !idcAccessToken) {
      return errorResponse(-32001, 'Missing required headers: x-sagemaker-project-id and x-idc-access-token');
    }

    const domainId = env.DATAZONE_DOMAIN_ID;
    if (!domainId) return errorResponse(-32001, 'DATAZONE_DOMAIN_ID is not configured');

    const envs = await resolveProjectEnvironments(domainId, projectId, REGION);
    const database = envs.glueDBName;
    if (!database) {
      return errorResponse(
        -32001,
        'Glue database not found for project. Ensure the project has a Lakehouse Database environment.',
      );
    }

    const projectCreds = await getCachedProjectCredentials(domainId, envs.toolingEnvironmentId, idcAccessToken);
    const athena = new AthenaClient({
      region: REGION,
      credentials: {
        accessKeyId: projectCreds.accessKeyId,
        secretAccessKey: projectCreds.secretAccessKey,
        sessionToken: projectCreds.sessionToken,
      },
    });

    const { columns, rows } = await runAthenaQuery(athena, query, database, envs.athenaWorkGroupName);
    const series = parseRowsToSeries(rows, columns);
    if (series.length === 0) return errorResponse(-32001, 'Query returned no usable rows (check ts/y aliases)');

    const filled = fillSeries(series, freq, fillPolicy);

    // ADR 0001: 6MB 上限に対する事前防御。p10/p50/p90 × 1024点 × 100系列 ≈ 3MB で余裕を持つ
    if (filled.length > MAX_SERIES) {
      return errorResponse(
        -32001,
        `Too many series (${filled.length}). Maximum supported: ${MAX_SERIES}. Narrow your SQL with WHERE or reduce GROUP BY cardinality.`,
      );
    }

    // 系列ごとの観測数バリデーション + 警告
    const warnings: string[] = [];
    for (const s of filled) {
      if (s.values.length < MIN_OBSERVATIONS) {
        return errorResponse(
          -32001,
          `Series '${s.itemId ?? '(single)'}' has fewer than ${MIN_OBSERVATIONS} observations (got ${s.values.length}). Chronos-2 requires at least 5.`,
        );
      }
      if (s.values.length < WARN_OBSERVATIONS) {
        warnings.push(
          `Series '${s.itemId ?? '(single)'}' has only ${s.values.length} observations (<${WARN_OBSERVATIONS} recommended)`,
        );
      }
      if (predictionLength > s.values.length * 0.5) {
        warnings.push(
          `prediction_length (${predictionLength}) exceeds 50% of observations for series '${s.itemId ?? '(single)'}' (${s.values.length})`,
        );
      }
      if (s.values.length > CHRONOS_MAX_CONTEXT) {
        s.values.splice(0, s.values.length - CHRONOS_MAX_CONTEXT);
        warnings.push(`Series '${s.itemId ?? '(single)'}' truncated to last ${CHRONOS_MAX_CONTEXT} observations`);
      }
    }

    // Chronos-2 ペイロード作成
    const inputs = filled.map((s) => ({
      target: s.values,
      ...(s.itemId ? { item_id: s.itemId } : {}),
      // Chronos は ISO 8601 の naive datetime（タイムゾーン無し）を期待する
      start: s.start.toISOString().replace(/\.\d+Z$/, ''),
    }));
    const payload = {
      inputs,
      parameters: {
        prediction_length: predictionLength,
        freq,
        quantile_levels: [0.1, 0.5, 0.9],
      },
    };

    const smRuntime = new SageMakerRuntimeClient({ region: REGION });
    const invokeResult = await smRuntime.send(
      new InvokeEndpointCommand({
        EndpointName: endpointName,
        ContentType: 'application/json',
        Accept: 'application/json',
        Body: new TextEncoder().encode(JSON.stringify(payload)),
      }),
    );
    const respText = new TextDecoder().decode(invokeResult.Body);
    const chronosResp: ChronosResponse = JSON.parse(respText);

    const summaries = summarize(chronosResp, freq);

    const meta = {
      data_points_used: filled.reduce((s, f) => s + f.values.length, 0),
      series_count: filled.length,
      freq,
      prediction_length: predictionLength,
      ...(warnings.length > 0 ? { warnings } : {}),
      ...(filled.length === 1
        ? {
            date_range: `${filled[0].start.toISOString().slice(0, 10)} to ${filled[0].end.toISOString().slice(0, 10)} (${filled[0].values.length} points)`,
            last_actual_value: filled[0].values[filled[0].values.length - 1],
          }
        : {}),
    };

    return successResponse(
      JSON.stringify({
        meta,
        predictions: summaries,
      }),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const name = err instanceof Error ? err.name : 'UnknownError';
    console.error('time-series-forecast error:', name, message, err instanceof Error ? err.stack : undefined);
    return errorResponse(-32001, `${name}: ${message}`);
  }
}
