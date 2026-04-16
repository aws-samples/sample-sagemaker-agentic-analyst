/**
 * CDK Provider Framework Lambda: Policy Engine + Cedar Policies + Gateway関連付け
 *
 * 1つのCustom Resourceで以下を一括管理:
 * - Policy Engine作成/削除
 * - Cedarポリシー作成/削除/更新
 * - GatewayへのPolicy Engine関連付け
 */
import {
  BedrockAgentCoreControlClient,
  CreatePolicyEngineCommand,
  DeletePolicyEngineCommand,
  GetPolicyEngineCommand,
  ListPolicyEnginesCommand,
  CreatePolicyCommand,
  DeletePolicyCommand,
  UpdatePolicyCommand,
  GetPolicyCommand,
  ListPoliciesCommand,
  UpdateGatewayCommand,
  GetGatewayCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';
import type { CdkCustomResourceEvent, CdkCustomResourceResponse } from 'aws-lambda';

const client = new BedrockAgentCoreControlClient({});

interface PolicyDef {
  name: string;
  statement: string;
}

interface ResourceProperties {
  ServiceToken: string;
  policyEngineName: string;
  policies: PolicyDef[];
  gatewayId: string;
  gatewayName: string;
  gatewayRoleArn: string;
}

export async function handler(event: CdkCustomResourceEvent): Promise<CdkCustomResourceResponse> {
  const props = event.ResourceProperties as unknown as ResourceProperties;

  switch (event.RequestType) {
    case 'Create':
      return onCreate(props);
    case 'Update':
      return onUpdate(event, props);
    case 'Delete':
      return onDelete(event);
    default:
      throw new Error(`Unknown request type: ${event.RequestType}`);
  }
}

async function onCreate(props: ResourceProperties): Promise<CdkCustomResourceResponse> {
  // 1. Policy Engine作成（同名が既に存在する場合はAdopt）
  const { id: policyEngineId, arn: policyEngineArn } = await getOrCreatePolicyEngine(props.policyEngineName);

  // 2. GatewayにPolicy Engine関連付け（ポリシー作成前に必要 — アクション名バリデーションにtarget情報が必要）
  await updateGatewayWithRetainedConfig(props, { arn: policyEngineArn, mode: 'ENFORCE' });

  // 3. Cedarポリシー同期（差分ベース — 既存ポリシーがあれば再利用）
  const policyIds = await syncPolicies(policyEngineId, props.policies);

  return {
    PhysicalResourceId: policyEngineId,
    Data: { policyEngineId, policyEngineArn, policyIds: JSON.stringify(policyIds) },
  };
}

async function onUpdate(event: CdkCustomResourceEvent, props: ResourceProperties): Promise<CdkCustomResourceResponse> {
  const policyEngineId = event.PhysicalResourceId;

  // ポリシー差分同期
  const policyIds = await syncPolicies(policyEngineId, props.policies);

  // Gateway関連付け更新（policyEngineConfigurationがnullの場合も復元）
  const engineInfo = await client.send(new GetPolicyEngineCommand({ policyEngineId }));
  const policyEngineArn = engineInfo.policyEngineArn!;
  await updateGatewayWithRetainedConfig(props, { arn: policyEngineArn, mode: 'ENFORCE' });

  return {
    PhysicalResourceId: policyEngineId,
    Data: { policyEngineId, policyEngineArn, policyIds: JSON.stringify(policyIds) },
  };
}

async function onDelete(event: CdkCustomResourceEvent): Promise<CdkCustomResourceResponse> {
  const policyEngineId = event.PhysicalResourceId;
  if (!policyEngineId) {
    return { PhysicalResourceId: 'not-created' };
  }

  try {
    // Gateway関連付け解除
    const props = event.ResourceProperties as unknown as ResourceProperties;
    try {
      await updateGatewayWithRetainedConfig(props, undefined);
      console.log('Disassociated policy engine from gateway');
    } catch (e: unknown) {
      console.log('Failed to disassociate gateway (may already be deleted):', e);
    }

    // ポリシー全削除
    const allPolicies = await listAllPolicies(policyEngineId);
    for (const p of allPolicies) {
      await client.send(new DeletePolicyCommand({ policyEngineId, policyId: p.policyId! }));
      console.log('Deleting policy:', p.policyId);
    }
    for (const p of allPolicies) {
      await waitForPolicyDeleted(policyEngineId, p.policyId);
    }

    await client.send(new DeletePolicyEngineCommand({ policyEngineId }));
    console.log('Deleted policy engine:', policyEngineId);
  } catch (e: unknown) {
    const err = e as { name?: string };
    if (err.name === 'ResourceNotFoundException') {
      console.log('Policy engine already deleted:', policyEngineId);
    } else {
      throw e;
    }
  }

  return { PhysicalResourceId: policyEngineId };
}

// --- helpers ---

/** Gateway更新時に既存設定を保持する共通関数 */
async function updateGatewayWithRetainedConfig(
  props: ResourceProperties,
  policyEngineConfiguration: { arn: string; mode: string } | undefined,
): Promise<void> {
  const gw = await client.send(new GetGatewayCommand({ gatewayIdentifier: props.gatewayId }));
  console.log('Updating gateway with policyEngineConfiguration:', JSON.stringify(policyEngineConfiguration));
  const result = await client.send(
    new UpdateGatewayCommand({
      gatewayIdentifier: props.gatewayId,
      name: props.gatewayName,
      roleArn: props.gatewayRoleArn,
      protocolType: 'MCP',
      authorizerType: 'CUSTOM_JWT',
      authorizerConfiguration: gw.authorizerConfiguration,
      interceptorConfigurations: gw.interceptorConfigurations ?? undefined,
      policyEngineConfiguration,
    }),
  );
  console.log('Gateway updated, policyEngineConfiguration:', JSON.stringify(result.policyEngineConfiguration));
}

/** Policy Engineを作成、または同名が既に存在する場合は既存を取得 */
async function getOrCreatePolicyEngine(name: string): Promise<{ id: string; arn: string }> {
  try {
    const engine = await client.send(
      new CreatePolicyEngineCommand({
        name,
        description: 'Tool authorization for Agentic Analyst',
      }),
    );
    const id = engine.policyEngineId!;
    console.log('Created policy engine:', id, 'status:', engine.status);
    await waitForPolicyEngineActive(id);
    return { id, arn: engine.policyEngineArn! };
  } catch (e: unknown) {
    if ((e as { name?: string }).name !== 'ConflictException') throw e;
    console.log('Policy engine already exists, adopting:', name);
    return findPolicyEngineByName(name);
  }
}

/** 名前でPolicy Engineを検索し、ACTIVEになるまで待機 */
async function findPolicyEngineByName(name: string): Promise<{ id: string; arn: string }> {
  let nextToken: string | undefined;
  do {
    const res = await client.send(new ListPolicyEnginesCommand({ nextToken }));
    const match = (res.policyEngines ?? []).find((pe) => pe.name === name);
    if (match) {
      await waitForPolicyEngineActive(match.policyEngineId!);
      return { id: match.policyEngineId!, arn: match.policyEngineArn! };
    }
    nextToken = res.nextToken;
  } while (nextToken);
  throw new Error(`Policy engine '${name}' reported as existing but not found in list`);
}

/** 全ポリシーをページネーション付きで取得 */
async function listAllPolicies(policyEngineId: string) {
  const policies: NonNullable<Awaited<ReturnType<typeof client.send<ListPoliciesCommand>>>['policies']> = [];
  let nextToken: string | undefined;
  do {
    const res = await client.send(new ListPoliciesCommand({ policyEngineId, nextToken }));
    policies.push(...(res.policies ?? []));
    nextToken = res.nextToken;
  } while (nextToken);
  return policies;
}

/** ポリシーを差分同期: 削除 → 更新/作成 */
async function syncPolicies(policyEngineId: string, desired: PolicyDef[]): Promise<string[]> {
  const allPolicies = await listAllPolicies(policyEngineId);
  const existingByName = new Map(
    allPolicies.map((p) => [p.name!, { policyId: p.policyId!, statement: p.definition?.cedar?.statement }]),
  );

  const desiredNames = new Set(desired.map((p) => p.name));
  const policyIds: string[] = [];

  // 削除: desiredに存在しないポリシーを削除
  const toDelete = [...existingByName.entries()].filter(([name]) => !desiredNames.has(name));
  for (const [name, { policyId }] of toDelete) {
    await client.send(new DeletePolicyCommand({ policyEngineId, policyId }));
    console.log('Deleting policy:', name, policyId);
  }
  for (const [, { policyId }] of toDelete) {
    await waitForPolicyDeleted(policyEngineId, policyId);
  }

  // 更新 or 作成
  for (const p of desired) {
    const ex = existingByName.get(p.name);
    if (ex && ex.statement === p.statement) {
      policyIds.push(ex.policyId);
      console.log(`Policy ${p.name} unchanged, skipping`);
    } else if (ex) {
      await client.send(
        new UpdatePolicyCommand({
          policyEngineId,
          policyId: ex.policyId,
          definition: { cedar: { statement: p.statement } },
        }),
      );
      await waitForPolicyActive(policyEngineId, ex.policyId);
      policyIds.push(ex.policyId);
      console.log(`Updated policy ${p.name}:`, ex.policyId);
    } else {
      const policyId = await getOrCreatePolicy(policyEngineId, p);
      policyIds.push(policyId);
    }
  }

  return policyIds;
}

/** ポリシーを作成、または同名が既に存在する場合は既存を取得して更新 */
async function getOrCreatePolicy(policyEngineId: string, p: PolicyDef): Promise<string> {
  try {
    const result = await client.send(
      new CreatePolicyCommand({
        policyEngineId,
        name: p.name,
        definition: { cedar: { statement: p.statement } },
      }),
    );
    await waitForPolicyActive(policyEngineId, result.policyId!);
    console.log(`Created policy ${p.name}:`, result.policyId);
    return result.policyId!;
  } catch (e: unknown) {
    if ((e as { name?: string }).name !== 'ConflictException') throw e;
    console.log(`Policy ${p.name} conflict, searching existing policies`);
    // Retry with fixed interval — API eventual consistency may delay visibility after prior deletion
    for (let attempt = 0; attempt < 5; attempt++) {
      const policies = await listAllPolicies(policyEngineId);
      const match = policies.find((ep) => ep.name === p.name);
      if (match) {
        if (match.definition?.cedar?.statement !== p.statement) {
          await client.send(
            new UpdatePolicyCommand({
              policyEngineId,
              policyId: match.policyId!,
              definition: { cedar: { statement: p.statement } },
            }),
          );
          await waitForPolicyActive(policyEngineId, match.policyId);
          console.log(`Updated adopted policy ${p.name}:`, match.policyId);
        }
        return match.policyId!;
      }
      console.log(`Policy ${p.name} not yet visible in list (attempt ${attempt + 1}), waiting...`);
      await new Promise((r) => setTimeout(r, 3_000));
    }
    throw new Error(`Policy '${p.name}' reported as existing but not found after retries`, { cause: e });
  }
}

async function waitForPolicyEngineActive(policyEngineId: string, maxAttempts = 30): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    const result = await client.send(new GetPolicyEngineCommand({ policyEngineId }));
    console.log(`Policy engine status (attempt ${i + 1}):`, result.status);
    if (result.status === 'ACTIVE') return;
    if (result.status === 'CREATE_FAILED' || result.status === 'FAILED') {
      throw new Error(`Policy engine creation failed: ${result.statusReasons?.join(', ')}`);
    }
    await new Promise((r) => setTimeout(r, 5_000));
  }
  throw new Error(`Policy engine did not become ACTIVE after ${maxAttempts} attempts`);
}

async function waitForPolicyActive(policyEngineId: string, policyId: string, maxAttempts = 30): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    const result = await client.send(new GetPolicyCommand({ policyEngineId, policyId }));
    if (result.status === 'ACTIVE') return;
    if (result.status === 'CREATE_FAILED' || result.status === 'UPDATE_FAILED') {
      throw new Error(`Policy ${policyId} failed: ${result.statusReasons?.join(', ')}`);
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error(`Policy ${policyId} did not become ACTIVE after ${maxAttempts} attempts`);
}

async function waitForPolicyDeleted(policyEngineId: string, policyId: string, maxAttempts = 30): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const result = await client.send(new GetPolicyCommand({ policyEngineId, policyId }));
      if (result.status === 'DELETE_FAILED') {
        throw new Error(`Policy ${policyId} delete failed: ${result.statusReasons?.join(', ')}`);
      }
      await new Promise((r) => setTimeout(r, 2_000));
    } catch (e: unknown) {
      if ((e as { name?: string }).name === 'ResourceNotFoundException') return;
      throw e;
    }
  }
  throw new Error(`Policy ${policyId} was not deleted after ${maxAttempts} attempts`);
}
