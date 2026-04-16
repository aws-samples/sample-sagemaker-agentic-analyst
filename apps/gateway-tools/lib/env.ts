/**
 * gateway-tools 環境変数バリデーション
 *
 * Lambda単位で必要な変数が異なるため、全変数をoptionalで定義し、
 * 各handlerで必要なキーの存在を確認する。
 * process.env を直接参照するのはこのファイルだけ。
 */

import { z } from 'zod';

const envSchema = z.object({
  AWS_REGION: z.string().default('ap-northeast-1'),
  // data-access, data-catalog
  DATAZONE_DOMAIN_ID: z.string().optional(),
  // cloudtrail-query
  CLOUDTRAIL_EVENT_DATA_STORE_ID: z.string().optional(),
});

export const env = envSchema.parse(process.env);
