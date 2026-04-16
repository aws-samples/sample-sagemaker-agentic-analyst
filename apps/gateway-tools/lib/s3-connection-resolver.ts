/**
 * DataZone S3コネクション情報を取得し、リクエストされたパスに対するアクセス方式を判断するモジュール。
 *
 * accessRole + s3AccessGrantLocationId の両方があれば S3 Access Grants 経由、
 * なければプロジェクトロールで直接アクセス。
 *
 * Subscriberプロジェクトでは外部バケットのコネクションがプロジェクトレベルに含まれないため、
 * ドメイン内の全プロジェクトのS3コネクションを取得してパス解決に使用する。
 */

import {
  DataZoneClient,
  ListConnectionsCommand,
  ListProjectsCommand,
  type ConnectionSummary,
} from '@aws-sdk/client-datazone';

import { env } from './env';

export type S3AccessMethod = 'direct' | 's3-access-grants';

interface S3ConnectionInfo {
  s3Uri: string;
  accessMethod: S3AccessMethod;
  accountId: string;
}

interface CachedConnections {
  connections: ResolvedConnection[];
  expiresAt: number;
}

interface ResolvedConnection {
  s3Uri: string;
  accessMethod: S3AccessMethod;
  accountId: string;
}

const projectCache = new Map<string, CachedConnections>();
const domainCache = new Map<string, CachedConnections>();
const CACHE_TTL_MS = 10 * 60 * 1000;

let dzClient: DataZoneClient | undefined;

function getClient(credentials?: {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
}): DataZoneClient {
  if (credentials) {
    return new DataZoneClient({ region: env.AWS_REGION, credentials });
  }
  if (!dzClient) {
    dzClient = new DataZoneClient({ region: env.AWS_REGION });
  }
  return dzClient;
}

function resolveConnection(conn: ConnectionSummary): ResolvedConnection | null {
  const s3Props = conn.props?.s3Properties;
  if (!s3Props?.s3Uri) return null;

  const awsLocation = conn.physicalEndpoints?.[0]?.awsLocation;
  const hasAccessGrants = !!awsLocation?.accessRole;

  return {
    s3Uri: s3Props.s3Uri,
    accessMethod: hasAccessGrants ? 's3-access-grants' : 'direct',
    accountId: awsLocation?.awsAccountId ?? '',
  };
}

async function listS3Connections(
  domainId: string,
  projectId: string,
  credentials?: { accessKeyId: string; secretAccessKey: string; sessionToken: string },
): Promise<ResolvedConnection[]> {
  const connections: ResolvedConnection[] = [];
  const seen = new Set<string>();
  let nextToken: string | undefined;

  do {
    const response = await getClient(credentials).send(
      new ListConnectionsCommand({
        domainIdentifier: domainId,
        projectIdentifier: projectId,
        type: 'S3',
        nextToken,
      }),
    );
    for (const item of response.items ?? []) {
      const resolved = resolveConnection(item);
      if (resolved && !seen.has(resolved.s3Uri)) {
        seen.add(resolved.s3Uri);
        connections.push(resolved);
      }
    }
    nextToken = response.nextToken;
  } while (nextToken);

  return connections;
}

/** プロジェクトレベルのコネクション取得（キャッシュ付き） */
async function fetchProjectConnections(
  domainId: string,
  projectId: string,
  credentials?: { accessKeyId: string; secretAccessKey: string; sessionToken: string },
): Promise<ResolvedConnection[]> {
  const cached = projectCache.get(projectId);
  if (cached && cached.expiresAt > Date.now()) return cached.connections;

  const connections = await listS3Connections(domainId, projectId, credentials);
  projectCache.set(projectId, { connections, expiresAt: Date.now() + CACHE_TTL_MS });
  return connections;
}

/**
 * ドメイン内の全プロジェクトのS3コネクションを取得（キャッシュ付き）。
 * Subscriberプロジェクトでは外部バケットのコネクションがプロジェクトレベルに含まれないため、
 * 全プロジェクトを横断して検索する。
 */
async function fetchDomainConnections(
  domainId: string,
  credentials?: { accessKeyId: string; secretAccessKey: string; sessionToken: string },
): Promise<ResolvedConnection[]> {
  const cached = domainCache.get(domainId);
  if (cached && cached.expiresAt > Date.now()) return cached.connections;

  const client = getClient(credentials);
  const projectIds: string[] = [];
  let nextToken: string | undefined;

  do {
    const response = await client.send(new ListProjectsCommand({ domainIdentifier: domainId, nextToken }));
    for (const p of response.items ?? []) {
      if (p.id) projectIds.push(p.id);
    }
    nextToken = response.nextToken;
  } while (nextToken);

  const seen = new Set<string>();
  const connections: ResolvedConnection[] = [];

  for (const pid of projectIds) {
    const conns = await listS3Connections(domainId, pid, credentials);
    for (const c of conns) {
      if (!seen.has(c.s3Uri)) {
        seen.add(c.s3Uri);
        connections.push(c);
      }
    }
  }

  domainCache.set(domainId, { connections, expiresAt: Date.now() + CACHE_TTL_MS });
  return connections;
}

function matchConnection(connections: ResolvedConnection[], requestedPath: string): S3ConnectionInfo | null {
  // 完全な s3:// URI: プレフィックスマッチ
  if (requestedPath.startsWith('s3://')) {
    const match = connections.find((c) => requestedPath.startsWith(c.s3Uri.replace(/\/$/, '')));
    if (!match) return null;
    return { s3Uri: requestedPath, accessMethod: match.accessMethod, accountId: match.accountId };
  }

  // 相対パス: コネクションの s3Uri プレフィックスで最長一致
  const normalizedPath = requestedPath.replace(/^\//, '');

  for (const conn of connections) {
    const baseUri = conn.s3Uri.replace(/\/$/, '');
    const parsed = baseUri.match(/^s3:\/\/[^/]+(\/.*)?$/);
    if (parsed?.[1]) {
      const prefix = parsed[1].replace(/^\//, '');
      if (normalizedPath.startsWith(prefix)) {
        return {
          s3Uri: `s3://${baseUri.replace('s3://', '').split('/')[0]}/${normalizedPath}`,
          accessMethod: conn.accessMethod,
          accountId: conn.accountId,
        };
      }
    }
  }

  return null;
}

export async function resolveS3Connection(
  domainId: string,
  projectId: string,
  requestedPath: string,
  credentials?: { accessKeyId: string; secretAccessKey: string; sessionToken: string },
): Promise<S3ConnectionInfo> {
  // 1. プロジェクトレベルのコネクションで解決を試みる
  const projectConns = await fetchProjectConnections(domainId, projectId, credentials);
  const projectMatch = matchConnection(projectConns, requestedPath);
  if (projectMatch) return projectMatch;

  // 2. ドメイン内の全プロジェクトのコネクションで解決を試みる
  //    （Subscriberプロジェクトでは外部バケットのコネクションがプロジェクトレベルに含まれないため）
  //    ドメインレベルで解決した場合、Subscriberロールには直接アクセス権限がないため
  //    S3 Access Grants経由を強制する
  const domainConns = await fetchDomainConnections(domainId, credentials);
  const domainMatch = matchConnection(domainConns, requestedPath);
  if (domainMatch) return { ...domainMatch, accessMethod: 's3-access-grants' };

  // 3. フォールバック: 相対パスを最初のコネクションのバケットに結合
  const allConns = [...projectConns, ...domainConns];
  if (allConns.length > 0 && !requestedPath.startsWith('s3://')) {
    const first = allConns[0];
    const bucket = first.s3Uri.replace('s3://', '').split('/')[0];
    return {
      s3Uri: `s3://${bucket}/${requestedPath.replace(/^\//, '')}`,
      accessMethod: first.accessMethod,
      accountId: first.accountId,
    };
  }

  throw new Error(`No S3 connections found for project: ${projectId}`);
}

export function clearCache(): void {
  projectCache.clear();
  domainCache.clear();
}
