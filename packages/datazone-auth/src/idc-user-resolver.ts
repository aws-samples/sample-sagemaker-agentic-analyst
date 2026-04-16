/**
 * IdCユーザーID解決ユーティリティ
 *
 * email/userName → IdCユーザーID解決
 * キャッシュは呼び出し側の責務
 */

import {
  IdentitystoreClient,
  GetUserIdCommand,
  ListGroupMembershipsForMemberCommand,
  DescribeGroupCommand,
} from '@aws-sdk/client-identitystore';

/**
 * email → IdCユーザーIDを取得
 * GetUserId APIのemails.valueで直接検索（UserName形式に依存しない）
 */
export async function resolveIdcUserIdByEmail(identityStoreId: string, email: string, region: string): Promise<string> {
  const client = new IdentitystoreClient({ region });

  const res = await client.send(
    new GetUserIdCommand({
      IdentityStoreId: identityStoreId,
      AlternateIdentifier: {
        UniqueAttribute: { AttributePath: 'emails.value', AttributeValue: email },
      },
    }),
  );
  if (!res.UserId) throw new Error(`IdC user not found for email: ${email}`);
  return res.UserId;
}

/**
 * userName → IdCユーザーIDを取得（IAM認証時用）
 */
export async function resolveIdcUserIdByUserName(
  identityStoreId: string,
  userName: string,
  region: string,
): Promise<string> {
  const client = new IdentitystoreClient({ region });
  const userRes = await client.send(
    new GetUserIdCommand({
      IdentityStoreId: identityStoreId,
      AlternateIdentifier: {
        UniqueAttribute: { AttributePath: 'userName', AttributeValue: userName },
      },
    }),
  );
  if (!userRes.UserId) throw new Error(`IdC user not found: ${userName}`);
  return userRes.UserId;
}

/**
 * IdCユーザーのグループ名一覧を取得
 */
export async function resolveIdcGroups(identityStoreId: string, idcUserId: string, region: string): Promise<string[]> {
  const client = new IdentitystoreClient({ region });

  const memberships = await client.send(
    new ListGroupMembershipsForMemberCommand({
      IdentityStoreId: identityStoreId,
      MemberId: { UserId: idcUserId },
    }),
  );
  const groupIds = memberships.GroupMemberships?.map((m) => m.GroupId).filter(Boolean) as string[];
  if (!groupIds?.length) return [];

  const groups: string[] = [];
  for (const groupId of groupIds) {
    const group = await client.send(new DescribeGroupCommand({ IdentityStoreId: identityStoreId, GroupId: groupId }));
    if (group.DisplayName) groups.push(group.DisplayName);
  }
  return groups;
}
