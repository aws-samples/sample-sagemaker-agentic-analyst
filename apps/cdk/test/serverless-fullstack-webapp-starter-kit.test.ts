import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { AgenticAnalystStack } from '../lib/main-stack';
import { AgenticAnalystUsEast1Stack } from '../lib/us-east-1-stack';
import { AgenticAnalystIdStoreStack } from '../lib/id-store-stack';

test('Snapshot test', () => {
  jest.useFakeTimers().setSystemTime(new Date('2020-01-01'));

  const app = new cdk.App();
  const props = {
    account: '123456789012',
    domainName: 'example.com',
  };

  const idStore = new AgenticAnalystIdStoreStack(app, 'AgenticAnalystIdStore', {
    env: { account: props.account, region: 'us-west-2' },
    idcInstanceArn: 'arn:aws:sso:::instance/ssoins-12345',
  });

  const virginia = new AgenticAnalystUsEast1Stack(app, 'AgenticAnalystUsEast1', {
    env: { account: props.account, region: 'us-east-1' },
    crossRegionReferences: true,
    domainName: props.domainName,
  });

  const mainStack = new AgenticAnalystStack(app, 'AgenticAnalyst', {
    env: { account: props.account, region: 'us-west-2' },
    crossRegionReferences: true,
    sharedCertificate: virginia.certificate,
    domainName: props.domainName,
    signPayloadHandler: virginia.signPayloadHandler,
    idcInstanceArn: 'arn:aws:sso:::instance/ssoins-12345',
    identityStoreId: 'd-1234567890',
    datazoneDomainId: 'dzd-12345',
    userPool: idStore.userPool,
    userPoolClient: idStore.userPoolClient,
    cognitoDomainName: idStore.domainName,
  });

  const virginiaTemplate = Template.fromStack(virginia);
  const mainTemplate = Template.fromStack(mainStack);

  expect(virginiaTemplate).toMatchSnapshot();
  expect(mainTemplate).toMatchSnapshot();
});
