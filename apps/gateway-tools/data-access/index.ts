/**
 * data-access Tool Lambda（athena_query + s3_read + s3_list 統合）
 *
 * Gateway Lambda Targetとして呼び出される。
 * context.clientContext.custom.bedrockAgentCoreToolName でツールをルーティング。
 * DZ RedeemAccessToken → GetEnvironmentCredentials フローで認証。VPC必要。
 */

import {
  AthenaClient,
  StartQueryExecutionCommand,
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
} from '@aws-sdk/client-athena';
import { S3ControlClient, GetDataAccessCommand } from '@aws-sdk/client-s3-control';
import { S3Client, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import {
  redeemAndGetProjectCredentials,
  getEnvironmentInfo,
  resolveProjectEnvironments,
} from '@agentic-analyst/datazone-auth';
import { resolveS3Connection } from '../lib/s3-connection-resolver';
import { env } from '../lib/env';
import type { Context } from 'aws-lambda';
import {
  type ToolResponse,
  getToolName,
  getProjectIdFromHeaders,
  getIdcAccessTokenFromHeaders,
  successResponse,
  errorResponse,
} from '../lib/types';

const REGION = env.AWS_REGION;
const POLL_INTERVAL_MS = 500;

// --- 共通: DZ認証（キャッシュ付き） ---

// RedeemAccessTokenはjti制約なし。同一IdC Access Tokenで複数回呼び出し可能だが、
// 同一Lambdaコンテナ内での不要なAPI呼び出しを避けるためキャッシュする。
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

interface DataAccessContext {
  projectId: string;
  idcAccessToken: string;
}

function extractDataAccessContext(context: Context): DataAccessContext {
  const projectId = getProjectIdFromHeaders(context);
  const idcAccessToken = getIdcAccessTokenFromHeaders(context);
  if (!projectId || !idcAccessToken) {
    throw new Error('Missing required headers: x-sagemaker-project-id and x-idc-access-token');
  }
  return { projectId, idcAccessToken };
}

function getDomainId(): string {
  return env.DATAZONE_DOMAIN_ID!;
}

// --- athena_query ---

interface AthenaQueryEvent {
  query?: string;
}

const ATHENA_MAX_POLL = 120;

async function handleAthenaQuery(event: AthenaQueryEvent, context: Context): Promise<ToolResponse> {
  const query = event.query;
  if (!query) return errorResponse(-32602, 'Missing required parameter: query');

  const { projectId, idcAccessToken } = extractDataAccessContext(context);
  const domainId = getDomainId();

  const envs = await resolveProjectEnvironments(domainId, projectId, REGION);
  const database = envs.glueDBName;
  if (!database)
    return errorResponse(
      -32001,
      'Glue database not found for project. Ensure the project has a Lakehouse Database environment.',
    );

  const creds = await getCachedProjectCredentials(domainId, envs.toolingEnvironmentId, idcAccessToken);
  const athena = new AthenaClient({
    region: REGION,
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken: creds.sessionToken,
    },
  });

  const startResult = await athena.send(
    new StartQueryExecutionCommand({
      QueryString: query,
      WorkGroup: envs.athenaWorkGroupName,
      QueryExecutionContext: { Database: database },
    }),
  );
  const queryExecutionId = startResult.QueryExecutionId;
  if (!queryExecutionId) return errorResponse(-32001, 'Failed to start query execution');

  let state: string | undefined;
  for (let i = 0; i < ATHENA_MAX_POLL; i++) {
    const execResult = await athena.send(new GetQueryExecutionCommand({ QueryExecutionId: queryExecutionId }));
    state = execResult.QueryExecution?.Status?.State;
    if (state === 'SUCCEEDED') break;
    if (state === 'FAILED' || state === 'CANCELLED') {
      return errorResponse(
        -32001,
        `Query ${state}: ${execResult.QueryExecution?.Status?.StateChangeReason ?? 'Unknown error'}`,
      );
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  if (state !== 'SUCCEEDED') return errorResponse(-32001, 'Query execution timed out');

  const resultsResponse = await athena.send(new GetQueryResultsCommand({ QueryExecutionId: queryExecutionId }));
  const rows = resultsResponse.ResultSet?.Rows ?? [];
  const columns = rows[0]?.Data?.map((d) => d.VarCharValue ?? '') ?? [];
  const dataRows = rows.slice(1).map((row) => {
    const obj: Record<string, string> = {};
    row.Data?.forEach((d, i) => {
      obj[columns[i]] = d.VarCharValue ?? '';
    });
    return obj;
  });

  return successResponse(JSON.stringify({ columns, rows: dataRows }));
}

// --- s3_read / s3_list ---

interface S3Event {
  path?: string;
}

function parseS3Uri(uri: string): { bucket: string; key: string } | null {
  const match = uri.match(/^s3:\/\/([^/]+)\/(.+)$/);
  return match ? { bucket: match[1], key: match[2] } : null;
}

async function resolveS3Access(event: S3Event, context: Context) {
  const rawPath = event.path;
  if (!rawPath) throw new Error('Missing required parameter: path');

  const { projectId, idcAccessToken } = extractDataAccessContext(context);
  const domainId = getDomainId();

  const envs = await resolveProjectEnvironments(domainId, projectId, REGION);
  const creds = await getCachedProjectCredentials(domainId, envs.toolingEnvironmentId, idcAccessToken);
  const projectCreds = {
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    sessionToken: creds.sessionToken,
  };

  const directS3Uri = parseS3Uri(rawPath);
  let s3Uri: { bucket: string; key: string };
  let accessMethod: 'direct' | 's3-access-grants';
  let accountId: string;

  if (directS3Uri) {
    s3Uri = directS3Uri;
    accessMethod = 's3-access-grants';
    accountId = (await getEnvironmentInfo(domainId, envs.toolingEnvironmentId, REGION)).awsAccountId;
  } else {
    const connInfo = await resolveS3Connection(domainId, projectId, rawPath, projectCreds);
    const parsed = parseS3Uri(connInfo.s3Uri);
    if (!parsed) throw new Error(`Invalid resolved S3 URI: ${connInfo.s3Uri}`);
    s3Uri = parsed;
    accessMethod = connInfo.accessMethod;
    accountId = connInfo.accountId;
  }

  let s3Client: S3Client;
  if (accessMethod === 's3-access-grants') {
    const s3Control = new S3ControlClient({ region: REGION, credentials: projectCreds });
    // S3 Access Grantsはプレフィックスベースのスコープ。個別ファイルパスではなくプレフィックス/*で取得する。
    // SubPrefix `*` を指定するとGrantScopeが `s3://bucket/**` になりマッチ失敗するため、具体的なプレフィックスを使う
    const keyParts = s3Uri.key.split('/');
    const prefix = s3Uri.key.endsWith('/') ? s3Uri.key : keyParts.slice(0, -1).join('/') + '/';
    const target = `s3://${s3Uri.bucket}/${prefix}*`;
    const dataAccessResponse = await s3Control.send(
      new GetDataAccessCommand({ AccountId: accountId, Target: target, Permission: 'READ' }),
    );
    const dataCreds = dataAccessResponse.Credentials;
    if (!dataCreds?.AccessKeyId || !dataCreds?.SecretAccessKey || !dataCreds?.SessionToken)
      throw new Error('Failed to get data access credentials');
    s3Client = new S3Client({
      region: REGION,
      credentials: {
        accessKeyId: dataCreds.AccessKeyId,
        secretAccessKey: dataCreds.SecretAccessKey,
        sessionToken: dataCreds.SessionToken,
      },
    });
  } else {
    s3Client = new S3Client({ region: REGION, credentials: projectCreds });
  }

  return { s3Client, s3Uri };
}

async function handleS3Read(event: S3Event, context: Context): Promise<ToolResponse> {
  const { s3Client, s3Uri } = await resolveS3Access(event, context);
  const response = await s3Client.send(new GetObjectCommand({ Bucket: s3Uri.bucket, Key: s3Uri.key }));
  const content = await response.Body?.transformToString('utf-8');
  if (!content) return errorResponse(-32001, 'Failed to read file content');
  return successResponse(content);
}

async function handleS3List(event: S3Event, context: Context): Promise<ToolResponse> {
  const { s3Client, s3Uri } = await resolveS3Access(event, context);
  const prefix = s3Uri.key.endsWith('/') ? s3Uri.key : `${s3Uri.key}/`;
  const listRes = await s3Client.send(new ListObjectsV2Command({ Bucket: s3Uri.bucket, Prefix: prefix, MaxKeys: 100 }));
  const files = (listRes.Contents ?? []).map((obj) => `s3://${s3Uri.bucket}/${obj.Key}`).filter(Boolean);
  return successResponse(JSON.stringify(files));
}

// --- Router ---

export async function handler(event: Record<string, unknown>, context: Context): Promise<ToolResponse> {
  try {
    const toolName = getToolName(context);
    if (toolName === 's3_read') return await handleS3Read(event as S3Event, context);
    if (toolName === 's3_list') return await handleS3List(event as S3Event, context);
    return await handleAthenaQuery(event as AthenaQueryEvent, context);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const name = err instanceof Error ? err.name : 'UnknownError';
    console.error('data-access error:', name, message, err instanceof Error ? err.stack : undefined);
    return errorResponse(-32001, `${name}: ${message}`);
  }
}
