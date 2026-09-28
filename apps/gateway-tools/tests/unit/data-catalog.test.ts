import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSend = vi.fn();
vi.mock('@aws-sdk/client-datazone', () => ({
  DataZoneClient: vi.fn(() => ({ send: mockSend })),
  SearchListingsCommand: vi.fn((input: unknown) => ({ _type: 'SearchListings', input })),
  ListSubscriptionsCommand: vi.fn((input: unknown) => ({ _type: 'ListSubscriptions', input })),
  GetListingCommand: vi.fn((input: unknown) => ({ _type: 'GetListing', input })),
  BatchGetAttributesMetadataCommand: vi.fn((input: unknown) => ({ _type: 'BatchGetAttributesMetadata', input })),
  GetGlossaryTermCommand: vi.fn((input: unknown) => ({ _type: 'GetGlossaryTerm', input })),
  GetGlossaryCommand: vi.fn((input: unknown) => ({ _type: 'GetGlossary', input })),
  GetFormTypeCommand: vi.fn((input: unknown) => ({ _type: 'GetFormType', input })),
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

import { handler, CATALOG_CONTENT_NOTICE } from '../../data-catalog/index';

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

describe('SearchListings additionalAttributes (R5)', () => {
  it('catalog_searchとcatalog_list_subscriptionsのSearchListings呼び出しはadditionalAttributes: ["FORMS"]を渡す', async () => {
    mockSend.mockResolvedValue({ items: [] });

    await handler({ query: 'test' }, ctx('catalog_search', { projectId: 'proj-1' }));
    await handler({}, ctx('catalog_list_subscriptions', { projectId: 'proj-1' }));

    const searchListingsCalls = mockSend.mock.calls
      .map(([cmd]) => cmd as { _type: string; input: Record<string, unknown> })
      .filter((cmd) => cmd._type === 'SearchListings');
    expect(searchListingsCalls).toHaveLength(2);
    for (const cmd of searchListingsCalls) {
      expect(cmd.input.additionalAttributes).toEqual(['FORMS']);
    }
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
    // BatchGetAttributesMetadata（カラムビジネスメタデータなしのケース）
    mockSend.mockResolvedValueOnce({ attributes: [], errors: [] });

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
    // BatchGetAttributesMetadata（カラムビジネスメタデータなしのケース）
    mockSend.mockResolvedValueOnce({ attributes: [], errors: [] });

    const result = await handler({ listingId: 'listing-1' }, ctx('catalog_detail'));
    const content = JSON.parse(result.result!.content[0].text);
    expect(content.tableName).toBe('store_details');
  });

  it('リスティング単位のビジネスメタデータ(R1)を返し、システム管理formは除く（stg実測形状のfixture）', async () => {
    const glossaryTermIds = ['gt-store', 'gt-sales', 'gt-region'];
    const forms = {
      DataSourceReferenceForm: JSON.stringify({ dataSourceId: 'ds-1' }),
      'AwsConfigurationForm.region': 'ap-northeast-1',
      'AwsConfigurationForm.accountId': '123456789012',
      AssetCommonDetailsForm: JSON.stringify({ realmId: 'realm-1' }),
      hasAttached: JSON.stringify(['an40pk82b5kl5l']),
      GlueTableForm: JSON.stringify({
        tableName: 'retail_sales_performance',
        databaseName: 'demo_salesdb',
        columns: [{ columnName: 'store_id', dataType: 'string' }],
      }),
      ListingSubscriberCountFormType: JSON.stringify({ subscriberCount: 3 }),
      DataOwnershipForm: JSON.stringify({
        dataOwner: 'Sales Operations',
        updateFrequency: 'daily',
        dataClassification: 'internal',
      }),
      SubscriptionTermsForm: JSON.stringify({ termsAndConditions: 'must not redistribute' }),
      __DataZoneGlossaryTerms: JSON.stringify([...glossaryTermIds, 'gt-store']),
    };

    mockSend.mockResolvedValueOnce({
      name: 'retail_sales_performance',
      description: '店舗別の販売数量。',
      item: {
        assetListing: {
          assetId: '4j1xf2tfqn4xi1',
          assetRevision: '8',
          assetType: 'GlueTableAssetType',
          glossaryTerms: [
            { name: 'Store', shortDescription: '店舗を表す用語' },
            { name: 'Sales', shortDescription: '販売を表す用語' },
            { name: 'Region', shortDescription: '地域を表す用語' },
          ],
          governedGlossaryTerms: [],
          forms: JSON.stringify(forms),
        },
      },
    });
    // BatchGetAttributesMetadata（カラムビジネスメタデータなしのケース）
    mockSend.mockResolvedValueOnce({ attributes: [], errors: [] });

    const result = await handler({ listingId: 'listing-1' }, ctx('catalog_detail'));
    const content = JSON.parse(result.result!.content[0].text);

    // プロデューサーが書いた文字列を指示として扱わせないための注記
    expect(content.notice).toBe(CATALOG_CONTENT_NOTICE);
    // 追加欄
    expect(content.name).toBe('retail_sales_performance');
    expect(content.description).toBe('店舗別の販売数量。');
    expect(content.assetId).toBe('4j1xf2tfqn4xi1');
    expect(content.assetRevision).toBe('8');
    expect(content.assetType).toBe('GlueTableAssetType');
    expect(content.glossaryTerms).toEqual([
      { name: 'Store', shortDescription: '店舗を表す用語' },
      { name: 'Sales', shortDescription: '販売を表す用語' },
      { name: 'Region', shortDescription: '地域を表す用語' },
    ]);
    // governedGlossaryTermsは空配列なので省かれる
    expect(content.governedGlossaryTerms).toBeUndefined();
    // glossaryTermIdsはforms由来で、glossaryTermsとは別欄（順序で対応付けない）
    expect(content.glossaryTermIds).toEqual(glossaryTermIds);

    // 既存欄は変わらない
    expect(content.tableName).toBe('retail_sales_performance');
    expect(content.databaseName).toBe('demo_salesdb');
    expect(content.columns).toEqual([{ columnName: 'store_id', dataType: 'string' }]);

    // forms欄にはDataOwnershipFormだけが残る（除外リスト・専用欄は落ちる）
    expect(content.forms).toEqual({
      DataOwnershipForm: {
        dataOwner: 'Sales Operations',
        updateFrequency: 'daily',
        dataClassification: 'internal',
      },
    });
  });

  it('GlueTableFormもS3ObjectCollectionFormも無いリスティングでもビジネスメタデータを返す', async () => {
    mockSend.mockResolvedValueOnce({
      name: 'some_model',
      description: 'モデルの説明',
      item: {
        assetListing: {
          assetId: 'asset-1',
          assetType: 'BedrockModelAssetType',
          forms: JSON.stringify({
            AssetCommonDetailsForm: JSON.stringify({ realmId: 'realm-1' }),
            CustomForm: JSON.stringify({ note: 'カスタムフォーム' }),
          }),
        },
      },
    });

    const result = await handler({ listingId: 'listing-2' }, ctx('catalog_detail'));
    const content = JSON.parse(result.result!.content[0].text);

    expect(content.name).toBe('some_model');
    expect(content.assetId).toBe('asset-1');
    expect(content.forms).toEqual({ CustomForm: { note: 'カスタムフォーム' } });
    expect(content.tableName).toBeUndefined();
    expect(content.bucketName).toBeUndefined();
  });

  it('JSON.parseに失敗するform値は生の文字列のまま保持する', async () => {
    mockSend.mockResolvedValueOnce({
      item: {
        assetListing: {
          forms: JSON.stringify({
            CustomForm: 'not-json-{',
          }),
        },
      },
    });

    const result = await handler({ listingId: 'listing-3' }, ctx('catalog_detail'));
    const content = JSON.parse(result.result!.content[0].text);

    expect(content.forms).toEqual({ CustomForm: 'not-json-{' });
  });

  describe('カラム単位のビジネスメタデータ(R2)とBatchGetAttributesMetadata障害耐性(R6)', () => {
    /** GlueTableFormを含むGetListingレスポンスを組み立てる（ColumnBusinessMetadataFormは省略可） */
    function glueListingResponse(
      columns: { columnName: string; dataType: string }[],
      columnBusinessMetadata?: unknown,
    ) {
      return {
        item: {
          assetListing: {
            listingRevision: 'rev-1',
            forms: JSON.stringify({
              GlueTableForm: JSON.stringify({ tableName: 't', databaseName: 'db', columns }),
              ...(columnBusinessMetadata !== undefined && {
                ColumnBusinessMetadataForm: JSON.stringify({ columnsBusinessMetadata: columnBusinessMetadata }),
              }),
            }),
          },
        },
      };
    }

    it('ColumnBusinessMetadataFormのcolumnsBusinessMetadataをcolumnIdentifierでマッチし、businessName/description/glossaryTermsを付加する', async () => {
      mockSend.mockResolvedValueOnce(
        glueListingResponse(
          [
            { columnName: 'store_id', dataType: 'string' },
            { columnName: 'sales_amount', dataType: 'double' },
            { columnName: 'date', dataType: 'date' },
          ],
          [
            {
              columnIdentifier: 'store_id',
              name: '店舗ID',
              description: '店舗を一意に識別するID',
              glossaryTerms: [
                { BusinessGlossaryTermForm: { name: 'Store' }, amazonmetadata: { entityId: 'an40pk82b5kl5l' } },
              ],
            },
            {
              columnIdentifier: 'sales_amount',
              name: '売上金額',
              glossaryTerms: ['gt-plain-id'],
            },
          ],
        ),
      );
      // BGAM: 3カラム <= 5なので1チャンク。store_idにformsを付与、他は空
      mockSend.mockResolvedValueOnce({
        attributes: [
          {
            attributeIdentifier: 'store_id',
            forms: [{ formName: 'SomeForm', content: JSON.stringify({ foo: 'bar' }) }],
          },
        ],
        errors: [],
      });

      const result = await handler({ listingId: 'listing-1' }, ctx('catalog_detail'));
      const content = JSON.parse(result.result!.content[0].text);

      expect(content.columns).toEqual([
        {
          columnName: 'store_id',
          dataType: 'string',
          businessName: '店舗ID',
          description: '店舗を一意に識別するID',
          glossaryTerms: [{ id: 'an40pk82b5kl5l', name: 'Store' }],
          forms: { SomeForm: { foo: 'bar' } },
        },
        {
          columnName: 'sales_amount',
          dataType: 'double',
          businessName: '売上金額',
          glossaryTerms: [{ id: 'gt-plain-id' }],
        },
        { columnName: 'date', dataType: 'date' },
      ]);
      expect(content.unavailable).toBeUndefined();
    });

    it('カラムが5件を超える場合はBatchGetAttributesMetadataを5件ずつのチャンクに分けて呼び出す', async () => {
      const columns = Array.from({ length: 6 }, (_, i) => ({ columnName: `col${i}`, dataType: 'string' }));
      mockSend.mockResolvedValueOnce(glueListingResponse(columns));
      mockSend.mockResolvedValueOnce({ attributes: [], errors: [] });
      mockSend.mockResolvedValueOnce({ attributes: [], errors: [] });

      const result = await handler({ listingId: 'listing-1' }, ctx('catalog_detail'));
      JSON.parse(result.result!.content[0].text);

      const bgamCalls = mockSend.mock.calls
        .map(([cmd]) => cmd as { _type: string; input: { attributeIdentifiers: string[] } })
        .filter((cmd) => cmd._type === 'BatchGetAttributesMetadata');
      expect(bgamCalls).toHaveLength(2);
      expect(bgamCalls[0].input.attributeIdentifiers).toHaveLength(5);
      expect(bgamCalls[1].input.attributeIdentifiers).toHaveLength(1);
    });

    it('BatchGetAttributesMetadataの呼び出しがreject（AccessDenied等）でもcolumnsは返しunavailableに積む', async () => {
      mockSend.mockResolvedValueOnce(
        glueListingResponse([
          { columnName: 'store_id', dataType: 'string' },
          { columnName: 'sales_amount', dataType: 'double' },
        ]),
      );
      mockSend.mockRejectedValueOnce(
        Object.assign(new Error('User is not authorized'), { name: 'AccessDeniedException' }),
      );

      const result = await handler({ listingId: 'listing-1' }, ctx('catalog_detail'));
      const content = JSON.parse(result.result!.content[0].text);

      expect(content.columns).toEqual([
        { columnName: 'store_id', dataType: 'string' },
        { columnName: 'sales_amount', dataType: 'double' },
      ]);
      expect(content.unavailable).toHaveLength(1);
      expect(content.unavailable[0].item).toContain('columnMetadata:');
      expect(content.unavailable[0].reason).toContain('AccessDeniedException');
    });

    it('BatchGetAttributesMetadataのレスポンスのerrors[]に載ったカラムはunavailableに積み、他のカラムは反映する', async () => {
      mockSend.mockResolvedValueOnce(
        glueListingResponse([
          { columnName: 'store_id', dataType: 'string' },
          { columnName: 'date', dataType: 'date' },
        ]),
      );
      mockSend.mockResolvedValueOnce({
        attributes: [
          {
            attributeIdentifier: 'store_id',
            forms: [{ formName: 'SomeForm', content: JSON.stringify({ foo: 'bar' }) }],
          },
        ],
        errors: [{ attributeIdentifier: 'date', code: 'AccessDeniedException', message: 'no access' }],
      });

      const result = await handler({ listingId: 'listing-1' }, ctx('catalog_detail'));
      const content = JSON.parse(result.result!.content[0].text);

      expect(content.columns).toEqual([
        { columnName: 'store_id', dataType: 'string', forms: { SomeForm: { foo: 'bar' } } },
        { columnName: 'date', dataType: 'date' },
      ]);
      expect(content.unavailable).toEqual([
        { item: 'columnMetadata:date', reason: 'AccessDeniedException: no access' },
      ]);
    });

    it('メタデータを持たないカラムの404はunavailableに積まない', async () => {
      mockSend.mockResolvedValueOnce(glueListingResponse([{ columnName: 'date', dataType: 'date' }]));
      mockSend.mockResolvedValueOnce({
        attributes: [],
        errors: [{ attributeIdentifier: 'date', code: '404', message: "Attribute 'date' not found" }],
      });

      const result = await handler({ listingId: 'listing-1' }, ctx('catalog_detail'));
      const content = JSON.parse(result.result!.content[0].text);

      expect(content.columns).toEqual([{ columnName: 'date', dataType: 'date' }]);
      expect(content.unavailable).toBeUndefined();
    });
  });
});

describe('catalog_definition', () => {
  it('glossaryTermIdを指定すると用語と所属用語集を返す', async () => {
    mockSend.mockResolvedValueOnce({
      id: 'gt-store',
      glossaryId: 'glossary-1',
      name: 'Store',
      shortDescription: '店舗を表す用語',
      longDescription: '店舗はSAP MMで管理される販売拠点を指す。',
    });
    mockSend.mockResolvedValueOnce({
      id: 'glossary-1',
      name: 'Sales Business Glossary',
      description: '販売業務の用語集',
    });

    const result = await handler({ glossaryTermId: 'gt-store' }, ctx('catalog_definition'));
    const content = JSON.parse(result.result!.content[0].text);

    expect(content).toMatchObject({
      notice: CATALOG_CONTENT_NOTICE,
      id: 'gt-store',
      name: 'Store',
      shortDescription: '店舗を表す用語',
      longDescription: '店舗はSAP MMで管理される販売拠点を指す。',
      glossary: { id: 'glossary-1', name: 'Sales Business Glossary', description: '販売業務の用語集' },
    });
    expect(content.unavailable).toBeUndefined();
  });

  it('GetGlossaryが失敗しても用語は返し、unavailableにglossaryを積む', async () => {
    mockSend.mockResolvedValueOnce({
      id: 'gt-store',
      glossaryId: 'glossary-1',
      name: 'Store',
      shortDescription: '店舗を表す用語',
    });
    mockSend.mockRejectedValueOnce(Object.assign(new Error('not found'), { name: 'ResourceNotFoundException' }));

    const result = await handler({ glossaryTermId: 'gt-store' }, ctx('catalog_definition'));
    const content = JSON.parse(result.result!.content[0].text);

    expect(content).toMatchObject({ id: 'gt-store', name: 'Store', shortDescription: '店舗を表す用語' });
    expect(content.glossary).toBeUndefined();
    expect(content.unavailable).toEqual([{ item: 'glossary', reason: 'ResourceNotFoundException: not found' }]);
  });

  it('formTypeNameを指定するとフォーム定義（smithyモデル）を返す', async () => {
    mockSend.mockResolvedValueOnce({
      name: 'DataOwnershipForm',
      revision: '1',
      description: 'データ所有者情報',
      model: { smithy: 'structure DataOwnershipForm {\n  @documentation("data owner")\n  dataOwner: String\n}' },
    });

    const result = await handler({ formTypeName: 'DataOwnershipForm' }, ctx('catalog_definition'));
    const content = JSON.parse(result.result!.content[0].text);

    expect(content.name).toBe('DataOwnershipForm');
    expect(content.revision).toBe('1');
    expect(content.description).toBe('データ所有者情報');
    expect(content.model).toContain('dataOwner');
  });

  it('glossaryTermIdとformTypeNameを両方指定すると-32602', async () => {
    const result = await handler(
      { glossaryTermId: 'gt-store', formTypeName: 'DataOwnershipForm' },
      ctx('catalog_definition'),
    );
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe(-32602);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('glossaryTermIdもformTypeNameも指定しないと-32602', async () => {
    const result = await handler({}, ctx('catalog_definition'));
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe(-32602);
    expect(mockSend).not.toHaveBeenCalled();
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
