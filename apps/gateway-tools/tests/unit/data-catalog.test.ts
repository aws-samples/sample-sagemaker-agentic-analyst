import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSend = vi.fn();
vi.mock('@aws-sdk/client-datazone', () => ({
  DataZoneClient: vi.fn(() => ({ send: mockSend })),
  SearchListingsCommand: vi.fn((input: unknown) => ({ _type: 'SearchListings', input })),
  ListSubscriptionsCommand: vi.fn((input: unknown) => ({ _type: 'ListSubscriptions', input })),
  GetListingCommand: vi.fn((input: unknown) => ({ _type: 'GetListing', input })),
  CreateSubscriptionRequestCommand: vi.fn((input: unknown) => ({ _type: 'CreateSubscriptionRequest', input })),
  ListSubscriptionRequestsCommand: vi.fn((input: unknown) => ({ _type: 'ListSubscriptionRequests', input })),
  AcceptSubscriptionRequestCommand: vi.fn((input: unknown) => ({ _type: 'AcceptSubscriptionRequest', input })),
  RejectSubscriptionRequestCommand: vi.fn((input: unknown) => ({ _type: 'RejectSubscriptionRequest', input })),
  ListAssetFiltersCommand: vi.fn((input: unknown) => ({ _type: 'ListAssetFilters', input })),
  CancelSubscriptionCommand: vi.fn((input: unknown) => ({ _type: 'CancelSubscription', input })),
  RevokeSubscriptionCommand: vi.fn((input: unknown) => ({ _type: 'RevokeSubscription', input })),
}));

vi.mock('../../lib/env', () => ({
  env: {
    AWS_REGION: 'ap-northeast-1',
    DATAZONE_DOMAIN_ID: 'dzd-test',
    IDC_APPLICATION_ARN: 'arn:aws:sso::123:application/test',
  },
}));

vi.mock('@agentic-analyst/datazone-auth', () => ({
  redeemAndGetDomainCredentials: vi.fn().mockResolvedValue({
    accessKeyId: 'AKIA-DER',
    secretAccessKey: 'secret-der',
    sessionToken: 'token-der',
    expiration: new Date(Date.now() + 3600_000),
  }),
}));

import { handler } from '../../data-catalog/index';

function ctx(toolName: string, opts?: { projectId?: string; idcAccessToken?: string }) {
  const headers: Record<string, string> = {};
  if (opts?.projectId) headers['x-sagemaker-project-id'] = opts.projectId;
  if (opts?.idcAccessToken) headers['x-idc-access-token'] = opts.idcAccessToken;
  return {
    clientContext: {
      custom: {
        bedrockAgentCoreToolName: `data-catalog___${toolName}`,
        ...(Object.keys(headers).length && {
          bedrockAgentCorePropagatedHeaders: JSON.stringify(headers),
        }),
      },
    },
  } as never;
}

/** subscription_*ツール用のcontext（projectId + idcAccessToken両方必要） */
function subCtx(toolName: string, projectId = 'proj-1') {
  return ctx(toolName, { projectId, idcAccessToken: 'mock-idc-access-token' });
}

beforeEach(() => {
  mockSend.mockReset();
});

describe('catalog_search', () => {
  it('検索結果にSubscribe状況とlistingId/listingRevisionを正しく付加する', async () => {
    mockSend
      .mockResolvedValueOnce({
        items: [
          {
            assetListing: {
              name: 'store_details',
              entityType: 'GlueTableAssetType',
              owningProjectId: 'proj-owner',
              listingId: 'listing-1',
              listingRevision: 'rev-1',
              description: '店舗マスタ',
            },
          },
          {
            assetListing: {
              name: 'sales_rep_performance',
              entityType: 'GlueTableAssetType',
              owningProjectId: 'proj-owner',
              listingId: 'listing-2',
              listingRevision: 'rev-2',
              description: '営業成績',
            },
          },
        ],
      })
      .mockResolvedValueOnce({ items: [{ id: 'sub-001', subscribedListing: { id: 'listing-1' } }] });

    const result = await handler({ query: 'sales' }, ctx('catalog_search', { projectId: 'proj-consumer' }));
    const content = JSON.parse(result.result!.content[0].text);
    expect(content).toHaveLength(2);
    expect(content[0]).toMatchObject({
      name: 'store_details',
      listingId: 'listing-1',
      subscribed: true,
      subscriptionId: 'sub-001',
    });
    expect(content[1]).toMatchObject({ name: 'sales_rep_performance', listingId: 'listing-2', subscribed: false });
  });

  it('Bedrockモデルをデフォルトで除外する', async () => {
    mockSend
      .mockResolvedValueOnce({
        items: [
          {
            assetListing: {
              name: 'store_details',
              entityType: 'GlueTableAssetType',
              owningProjectId: 'proj-owner',
              listingId: 'listing-1',
              listingRevision: 'rev-1',
            },
          },
          {
            assetListing: {
              name: 'Claude Sonnet',
              entityType: 'BedrockModelAssetType',
              owningProjectId: 'proj-owner',
              listingId: 'listing-bedrock',
              listingRevision: 'rev-b',
            },
          },
          {
            assetListing: {
              name: 'Claude Haiku',
              entityType: 'BedrockInferenceOnlyAssetType',
              owningProjectId: 'proj-owner',
              listingId: 'listing-bedrock2',
              listingRevision: 'rev-b2',
            },
          },
        ],
      })
      .mockResolvedValueOnce({ items: [] });

    const result = await handler({ query: 'test' }, ctx('catalog_search', { projectId: 'proj-1' }));
    const content = JSON.parse(result.result!.content[0].text);
    expect(content).toHaveLength(1);
    expect(content[0].name).toBe('store_details');
  });

  it('entityTypeフィルタで特定タイプのみ返す', async () => {
    mockSend
      .mockResolvedValueOnce({
        items: [
          {
            assetListing: {
              name: 'store_details',
              entityType: 'GlueTableAssetType',
              owningProjectId: 'proj-owner',
              listingId: 'listing-1',
              listingRevision: 'rev-1',
            },
          },
          {
            assetListing: {
              name: 'public_docs',
              entityType: 'S3ObjectCollectionAssetType',
              owningProjectId: 'proj-owner',
              listingId: 'listing-s3',
              listingRevision: 'rev-s3',
            },
          },
        ],
      })
      .mockResolvedValueOnce({ items: [] });

    const result = await handler(
      { query: 'test', entityType: 'S3ObjectCollectionAssetType' },
      ctx('catalog_search', { projectId: 'proj-1' }),
    );
    const content = JSON.parse(result.result!.content[0].text);
    expect(content).toHaveLength(1);
    expect(content[0].name).toBe('public_docs');
  });

  it('同一S3 URIの重複アセットをdedupeする', async () => {
    mockSend
      .mockResolvedValueOnce({
        items: [
          {
            assetListing: {
              name: 'public/',
              entityType: 'S3ObjectCollectionAssetType',
              owningProjectId: 'proj-owner',
              listingId: 'listing-s3-1',
              listingRevision: 'rev-1',
              additionalAttributes: {
                forms: JSON.stringify({
                  S3ObjectCollectionForm: JSON.stringify({ bucketArn: 'arn:aws:s3:::my-bucket/public/' }),
                }),
              },
            },
          },
          {
            assetListing: {
              name: 'public',
              entityType: 'S3ObjectCollectionAssetType',
              owningProjectId: 'proj-owner',
              listingId: 'listing-s3-2',
              listingRevision: 'rev-2',
              additionalAttributes: {
                forms: JSON.stringify({
                  S3ObjectCollectionForm: JSON.stringify({ bucketArn: 'arn:aws:s3:::my-bucket/public' }),
                }),
              },
            },
          },
        ],
      })
      .mockResolvedValueOnce({ items: [{ id: 'sub-s3', subscribedListing: { id: 'listing-s3-1' } }] });

    const result = await handler({ query: 'public' }, ctx('catalog_search', { projectId: 'proj-consumer' }));
    const content = JSON.parse(result.result!.content[0].text);
    expect(content).toHaveLength(1);
    expect(content[0]).toMatchObject({ type: 'S3ObjectCollectionAssetType', subscribed: true });
  });

  it('同一S3 URIで異なるlistingIdでもdedupeでsubscribed=trueになる', async () => {
    // SearchListingsが "public"（listing-B, 未購読）と "public/"（listing-A, 購読済み）を返す
    // listing-Aはsubscribed、listing-Bは未subscribed。同じbucketArnなのでdedupeされる
    mockSend
      .mockResolvedValueOnce({
        items: [
          {
            assetListing: {
              name: 'public',
              entityType: 'S3ObjectCollectionAssetType',
              owningProjectId: 'proj-owner',
              listingId: 'listing-B',
              listingRevision: 'rev-1',
              additionalAttributes: {
                forms: JSON.stringify({
                  S3ObjectCollectionForm: JSON.stringify({ bucketArn: 'arn:aws:s3:::my-bucket/public' }),
                }),
              },
            },
          },
          {
            assetListing: {
              name: 'public/',
              entityType: 'S3ObjectCollectionAssetType',
              owningProjectId: 'proj-owner',
              listingId: 'listing-A',
              listingRevision: 'rev-2',
              additionalAttributes: {
                forms: JSON.stringify({
                  S3ObjectCollectionForm: JSON.stringify({ bucketArn: 'arn:aws:s3:::my-bucket/public/' }),
                }),
              },
            },
          },
        ],
      })
      .mockResolvedValueOnce({ items: [{ id: 'sub-s3', subscribedListing: { id: 'listing-A' } }] });

    const result = await handler({ query: 'public' }, ctx('catalog_search', { projectId: 'proj-consumer' }));
    const content = JSON.parse(result.result!.content[0].text);
    expect(content).toHaveLength(1);
    expect(content[0]).toMatchObject({ subscribed: true, subscriptionId: 'sub-s3' });
  });

  it('SearchListingsにない購読済みS3アセットとS3 URIでマッチする', async () => {
    // SearchListingsが "public"（listing-B）のみ返し、
    // ListSubscriptionsが "public/"（listing-A）を購読済みとして返す。
    // listing-A/listing-BのlistingIdは異なるが、同じS3 URIなのでsubscribed=trueになる
    mockSend
      .mockResolvedValueOnce({
        items: [
          {
            assetListing: {
              name: 'public',
              entityType: 'S3ObjectCollectionAssetType',
              owningProjectId: 'proj-owner',
              listingId: 'listing-B',
              listingRevision: 'rev-1',
              additionalAttributes: {
                forms: JSON.stringify({
                  S3ObjectCollectionForm: JSON.stringify({ bucketArn: 'arn:aws:s3:::my-bucket/public' }),
                }),
              },
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        items: [
          {
            id: 'sub-s3',
            subscribedListing: {
              id: 'listing-A',
              name: 'public/',
              ownerProjectId: 'proj-owner',
              item: {
                assetListing: {
                  entityType: 'S3ObjectCollectionAssetType',
                  forms: JSON.stringify({
                    S3ObjectCollectionForm: JSON.stringify({ bucketArn: 'arn:aws:s3:::my-bucket/public/' }),
                  }),
                },
              },
            },
          },
        ],
      });

    const result = await handler({ query: 'public' }, ctx('catalog_search', { projectId: 'proj-consumer' }));
    const content = JSON.parse(result.result!.content[0].text);
    expect(content).toHaveLength(1);
    expect(content[0]).toMatchObject({ name: 'public', subscribed: true, subscriptionId: 'sub-s3' });
  });

  it('queryが空の場合はエラーを返す', async () => {
    const result = await handler({ query: '' }, ctx('catalog_search', { projectId: 'proj-1' }));
    expect(result.error).toBeDefined();
    expect(result.error!.message).toContain('Missing required parameter: query');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('queryが未指定の場合はエラーを返す', async () => {
    const result = await handler({}, ctx('catalog_search', { projectId: 'proj-1' }));
    expect(result.error).toBeDefined();
    expect(result.error!.message).toContain('Missing required parameter: query');
  });

  it('projectIdが未指定の場合はエラー', async () => {
    const result = await handler({ query: 'test' }, ctx('catalog_search'));
    expect(result.error).toBeDefined();
    expect(result.error!.message).toContain('Missing x-sagemaker-project-id');
  });
});

describe('catalog_list_subscriptions', () => {
  it('Subscribe済みアセット一覧を返す', async () => {
    mockSend.mockResolvedValueOnce({
      items: [
        {
          id: 'sub-store',
          subscribedListing: {
            id: 'listing-1',
            revision: 'rev-1',
            name: 'store_details',
            ownerProjectId: 'proj-owner',
            description: '店舗マスタ',
            item: { assetListing: { name: 'store_details', entityType: 'GlueTableAssetType' } },
          },
        },
      ],
    });
    // SearchListings（自プロジェクト所有アセット取得用）
    mockSend.mockResolvedValueOnce({ items: [] });

    const result = await handler({}, ctx('catalog_list_subscriptions', { projectId: 'proj-1' }));
    const content = JSON.parse(result.result!.content[0].text);
    expect(content).toHaveLength(1);
    expect(content[0]).toMatchObject({ name: 'store_details', subscribed: true, subscriptionId: 'sub-store' });
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it('entityTypeでフィルタできる', async () => {
    mockSend.mockResolvedValueOnce({
      items: [
        {
          id: 'sub-1',
          subscribedListing: {
            id: 'listing-1',
            revision: 'rev-1',
            name: 'store_details',
            ownerProjectId: 'proj-owner',
            item: { assetListing: { entityType: 'GlueTableAssetType' } },
          },
        },
        {
          id: 'sub-2',
          subscribedListing: {
            id: 'listing-2',
            revision: 'rev-2',
            name: 'public_docs',
            ownerProjectId: 'proj-owner',
            item: { assetListing: { entityType: 'S3ObjectCollectionAssetType' } },
          },
        },
      ],
    });
    // SearchListings（自プロジェクト所有アセット取得用）
    mockSend.mockResolvedValueOnce({ items: [] });

    const result = await handler(
      { entityType: 'S3ObjectCollectionAssetType' },
      ctx('catalog_list_subscriptions', { projectId: 'proj-1' }),
    );
    const content = JSON.parse(result.result!.content[0].text);
    expect(content).toHaveLength(1);
    expect(content[0].name).toBe('public_docs');
  });

  it('projectIdが未指定の場合はエラー', async () => {
    const result = await handler({}, ctx('catalog_list_subscriptions'));
    expect(result.error).toBeDefined();
    expect(result.error!.message).toContain('Missing x-sagemaker-project-id');
  });
});

describe('catalog_detail', () => {
  it('GlueTableFormからスキーマ情報を抽出する', async () => {
    mockSend.mockResolvedValueOnce({
      item: {
        assetListing: {
          forms: JSON.stringify({
            GlueTableForm: JSON.stringify({
              tableName: 'store_details',
              databaseName: 'demo_salesdb',
              columns: [
                { columnName: 'store_id', dataType: 'string' },
                { columnName: 'city', dataType: 'string' },
              ],
            }),
          }),
        },
      },
    });

    const result = await handler({ listingId: 'listing-1' }, ctx('catalog_detail'));
    const content = JSON.parse(result.result!.content[0].text);
    expect(content).toMatchObject({ tableName: 'store_details', databaseName: 'demo_salesdb' });
    expect(content.columns).toHaveLength(2);
  });

  it('listingIdが未指定の場合はエラー', async () => {
    const result = await handler({ listingId: '' }, ctx('catalog_detail'));
    expect(result.error).toBeDefined();
  });

  it('formsがオブジェクトの場合も正しく処理する', async () => {
    mockSend.mockResolvedValueOnce({
      item: {
        assetListing: {
          forms: {
            GlueTableForm: {
              tableName: 'store_details',
              databaseName: 'demo_salesdb',
              columns: [{ columnName: 'store_id', dataType: 'string' }],
            },
          },
        },
      },
    });

    const result = await handler({ listingId: 'listing-1' }, ctx('catalog_detail'));
    const content = JSON.parse(result.result!.content[0].text);
    expect(content.tableName).toBe('store_details');
  });
});

describe('subscription_request', () => {
  it('DER認証情報でSubscription Requestを作成する', async () => {
    mockSend.mockResolvedValueOnce({
      id: 'req-001',
      status: 'PENDING',
      subscribedListings: [
        {
          name: 'sales_data',
          id: 'listing-1',
          revision: 'rev-1',
          item: { assetListing: { entityId: 'entity-1', entityRevision: 'erev-1' } },
        },
      ],
    });

    const result = await handler(
      { listingId: 'listing-1', requestReason: 'Need sales data' },
      subCtx('subscription_request', 'proj-consumer'),
    );
    const content = JSON.parse(result.result!.content[0].text);
    expect(content.requestId).toBe('req-001');
    expect(content.status).toBe('PENDING');
  });

  it('自己Subscribeは自動承認されACCEPTEDが返る', async () => {
    mockSend.mockResolvedValueOnce({ id: 'req-002', status: 'ACCEPTED', subscribedListings: [] });

    const result = await handler(
      { listingId: 'listing-1', requestReason: 'Self subscribe' },
      subCtx('subscription_request', 'proj-owner'),
    );
    const content = JSON.parse(result.result!.content[0].text);
    expect(content.status).toBe('ACCEPTED');
  });

  it('listingIdが未指定の場合はエラー', async () => {
    const result = await handler({ listingId: '', requestReason: 'test' }, subCtx('subscription_request'));
    expect(result.error).toBeDefined();
  });

  it('idcAccessTokenが未指定の場合はエラー', async () => {
    const result = await handler(
      { listingId: 'listing-1', requestReason: 'test' },
      ctx('subscription_request', { projectId: 'proj-1' }),
    );
    expect(result.error).toBeDefined();
    expect(result.error!.message).toContain('x-idc-access-token');
  });
});

describe('subscription_list_requests', () => {
  it('PENDINGリクエスト一覧を返す', async () => {
    mockSend.mockResolvedValueOnce({
      items: [
        {
          id: 'req-001',
          status: 'PENDING',
          requestReason: 'Need data',
          createdAt: new Date('2025-01-01T00:00:00Z'),
          subscribedPrincipals: [{ project: { id: 'proj-consumer' } }],
          subscribedListings: [
            {
              name: 'sales_data',
              id: 'listing-1',
              item: { assetListing: { entityId: 'entity-1', entityRevision: 'erev-1' } },
            },
          ],
        },
      ],
    });

    const result = await handler({}, subCtx('subscription_list_requests', 'proj-owner'));
    const content = JSON.parse(result.result!.content[0].text);
    expect(content).toHaveLength(1);
    expect(content[0].requestId).toBe('req-001');
    expect(content[0].requesterProjectId).toBe('proj-consumer');
  });
});

describe('subscription_approve', () => {
  it('Full access承認でACCEPTEDが返る', async () => {
    mockSend.mockResolvedValueOnce({ id: 'req-001', status: 'ACCEPTED', decisionComment: 'Approved' });

    const result = await handler({ requestId: 'req-001', decisionComment: 'Approved' }, subCtx('subscription_approve'));
    const content = JSON.parse(result.result!.content[0].text);
    expect(content.status).toBe('ACCEPTED');
  });

  it('FGAC付き承認でassetScopesが送信される', async () => {
    mockSend.mockResolvedValueOnce({ id: 'req-001', status: 'ACCEPTED' });

    await handler(
      { requestId: 'req-001', assetId: 'entity-1', filterIds: ['filter-1'] },
      subCtx('subscription_approve'),
    );
    const sentCommand = mockSend.mock.calls[0][0];
    expect(sentCommand.input.assetScopes).toEqual([{ assetId: 'entity-1', filterIds: ['filter-1'] }]);
  });

  it('requestIdが未指定の場合はエラー', async () => {
    const result = await handler({ requestId: '' }, subCtx('subscription_approve'));
    expect(result.error).toBeDefined();
  });
});

describe('subscription_reject', () => {
  it('拒否でREJECTEDが返る', async () => {
    mockSend.mockResolvedValueOnce({ id: 'req-001', status: 'REJECTED' });

    const result = await handler(
      { requestId: 'req-001', decisionComment: 'Not authorized' },
      subCtx('subscription_reject'),
    );
    const content = JSON.parse(result.result!.content[0].text);
    expect(content.status).toBe('REJECTED');
  });
});

describe('subscription_list_filters', () => {
  it('フィルタ一覧を返す', async () => {
    mockSend.mockResolvedValueOnce({
      items: [
        {
          id: 'filter-1',
          name: 'Tokyo stores only',
          effectiveColumnNames: ['store_id', 'city'],
          effectiveRowFilter: "city = 'Tokyo'",
          status: 'ACTIVE',
        },
      ],
    });

    const result = await handler({ assetId: 'entity-1' }, subCtx('subscription_list_filters'));
    const content = JSON.parse(result.result!.content[0].text);
    expect(content).toHaveLength(1);
    expect(content[0].filterId).toBe('filter-1');
    expect(content[0].effectiveRowFilter).toBe("city = 'Tokyo'");
  });
});

describe('subscription_cancel', () => {
  it('Subscription解除でstatusが返る', async () => {
    mockSend.mockResolvedValueOnce({ id: 'sub-001', status: 'CANCELLED' });

    const result = await handler({ subscriptionId: 'sub-001' }, subCtx('subscription_cancel'));
    const content = JSON.parse(result.result!.content[0].text);
    expect(content.subscriptionId).toBe('sub-001');
  });
});

describe('subscription_revoke', () => {
  it('Subscription取り消しでstatusが返る', async () => {
    mockSend.mockResolvedValueOnce({ id: 'sub-001', status: 'REVOKED' });

    const result = await handler({ subscriptionId: 'sub-001' }, subCtx('subscription_revoke'));
    const content = JSON.parse(result.result!.content[0].text);
    expect(content.status).toBe('REVOKED');
  });

  it('retainPermissions=trueが送信される', async () => {
    mockSend.mockResolvedValueOnce({ id: 'sub-001', status: 'REVOKED' });

    await handler({ subscriptionId: 'sub-001', retainPermissions: true }, subCtx('subscription_revoke'));
    const sentCommand = mockSend.mock.calls[0][0];
    expect(sentCommand.input.retainPermissions).toBe(true);
  });
});

describe('router', () => {
  it('DataZone APIエラーをキャッチしてエラーレスポンスを返す', async () => {
    mockSend.mockRejectedValueOnce(new Error('AccessDeniedException'));

    const result = await handler({ listingId: 'listing-1', requestReason: 'test' }, subCtx('subscription_request'));
    expect(result.error).toBeDefined();
    expect(result.error!.message).toContain('AccessDeniedException');
  });
});
