/**
 * E2E: RedeemAccessTokenフローによるユーザー別プロジェクトロール取得とFGAC検証
 *
 * 検証内容:
 *   1. フロー正常系: 各ユーザーが所属プロジェクトのプロジェクトロールを取得できる
 *   2. 監査可能性: セッション名にIdCユーザーIDが含まれる
 *   3. プロジェクト分離: 異なるユーザーが異なるプロジェクトロールを取得する
 *   4. クロスプロジェクト拒否: 非所属プロジェクトの環境にはアクセスできない
 *   5. Athenaクエリ実行: 取得したプロジェクトロールで実際にクエリが成功する
 *   6. Lake Formation FGAC: data-ownerとbusiness-analystで見えるデータが異なる
 *   7. CreateTokenWithIAMトークン制約: 同一jtiのID Token再利用が拒否される
 *
 * 前提:
 *   - source .env.credentials で認証情報をロード済み
 *   - OAuth CMAに datazone:domain:access スコープが設定済み
 *
 * 実行:
 *   source .env.credentials && pnpm run test:e2e
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { CognitoIdentityProviderClient, InitiateAuthCommand } from '@aws-sdk/client-cognito-identity-provider';
import { SSOOIDCClient, CreateTokenWithIAMCommand } from '@aws-sdk/client-sso-oidc';
import { DataZoneClient, GetEnvironmentCredentialsCommand } from '@aws-sdk/client-datazone';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import {
  AthenaClient,
  StartQueryExecutionCommand,
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
} from '@aws-sdk/client-athena';

// --- 環境変数から取得（.env.credentials + CDK Outputs） ---
// すべて環境変数必須。フォールバック値は設けない（環境依存のハードコードを防止）
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`環境変数 ${name} が未設定です。source .env.credentials を実行してください。`);
  return value;
}

const REGION = requireEnv('AWS_REGION');
const USER_POOL_CLIENT_ID = requireEnv('USER_POOL_CLIENT_ID');
const IDC_APPLICATION_ARN = requireEnv('IDC_APPLICATION_ARN');
const DOMAIN_ID = requireEnv('DATAZONE_DOMAIN_ID');
// プロジェクトごとのLakehouse DB環境が自動作成するGlueデータベース（環境ごとに異なる）
const PRODUCER_GLUE_DB = requireEnv('E2E_PRODUCER_GLUE_DB');
const CONSUMER_GLUE_DB = requireEnv('E2E_CONSUMER_GLUE_DB');
const DZ_ENDPOINT = `https://datazone.${REGION}.api.aws`;

const cognito = new CognitoIdentityProviderClient({ region: REGION });
const ssoOidc = new SSOOIDCClient({ region: REGION });

interface TestUser {
  name: string;
  username: string;
  passwordEnvVar: string;
  environmentId: string;
  projectId: string;
}

const DATA_OWNER: TestUser = {
  name: 'dg-data-owner',
  username: requireEnv('E2E_DATA_OWNER_USERNAME'),
  passwordEnvVar: 'IDC_DATA_OWNER_PASSWORD',
  environmentId: requireEnv('E2E_DATA_OWNER_ENVIRONMENT_ID'),
  projectId: requireEnv('E2E_DATA_OWNER_PROJECT_ID'),
};

const BUSINESS_ANALYST: TestUser = {
  name: 'dg-business-analyst',
  username: requireEnv('E2E_BUSINESS_ANALYST_USERNAME'),
  passwordEnvVar: 'IDC_BUSINESS_ANALYST_PASSWORD',
  environmentId: requireEnv('E2E_BUSINESS_ANALYST_ENVIRONMENT_ID'),
  projectId: requireEnv('E2E_BUSINESS_ANALYST_PROJECT_ID'),
};

const TEST_USERS = [DATA_OWNER, BUSINESS_ANALYST];

// --- ヘルパー ---

interface DerCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
}

/** Cognito認証 → CreateTokenWithIAM → RedeemAccessToken でDER credsを取得 */
async function getDerCredentials(user: TestUser): Promise<DerCredentials> {
  const password = process.env[user.passwordEnvVar];
  if (!password) throw new Error(`${user.passwordEnvVar} not set`);

  const authRes = await cognito.send(
    new InitiateAuthCommand({
      AuthFlow: 'USER_PASSWORD_AUTH',
      ClientId: USER_POOL_CLIENT_ID,
      AuthParameters: { USERNAME: user.username, PASSWORD: password },
    }),
  );

  const tokenRes = await ssoOidc.send(
    new CreateTokenWithIAMCommand({
      clientId: IDC_APPLICATION_ARN,
      grantType: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: authRes.AuthenticationResult!.IdToken!,
    }),
  );

  const redeemRes = await fetch(`${DZ_ENDPOINT}/sso/redeem-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ domainId: DOMAIN_ID, accessToken: tokenRes.accessToken }),
  });
  if (!redeemRes.ok) {
    throw new Error(`RedeemAccessToken failed: ${redeemRes.status} ${await redeemRes.text()}`);
  }
  const { credentials } = (await redeemRes.json()) as { credentials: DerCredentials };
  return credentials;
}

/** DER creds → GetEnvironmentCredentials → プロジェクトロール creds */
async function getProjectRoleCredentials(
  derCreds: DerCredentials,
  environmentId: string,
): Promise<{ accessKeyId: string; secretAccessKey: string; sessionToken: string }> {
  const dz = new DataZoneClient({
    region: REGION,
    credentials: {
      accessKeyId: derCreds.accessKeyId,
      secretAccessKey: derCreds.secretAccessKey,
      sessionToken: derCreds.sessionToken,
    },
  });
  const res = await dz.send(
    new GetEnvironmentCredentialsCommand({
      domainIdentifier: DOMAIN_ID,
      environmentIdentifier: environmentId,
    }),
  );
  return {
    accessKeyId: res.accessKeyId!,
    secretAccessKey: res.secretAccessKey!,
    sessionToken: res.sessionToken!,
  };
}

/** GetCallerIdentity でロール名とセッション名を取得 */
async function getCallerIdentity(creds: { accessKeyId: string; secretAccessKey: string; sessionToken: string }) {
  const sts = new STSClient({ region: REGION, credentials: creds });
  const res = await sts.send(new GetCallerIdentityCommand({}));
  const parts = res.Arn!.split('/');
  return { roleName: parts[1], sessionName: parts[2], fullArn: res.Arn! };
}

/** Athenaクエリを実行して結果行数を返す */
async function runAthenaQuery(
  creds: { accessKeyId: string; secretAccessKey: string; sessionToken: string },
  workgroup: string,
  sql: string,
  database: string,
): Promise<{ rowCount: number; columns: string[] }> {
  const athena = new AthenaClient({ region: REGION, credentials: creds });

  const startRes = await athena.send(
    new StartQueryExecutionCommand({
      QueryString: sql,
      QueryExecutionContext: { Database: database },
      WorkGroup: workgroup,
    }),
  );
  const queryId = startRes.QueryExecutionId!;

  // ポーリング
  for (let i = 0; i < 60; i++) {
    const execRes = await athena.send(new GetQueryExecutionCommand({ QueryExecutionId: queryId }));
    const state = execRes.QueryExecution?.Status?.State;
    if (state === 'SUCCEEDED') break;
    if (state === 'FAILED' || state === 'CANCELLED') {
      throw new Error(`Query ${state}: ${execRes.QueryExecution?.Status?.StateChangeReason}`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  const resultRes = await athena.send(new GetQueryResultsCommand({ QueryExecutionId: queryId }));
  const rows = resultRes.ResultSet?.Rows ?? [];
  const columns = rows[0]?.Data?.map((d) => d.VarCharValue ?? '') ?? [];
  return { rowCount: Math.max(0, rows.length - 1), columns }; // ヘッダー行を除く
}

// --- テスト ---

describe('RedeemAccessToken → GetEnvironmentCredentials', () => {
  // DER credsをキャッシュ（CreateTokenWithIAMは同一JWTの再利用不可のため）
  const derCredsCache = new Map<string, DerCredentials>();
  const projectCredsCache = new Map<string, { accessKeyId: string; secretAccessKey: string; sessionToken: string }>();

  beforeAll(async () => {
    // 全ユーザーのDER credsを事前取得
    for (const user of TEST_USERS) {
      const derCreds = await getDerCredentials(user);
      derCredsCache.set(user.name, derCreds);
      const projectCreds = await getProjectRoleCredentials(derCreds, user.environmentId);
      projectCredsCache.set(user.name, projectCreds);
    }
  }, 60_000);

  // --- 1. フロー正常系 ---
  describe('フロー正常系', () => {
    for (const user of TEST_USERS) {
      it(`${user.name}: 所属プロジェクトのプロジェクトロールを取得できる`, async () => {
        const creds = projectCredsCache.get(user.name)!;
        const identity = await getCallerIdentity(creds);

        expect(identity.roleName).toContain(user.projectId);
        expect(identity.roleName).toContain(user.environmentId);
      });
    }
  });

  // --- 2. 監査可能性 ---
  describe('監査可能性', () => {
    for (const user of TEST_USERS) {
      it(`${user.name}: セッション名が {IdCユーザーID}@{環境ID} 形式`, async () => {
        const creds = projectCredsCache.get(user.name)!;
        const identity = await getCallerIdentity(creds);

        // UUID@environmentId 形式
        const [idcUserId, envId] = identity.sessionName.split('@');
        expect(idcUserId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
        expect(envId).toBe(user.environmentId);
      });
    }
  });

  // --- 3. プロジェクト分離 ---
  it('異なるユーザーが異なるプロジェクトロールを取得する', async () => {
    const ownerIdentity = await getCallerIdentity(projectCredsCache.get(DATA_OWNER.name)!);
    const analystIdentity = await getCallerIdentity(projectCredsCache.get(BUSINESS_ANALYST.name)!);

    expect(ownerIdentity.roleName).not.toBe(analystIdentity.roleName);
    // セッション名のIdCユーザーIDも異なる
    expect(ownerIdentity.sessionName.split('@')[0]).not.toBe(analystIdentity.sessionName.split('@')[0]);
  });

  // --- 4. クロスプロジェクト拒否 ---
  describe('クロスプロジェクト拒否', () => {
    it('dg-business-analyst が dg-data-owner のプロジェクト環境にアクセスできない', async () => {
      const analystDerCreds = derCredsCache.get(BUSINESS_ANALYST.name)!;

      await expect(getProjectRoleCredentials(analystDerCreds, DATA_OWNER.environmentId)).rejects.toThrow(
        'not permitted',
      );
    });

    // 注意: dg-data-ownerはanalyst-data-accessのPROJECT_OWNERでもあるため、
    // 逆方向のクロスプロジェクト拒否テストは成立しない
  });

  // --- 5. Athenaクエリ実行 ---
  describe('Athenaクエリ実行', () => {
    it('dg-data-owner: プロジェクトロールでAthenaクエリが成功する', async () => {
      const creds = projectCredsCache.get(DATA_OWNER.name)!;
      const workgroup = `workgroup-${DATA_OWNER.projectId}-${DATA_OWNER.environmentId}`;

      const result = await runAthenaQuery(creds, workgroup, 'SELECT 1 AS test_col', PRODUCER_GLUE_DB);
      expect(result.rowCount).toBe(1);
      expect(result.columns).toContain('test_col');
    }, 30_000);

    it('dg-data-owner: 実テーブルへのクエリが成功する', async () => {
      const creds = projectCredsCache.get(DATA_OWNER.name)!;
      const workgroup = `workgroup-${DATA_OWNER.projectId}-${DATA_OWNER.environmentId}`;

      const result = await runAthenaQuery(
        creds,
        workgroup,
        'SELECT * FROM retail_sales_performance LIMIT 1',
        PRODUCER_GLUE_DB,
      );
      expect(result.rowCount).toBeGreaterThanOrEqual(0); // テーブルが空でもエラーにならないこと
    }, 30_000);
  });

  // --- 6. Lake Formation FGAC ---
  describe('Lake Formation FGAC', () => {
    it('dg-data-owner: 機密テーブル（sales_rep_performance）にアクセスできる', async () => {
      const creds = projectCredsCache.get(DATA_OWNER.name)!;
      const workgroup = `workgroup-${DATA_OWNER.projectId}-${DATA_OWNER.environmentId}`;

      const result = await runAthenaQuery(
        creds,
        workgroup,
        'SELECT * FROM sales_rep_performance LIMIT 1',
        PRODUCER_GLUE_DB,
      );
      expect(result.rowCount).toBeGreaterThanOrEqual(0);
    }, 30_000);

    it('dg-business-analyst: 一般テーブル（store_details）にアクセスできる', async () => {
      const creds = projectCredsCache.get(BUSINESS_ANALYST.name)!;
      const workgroup = `workgroup-${BUSINESS_ANALYST.projectId}-${BUSINESS_ANALYST.environmentId}`;

      const result = await runAthenaQuery(creds, workgroup, 'SELECT * FROM store_details LIMIT 1', CONSUMER_GLUE_DB);
      expect(result.rowCount).toBeGreaterThanOrEqual(0);
    }, 30_000);

    it('dg-business-analyst: 機密テーブル（sales_rep_performance）にアクセスが拒否される', async () => {
      const creds = projectCredsCache.get(BUSINESS_ANALYST.name)!;
      const workgroup = `workgroup-${BUSINESS_ANALYST.projectId}-${BUSINESS_ANALYST.environmentId}`;

      await expect(
        runAthenaQuery(creds, workgroup, 'SELECT * FROM sales_rep_performance LIMIT 1', CONSUMER_GLUE_DB),
      ).rejects.toThrow(/Lake Formation|permission|AccessDenied/i);
    }, 30_000);
  });

  // --- 7. CreateTokenWithIAMのトークン再利用制約 ---
  describe('CreateTokenWithIAMトークン制約', () => {
    it('同一jtiのID Tokenを再利用するとInvalidGrantExceptionになる', async () => {
      const password = process.env[DATA_OWNER.passwordEnvVar];
      if (!password) throw new Error(`${DATA_OWNER.passwordEnvVar} not set`);

      // 同一のID Tokenを取得（forceRefreshなし = 同じjti）
      const authRes = await cognito.send(
        new InitiateAuthCommand({
          AuthFlow: 'USER_PASSWORD_AUTH',
          ClientId: USER_POOL_CLIENT_ID,
          AuthParameters: { USERNAME: DATA_OWNER.username, PASSWORD: password },
        }),
      );
      const idToken = authRes.AuthenticationResult!.IdToken!;

      // 1回目: 成功
      await ssoOidc.send(
        new CreateTokenWithIAMCommand({
          clientId: IDC_APPLICATION_ARN,
          grantType: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion: idToken,
        }),
      );

      // 2回目: 同一jtiで失敗（InvalidGrantException、メッセージは "Unknown"）
      await expect(
        ssoOidc.send(
          new CreateTokenWithIAMCommand({
            clientId: IDC_APPLICATION_ARN,
            grantType: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion: idToken,
          }),
        ),
      ).rejects.toThrow(/InvalidGrant|Unknown/);
    }, 30_000);
  });
});
