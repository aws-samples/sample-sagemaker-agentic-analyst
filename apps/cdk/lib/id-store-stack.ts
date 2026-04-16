import { CfnOutput, CustomResource, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { type ICertificate } from 'aws-cdk-lib/aws-certificatemanager';
import {
  CfnManagedLoginBranding,
  type CfnUserPool,
  FeaturePlan,
  type IUserPool,
  type IUserPoolClient,
  ManagedLoginVersion,
  ProviderAttribute,
  UserPool,
  UserPoolIdentityProviderSaml,
  UserPoolIdentityProviderSamlMetadata,
  UserPoolOperation,
} from 'aws-cdk-lib/aws-cognito';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Code, Runtime, SingletonFunction } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { CnameRecord, HostedZone } from 'aws-cdk-lib/aws-route53';
import { type Construct } from 'constructs';
import { readFileSync } from 'fs';
import { join } from 'path';

export interface AgenticAnalystIdStoreStackProps extends StackProps {
  readonly idcInstanceArn: string;
  readonly idcSamlMetadataUrl?: string;
  readonly domainName?: string;
  readonly sharedCertificate?: ICertificate;
  /** IdC OAuth CMA ARN（管理アカウントで手動作成。docs/01-deployment.md参照） */
  readonly idcApplicationArn?: string;
  /** Identity Store ID（Pre Token Generation V2でIdCグループ解決に必要） */
  readonly identityStoreId?: string;
}

export class AgenticAnalystIdStoreStack extends Stack {
  readonly userPool: IUserPool;
  readonly userPoolClient: IUserPoolClient;
  readonly domainName: string;
  /** IdC OAuth CMA ARN（TIP有効時のみ） */
  readonly idcApplicationArn?: string;

  constructor(scope: Construct, id: string, props: AgenticAnalystIdStoreStackProps) {
    super(scope, id, { description: 'Agentic Analyst - Identity Store (Cognito)', ...props });

    const hostedZone = props.domainName
      ? HostedZone.fromLookup(this, 'HostedZone', { domainName: props.domainName })
      : undefined;

    let domainPrefix = '';
    if (!hostedZone) {
      const generator = new SingletonFunction(this, 'RandomStringGenerator', {
        runtime: Runtime.NODEJS_22_X,
        handler: 'index.handler',
        timeout: Duration.seconds(5),
        lambdaPurpose: 'RandomStringGenerator',
        uuid: '11e9c903-f11a-4989-833c-985dddef5eb2',
        code: Code.fromInline(readFileSync(join(__dirname, 'constructs/auth/prefix-generator.js')).toString()),
      });
      const domainPrefixResource = new CustomResource(this, 'DomainPrefix', {
        serviceToken: generator.functionArn,
        resourceType: 'Custom::RandomString',
        properties: { prefix: 'agentic-analyst-', length: 10 },
      });
      domainPrefix = domainPrefixResource.getAttString('generated');
    }

    this.domainName = hostedZone
      ? `auth.${hostedZone.zoneName}`
      : `${domainPrefix}.auth.${this.region}.amazoncognito.com`;

    const userPool = new UserPool(this, 'UserPool', {
      passwordPolicy: { requireUppercase: true, requireSymbols: true, requireDigits: true, minLength: 8 },
      selfSignUpEnabled: false,
      signInAliases: { username: false, email: true },
      removalPolicy: RemovalPolicy.DESTROY,
      featurePlan: FeaturePlan.ESSENTIALS,
    });
    this.userPool = userPool;

    // Pre Token Generation V2: IdCグループをcognito:groupsに埋め込む
    if (props.identityStoreId) {
      const preTokenLogGroup = new LogGroup(this, 'PreTokenGenLogs', { retention: RetentionDays.ONE_WEEK });
      const preTokenFn = new NodejsFunction(this, 'PreTokenGen', {
        entry: join(__dirname, 'constructs/auth/pre-token-generation.ts'),
        handler: 'handler',
        runtime: Runtime.NODEJS_22_X,
        timeout: Duration.seconds(10),
        memorySize: 256,
        logGroup: preTokenLogGroup,
        environment: { IDENTITY_STORE_ID: props.identityStoreId },
        bundling: { minify: true, sourceMap: true, externalModules: [] },
        depsLockFilePath: join(__dirname, '..', '..', '..', 'pnpm-lock.yaml'),
      });
      preTokenFn.addToRolePolicy(
        new PolicyStatement({
          actions: [
            'identitystore:GetUserId',
            'identitystore:ListGroupMembershipsForMember',
            'identitystore:DescribeGroup',
          ],
          resources: ['*'],
        }),
      );
      userPool.addTrigger(UserPoolOperation.PRE_TOKEN_GENERATION_CONFIG, preTokenFn);
      const cfnUserPool = userPool.node.defaultChild as CfnUserPool;
      cfnUserPool.addPropertyOverride('LambdaConfig.PreTokenGenerationConfig.LambdaVersion', 'V2_0');
    }

    let samlIdp: UserPoolIdentityProviderSaml | undefined;
    const samlIdpName = 'IdC';
    if (props.idcSamlMetadataUrl) {
      samlIdp = new UserPoolIdentityProviderSaml(this, 'IdcSamlIdp', {
        userPool,
        name: samlIdpName,
        metadata: UserPoolIdentityProviderSamlMetadata.url(props.idcSamlMetadataUrl),
        attributeMapping: { email: ProviderAttribute.other('email') },
        idpSignout: true,
        // IdP-initiated SSOを有効化
        idpInitiated: true,
      });
    }

    // IdP-initiated SSOを有効にするには、SupportedIdentityProvidersからCOGNITOを削除する必要がある
    // https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-saml-idp.html
    const client = userPool.addClient('Client', {
      idTokenValidity: Duration.minutes(60),
      authFlows: { userPassword: true, userSrp: true },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        callbackUrls: ['http://localhost:3012/api/auth/sign-in-callback'],
        logoutUrls: ['http://localhost:3012/api/auth/sign-out-callback'],
      },
      supportedIdentityProviders: samlIdp ? [{ name: samlIdpName }] : [{ name: 'COGNITO' }],
    });
    if (samlIdp) client.node.addDependency(samlIdp);
    this.userPoolClient = client;

    const domain = userPool.addDomain('Domain', {
      ...(hostedZone && props.sharedCertificate
        ? { customDomain: { domainName: this.domainName, certificate: props.sharedCertificate } }
        : { cognitoDomain: { domainPrefix } }),
      managedLoginVersion: ManagedLoginVersion.NEWER_MANAGED_LOGIN,
    });

    if (hostedZone) {
      new CnameRecord(this, 'DomainRecord', {
        zone: hostedZone,
        recordName: 'auth',
        domainName: domain.cloudFrontEndpoint,
      });
    }

    new CfnManagedLoginBranding(this, 'Branding', {
      userPoolId: userPool.userPoolId,
      clientId: client.userPoolClientId,
      useCognitoProvidedValues: true,
    });

    new CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new CfnOutput(this, 'UserPoolClientId', { value: client.userPoolClientId });
    new CfnOutput(this, 'CognitoDomainName', { value: this.domainName });

    // TIP: IdC OAuth CMA ARNをそのまま公開（管理アカウントで手動作成済み）
    if (props.idcApplicationArn) {
      this.idcApplicationArn = props.idcApplicationArn;
      new CfnOutput(this, 'IdcApplicationArn', { value: props.idcApplicationArn });
    }
  }
}
