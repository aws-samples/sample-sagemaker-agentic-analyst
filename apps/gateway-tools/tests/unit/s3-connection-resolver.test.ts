import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSend = vi.fn();
vi.mock('@aws-sdk/client-datazone', () => ({
  DataZoneClient: vi.fn().mockImplementation(() => ({ send: mockSend })),
  ListConnectionsCommand: vi.fn().mockImplementation((input: unknown) => ({ type: 'ListConnections', input })),
  ListProjectsCommand: vi.fn().mockImplementation((input: unknown) => ({ type: 'ListProjects', input })),
}));

import { resolveS3Connection, clearCache } from '../../lib/s3-connection-resolver';

function makeConnection(overrides: {
  s3Uri: string;
  accessRole?: string;
  s3AccessGrantLocationId?: string;
  awsAccountId?: string;
}) {
  return {
    connectionId: 'conn-test',
    domainId: 'dzd-test',
    domainUnitId: 'du-test',
    name: 'test-connection',
    type: 'S3',
    physicalEndpoints: [
      {
        awsLocation: {
          accessRole: overrides.accessRole,
          awsAccountId: overrides.awsAccountId ?? '123456789012',
        },
      },
    ],
    props: {
      s3Properties: {
        s3Uri: overrides.s3Uri,
        s3AccessGrantLocationId: overrides.s3AccessGrantLocationId,
      },
    },
  };
}

/**
 * mockSendのハンドラを設定するヘルパー。
 * projectConnections: projectId → コネクション配列のマップ
 * projectIds: ListProjectsが返すプロジェクトID一覧
 */
function setupMock(
  projectConnections: Record<string, ReturnType<typeof makeConnection>[]>,
  projectIds: string[] = Object.keys(projectConnections),
) {
  mockSend.mockImplementation((cmd: { type: string; input: { projectIdentifier?: string } }) => {
    if (cmd.type === 'ListConnections') {
      const pid = cmd.input.projectIdentifier;
      return Promise.resolve({ items: pid ? (projectConnections[pid] ?? []) : [] });
    }
    if (cmd.type === 'ListProjects') {
      return Promise.resolve({ items: projectIds.map((id) => ({ id })) });
    }
    return Promise.resolve({});
  });
}

describe('resolveS3Connection', () => {
  beforeEach(() => {
    clearCache();
    mockSend.mockReset();
  });

  it('accessRole ありのコネクション（Access Role方式）→ s3-access-grants', async () => {
    setupMock({
      'proj-1': [
        makeConnection({
          s3Uri: 's3://external-bucket/data/',
          accessRole: 'arn:aws:iam::123456789012:role/AccessRole',
          s3AccessGrantLocationId: 'grant-loc-123',
          awsAccountId: '123456789012',
        }),
      ],
    });

    const result = await resolveS3Connection('dzd-test', 'proj-1', 's3://external-bucket/data/file.txt');
    expect(result.accessMethod).toBe('s3-access-grants');
    expect(result.s3Uri).toBe('s3://external-bucket/data/file.txt');
    expect(result.accountId).toBe('123456789012');
  });

  it('accessRole なしのコネクション（ドメインバケット）→ direct', async () => {
    setupMock({ 'proj-1': [makeConnection({ s3Uri: 's3://domain-bucket/' })] });

    const result = await resolveS3Connection('dzd-test', 'proj-1', 's3://domain-bucket/file.txt');
    expect(result.accessMethod).toBe('direct');
  });

  it('accessRole あり・s3AccessGrantLocationId なしのコネクション → s3-access-grants', async () => {
    setupMock({
      'proj-1': [
        makeConnection({
          s3Uri: 's3://external-bucket/data/',
          accessRole: 'arn:aws:iam::123456789012:role/AccessRole',
          awsAccountId: '123456789012',
        }),
      ],
    });

    const result = await resolveS3Connection('dzd-test', 'proj-1', 's3://external-bucket/data/file.txt');
    expect(result.accessMethod).toBe('s3-access-grants');
    expect(result.accountId).toBe('123456789012');
  });

  it('Project Role方式（accessRole なし、s3AccessGrantLocationId あり）→ direct', async () => {
    // Project Role方式: accessRoleが設定されないため direct と判定される。
    // Publisherプロジェクトロールは S3BucketAccess IAMポリシーで直接アクセスする。
    setupMock({
      'proj-1': [
        makeConnection({
          s3Uri: 's3://external-bucket/unstructured/',
          s3AccessGrantLocationId: 'loc-123',
          awsAccountId: '123456789012',
        }),
      ],
    });

    const result = await resolveS3Connection('dzd-test', 'proj-1', 's3://external-bucket/unstructured/file.txt');
    expect(result.accessMethod).toBe('direct');
  });

  it('相対パスがコネクションの s3Uri にマッチ → 完全S3 URI構築', async () => {
    setupMock({
      'proj-1': [
        makeConnection({
          s3Uri: 's3://my-bucket/unstructured/',
          accessRole: 'arn:aws:iam::123456789012:role/Role',
          s3AccessGrantLocationId: 'loc-1',
        }),
      ],
    });

    const result = await resolveS3Connection('dzd-test', 'proj-1', 'unstructured/public/catalog.txt');
    expect(result.s3Uri).toBe('s3://my-bucket/unstructured/public/catalog.txt');
    expect(result.accessMethod).toBe('s3-access-grants');
  });

  it('マッチするコネクションなし（s3:// URI） → エラー', async () => {
    setupMock({ 'proj-1': [makeConnection({ s3Uri: 's3://other-bucket/' })] });

    await expect(resolveS3Connection('dzd-test', 'proj-1', 's3://nonexistent-bucket/file.txt')).rejects.toThrow(
      'No S3 connections found',
    );
  });

  it('コネクションが0件 → エラー', async () => {
    setupMock({}, ['proj-1']);

    await expect(resolveS3Connection('dzd-test', 'proj-1', 'file.txt')).rejects.toThrow('No S3 connections found');
  });

  it('キャッシュが効く（2回目はAPIを呼ばない）', async () => {
    setupMock({ 'proj-1': [makeConnection({ s3Uri: 's3://bucket/' })] });

    await resolveS3Connection('dzd-test', 'proj-1', 's3://bucket/a.txt');
    const callCount = mockSend.mock.calls.length;
    await resolveS3Connection('dzd-test', 'proj-1', 's3://bucket/b.txt');
    expect(mockSend.mock.calls.length).toBe(callCount); // 追加呼び出しなし
  });

  it('Subscriberパターン: プロジェクトレベルにないコネクションがドメインレベルで見つかる', async () => {
    setupMock(
      {
        // Subscriberプロジェクト: ドメインバケットのみ
        'subscriber-proj': [makeConnection({ s3Uri: 's3://domain-bucket/dzd-xxx/subscriber-proj/' })],
        // Publisherプロジェクト: 外部バケットのコネクションあり（directでもs3-access-grantsに強制される）
        'publisher-proj': [
          makeConnection({
            s3Uri: 's3://external-bucket/unstructured/',
            awsAccountId: '123456789012',
          }),
        ],
      },
      ['subscriber-proj', 'publisher-proj'],
    );

    const result = await resolveS3Connection('dzd-test', 'subscriber-proj', 'unstructured/public/catalog.txt');
    expect(result.s3Uri).toBe('s3://external-bucket/unstructured/public/catalog.txt');
    // ドメインレベルで解決した場合、Subscriberロールには直接アクセス権限がないため
    // S3 Access Grants経由が強制される
    expect(result.accessMethod).toBe('s3-access-grants');
  });
});
