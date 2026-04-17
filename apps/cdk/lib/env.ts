/**
 * CDK 環境変数バリデーション
 *
 * cdk.ts が環境名に応じた .env.local ファイルを dotenv で読み込んだ後、
 * loadEnv() を呼び出して process.env をバリデーションする。
 */

import { config } from 'dotenv';
import { resolve } from 'path';
import { z } from 'zod';

const envSchema = z.object({
  // CDK実行環境（AWS CLIプロファイルから自動設定）
  CDK_DEFAULT_REGION: z.string().default('ap-northeast-1'),
  CDK_DEFAULT_ACCOUNT: z.string().min(1),

  // Phase 2: 必須
  IDC_INSTANCE_ARN: z.string().min(1),

  // Phase 4: SAML Application作成後
  IDC_SAML_METADATA_URL: z.string().optional(),
  IDC_APPLICATION_ARN: z.string().optional(),

  // Phase 5: SMUSドメイン作成後
  SMUS_DOMAIN_ID: z.string().optional(),

  // sync-env.sh で自動設定
  IDENTITY_STORE_ID: z.string().optional(),
  IDC_PORTAL_URL: z.string().optional(),

  // オプション
  DOMAIN_NAME: z.string().optional(),
  BEDROCK_MODEL_ID: z.string().optional(),
  ENABLE_TIME_SERIES: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
});

export type Env = z.infer<typeof envSchema>;

/**
 * 環境名に応じた .env.local ファイルを読み込み、バリデーションして返す。
 *
 * @param envName 環境名（例: 'dev', 'stg'）。未指定なら .env.local を読む。
 */
export function loadEnv(envName?: string): Env {
  const fileName = envName ? `.env.local.${envName}` : '.env.local';
  config({ path: resolve(__dirname, '..', '..', '..', fileName), override: true });
  return envSchema.parse(process.env);
}
