/**
 * RedeemAccessToken経由でDomainExecutionRole / プロジェクトロールの一時認証情報を取得する
 *
 * フロー:
 *   Cognito ID Token → CreateTokenWithIAM(jwt-bearer) → IdC Access Token
 *   → RedeemAccessToken → DomainExecutionRole creds (getDomainCredentials)
 *   → GetEnvironmentCredentials → プロジェクトロール creds (getProjectCredentials)
 *
 * キャッシュは呼び出し側の責務（実行環境に依存するため）
 */

import { DataZoneClient, GetEnvironmentCredentialsCommand } from '@aws-sdk/client-datazone';
import { SSOOIDCClient, CreateTokenWithIAMCommand } from '@aws-sdk/client-sso-oidc';

export interface ProjectCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration?: Date;
}

/** DomainExecutionRole認証情報。ProjectCredentialsと同じ構造だがセマンティクスが異なる */
export type DomainCredentials = ProjectCredentials;

interface RedeemTokenResponse {
  credentials: { accessKeyId: string; secretAccessKey: string; sessionToken: string; expiration?: string };
}

/**
 * Step 1のみ: Cognito ID Token → IdC Access Token
 *
 * jtiを消費する唯一の操作。呼び出し元で1回だけ実行し、
 * 得られたIdC Access Tokenを複数のTool Lambdaに伝播する。
 */
export async function exchangeIdToken(jwt: string, region: string, idcApplicationArn: string): Promise<string> {
  const tokenRes = await new SSOOIDCClient({ region }).send(
    new CreateTokenWithIAMCommand({
      clientId: idcApplicationArn,
      grantType: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  );
  if (!tokenRes.accessToken) throw new Error('CreateTokenWithIAM did not return accessToken');
  return tokenRes.accessToken;
}

/**
 * Step 2のみ: IdC Access Token → DomainExecutionRole creds
 *
 * RedeemAccessTokenはjti制約なし。同一IdC Access Tokenで複数回呼び出し可能。
 */
export async function redeemAndGetDomainCredentials(
  domainId: string,
  idcAccessToken: string,
  region: string,
): Promise<DomainCredentials> {
  const redeemRes = await fetch(`https://datazone.${region}.api.aws/sso/redeem-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ domainId, accessToken: idcAccessToken }),
  });
  if (!redeemRes.ok) {
    throw new Error(`RedeemAccessToken failed: ${redeemRes.status} ${await redeemRes.text()}`);
  }
  const { credentials: derCreds } = (await redeemRes.json()) as RedeemTokenResponse;
  return {
    accessKeyId: derCreds.accessKeyId,
    secretAccessKey: derCreds.secretAccessKey,
    sessionToken: derCreds.sessionToken,
    ...(derCreds.expiration && { expiration: new Date(derCreds.expiration) }),
  };
}

/**
 * Step 2-3: IdC Access Token → DER creds → プロジェクトロール creds
 *
 * RedeemAccessToken + GetEnvironmentCredentials。jti制約なし。
 */
export async function redeemAndGetProjectCredentials(
  domainId: string,
  environmentId: string,
  idcAccessToken: string,
  region: string,
): Promise<ProjectCredentials> {
  const derCreds = await redeemAndGetDomainCredentials(domainId, idcAccessToken, region);
  const envCreds = await new DataZoneClient({
    region,
    credentials: {
      accessKeyId: derCreds.accessKeyId,
      secretAccessKey: derCreds.secretAccessKey,
      sessionToken: derCreds.sessionToken,
    },
  }).send(
    new GetEnvironmentCredentialsCommand({
      domainIdentifier: domainId,
      environmentIdentifier: environmentId,
    }),
  );
  if (!envCreds.accessKeyId || !envCreds.secretAccessKey || !envCreds.sessionToken) {
    throw new Error('GetEnvironmentCredentials did not return complete credentials');
  }
  return {
    accessKeyId: envCreds.accessKeyId,
    secretAccessKey: envCreds.secretAccessKey,
    sessionToken: envCreds.sessionToken,
    ...(envCreds.expiration && { expiration: envCreds.expiration }),
  };
}

/**
 * Step 1-2: Cognito ID Token → IdC Access Token → DomainExecutionRole creds
 *
 * 後方互換。内部でexchangeIdToken + redeemAndGetDomainCredentialsを呼ぶ。
 * webapp の /api/query と /api/s3-credentials が使用。
 */
export async function getDomainCredentials(
  domainId: string,
  jwt: string,
  region: string,
  idcApplicationArn: string,
): Promise<DomainCredentials> {
  const idcAccessToken = await exchangeIdToken(jwt, region, idcApplicationArn);
  return redeemAndGetDomainCredentials(domainId, idcAccessToken, region);
}

/**
 * Step 1-2-3: Cognito ID Token → DER creds → プロジェクトロール creds
 *
 * Athena/S3等、プロジェクトロールで呼ぶAPIの認証情報を取得する。
 */
export async function getProjectCredentials(
  domainId: string,
  environmentId: string,
  jwt: string,
  region: string,
  idcApplicationArn: string,
): Promise<ProjectCredentials> {
  const idcAccessToken = await exchangeIdToken(jwt, region, idcApplicationArn);
  return redeemAndGetProjectCredentials(domainId, environmentId, idcAccessToken, region);
}
