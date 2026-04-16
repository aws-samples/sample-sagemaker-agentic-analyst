/**
 * data-catalog Tool Lambda（catalog + subscription 統合）
 *
 * Gateway Lambda Targetとして呼び出される。
 * context.clientContext.custom.bedrockAgentCoreToolName でツールをルーティング。
 *
 * catalog_search / catalog_detail: Lambda実行ロールの権限で動作（読み取り専用）
 * subscription_*: RedeemAccessTokenフローでDER認証情報を取得し、
 *   ユーザーのIdCアイデンティティでDataZone APIを呼ぶ（data-access-control.md Step 1-2）
 */

import {
  DataZoneClient,
  SearchListingsCommand,
  ListSubscriptionsCommand,
  GetListingCommand,
  CreateSubscriptionRequestCommand,
  ListSubscriptionRequestsCommand,
  AcceptSubscriptionRequestCommand,
  RejectSubscriptionRequestCommand,
  ListAssetFiltersCommand,
  CancelSubscriptionCommand,
  RevokeSubscriptionCommand,
  type SubscriptionRequestStatus,
} from '@aws-sdk/client-datazone';
import { redeemAndGetDomainCredentials } from '@agentic-analyst/datazone-auth';
import type { Context } from 'aws-lambda';
import {
  type ToolResponse,
  getToolName,
  getProjectIdFromHeaders,
  getIdcAccessTokenFromHeaders,
  successResponse,
  errorResponse,
} from '../lib/types';
import { env } from '../lib/env';

// --- 共通 ---

const REGION = env.AWS_REGION;

/** Lambda実行ロールで動作するクライアント（catalog_search / catalog_detail用） */
let dzClient: DataZoneClient | undefined;
function getClient(): DataZoneClient {
  return (dzClient ??= new DataZoneClient({ region: REGION }));
}

/**
 * DER認証情報キャッシュ（不要なRedeemAccessToken呼び出しを回避）
 * RedeemAccessTokenはjti制約なし。同一IdC Access Tokenで複数回呼び出し可能。
 */
let credsCache: {
  key: string;
  creds: Awaited<ReturnType<typeof redeemAndGetDomainCredentials>>;
  expiresAt: number;
} | null = null;

async function getCachedDomainCredentials(domainId: string, idcAccessToken: string) {
  const key = `der:${idcAccessToken.slice(-16)}`;
  const now = Date.now();
  if (credsCache && credsCache.key === key && credsCache.expiresAt > now + 60_000) {
    return credsCache.creds;
  }
  const creds = await redeemAndGetDomainCredentials(domainId, idcAccessToken, REGION);
  credsCache = { key, creds, expiresAt: creds.expiration ? creds.expiration.getTime() : now + 14 * 60_000 };
  return creds;
}

/** DER認証情報で初期化したDataZoneClientを返す */
async function getUserClient(context: Context): Promise<{ client: DataZoneClient; projectId: string }> {
  const projectId = getProjectIdFromHeaders(context);
  const idcAccessToken = getIdcAccessTokenFromHeaders(context);
  if (!projectId || !idcAccessToken) {
    throw new Error('Missing required headers: x-sagemaker-project-id and x-idc-access-token');
  }

  const domainId = env.DATAZONE_DOMAIN_ID!;
  const creds = await getCachedDomainCredentials(domainId, idcAccessToken);
  const client = new DataZoneClient({
    region: REGION,
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken: creds.sessionToken,
    },
  });
  return { client, projectId };
}

// --- catalog_search ---

interface CatalogSearchEvent {
  query?: string;
  entityType?: string;
  subscribedOnly?: boolean;
}

interface CatalogResult {
  name: string;
  type: string;
  listingId: string;
  listingRevision: string;
  owningProjectId: string;
  description?: string;
  subscribed: boolean;
  subscriptionId?: string;
  s3Uri?: string;
}

// SearchListings APIのfiltersパラメータはentityTypeフィルタに非対応。クライアント側で除外する
const EXCLUDED_ENTITY_TYPES = new Set(['BedrockModelAssetType', 'BedrockInferenceOnlyAssetType']);
const S3_ASSET_TYPE = 'S3ObjectCollectionAssetType';

/** S3ObjectCollectionFormからS3 URIを抽出する（末尾スラッシュ正規化済み） */
function extractS3Uri(formsRaw: unknown): string | undefined {
  if (!formsRaw) return undefined;
  try {
    const forms: Record<string, unknown> = typeof formsRaw === 'string' ? JSON.parse(formsRaw) : formsRaw;
    const s3Raw = forms['S3ObjectCollectionForm'];
    if (!s3Raw) return undefined;
    const s3Form: Record<string, unknown> = typeof s3Raw === 'string' ? JSON.parse(s3Raw) : s3Raw;
    const arnMatch = (s3Form.bucketArn as string)?.match(/^arn:aws:s3:::(.+)$/);
    if (arnMatch) return `s3://${arnMatch[1]}`.replace(/\/+$/, '');
  } catch {
    // formsのパースに失敗した場合はundefinedを返す
  }
  return undefined;
}

function dedupeS3Assets(items: CatalogResult[]): CatalogResult[] {
  const s3Items = items.filter((r) => r.type === S3_ASSET_TYPE);
  const others = items.filter((r) => r.type !== S3_ASSET_TYPE);

  const deduped = new Map<string, CatalogResult>();
  for (const item of s3Items) {
    // S3 URIで同一ロケーションを識別。S3 URIが取れない場合はlistingIdをそのままキーにする（dedupeしない）
    const key = item.s3Uri ?? item.listingId;
    const existing = deduped.get(key);
    if (!existing || (!existing.subscribed && item.subscribed)) {
      deduped.set(key, existing ? { ...item, subscribed: existing.subscribed || item.subscribed } : item);
    } else if (item.subscribed) {
      deduped.set(key, { ...existing, subscribed: true });
    }
  }

  return [...others, ...deduped.values()];
}

async function handleCatalogSearch(event: CatalogSearchEvent, context: Context): Promise<ToolResponse> {
  const query = event.query;
  if (!query?.trim()) return errorResponse(-32602, 'Missing required parameter: query');
  const entityTypeFilter = event.entityType;
  const subscribedOnly = event.subscribedOnly ?? false;
  const projectId = getProjectIdFromHeaders(context);

  if (!projectId) return errorResponse(-32001, 'Missing x-sagemaker-project-id in propagated headers');

  const domainId = env.DATAZONE_DOMAIN_ID!;
  const client = getClient();

  const [searchRes, subsRes] = await Promise.all([
    client.send(new SearchListingsCommand({ domainIdentifier: domainId, searchText: query, maxResults: 50 })),
    client.send(
      new ListSubscriptionsCommand({
        domainIdentifier: domainId,
        owningProjectId: projectId,
        status: 'APPROVED',
        maxResults: 50,
      }),
    ),
  ]);

  const subscribedListingMap = new Map<string, string>();
  const subscribedS3UriMap = new Map<string, string>();
  for (const sub of subsRes.items ?? []) {
    if (sub.subscribedListing?.id && sub.id) {
      subscribedListingMap.set(sub.subscribedListing.id, sub.id);
      // S3アセット: forms から S3 URI を抽出し、S3 URIベースでもマッチできるようにする
      const assetListing = sub.subscribedListing.item?.assetListing;
      if (assetListing?.entityType === S3_ASSET_TYPE) {
        const s3Uri = extractS3Uri(assetListing.forms);
        if (s3Uri) subscribedS3UriMap.set(s3Uri, sub.id);
      }
    }
  }

  const raw: CatalogResult[] = [];
  for (const item of searchRes.items ?? []) {
    const listing = item.assetListing;
    if (!listing) continue;
    const type = listing.entityType ?? 'Unknown';
    if (entityTypeFilter ? type !== entityTypeFilter : EXCLUDED_ENTITY_TYPES.has(type)) continue;
    const s3Uri = type === S3_ASSET_TYPE ? extractS3Uri(listing.additionalAttributes?.forms) : undefined;
    // listingIdでマッチ → S3 URIでフォールバック（同じS3ロケーションの別listingが購読済みの場合）
    const subscriptionId =
      subscribedListingMap.get(listing.listingId ?? '') ?? (s3Uri && subscribedS3UriMap.get(s3Uri));
    raw.push({
      name: listing.name ?? 'Unknown',
      type,
      listingId: listing.listingId ?? '',
      listingRevision: listing.listingRevision ?? '',
      owningProjectId: listing.owningProjectId ?? 'Unknown',
      description: listing.description,
      subscribed: !!subscriptionId,
      subscriptionId,
      s3Uri,
    });
  }

  const results = dedupeS3Assets(raw);
  if (subscribedOnly) return successResponse(JSON.stringify(results.filter((r) => r.subscribed)));
  return successResponse(JSON.stringify(results));
}

interface ListSubscriptionsEvent {
  entityType?: string;
}

async function handleListSubscriptions(event: ListSubscriptionsEvent, context: Context): Promise<ToolResponse> {
  const projectId = getProjectIdFromHeaders(context);
  if (!projectId) return errorResponse(-32001, 'Missing x-sagemaker-project-id in propagated headers');

  const domainId = env.DATAZONE_DOMAIN_ID!;
  const client = getClient();
  const entityTypeFilter = event.entityType;
  const subsRes = await client.send(
    new ListSubscriptionsCommand({
      domainIdentifier: domainId,
      owningProjectId: projectId,
      status: 'APPROVED',
      maxResults: 50,
    }),
  );

  const results: CatalogResult[] = [];
  for (const sub of subsRes.items ?? []) {
    const listing = sub.subscribedListing;
    if (!listing) continue;
    const type = listing.item?.assetListing?.entityType ?? 'Unknown';
    if (entityTypeFilter ? type !== entityTypeFilter : EXCLUDED_ENTITY_TYPES.has(type)) continue;
    results.push({
      name: listing.name ?? 'Unknown',
      type,
      listingId: listing.id ?? '',
      listingRevision: listing.revision ?? '',
      owningProjectId: listing.ownerProjectId ?? 'Unknown',
      description: listing.description,
      subscribed: true,
      subscriptionId: sub.id,
    });
  }

  return successResponse(JSON.stringify(dedupeS3Assets(results)));
}

// --- catalog_detail ---

interface CatalogDetailEvent {
  listingId?: string;
  listingRevision?: string;
}

interface GlueTableColumn {
  columnName: string;
  dataType: string;
}
interface GlueTableForm {
  tableName?: string;
  databaseName?: string;
  columns?: GlueTableColumn[];
}

async function handleCatalogDetail(event: CatalogDetailEvent): Promise<ToolResponse> {
  const listingId = event.listingId;
  if (!listingId) return errorResponse(-32602, 'Missing required parameter: listingId');

  const domainId = env.DATAZONE_DOMAIN_ID!;
  const client = getClient();
  const res = await client.send(
    new GetListingCommand({
      domainIdentifier: domainId,
      identifier: listingId,
      ...(event.listingRevision && { listingRevision: event.listingRevision }),
    }),
  );

  const formsRaw = (res.item as any)?.assetListing?.forms;
  if (!formsRaw) return successResponse(JSON.stringify({ error: 'No forms found in listing' }));

  // GetListing APIのformsはドキュメント上「JSON文字列」だが、パース済みオブジェクトで返る場合がある
  const forms: Record<string, string> = typeof formsRaw === 'string' ? JSON.parse(formsRaw) : formsRaw;
  const glueTableRaw = forms['GlueTableForm'];
  const s3CollectionRaw = forms['S3ObjectCollectionForm'];

  if (glueTableRaw) {
    const glueTable: GlueTableForm = typeof glueTableRaw === 'string' ? JSON.parse(glueTableRaw) : glueTableRaw;
    return successResponse(
      JSON.stringify({
        tableName: glueTable.tableName,
        databaseName: glueTable.databaseName,
        columns: glueTable.columns?.map((c) => ({ columnName: c.columnName, dataType: c.dataType })) ?? [],
      }),
    );
  }

  if (s3CollectionRaw) {
    const s3Form = typeof s3CollectionRaw === 'string' ? JSON.parse(s3CollectionRaw) : s3CollectionRaw;
    const arnMatch = (s3Form.bucketArn as string)?.match(/^arn:aws:s3:::(.+)$/);
    return successResponse(
      JSON.stringify({
        bucketName: s3Form.bucketName,
        s3Uri: arnMatch ? `s3://${arnMatch[1]}` : undefined,
        region: s3Form.region,
      }),
    );
  }

  return successResponse(JSON.stringify({ availableForms: Object.keys(forms) }));
}

// --- subscription_request ---

interface SubscriptionRequestEvent {
  listingId: string;
  requestReason: string;
}

async function handleSubscriptionRequest(event: SubscriptionRequestEvent, context: Context): Promise<ToolResponse> {
  if (!event.listingId) return errorResponse(-32602, 'Missing required parameter: listingId');

  const { client, projectId } = await getUserClient(context);
  const domainId = env.DATAZONE_DOMAIN_ID!;

  const res = await client.send(
    new CreateSubscriptionRequestCommand({
      domainIdentifier: domainId,
      subscribedPrincipals: [{ project: { identifier: projectId } }],
      subscribedListings: [{ identifier: event.listingId }],
      requestReason: event.requestReason || 'Requested via AI agent',
    }),
  );

  return successResponse(
    JSON.stringify({
      requestId: res.id,
      status: res.status,
      subscribedListings: res.subscribedListings?.map((l) => ({
        name: l.name,
        id: l.id,
        revision: l.revision,
        entityId: l.item?.assetListing?.entityId,
        entityRevision: l.item?.assetListing?.entityRevision,
      })),
    }),
  );
}

// --- subscription_list_requests ---

interface ListRequestsEvent {
  status?: string;
}

async function handleListRequests(event: ListRequestsEvent, context: Context): Promise<ToolResponse> {
  const { client, projectId } = await getUserClient(context);
  const domainId = env.DATAZONE_DOMAIN_ID!;

  const res = await client.send(
    new ListSubscriptionRequestsCommand({
      domainIdentifier: domainId,
      approverProjectId: projectId,
      status: (event.status ?? 'PENDING') as SubscriptionRequestStatus,
      maxResults: 50,
    }),
  );

  const requests = (res.items ?? []).map((item) => ({
    requestId: item.id,
    status: item.status,
    requestReason: item.requestReason,
    createdAt: item.createdAt?.toISOString(),
    requesterProjectId: item.subscribedPrincipals?.[0]?.project?.id,
    subscribedListings: item.subscribedListings?.map((l) => ({
      name: l.name,
      id: l.id,
      entityId: l.item?.assetListing?.entityId,
      entityRevision: l.item?.assetListing?.entityRevision,
    })),
  }));

  return successResponse(JSON.stringify(requests));
}

// --- subscription_approve ---

interface ApproveEvent {
  requestId: string;
  decisionComment?: string;
  assetId?: string;
  filterIds?: string[];
}

async function handleApprove(event: ApproveEvent, context: Context): Promise<ToolResponse> {
  if (!event.requestId) return errorResponse(-32602, 'Missing required parameter: requestId');

  const { client } = await getUserClient(context);
  const domainId = env.DATAZONE_DOMAIN_ID!;

  const params: Record<string, unknown> = {
    domainIdentifier: domainId,
    identifier: event.requestId,
    ...(event.decisionComment && { decisionComment: event.decisionComment }),
  };

  if (event.assetId && event.filterIds?.length) {
    params.assetScopes = [{ assetId: event.assetId, filterIds: event.filterIds }];
  }

  const res = await client.send(new AcceptSubscriptionRequestCommand(params as any));
  return successResponse(
    JSON.stringify({ requestId: res.id, status: res.status, decisionComment: res.decisionComment }),
  );
}

// --- subscription_reject ---

interface RejectEvent {
  requestId: string;
  decisionComment?: string;
}

async function handleReject(event: RejectEvent, context: Context): Promise<ToolResponse> {
  if (!event.requestId) return errorResponse(-32602, 'Missing required parameter: requestId');

  const { client } = await getUserClient(context);
  const domainId = env.DATAZONE_DOMAIN_ID!;

  const res = await client.send(
    new RejectSubscriptionRequestCommand({
      domainIdentifier: domainId,
      identifier: event.requestId,
      ...(event.decisionComment && { decisionComment: event.decisionComment }),
    }),
  );

  return successResponse(JSON.stringify({ requestId: res.id, status: res.status }));
}

// --- subscription_list_filters ---

interface ListFiltersEvent {
  assetId: string;
}

async function handleListFilters(event: ListFiltersEvent, context: Context): Promise<ToolResponse> {
  if (!event.assetId) return errorResponse(-32602, 'Missing required parameter: assetId');

  const { client } = await getUserClient(context);
  const domainId = env.DATAZONE_DOMAIN_ID!;

  const res = await client.send(
    new ListAssetFiltersCommand({ domainIdentifier: domainId, assetIdentifier: event.assetId, maxResults: 50 }),
  );

  const filters = (res.items ?? []).map((f) => ({
    filterId: f.id,
    name: f.name,
    description: f.description,
    effectiveColumnNames: f.effectiveColumnNames,
    effectiveRowFilter: f.effectiveRowFilter,
    status: f.status,
  }));

  return successResponse(JSON.stringify(filters));
}

// --- subscription_cancel ---

interface CancelEvent {
  subscriptionId: string;
}

async function handleCancel(event: CancelEvent, context: Context): Promise<ToolResponse> {
  if (!event.subscriptionId) return errorResponse(-32602, 'Missing required parameter: subscriptionId');

  const { client } = await getUserClient(context);
  const domainId = env.DATAZONE_DOMAIN_ID!;

  const res = await client.send(
    new CancelSubscriptionCommand({ domainIdentifier: domainId, identifier: event.subscriptionId }),
  );

  return successResponse(JSON.stringify({ subscriptionId: res.id, status: res.status }));
}

// --- subscription_revoke ---

interface RevokeEvent {
  subscriptionId: string;
  retainPermissions?: boolean;
}

async function handleRevoke(event: RevokeEvent, context: Context): Promise<ToolResponse> {
  if (!event.subscriptionId) return errorResponse(-32602, 'Missing required parameter: subscriptionId');

  const { client } = await getUserClient(context);
  const domainId = env.DATAZONE_DOMAIN_ID!;

  const res = await client.send(
    new RevokeSubscriptionCommand({
      domainIdentifier: domainId,
      identifier: event.subscriptionId,
      retainPermissions: event.retainPermissions ?? false,
    }),
  );

  return successResponse(JSON.stringify({ subscriptionId: res.id, status: res.status }));
}

// --- Router ---

export async function handler(event: Record<string, unknown>, context: Context): Promise<ToolResponse> {
  try {
    const toolName = getToolName(context);
    switch (toolName) {
      case 'catalog_detail':
        return await handleCatalogDetail(event as CatalogDetailEvent);
      case 'catalog_list_subscriptions':
        return await handleListSubscriptions(event as ListSubscriptionsEvent, context);
      case 'subscription_request':
        return await handleSubscriptionRequest(event as unknown as SubscriptionRequestEvent, context);
      case 'subscription_list_requests':
        return await handleListRequests(event as unknown as ListRequestsEvent, context);
      case 'subscription_approve':
        return await handleApprove(event as unknown as ApproveEvent, context);
      case 'subscription_reject':
        return await handleReject(event as unknown as RejectEvent, context);
      case 'subscription_list_filters':
        return await handleListFilters(event as unknown as ListFiltersEvent, context);
      case 'subscription_cancel':
        return await handleCancel(event as unknown as CancelEvent, context);
      case 'subscription_revoke':
        return await handleRevoke(event as unknown as RevokeEvent, context);
      default:
        return await handleCatalogSearch(event as CatalogSearchEvent, context);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const name = err instanceof Error ? err.name : 'UnknownError';
    const metadata = (err as any)?.$metadata;
    console.error('data-catalog error:', name, message, metadata ? JSON.stringify(metadata) : '');
    return errorResponse(-32001, `${name}: ${message}`);
  }
}
