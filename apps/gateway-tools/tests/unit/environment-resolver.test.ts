import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveProjectEnvironments } from '@agentic-analyst/datazone-auth';

// DataZoneClient をモック
const mockSend = vi.fn();
vi.mock('@aws-sdk/client-datazone', () => ({
  DataZoneClient: vi.fn(() => ({ send: mockSend })),
  ListEnvironmentsCommand: vi.fn((input: unknown) => ({ _type: 'ListEnvironments', input })),
  GetEnvironmentCommand: vi.fn((input: unknown) => ({ _type: 'GetEnvironment', input })),
}));

beforeEach(() => {
  mockSend.mockReset();
});

describe('resolveProjectEnvironments', () => {
  it('Tooling環境とLakehouse DB環境を正しく解決する', async () => {
    // ListEnvironments
    mockSend.mockResolvedValueOnce({
      items: [{ id: 'env-tooling' }, { id: 'env-lakehouse' }, { id: 'env-other' }],
    });
    // GetEnvironment(env-tooling)
    mockSend.mockResolvedValueOnce({
      provisionedResources: [
        { name: 'isDefaultToolingEnvironment', value: 'true' },
        { name: 'athenaWorkGroupName', value: 'smus_workgroup_123' },
      ],
    });
    // GetEnvironment(env-lakehouse)
    mockSend.mockResolvedValueOnce({
      provisionedResources: [{ name: 'glueDBName', value: 'glue_db_abc123' }],
    });
    // env-other は呼ばれない（早期終了）

    const result = await resolveProjectEnvironments('domain-1', 'project-1', 'ap-northeast-1');

    expect(result).toEqual({
      toolingEnvironmentId: 'env-tooling',
      athenaWorkGroupName: 'smus_workgroup_123',
      glueDBName: 'glue_db_abc123',
    });
    // ListEnvironments(1) + GetEnvironment(2) = 3回（早期終了で3つ目のGetEnvironmentは呼ばれない）
    expect(mockSend).toHaveBeenCalledTimes(3);
  });

  it('Lakehouse DB環境がないプロジェクトではglueDBNameがundefined', async () => {
    mockSend.mockResolvedValueOnce({
      items: [{ id: 'env-tooling' }],
    });
    mockSend.mockResolvedValueOnce({
      provisionedResources: [
        { name: 'isDefaultToolingEnvironment', value: 'true' },
        { name: 'athenaWorkGroupName', value: 'wg_456' },
      ],
    });

    const result = await resolveProjectEnvironments('domain-1', 'project-2', 'ap-northeast-1');

    expect(result.toolingEnvironmentId).toBe('env-tooling');
    expect(result.athenaWorkGroupName).toBe('wg_456');
    expect(result.glueDBName).toBeUndefined();
  });

  it('Tooling環境が見つからない場合はエラー', async () => {
    mockSend.mockResolvedValueOnce({
      items: [{ id: 'env-lakehouse' }],
    });
    mockSend.mockResolvedValueOnce({
      provisionedResources: [{ name: 'glueDBName', value: 'glue_db_xyz' }],
    });

    await expect(resolveProjectEnvironments('domain-1', 'project-3', 'ap-northeast-1')).rejects.toThrow(
      'Tooling environment not found',
    );
  });
});
