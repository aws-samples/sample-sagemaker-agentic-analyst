import { type UpdateUserPoolClientCommandInput } from '@aws-sdk/client-cognito-identity-provider';
import { CfnOutput, CfnResource, CustomResource, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import { type ICertificate } from 'aws-cdk-lib/aws-certificatemanager';
import {
  CfnManagedLoginBranding,
  type CfnUserPool,
  FeaturePlan,
  ManagedLoginVersion,
  ProviderAttribute,
  UserPool,
  type UserPoolClient,
  UserPoolIdentityProviderSaml,
  UserPoolIdentityProviderSamlMetadata,
  UserPoolOperation,
} from 'aws-cdk-lib/aws-cognito';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Code, Runtime, SingletonFunction } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { CnameRecord, type IHostedZone } from 'aws-cdk-lib/aws-route53';
import { AwsCustomResource, AwsCustomResourcePolicy, PhysicalResourceId } from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { readFileSync } from 'fs';
import { join } from 'path';

export interface AuthProps {
  /**
   * Route 53 hosted zone for custom domain.
   *
   * @default No custom domain. A random prefix will be automatically generated for the Cognito domain.
   */
  readonly hostedZone?: IHostedZone;
  /**
   * ACM certificate for custom domain (must be in us-east-1 for Cognito).
   *
   * @default No custom domain.
   */
  readonly sharedCertificate?: ICertificate;
  /**
   * IdC SAML Application のメタデータURL。
   * 設定するとIdCをSAML IdPとして追加する。
   *
   * @default SAML IdPなし（Cognito Managed Loginのみ）
   */
  readonly idcSamlMetadataUrl?: string;
  /**
   * Identity Store ID（Pre Token Generation V2でIdCグループを解決するために必要）
   *
   * @default Pre Token Generation V2 Lambdaを作成しない
   */
  readonly identityStoreId?: string;
}

export class Auth extends Construct {
  readonly userPool: UserPool;
  readonly client: UserPoolClient;
  readonly domainName: string;
  readonly samlIdpName?: string;

  private callbackUrlCount = 0;

  constructor(scope: Construct, id: string, props: AuthProps) {
    super(scope, id);
    const { hostedZone } = props;
    const subDomain = 'auth';
    let domainPrefix = '';
    if (!hostedZone) {
      // When we do not use a custom domain, we must make domainPrefix unique in the AWS region.
      // To avoid a collision, we generate a random string with CFn custom resource.
      // This allows the stack to work without requiring a custom domain setup.
      const generator = new SingletonFunction(this, 'RandomStringGenerator', {
        runtime: Runtime.NODEJS_22_X,
        handler: 'index.handler',
        timeout: Duration.seconds(5),
        lambdaPurpose: 'RandomStringGenerator',
        uuid: '11e9c903-f11a-4989-833c-985dddef5eb2',
        code: Code.fromInline(readFileSync(join(__dirname, 'prefix-generator.js')).toString()),
      });

      const domainPrefixResource = new CustomResource(this, 'DomainPrefix', {
        serviceToken: generator.functionArn,
        resourceType: 'Custom::RandomString',
        properties: { prefix: 'webapp-', length: 10 },
        serviceTimeout: Duration.seconds(10),
      });
      domainPrefix = domainPrefixResource.getAttString('generated');
    }

    this.domainName = hostedZone
      ? `${subDomain}.${hostedZone.zoneName}`
      : `${domainPrefix}.auth.${Stack.of(this).region}.amazoncognito.com`;

    const userPool = new UserPool(this, 'UserPool', {
      passwordPolicy: {
        requireUppercase: true,
        requireSymbols: true,
        requireDigits: true,
        minLength: 8,
      },
      selfSignUpEnabled: true,
      signInAliases: {
        username: false,
        email: true,
      },
      removalPolicy: RemovalPolicy.DESTROY,
      featurePlan: FeaturePlan.ESSENTIALS,
    });

    // Pre Token Generation V2: IdCグループをcognito:groupsに埋め込む
    if (props.identityStoreId) {
      const preTokenLogGroup = new LogGroup(this, 'PreTokenGenLogs', { retention: RetentionDays.ONE_WEEK });
      const preTokenFn = new NodejsFunction(this, 'PreTokenGen', {
        entry: join(__dirname, 'pre-token-generation.ts'),
        handler: 'handler',
        runtime: Runtime.NODEJS_22_X,
        timeout: Duration.seconds(10),
        memorySize: 256,
        logGroup: preTokenLogGroup,
        environment: { IDENTITY_STORE_ID: props.identityStoreId },
        bundling: { minify: true, sourceMap: true, externalModules: [] },
        depsLockFilePath: join(__dirname, '..', '..', '..', '..', '..', 'pnpm-lock.yaml'),
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
      // V2_0イベントバージョンを設定（L1エスケープハッチ）
      const cfnUserPool = userPool.node.defaultChild as CfnUserPool;
      cfnUserPool.addPropertyOverride('LambdaConfig.PreTokenGenerationConfig.LambdaVersion', 'V2_0');
    }

    // IdC SAML IdP設定（オプション）
    let samlIdp: UserPoolIdentityProviderSaml | undefined;
    if (props.idcSamlMetadataUrl) {
      this.samlIdpName = 'IdC';
      samlIdp = new UserPoolIdentityProviderSaml(this, 'IdcSamlIdp', {
        userPool,
        name: this.samlIdpName,
        metadata: UserPoolIdentityProviderSamlMetadata.url(props.idcSamlMetadataUrl),
        attributeMapping: {
          email: ProviderAttribute.other('email'),
        },
        idpSignout: true,
        // IdP-initiated SSOを有効化
        idpInitiated: true,
      });
    }

    const client = userPool.addClient(`Client`, {
      idTokenValidity: Duration.minutes(60),
      authFlows: {
        userPassword: true,
        userSrp: true,
      },
      oAuth: {
        flows: {
          authorizationCodeGrant: true,
        },
        callbackUrls: ['http://localhost/dummy'],
        logoutUrls: ['http://localhost/dummy'],
      },
    });

    // SAML IdPがある場合は依存関係を設定
    if (samlIdp) {
      client.node.addDependency(samlIdp);
    }

    this.client = client;
    this.userPool = userPool;

    const domain = userPool.addDomain('CognitoDomain', {
      ...(hostedZone && props.sharedCertificate
        ? {
            customDomain: {
              domainName: this.domainName,
              certificate: props.sharedCertificate,
            },
          }
        : {
            cognitoDomain: {
              domainPrefix,
            },
          }),
      managedLoginVersion: ManagedLoginVersion.NEWER_MANAGED_LOGIN,
    });

    if (hostedZone) {
      new CnameRecord(this, 'CognitoDomainRecord', {
        zone: hostedZone,
        recordName: subDomain,
        domainName: domain.cloudFrontEndpoint,
      });
    }

    new CfnManagedLoginBranding(this, 'Branding', {
      userPoolId: this.userPool.userPoolId,
      clientId: client.userPoolClientId,
      useCognitoProvidedValues: true,
    });

    new CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new CfnOutput(this, 'UserPoolClientId', { value: client.userPoolClientId });
    new CfnOutput(this, 'UserPoolDomainName', { value: this.domainName });
  }

  public addAllowedCallbackUrls(callbackUrl: string, logoutUrl: string) {
    const resource = this.client.node.defaultChild;
    if (!CfnResource.isCfnResource(resource)) {
      throw new Error('Expected CfnResource');
    }
    resource.addPropertyOverride(`CallbackURLs.${this.callbackUrlCount}`, callbackUrl);
    resource.addPropertyOverride(`LogoutURLs.${this.callbackUrlCount}`, logoutUrl);
    this.callbackUrlCount += 1;
  }

  public updateAllowedCallbackUrls(callbackUrls: string[], logoutUrls: string[]) {
    // Lambda depends on userPoolClientId but userPoolClient depends on the CloudFront domain name (callback URL) which depends on Lambda (fURL).
    // To avoid the circular dependency, we update the callback URL after a userPoolClientId is created.
    // We only use this when custom domain is not used.
    //
    // IdP-initiated SSOを有効にするには、SupportedIdentityProvidersからCOGNITOを削除する必要がある
    // https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-saml-idp.html
    const supportedIdps = this.samlIdpName ? [this.samlIdpName] : ['COGNITO'];

    new AwsCustomResource(this, 'UpdateCallbackUrls', {
      onUpdate: {
        service: '@aws-sdk/client-cognito-identity-provider',
        action: 'updateUserPoolClient',
        parameters: {
          ClientId: this.client.userPoolClientId,
          UserPoolId: this.userPool.userPoolId,
          AllowedOAuthFlows: ['code'],
          AllowedOAuthFlowsUserPoolClient: true,
          AllowedOAuthScopes: ['profile', 'phone', 'email', 'openid', 'aws.cognito.signin.user.admin'],
          ExplicitAuthFlows: ['ALLOW_USER_PASSWORD_AUTH', 'ALLOW_USER_SRP_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH'],
          CallbackURLs: callbackUrls,
          LogoutURLs: logoutUrls,
          SupportedIdentityProviders: supportedIdps,
          TokenValidityUnits: {
            IdToken: 'minutes',
          },
          IdTokenValidity: 1440,
        } satisfies UpdateUserPoolClientCommandInput,
        physicalResourceId: PhysicalResourceId.of(this.userPool.userPoolId),
      },
      policy: AwsCustomResourcePolicy.fromSdkCalls({
        resources: [this.userPool.userPoolArn],
      }),
    });
  }
}
