import { Duration, IgnoreMode, Stack } from 'aws-cdk-lib';
import { Runtime as LambdaRuntime, Architecture } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Effect, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { type IUserPool, type IUserPoolClient } from 'aws-cdk-lib/aws-cognito';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import { Construct } from 'constructs';
import {
  Gateway,
  GatewayAuthorizer,
  GatewayTarget,
  ToolSchema,
  GatewayExceptionLevel,
  Runtime,
  AgentRuntimeArtifact,
  RuntimeAuthorizerConfiguration,
  Memory,
} from '@aws-cdk/aws-bedrock-agentcore-alpha';
import { CfnGatewayTargetPropsMixin, CfnGatewayPropsMixin } from '@aws-cdk/mixins-preview/aws-bedrockagentcore/mixins';
import { PropertyMergeStrategy } from '@aws-cdk/mixins-preview/mixins';
import '@aws-cdk/mixins-preview/with';
import { ContainerImageBuild } from '@cdklabs/deploy-time-build';
import { join } from 'path';
import { PolicyEngine } from './agentcore-policy';
import { GatewayTracing } from './agentcore-gateway';
import { type Database } from './database';

export interface AgentProps {
  /** DataZoneドメインID */
  readonly datazoneDomainId: string;
  /** CloudTrail Event Data Store ID */
  readonly cloudtrailEventDataStoreId: string;
  /** Cognito User Pool（Gateway JWT認証用） */
  readonly userPool: IUserPool;
  /** Cognito User Pool Client（Gateway JWT認証用） */
  readonly userPoolClient: IUserPoolClient;
  /** IdC OAuth CMA ARN（RedeemAccessTokenフロー用） */
  readonly idcApplicationArn?: string;
  /** Bedrockモデル ID（例: jp.anthropic.claude-sonnet-4-6） */
  readonly bedrockModelId?: string;
  /** 環境名（例: 'dev', 'stg'）。未指定なら無印環境 */
  readonly envName?: string;
  /** DSQL Database（セッションメタデータ保存用） */
  readonly database?: Database;
}

/**
 * AgentCore統合: Gateway, Tool Lambda Targets
 *
 * Lambda統合:
 * - data-access: athena_query + s3_read + s3_list（DZ認証フロー共有）
 * - data-catalog: catalog_search + catalog_detail + subscription_*（カタログ読み取り + Subscription管理）
 * - cloudtrail: cloudtrail_query（独立した認証・権限体系）
 */
export class Agent extends Construct {
  /** AgentCore Gateway */
  readonly gateway: Gateway;
  /** AgentCore Runtime */
  readonly runtime: Runtime;
  /** AgentCore Memory ID */
  readonly memoryId: string;

  constructor(scope: Construct, id: string, props: AgentProps) {
    super(scope, id);

    const { datazoneDomainId, cloudtrailEventDataStoreId } = props;
    const gatewayToolsDir = join(__dirname, '..', '..', '..', 'gateway-tools');
    const commonBundling = { minify: true, sourceMap: true, externalModules: [] as string[] };
    const depsLockFilePath = join(__dirname, '..', '..', '..', '..', 'pnpm-lock.yaml');

    // DataZone API権限（data-access Lambda用）
    const datazonePolicy = new PolicyStatement({
      actions: [
        'datazone:GetEnvironment',
        'datazone:ListEnvironments',
        'datazone:ListConnections',
        'datazone:GetConnection',
        'datazone:ListProjects',
      ],
      resources: ['*'],
    });

    const gatewayName = `${props.envName ? `${props.envName}-` : ''}agentic-analyst-jwt`;

    // --- Gateway (JWT認証、Cognito User Pool) ---
    // Gateway PolicyはJWT認証のGatewayでのみ動作する。IAM認証ではPolicy Engine（Cedarポリシー）が使えない
    this.gateway = new Gateway(this, 'JwtGateway', {
      gatewayName,
      description: 'Agentic Analyst Gateway',
      authorizerConfiguration: GatewayAuthorizer.usingCognito({
        userPool: props.userPool,
        allowedClients: [props.userPoolClient],
      }),
      exceptionLevel: GatewayExceptionLevel.DEBUG,
    });

    // L2コンストラクトがSearchType: SEMANTICをデフォルト設定するが、
    // 既存Gatewayにターゲットが存在する状態ではSearchType変更が拒否される。
    // OVERRIDEでprotocolConfigurationを上書きし、searchTypeを除外する。
    this.gateway.with(
      new CfnGatewayPropsMixin(
        {
          protocolConfiguration: {
            mcp: {
              supportedVersions: ['2025-03-26'],
            },
          },
        },
        { strategy: PropertyMergeStrategy.OVERRIDE },
      ),
    );

    // --- Tool Lambda: data-access (athena_query + s3_read + s3_list) ---
    const dataAccessLogGroup = new LogGroup(this, 'DataAccessLogs', { retention: RetentionDays.ONE_WEEK });
    const dataAccessFn = new NodejsFunction(this, 'DataAccess', {
      entry: join(gatewayToolsDir, 'data-access', 'index.ts'),
      handler: 'handler',
      runtime: LambdaRuntime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      timeout: Duration.minutes(2),
      memorySize: 256,
      logGroup: dataAccessLogGroup,
      depsLockFilePath,
      bundling: commonBundling,
      environment: {
        DATAZONE_DOMAIN_ID: datazoneDomainId,
      },
    });

    dataAccessFn.addToRolePolicy(datazonePolicy);

    // GatewayロールにLambda呼び出し権限を明示的に付与（L2コンストラクトのバグ回避:
    // addLambdaTarget内のbind()でgrantInvokeされるが、GatewayTargetリソースに
    // IAMポリシーへのDependsOnが設定されず、ポリシー伝播前にTarget作成が実行される）
    dataAccessFn.grantInvoke(this.gateway.role);

    this.gateway
      .addLambdaTarget('DataAccessTarget', {
        gatewayTargetName: 'data-access',
        description: 'SMUS FGAC適用済みデータアクセス（Athena + S3）',
        lambdaFunction: dataAccessFn,
        toolSchema: ToolSchema.fromLocalAsset(join(gatewayToolsDir, 'schemas', 'data-access-tools.json')),
      })
      .with(
        new CfnGatewayTargetPropsMixin({
          metadataConfiguration: {
            // Gateway allowedRequestHeaders に Authorization は設定不可（制限ヘッダー）。
            // Cognito ID Token / IdC Access Token はカスタムヘッダーで伝播する
            allowedRequestHeaders: ['x-sagemaker-project-id', 'x-idc-access-token'],
          },
        }),
      );

    // --- Tool Lambda: data-catalog (catalog + subscription管理) ---
    // catalog_search/catalog_detail: Lambda実行ロールで動作（読み取り専用）
    // subscription_*: RedeemAccessTokenフローでDER認証情報を取得しユーザーのIdCアイデンティティで動作
    const dataCatalogLogGroup = new LogGroup(this, 'DataCatalogLogs', { retention: RetentionDays.ONE_WEEK });
    const dataCatalogFn = new NodejsFunction(this, 'DataCatalog', {
      entry: join(gatewayToolsDir, 'data-catalog', 'index.ts'),
      handler: 'handler',
      runtime: LambdaRuntime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      timeout: Duration.seconds(30),
      memorySize: 256,
      logGroup: dataCatalogLogGroup,
      depsLockFilePath,
      bundling: commonBundling,
      environment: {
        DATAZONE_DOMAIN_ID: datazoneDomainId,
      },
    });

    // catalog_search/catalog_detail用（Lambda実行ロール）
    dataCatalogFn.addToRolePolicy(
      new PolicyStatement({
        actions: ['datazone:SearchListings', 'datazone:ListSubscriptions', 'datazone:GetListing'],
        resources: ['*'],
      }),
    );
    // subscription_*用（RedeemAccessTokenフロー: chat-agentがCreateTokenWithIAMを実行済み）

    dataCatalogFn.grantInvoke(this.gateway.role);

    this.gateway
      .addLambdaTarget('DataCatalogTarget', {
        gatewayTargetName: 'data-catalog',
        description: 'DataZoneカタログ検索・詳細取得・Subscription管理',
        lambdaFunction: dataCatalogFn,
        toolSchema: ToolSchema.fromLocalAsset(join(gatewayToolsDir, 'schemas', 'data-catalog-tools.json')),
      })
      .with(
        new CfnGatewayTargetPropsMixin({
          metadataConfiguration: {
            allowedRequestHeaders: ['x-sagemaker-project-id', 'x-idc-access-token'],
          },
        }),
      );

    // --- Tool Lambda: cloudtrail_query ---
    const cloudtrailQueryLogGroup = new LogGroup(this, 'CloudtrailQueryLogs', { retention: RetentionDays.ONE_WEEK });
    const cloudtrailQueryFn = new NodejsFunction(this, 'CloudtrailQuery', {
      entry: join(gatewayToolsDir, 'cloudtrail-query', 'index.ts'),
      handler: 'handler',
      runtime: LambdaRuntime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      timeout: Duration.minutes(2),
      memorySize: 256,
      logGroup: cloudtrailQueryLogGroup,
      depsLockFilePath,
      bundling: commonBundling,
      environment: { CLOUDTRAIL_EVENT_DATA_STORE_ID: cloudtrailEventDataStoreId },
    });

    cloudtrailQueryFn.addToRolePolicy(
      new PolicyStatement({
        actions: ['cloudtrail:StartQuery', 'cloudtrail:GetQueryResults'],
        resources: [cloudtrailEventDataStoreId],
      }),
    );

    // GatewayロールにLambda呼び出し権限を明示的に付与（L2コンストラクトのバグ回避）
    cloudtrailQueryFn.grantInvoke(this.gateway.role);

    this.gateway.addLambdaTarget('CloudtrailQueryTarget', {
      gatewayTargetName: 'cloudtrail-query',
      description: 'CloudTrail Lakeへのセキュリティログ検索',
      lambdaFunction: cloudtrailQueryFn,
      toolSchema: ToolSchema.fromLocalAsset(join(gatewayToolsDir, 'schemas', 'cloudtrail-query-tools.json')),
    });

    // Policy Engine権限
    this.gateway.role.addToPrincipalPolicy(
      new PolicyStatement({
        actions: [
          'bedrock-agentcore:GetPolicyEngine',
          'bedrock-agentcore:AuthorizeAction',
          'bedrock-agentcore:PartiallyAuthorizeActions',
        ],
        resources: ['*'],
      }),
    );

    // L2コンストラクトのバグ回避: addLambdaTarget内のbind()でgrantInvokeされるが、
    // GatewayTargetのCfnリソースにIAMポリシーへのDependsOnが設定されない。
    // 新規Lambda作成時にIAMポリシー伝播前にGatewayTarget作成が実行されて失敗する。
    const gatewayRolePolicy = this.gateway.role.node.tryFindChild('DefaultPolicy') as Construct | undefined;
    if (gatewayRolePolicy) {
      for (const child of this.gateway.node.findAll()) {
        if (child instanceof GatewayTarget) {
          child.node.addDependency(gatewayRolePolicy);
        }
      }
    }

    // --- Policy Engine（Cedarポリシーによるツール認可） ---
    // Provider Frameworkで管理（L2/L1にPolicy Engineプロパティがないため）
    const region = Stack.of(this).region;

    const policyEngine = new PolicyEngine(this, 'PolicyEngine', {
      gateway: this.gateway,
    });

    policyEngine.addPolicy('DataProducersDataAccess', {
      group: 'data-producers',
      tools: ['data-access___athena_query', 'data-access___s3_read', 'data-access___s3_list'],
    });

    policyEngine.addPolicy('DataProducersCatalog', {
      group: 'data-producers',
      tools: [
        'data-catalog___catalog_search',
        'data-catalog___catalog_detail',
        'data-catalog___catalog_list_subscriptions',
      ],
    });

    policyEngine.addPolicy('DataConsumersDataAccess', {
      group: 'data-consumers',
      tools: ['data-access___athena_query', 'data-access___s3_read', 'data-access___s3_list'],
    });

    policyEngine.addPolicy('DataConsumersCatalog', {
      group: 'data-consumers',
      tools: [
        'data-catalog___catalog_search',
        'data-catalog___catalog_detail',
        'data-catalog___catalog_list_subscriptions',
      ],
    });

    policyEngine.addPolicy('DataProducersSubscription', {
      group: 'data-producers',
      tools: [
        'data-catalog___subscription_request',
        'data-catalog___subscription_list_requests',
        'data-catalog___subscription_approve',
        'data-catalog___subscription_reject',
        'data-catalog___subscription_list_filters',
        'data-catalog___subscription_cancel',
        'data-catalog___subscription_revoke',
      ],
    });

    policyEngine.addPolicy('DataConsumersSubscription', {
      group: 'data-consumers',
      tools: [
        'data-catalog___subscription_request',
        'data-catalog___subscription_list_requests',
        'data-catalog___subscription_list_filters',
        'data-catalog___subscription_cancel',
      ],
    });

    policyEngine.addPolicy('SecurityAuditorsCloudtrail', {
      group: 'security-auditors',
      tools: ['cloudtrail-query___cloudtrail_query'],
    });

    // --- Gateway Tracing（Policy Engine 評価ログを aws/spans に出力） ---
    new GatewayTracing(this, 'GatewayTracing', { gateway: this.gateway });

    // --- AgentCore Memory（チャット履歴保存） ---
    const memory = new Memory(this, 'Memory', {
      description: 'Agentic Analyst - Chat History',
    });
    this.memoryId = memory.memoryId;

    // --- AgentCore Runtime ---
    // ContainerImageBuildでCodeBuild上でビルド（ローカルマシンのアーキテクチャに非依存）
    const chatAgentImage = new ContainerImageBuild(this, 'ChatAgentBuild', {
      directory: join('..', '..'),
      file: 'apps/chat-agent/Dockerfile',
      platform: Platform.LINUX_ARM64,
      ignoreMode: IgnoreMode.DOCKER,
      tagPrefix: 'chat-agent-',
    });

    const agentRuntimeArtifact = AgentRuntimeArtifact.fromEcrRepository(
      chatAgentImage.repository,
      chatAgentImage.imageTag,
    );

    this.runtime = new Runtime(this, 'Runtime', {
      description: 'Agentic Analyst - Chat Agent',
      agentRuntimeArtifact,
      authorizerConfiguration: RuntimeAuthorizerConfiguration.usingCognito(props.userPool, [props.userPoolClient]),
      requestHeaderConfiguration: {
        allowlistedHeaders: [
          'Authorization',
          'X-Amzn-Bedrock-AgentCore-Runtime-Custom-Sagemaker-Project-Id',
          'X-Amzn-Bedrock-AgentCore-Runtime-Custom-Cognito-Id-Token',
        ],
      },
      environmentVariables: {
        AGENTCORE_GATEWAY_URL: `https://${this.gateway.gatewayId}.gateway.bedrock-agentcore.${region}.amazonaws.com/mcp`,
        AGENTCORE_MEMORY_ID: memory.memoryId,
        AWS_REGION: region,
        TITLE_MODEL_ID: 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
        ...(props.bedrockModelId && { BEDROCK_MODEL_ID: props.bedrockModelId }),
        ...(props.cloudtrailEventDataStoreId && { CLOUDTRAIL_EVENT_DATA_STORE_ID: props.cloudtrailEventDataStoreId }),
        ...(props.database && { DSQL_ENDPOINT: props.database.endpoint }),
        ...(props.idcApplicationArn && { IDC_APPLICATION_ARN: props.idcApplicationArn }),
      },
      lifecycleConfiguration: {
        idleRuntimeSessionTimeout: Duration.minutes(15),
        maxLifetime: Duration.hours(8),
      },
    });

    // Bedrock モデル呼び出し権限
    this.runtime.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: ['*'],
      }),
    );

    // CreateTokenWithIAM権限（Cognito ID Token → IdC Access Token変換）
    if (props.idcApplicationArn) {
      this.runtime.addToRolePolicy(
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: ['sso-oauth:CreateTokenWithIAM'],
          resources: ['*'],
        }),
      );
    }

    // Code Interpreter権限
    // マネージドCode InterpreterはAWS所有リソースのため、ARNのアカウント部分は`aws`を指定
    this.runtime.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          'bedrock-agentcore:StartCodeInterpreterSession',
          'bedrock-agentcore:InvokeCodeInterpreter',
          'bedrock-agentcore:StopCodeInterpreterSession',
          'bedrock-agentcore:GetCodeInterpreterSession',
        ],
        resources: [`arn:aws:bedrock-agentcore:${region}:aws:code-interpreter/*`],
      }),
    );

    // AgentCore Memory権限（チャット履歴の読み書き）
    // bedrock-agentcore の Memory API はリソースレベルのポリシーを未サポート（IAM Service Authorization Reference に
    // Resource types / Condition keys が未定義）。Memory ARN での絞り込みは不可のため resources: '*' を使用。
    this.runtime.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          'bedrock-agentcore:CreateEvent',
          'bedrock-agentcore:ListEvents',
          'bedrock-agentcore:DeleteEvent',
          'bedrock-agentcore:GetMemory',
        ],
        resources: ['*'],
      }),
    );

    // DSQL接続権限（セッションメタデータ保存用）
    if (props.database) {
      props.database.grantConnect(this.runtime);
    }
  }
}
