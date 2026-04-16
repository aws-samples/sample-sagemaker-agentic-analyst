/**
 * webapp 環境変数バリデーション
 *
 * Next.jsビルトインで .env.local を読み込み済み。zodでバリデーションする。
 * process.env を直接参照するのはこのファイルと amplifyServerUtils.ts だけ。
 */

import { z } from 'zod';

const envSchema = z.object({
  // Cognito認証
  COGNITO_DOMAIN: z.string().min(1),
  USER_POOL_ID: z.string().min(1),
  USER_POOL_CLIENT_ID: z.string().min(1),
  // カスタムドメインありの場合は直接設定、なしの場合はSSMパラメータ経由で動的取得
  // （amplifyServerUtils.tsがAMPLIFY_APP_ORIGIN_SOURCE_PARAMETERから取得してprocess.envに設定）
  AMPLIFY_APP_ORIGIN: z.string().min(1).optional(),

  // リージョン
  AWS_REGION: z.string().default('ap-northeast-1'),
  NEXT_PUBLIC_AWS_REGION: z.string().default('ap-northeast-1'),

  // AgentCore
  AGENTCORE_RUNTIME_ARN: z.string().optional(),
  AGENTCORE_ENDPOINT: z.string().optional(),
  AGENTCORE_MEMORY_ID: z.string().optional(),

  // DataZone
  DATAZONE_DOMAIN_ID: z.string().optional(),

  // IdC
  IDC_PORTAL_URL: z.string().optional(),
  IDC_IDENTITY_STORE_ID: z.string().optional(),
  IDC_APPLICATION_ARN: z.string().optional(),

  // CloudTrail
  CLOUDTRAIL_EVENT_DATA_STORE_ID: z.string().optional(),

  // DSQL
  DSQL_ENDPOINT: z.string().optional(),

  // その他
  AWS_ACCOUNT_ID: z.string().optional(),

  // Lambda本番環境: SSMからAMPLIFY_APP_ORIGINを動的取得するためのパラメータ名
  AMPLIFY_APP_ORIGIN_SOURCE_PARAMETER: z.string().optional(),
});

export const env = envSchema.parse(process.env);
