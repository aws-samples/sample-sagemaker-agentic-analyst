/**
 * プロジェクトID → 環境情報の解決ユーティリティ
 *
 * ListEnvironments + GetEnvironment で Tooling環境ID・athenaWorkGroupName・glueDBName を解決する。
 * キャッシュは呼び出し側の責務（実行環境に依存するため）
 */

import { DataZoneClient, ListEnvironmentsCommand, GetEnvironmentCommand } from '@aws-sdk/client-datazone';

export interface ProjectEnvironments {
  toolingEnvironmentId: string;
  athenaWorkGroupName: string;
  glueDBName?: string;
}

export interface EnvironmentInfo {
  projectId: string;
  awsAccountId: string;
  athenaWorkGroupName?: string;
}

/**
 * projectId から Tooling環境ID + athenaWorkGroupName + glueDBName を解決する。
 */
export async function resolveProjectEnvironments(
  domainId: string,
  projectId: string,
  region: string,
): Promise<ProjectEnvironments> {
  const client = new DataZoneClient({ region });

  const environmentIds: string[] = [];
  let nextToken: string | undefined;
  do {
    const res = await client.send(
      new ListEnvironmentsCommand({
        domainIdentifier: domainId,
        projectIdentifier: projectId,
        ...(nextToken && { nextToken }),
      }),
    );
    for (const env of res.items ?? []) {
      if (env.id) environmentIds.push(env.id);
    }
    nextToken = res.nextToken;
  } while (nextToken);

  let toolingEnvironmentId: string | undefined;
  let athenaWorkGroupName: string | undefined;
  let glueDBName: string | undefined;

  for (const envId of environmentIds) {
    const envDetail = await client.send(new GetEnvironmentCommand({ domainIdentifier: domainId, identifier: envId }));
    const resources = envDetail.provisionedResources ?? [];

    const isTooling = resources.some((r) => r.name === 'isDefaultToolingEnvironment' && r.value === 'true');
    if (isTooling) {
      toolingEnvironmentId = envId;
      athenaWorkGroupName = resources.find((r) => r.name === 'athenaWorkGroupName')?.value;
    }

    const glueDb = resources.find((r) => r.name === 'glueDBName');
    if (glueDb?.value) {
      glueDBName = glueDb.value;
    }

    if (toolingEnvironmentId && glueDBName !== undefined) break;
  }

  if (!toolingEnvironmentId || !athenaWorkGroupName) {
    throw new Error(
      `Tooling environment not found for project ${projectId}. ` +
        'Ensure the project has a Tooling environment with isDefaultToolingEnvironment=true.',
    );
  }

  return { toolingEnvironmentId, athenaWorkGroupName, glueDBName };
}

/**
 * GetEnvironment で環境情報を取得
 */
export async function getEnvironmentInfo(
  domainId: string,
  environmentId: string,
  region: string,
): Promise<EnvironmentInfo> {
  const response = await new DataZoneClient({ region }).send(
    new GetEnvironmentCommand({ domainIdentifier: domainId, identifier: environmentId }),
  );
  if (!response.projectId || !response.awsAccountId) {
    throw new Error('GetEnvironment did not return projectId or awsAccountId');
  }

  const workgroupResource = (response.provisionedResources ?? []).find((r) => r.name === 'athenaWorkGroupName');
  return {
    projectId: response.projectId,
    awsAccountId: response.awsAccountId,
    athenaWorkGroupName: workgroupResource?.value,
  };
}
