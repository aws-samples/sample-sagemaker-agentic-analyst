import { IgnoreMode, Duration, Stack } from 'aws-cdk-lib';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import { DockerImageFunction, Architecture } from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
import { parseDockerignore } from '../utils';
import { CloudFrontLambdaFunctionUrlService } from './cf-lambda-furl-service/service';
import { type IHostedZone } from 'aws-cdk-lib/aws-route53';
import { type Bucket } from 'aws-cdk-lib/aws-s3';
import { type EdgeFunction } from './cf-lambda-furl-service/edge-function';
import { type ICertificate } from 'aws-cdk-lib/aws-certificatemanager';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { type IUserPool, type IUserPoolClient } from 'aws-cdk-lib/aws-cognito';
import { ContainerImageBuild } from '@cdklabs/deploy-time-build';
import { join } from 'path';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import { AwsCustomResource, AwsCustomResourcePolicy, PhysicalResourceId } from 'aws-cdk-lib/custom-resources';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { type Database } from './database';

export interface WebappProps {
  signPayloadHandler: EdgeFunction;
  accessLogBucket: Bucket;

  /** Cognito User Pool */
  userPool: IUserPool;
  /** Cognito User Pool Client */
  userPoolClient: IUserPoolClient;
  /** Cognitoドメイン名 */
  cognitoDomainName: string;

  /** DataZoneドメインID */
  datazoneDomainId?: string;
  /** AgentCore Runtime ARN */
  agentcoreRuntimeArn?: string;
  /** AgentCore Memory ID */
  agentcoreMemoryId?: string;
  /** DSQL Database */
  database?: Database;
  /** IdCポータルURL（サインアウト時のIdCセッション破棄用） */
  idcPortalUrl?: string;
  /** Identity Store ID（メンバーシップ検証用） */
  identityStoreId?: string;
  /** IdC OAuth CMA ARN（TIP用） */
  idcApplicationArn?: string;
  /** CloudTrail Lake Event Data Store ARN（監査ログ検索用） */
  cloudtrailEventDataStoreId?: string;
  /** IdC SAML Metadata URL（設定されている場合、IdP-initiated SSOが有効） */
  idcSamlMetadataUrl?: string;

  /**
   * Route 53 hosted zone for custom domain.
   * @default No custom domain.
   */
  hostedZone?: IHostedZone;
  /**
   * ACM certificate for custom domain (must be in us-east-1 for CloudFront).
   * @default No custom domain.
   */
  certificate?: ICertificate;
  /**
   * Subdomain name for the webapp.
   * @default Use root domain
   */
  subDomain?: string;
}

export class Webapp extends Construct {
  public readonly baseUrl: string;

  constructor(scope: Construct, id: string, props: WebappProps) {
    super(scope, id);

    const { hostedZone, userPool, userPoolClient, cognitoDomainName, subDomain } = props;

    const image = new ContainerImageBuild(this, 'Build', {
      directory: join('..', '..'),
      file: 'apps/webapp/Dockerfile',
      platform: Platform.LINUX_ARM64,
      ignoreMode: IgnoreMode.DOCKER,
      exclude: parseDockerignore(join('..', '..', '.dockerignore')),
      tagPrefix: 'agentic-analyst-',
      buildArgs: {
        ALLOWED_ORIGIN_HOST: hostedZone ? `*.${hostedZone.zoneName}` : '*.cloudfront.net',
        SKIP_TS_BUILD: 'true',
      },
    });

    const logGroup = new LogGroup(this, 'Logs', { retention: RetentionDays.ONE_WEEK });

    const handler = new DockerImageFunction(this, 'Handler', {
      code: image.toLambdaDockerImageCode(),
      timeout: Duration.minutes(3),
      logGroup,
      environment: {
        COGNITO_DOMAIN: cognitoDomainName,
        USER_POOL_ID: userPool.userPoolId,
        USER_POOL_CLIENT_ID: userPoolClient.userPoolClientId,
        AWS_ACCOUNT_ID: Stack.of(this).account,
        ...(props.datazoneDomainId && { DATAZONE_DOMAIN_ID: props.datazoneDomainId }),
        ...(props.agentcoreRuntimeArn && { AGENTCORE_RUNTIME_ARN: props.agentcoreRuntimeArn }),
        ...(props.agentcoreMemoryId && { AGENTCORE_MEMORY_ID: props.agentcoreMemoryId }),
        ...(props.database && { DSQL_ENDPOINT: props.database.endpoint }),
        ...(props.idcPortalUrl && { IDC_PORTAL_URL: props.idcPortalUrl }),
        ...(props.identityStoreId && { IDC_IDENTITY_STORE_ID: props.identityStoreId }),
        ...(props.cloudtrailEventDataStoreId && { CLOUDTRAIL_EVENT_DATA_STORE_ID: props.cloudtrailEventDataStoreId }),
      },
      memorySize: 1024,
      architecture: Architecture.ARM_64,
    });

    // DataZone: プロジェクト一覧取得 + Direct Queryパス用
    if (props.datazoneDomainId) {
      handler.addToRolePolicy(
        new PolicyStatement({
          actions: ['datazone:GetEnvironment', 'datazone:ListEnvironments', 'datazone:ListProjects'],
          resources: ['*'],
        }),
      );
      // メンバーシップ検証: email→IdCユーザーID変換
      handler.addToRolePolicy(
        new PolicyStatement({
          actions: ['identitystore:GetUserId'],
          resources: ['*'],
        }),
      );

      if (props.idcApplicationArn) {
        // RedeemAccessTokenフロー: CreateTokenWithIAMのみ必要
        handler.addToRolePolicy(
          new PolicyStatement({
            actions: ['sso-oauth:CreateTokenWithIAM'],
            resources: ['*'],
          }),
        );
        handler.addEnvironment('IDC_APPLICATION_ARN', props.idcApplicationArn);
      } else {
        // RedeemAccessToken無効時: Lambda実行ロールで直接GetEnvironmentCredentials
        handler.addToRolePolicy(
          new PolicyStatement({
            actions: ['datazone:GetEnvironmentCredentials'],
            resources: ['*'],
          }),
        );
      }
    }

    // CloudTrail Lake: 監査ログ検索（security-auditors グループのみAPIで認可）
    if (props.cloudtrailEventDataStoreId) {
      handler.addToRolePolicy(
        new PolicyStatement({
          actions: ['cloudtrail:StartQuery', 'cloudtrail:GetQueryResults'],
          resources: [props.cloudtrailEventDataStoreId],
        }),
      );
      handler.addToRolePolicy(
        new PolicyStatement({
          actions: ['identitystore:ListGroupMembershipsForMember', 'identitystore:DescribeGroup'],
          resources: ['*'],
        }),
      );
    }

    // AgentCore Memory: セッション履歴の取得・削除
    // bedrock-agentcore の Memory API はリソースレベルのポリシーを未サポートのため resources: '*' を使用
    if (props.agentcoreMemoryId) {
      handler.addToRolePolicy(
        new PolicyStatement({
          actions: ['bedrock-agentcore:ListEvents', 'bedrock-agentcore:DeleteEvent', 'bedrock-agentcore:GetMemory'],
          resources: ['*'],
        }),
      );
    }

    // DSQL: セッションメタデータ管理
    if (props.database) {
      props.database.grantConnect(handler);
    }

    const service = new CloudFrontLambdaFunctionUrlService(this, 'Resource', {
      subDomain,
      handler,
      serviceName: 'Webapp',
      hostedZone,
      certificate: props.certificate,
      accessLogBucket: props.accessLogBucket,
      signPayloadHandler: props.signPayloadHandler,
    });
    this.baseUrl = service.url;

    // Callback URL更新（CloudFront URLが確定後）
    // Amplify Auth createAuthRouteHandlers使用時、コールバックURLは
    // /api/auth/sign-in-callback と /api/auth/sign-out-callback を指定する必要がある
    const callbackUrls = [
      `${service.url}/api/auth/sign-in-callback`,
      'http://localhost:3012/api/auth/sign-in-callback',
    ];
    const logoutUrls = [
      `${service.url}/api/auth/sign-out-callback`,
      'http://localhost:3012/api/auth/sign-out-callback',
    ];

    new AwsCustomResource(this, 'UpdateCallbackUrls', {
      onUpdate: {
        service: '@aws-sdk/client-cognito-identity-provider',
        action: 'updateUserPoolClient',
        parameters: {
          ClientId: userPoolClient.userPoolClientId,
          UserPoolId: userPool.userPoolId,
          AllowedOAuthFlows: ['code'],
          AllowedOAuthFlowsUserPoolClient: true,
          AllowedOAuthScopes: ['profile', 'phone', 'email', 'openid', 'aws.cognito.signin.user.admin'],
          ExplicitAuthFlows: ['ALLOW_USER_PASSWORD_AUTH', 'ALLOW_USER_SRP_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH'],
          CallbackURLs: callbackUrls,
          LogoutURLs: logoutUrls,
          // IdP-initiated SSOを有効にするには、SupportedIdentityProvidersからCOGNITOを削除する必要がある
          // IdC SAML IdPが設定されている場合はIdCのみ、そうでなければCOGNITOのみ
          SupportedIdentityProviders: props.idcSamlMetadataUrl ? ['IdC'] : ['COGNITO'],
          TokenValidityUnits: { IdToken: 'minutes' },
          IdTokenValidity: 60,
        },
        physicalResourceId: PhysicalResourceId.of(userPool.userPoolId),
      },
      policy: AwsCustomResourcePolicy.fromSdkCalls({
        resources: [userPool.userPoolArn],
      }),
    });

    if (!hostedZone) {
      // カスタムドメインなしの場合、AMPLIFY_APP_ORIGINをSSMパラメータ経由で設定
      const originSourceParameter = new StringParameter(this, 'OriginSourceParameter', {
        stringValue: 'dummy',
      });
      originSourceParameter.grantRead(handler);
      handler.addEnvironment('AMPLIFY_APP_ORIGIN_SOURCE_PARAMETER', originSourceParameter.parameterName);

      new AwsCustomResource(this, 'UpdateAmplifyOriginSourceParameter', {
        onUpdate: {
          service: 'ssm',
          action: 'putParameter',
          parameters: {
            Name: originSourceParameter.parameterName,
            Value: service.url,
            Overwrite: true,
          },
          physicalResourceId: PhysicalResourceId.of(originSourceParameter.parameterName),
        },
        policy: AwsCustomResourcePolicy.fromSdkCalls({
          resources: [originSourceParameter.parameterArn],
        }),
      });
    } else {
      handler.addEnvironment('AMPLIFY_APP_ORIGIN', service.url);
    }
  }
}
