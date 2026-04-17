#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { RemovalPolicies, Tags } from 'aws-cdk-lib';
import { AgenticAnalystStack } from '../lib/main-stack';
import { AgenticAnalystUsEast1Stack } from '../lib/us-east-1-stack';
import { AgenticAnalystIdStoreStack } from '../lib/id-store-stack';
import { loadEnv } from '../lib/env';

const app = new cdk.App();

// -c env=dev のように環境名を指定（未指定なら無印環境）
const envName: string | undefined = app.node.tryGetContext('env') || undefined;
const prefix = envName ? `${envName}-` : '';

const env = loadEnv(envName);

// 全スタック共通タグ
Tags.of(app).add('Application', 'Agentic Analyst');
if (envName) {
  Tags.of(app).add('Environment', envName);
}

// 全スタックをdestroyable
RemovalPolicies.of(app).destroy();

const region = env.CDK_DEFAULT_REGION;
const account = env.CDK_DEFAULT_ACCOUNT;

// IdStoreスタック（Cognito） — SAML Application作成前にデプロイが必要
const idStore = new AgenticAnalystIdStoreStack(app, `${prefix}AgenticAnalystIdStore`, {
  env: { account, region },
  idcInstanceArn: env.IDC_INSTANCE_ARN,
  idcSamlMetadataUrl: env.IDC_SAML_METADATA_URL,
  idcApplicationArn: env.IDC_APPLICATION_ARN,
  identityStoreId: env.IDENTITY_STORE_ID,
});

// us-east-1スタック（Lambda@Edge用）
const usEast1 = new AgenticAnalystUsEast1Stack(app, `${prefix}AgenticAnalystUsEast1`, {
  env: { account, region: 'us-east-1' },
  crossRegionReferences: true,
  domainName: env.DOMAIN_NAME,
});

// メインスタック
new AgenticAnalystStack(app, `${prefix}AgenticAnalyst`, {
  env: { account, region },
  crossRegionReferences: true,
  sharedCertificate: usEast1.certificate,
  domainName: env.DOMAIN_NAME,
  signPayloadHandler: usEast1.signPayloadHandler,
  idcInstanceArn: env.IDC_INSTANCE_ARN,
  identityStoreId: env.IDENTITY_STORE_ID ?? '',
  datazoneDomainId: env.SMUS_DOMAIN_ID ?? '',
  idcPortalUrl: env.IDC_PORTAL_URL,
  idcSamlMetadataUrl: env.IDC_SAML_METADATA_URL,
  userPool: idStore.userPool,
  userPoolClient: idStore.userPoolClient,
  cognitoDomainName: idStore.domainName,
  idcApplicationArn: idStore.idcApplicationArn,
  bedrockModelId: env.BEDROCK_MODEL_ID,
  envName,
  enableTimeSeries: env.ENABLE_TIME_SERIES,
});
