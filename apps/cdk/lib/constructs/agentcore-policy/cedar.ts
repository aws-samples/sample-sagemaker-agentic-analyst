/**
 * Cedar ポリシー文生成（純粋関数）
 *
 * AgentCore Policy Engine 用の Cedar ポリシー文を生成する。
 * AWS SDK 依存なし、副作用なし。
 */

/**
 * cedar_groups × ツール名のマトリクスで permit 文を生成する。
 *
 * @param gatewayArn - Gateway ARN（resource条件に使用）
 * @param group - Cognito グループ名（like "*|{group}|*" パターンで照合）
 * @param tools - 許可するツールアクション（"target___tool" 形式）
 */
export function generateCedarStatement(gatewayArn: string, group: string, tools: string[]): string {
  const actionConditions = tools.map((t) => `action == AgentCore::Action::"${t}"`).join(' ||\n   ');

  return `permit(
  principal is AgentCore::OAuthUser, action,
  resource == AgentCore::Gateway::"${gatewayArn}"
) when {
  principal.hasTag("cedar_groups") &&
  principal.getTag("cedar_groups") like "*|${group}|*" &&
  (${actionConditions})
};`;
}
