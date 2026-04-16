/**
 * Athena直接クエリクライアント
 *
 * RedeemAccessToken経由でプロジェクトロールの認証情報を取得し、
 * SMUS Pub/Sub FGACが適用されたAthenaクエリを実行する。
 */

import {
  AthenaClient,
  StartQueryExecutionCommand,
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
  QueryExecutionState,
} from '@aws-sdk/client-athena';
import { DataZoneClient, GetEnvironmentCommand } from '@aws-sdk/client-datazone';
import { getProjectCredentials } from './project-credentials';
import { env } from './env';

export interface AthenaClientConfig {
  datazoneDomainId: string;
  environmentId: string;
  database: string;
  region?: string;
  /** Cognito ID Token（RedeemAccessTokenフローに必須） */
  idToken?: string;
}

export interface QueryResult {
  columns: string[];
  rows: Record<string, string>[];
}

export class ProjectAthenaClient {
  private config: AthenaClientConfig;
  private region: string;

  constructor(config: AthenaClientConfig) {
    this.config = config;
    this.region = config.region ?? env.AWS_REGION;
  }

  async executeQuery(sql: string): Promise<QueryResult> {
    // Workgroup名を環境情報から取得
    const envResponse = await new DataZoneClient({ region: this.region }).send(
      new GetEnvironmentCommand({
        domainIdentifier: this.config.datazoneDomainId,
        identifier: this.config.environmentId,
      }),
    );
    const workgroupResource = envResponse.provisionedResources?.find((r) => r.name === 'athenaWorkGroupName');
    if (!workgroupResource?.value) {
      throw new Error('Athena workgroup not found in environment provisionedResources');
    }

    if (!this.config.idToken) {
      throw new Error('idToken is required for RedeemAccessToken flow');
    }

    if (!env.IDC_APPLICATION_ARN) {
      throw new Error('IDC_APPLICATION_ARN is required for RedeemAccessToken flow');
    }

    // 共通モジュールでプロジェクトロール認証情報を取得
    const credentials = await getProjectCredentials(
      this.config.datazoneDomainId,
      this.config.environmentId,
      this.config.idToken,
      this.region,
      env.IDC_APPLICATION_ARN,
    );

    const athena = new AthenaClient({ region: this.region, credentials });

    const queryExecutionId = await this.startQuery(athena, sql, workgroupResource.value);
    await this.waitForCompletion(athena, queryExecutionId);
    return this.getResults(athena, queryExecutionId);
  }

  private async startQuery(athena: AthenaClient, sql: string, workgroup: string): Promise<string> {
    const response = await athena.send(
      new StartQueryExecutionCommand({
        QueryString: sql,
        QueryExecutionContext: { Database: this.config.database },
        WorkGroup: workgroup,
      }),
    );

    if (!response.QueryExecutionId) {
      throw new Error('StartQueryExecution did not return QueryExecutionId');
    }
    return response.QueryExecutionId;
  }

  private async waitForCompletion(athena: AthenaClient, queryExecutionId: string): Promise<void> {
    const maxAttempts = 60;
    const delayMs = 1000;

    for (let i = 0; i < maxAttempts; i++) {
      const response = await athena.send(new GetQueryExecutionCommand({ QueryExecutionId: queryExecutionId }));

      const state = response.QueryExecution?.Status?.State;

      if (state === QueryExecutionState.SUCCEEDED) return;
      if (state === QueryExecutionState.FAILED || state === QueryExecutionState.CANCELLED) {
        const reason = response.QueryExecution?.Status?.StateChangeReason ?? 'Unknown error';
        throw new Error(`Query ${state}: ${reason}`);
      }

      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    throw new Error('Query execution timeout');
  }

  private async getResults(athena: AthenaClient, queryExecutionId: string): Promise<QueryResult> {
    const response = await athena.send(new GetQueryResultsCommand({ QueryExecutionId: queryExecutionId }));

    const resultSet = response.ResultSet;
    if (!resultSet?.Rows || resultSet.Rows.length === 0) {
      return { columns: [], rows: [] };
    }

    const headerRow = resultSet.Rows[0];
    const columns = headerRow.Data?.map((d) => d.VarCharValue ?? '') ?? [];

    const rows = resultSet.Rows.slice(1).map((row) => {
      const record: Record<string, string> = {};
      row.Data?.forEach((d, i) => {
        record[columns[i]] = d.VarCharValue ?? '';
      });
      return record;
    });

    return { columns, rows };
  }
}
