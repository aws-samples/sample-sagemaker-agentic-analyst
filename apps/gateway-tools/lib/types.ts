/**
 * Gateway Tool Lambda 共通型定義
 *
 * Gateway Lambda Targetの仕様:
 * - event: inputSchema.properties がフラット化されたオブジェクト
 * - context.clientContext.custom.bedrockAgentCoreToolName: ツール名（{target}___{tool}形式）
 * - context.clientContext.custom.bedrockAgentCorePropagatedHeaders: Gatewayが伝播したヘッダー（JSON文字列）
 */

import type { Context } from 'aws-lambda';

/** Gateway → Tool Lambda のフラット化イベント */
export type ToolEvent = Record<string, unknown>;

/** Tool Lambda → Gateway のレスポンス型（JSON-RPC形式を維持） */
export interface ToolResponse {
  jsonrpc: '2.0';
  id?: string | number;
  result?: { content: Array<{ type: string; text: string }> };
  error?: { code: number; message: string };
}

/** Lambda contextからツール名を取得 */
export function getToolName(context: Context): string {
  const full = context.clientContext?.custom?.bedrockAgentCoreToolName ?? '';
  return full.includes('___') ? full.split('___').pop()! : full;
}

/** Lambda contextからGatewayが伝播したヘッダーを取得 */
export function getPropagatedHeaders(context: Context): Record<string, string> {
  const raw = context.clientContext?.custom?.bedrockAgentCorePropagatedHeaders;
  if (!raw) {
    console.warn('No bedrockAgentCorePropagatedHeaders in context');
    return {};
  }
  try {
    const headers = typeof raw === 'string' ? JSON.parse(raw) : raw;
    console.info('Received propagated headers', { headerKeys: Object.keys(headers) });
    return headers;
  } catch {
    console.warn('Failed to parse bedrockAgentCorePropagatedHeaders');
    return {};
  }
}

/** 伝播ヘッダーからProject IDを取得 */
export function getProjectIdFromHeaders(context: Context): string | undefined {
  return getPropagatedHeaders(context)['x-sagemaker-project-id'];
}

/** 伝播ヘッダーからCognito ID Tokenを取得 */
export function getIdTokenFromHeaders(context: Context): string | undefined {
  return getPropagatedHeaders(context)['x-cognito-id-token'];
}

/** 伝播ヘッダーからIdC Access Tokenを取得（chat-agentが一元取得したトークン） */
export function getIdcAccessTokenFromHeaders(context: Context): string | undefined {
  return getPropagatedHeaders(context)['x-idc-access-token'];
}

export function successResponse(text: string): ToolResponse {
  return { jsonrpc: '2.0', result: { content: [{ type: 'text', text }] } };
}

export function errorResponse(code: number, message: string): ToolResponse {
  return { jsonrpc: '2.0', error: { code, message } };
}
