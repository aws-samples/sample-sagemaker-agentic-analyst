/**
 * Pre Token Generation V2 Lambda
 *
 * IdCグループをCognito Access/ID Tokenの`cognito:groups`クレームに埋め込む。
 * Policy EngineがJWTクレームだけでツール認可を行えるようにする。
 */

import type { PreTokenGenerationV2TriggerEvent, PreTokenGenerationV2TriggerHandler } from 'aws-lambda';
import type { IdentitystoreClient } from '@aws-sdk/client-identitystore';

const IDENTITY_STORE_ID = process.env.IDENTITY_STORE_ID!;
const AWS_REGION = process.env.AWS_REGION ?? 'us-west-2';

// 動的importでバンドルサイズを最適化（コールドスタート時のみ）
// oxlint-disable-next-line no-redundant-type-constituents -- --type-checkなしでは型が解決できず誤検知する
let cachedClient: IdentitystoreClient | undefined;

async function getClient() {
  if (!cachedClient) {
    const { IdentitystoreClient } = await import('@aws-sdk/client-identitystore');
    cachedClient = new IdentitystoreClient({ region: AWS_REGION });
  }
  return cachedClient;
}

/**
 * email → IdCユーザーID → グループ名一覧を取得
 */
async function resolveIdcGroups(email: string): Promise<string[]> {
  const { GetUserIdCommand, ListGroupMembershipsForMemberCommand, DescribeGroupCommand } =
    await import('@aws-sdk/client-identitystore');
  const client = await getClient();

  // email → IdCユーザーID
  let userId: string;
  try {
    const res = await client.send(
      new GetUserIdCommand({
        IdentityStoreId: IDENTITY_STORE_ID,
        AlternateIdentifier: {
          UniqueAttribute: {
            AttributePath: 'emails.value',
            AttributeValue: email,
          },
        },
      }),
    );
    userId = res.UserId!;
  } catch {
    // IdCに存在しないユーザー（Cognito直接登録）→ グループ空
    return [];
  }

  // IdCユーザーID → グループメンバーシップ
  const memberships = await client.send(
    new ListGroupMembershipsForMemberCommand({
      IdentityStoreId: IDENTITY_STORE_ID,
      MemberId: { UserId: userId },
    }),
  );

  // グループID → グループ名
  const groups: string[] = [];
  for (const m of memberships.GroupMemberships ?? []) {
    const group = await client.send(
      new DescribeGroupCommand({
        IdentityStoreId: IDENTITY_STORE_ID,
        GroupId: m.GroupId!,
      }),
    );
    if (group.DisplayName) groups.push(group.DisplayName);
  }

  return groups;
}

export const handler: PreTokenGenerationV2TriggerHandler = async (event: PreTokenGenerationV2TriggerEvent) => {
  const email = event.request.userAttributes.email ?? event.userName;

  const groups = await resolveIdcGroups(email);
  console.log(JSON.stringify({ event: 'PreTokenGen', email, groups }));

  // cedar_groups: 区切り文字付き文字列。Cedar の like "*|group|*" パターンで完全一致照合するため。
  // cognito:groups（JSON配列）はAgentCoreのtags文字列化形式が未文書化のため、独自クレームで制御する。
  const cedarGroups = groups.length > 0 ? `|${groups.join('|')}|` : '';

  event.response = {
    claimsAndScopeOverrideDetails: {
      accessTokenGeneration: {
        claimsToAddOrOverride: { cedar_groups: cedarGroups },
        claimsToSuppress: [],
        scopesToAdd: [],
        scopesToSuppress: [],
        groupsToOverride: groups,
      },
      idTokenGeneration: {
        claimsToAddOrOverride: { cedar_groups: cedarGroups },
        claimsToSuppress: [],
        groupsToOverride: groups,
      },
      groupOverrideDetails: {
        groupsToOverride: groups,
      },
    },
  };

  return event;
};
