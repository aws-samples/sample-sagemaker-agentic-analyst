/**
 * data-catalog Lambda handler の stg 統合テスト
 *
 * 実際の DataZone API を呼ぶ（デフォルト認証情報チェーン、AWS_REGION=ap-northeast-1 前提）。
 * handler を直接importし、Lambdaにはデプロイしない（design.md「実装の界面」節）。
 * DATAZONE_DOMAIN_ID または INTEG_LISTING_ID が未設定ならdescribe.skipする。
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { handler } from '../../data-catalog/index';
import type { ToolResponse } from '../../lib/types';

const DATAZONE_DOMAIN_ID = process.env.DATAZONE_DOMAIN_ID;
const INTEG_LISTING_ID = process.env.INTEG_LISTING_ID;
const INTEG_PROJECT_ID = process.env.INTEG_PROJECT_ID;
const INTEG_S3_QUERY = process.env.INTEG_S3_QUERY ?? 'public';

/** catalog_detailのformsから除くべきシステム管理formの名前（GlueTableForm/ColumnBusinessMetadataFormは専用欄に整形済み） */
const EXCLUDED_FORM_KEYS = [
  'DataSourceReferenceForm',
  'AssetCommonDetailsForm',
  'ListingSubscriberCountFormType',
  'SubscriptionTermsForm',
  'hasAttached',
  '__DataZoneGlossaryTerms',
  'GlueTableForm',
  'ColumnBusinessMetadataForm',
];

/** tests/unit/data-catalog.test.ts の ctx() を統合テスト用に複製したもの（importはしない） */
function ctx(toolName: string, opts?: { projectId?: string }) {
  const headers: Record<string, string> = {};
  if (opts?.projectId) headers['x-sagemaker-project-id'] = opts.projectId;
  return {
    clientContext: {
      custom: {
        bedrockAgentCoreToolName: `data-catalog___${toolName}`,
        ...(Object.keys(headers).length && {
          bedrockAgentCorePropagatedHeaders: JSON.stringify(headers),
        }),
      },
    },
  } as never;
}

function parseContent(response: ToolResponse): any {
  if (response.error) {
    throw new Error(`handler returned error ${response.error.code}: ${response.error.message}`);
  }
  return JSON.parse(response.result!.content[0].text);
}

const skip = !DATAZONE_DOMAIN_ID || !INTEG_LISTING_ID;

(skip ? describe.skip : describe)('data-catalog stg統合テスト', () => {
  let detail: any;

  beforeAll(async () => {
    const response = await handler({ listingId: INTEG_LISTING_ID }, ctx('catalog_detail'));
    detail = parseContent(response);
  });

  describe('catalog_detail', () => {
    it('description・glossaryTerms・glossaryTermIds・forms・columnsが存在する', () => {
      expect(typeof detail.description).toBe('string');
      expect(detail.description.length).toBeGreaterThan(0);

      expect(Array.isArray(detail.glossaryTerms)).toBe(true);
      expect(detail.glossaryTerms.length).toBeGreaterThan(0);
      for (const term of detail.glossaryTerms) {
        expect(typeof term.name).toBe('string');
        expect(term.name.length).toBeGreaterThan(0);
      }

      expect(Array.isArray(detail.glossaryTermIds)).toBe(true);
      expect(detail.glossaryTermIds.length).toBeGreaterThan(0);
      expect(new Set(detail.glossaryTermIds).size).toBe(detail.glossaryTermIds.length);

      const formKeys = Object.keys(detail.forms ?? {});
      expect(formKeys.length).toBeGreaterThanOrEqual(1);
      for (const key of formKeys) {
        expect(EXCLUDED_FORM_KEYS).not.toContain(key);
        expect(key.startsWith('AwsConfigurationForm.')).toBe(false);
      }

      expect(Array.isArray(detail.columns)).toBe(true);
      expect(detail.columns.length).toBeGreaterThan(0);
      for (const column of detail.columns) {
        expect(typeof column.columnName).toBe('string');
        expect(typeof column.dataType).toBe('string');
      }
      expect(detail.columns.some((c: any) => typeof c.businessName === 'string' && c.businessName.length > 0)).toBe(
        true,
      );

      // BatchGetAttributesMetadataがdevロールで拒否される場合はunavailableが載る（それ自体は許容する）
      if (detail.unavailable) {
        expect(Array.isArray(detail.unavailable)).toBe(true);
        for (const entry of detail.unavailable) {
          expect(typeof entry.item).toBe('string');
          expect(typeof entry.reason).toBe('string');
        }
      }
    });
  });

  describe('catalog_definition', () => {
    it('先頭のglossaryTermIdで用語と所属用語集を返す', async () => {
      const glossaryTermId = detail.glossaryTermIds[0];
      const response = await handler({ glossaryTermId }, ctx('catalog_definition'));
      const definition = parseContent(response);

      expect(typeof definition.name).toBe('string');
      expect(definition.name.length).toBeGreaterThan(0);
      expect(typeof definition.longDescription).toBe('string');
      expect(definition.longDescription.length).toBeGreaterThan(0);
      expect(typeof definition.glossary?.name).toBe('string');
      expect(definition.glossary.name.length).toBeGreaterThan(0);
    });

    it('先頭のformsキーでフォーム定義（smithyモデル）を返す', async () => {
      const formTypeName = Object.keys(detail.forms)[0];
      const response = await handler({ formTypeName }, ctx('catalog_definition'));
      const definition = parseContent(response);

      expect(typeof definition.model).toBe('string');
      expect(definition.model.length).toBeGreaterThan(0);
      expect(definition.revision).toBeDefined();
    });
  });

  describe('catalog_search', () => {
    it('S3ObjectCollectionAssetTypeの結果はすべてs3Uriがs3://で始まり、1件以上存在する', async () => {
      const response = await handler({ query: INTEG_S3_QUERY }, ctx('catalog_search', { projectId: INTEG_PROJECT_ID }));
      const results = parseContent(response);
      const s3Results = results.filter((r: any) => r.type === 'S3ObjectCollectionAssetType');

      expect(s3Results.length).toBeGreaterThan(0);
      for (const result of s3Results) {
        expect(typeof result.s3Uri).toBe('string');
        expect(result.s3Uri.startsWith('s3://')).toBe(true);
      }
    });
  });
});
