import { describe, it, expect } from 'vitest';
import { getPropagatedHeaders, getProjectIdFromHeaders, getIdTokenFromHeaders } from '../../lib/types';
import type { Context } from 'aws-lambda';

function createContext(propagatedHeaders?: Record<string, string>): Context {
  return {
    clientContext: {
      custom: {
        ...(propagatedHeaders !== undefined && {
          bedrockAgentCorePropagatedHeaders: JSON.stringify(propagatedHeaders),
        }),
      },
    },
  } as unknown as Context;
}

describe('getPropagatedHeaders', () => {
  it('JSON文字列のヘッダーをパースする', () => {
    const ctx = createContext({ 'x-sagemaker-project-id': 'proj-123' });
    expect(getPropagatedHeaders(ctx)).toEqual({ 'x-sagemaker-project-id': 'proj-123' });
  });

  it('ヘッダーが未設定の場合は空オブジェクトを返す', () => {
    const ctx = { clientContext: { custom: {} } } as unknown as Context;
    expect(getPropagatedHeaders(ctx)).toEqual({});
  });

  it('clientContextがない場合は空オブジェクトを返す', () => {
    const ctx = {} as unknown as Context;
    expect(getPropagatedHeaders(ctx)).toEqual({});
  });
});

describe('getProjectIdFromHeaders', () => {
  it('x-sagemaker-project-idを取得する', () => {
    const ctx = createContext({ 'x-sagemaker-project-id': 'proj-abc' });
    expect(getProjectIdFromHeaders(ctx)).toBe('proj-abc');
  });

  it('ヘッダーがない場合はundefinedを返す', () => {
    const ctx = createContext({});
    expect(getProjectIdFromHeaders(ctx)).toBeUndefined();
  });
});

describe('getIdTokenFromHeaders', () => {
  it('x-cognito-id-tokenを取得する', () => {
    const ctx = createContext({ 'x-cognito-id-token': 'eyJhbGciOi...' });
    expect(getIdTokenFromHeaders(ctx)).toBe('eyJhbGciOi...');
  });

  it('ヘッダーがない場合はundefinedを返す', () => {
    const ctx = createContext({});
    expect(getIdTokenFromHeaders(ctx)).toBeUndefined();
  });
});
