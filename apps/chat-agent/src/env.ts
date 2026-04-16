/**
 * chat-agent 環境変数バリデーション
 *
 * dotenvで .env.local を読み込み、zodでバリデーションする。
 * process.env を直接参照するのはこのファイルだけ。
 */

import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  PORT: z.string().default('8080'),
  NODE_ENV: z.string().default('development'),
  AWS_REGION: z.string().default('ap-northeast-1'),
  AWS_PROFILE: z.string().optional(),
  AGENTCORE_GATEWAY_URL: z.string().default(''),
  AGENTCORE_MEMORY_ID: z.string().optional(),
  BEDROCK_MODEL_ID: z.string().default('global.anthropic.claude-sonnet-4-6'),
  TITLE_MODEL_ID: z.string().default('global.anthropic.claude-haiku-4-5-20251001-v1:0'),
  CLOUDTRAIL_EVENT_DATA_STORE_ID: z.string().optional(),
  DSQL_ENDPOINT: z.string().optional(),
  CONVERSATION_WINDOW_SIZE: z.coerce.number().default(40),
  IDC_APPLICATION_ARN: z.string().optional(),
});

export const env = envSchema.parse(process.env);
