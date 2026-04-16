/**
 * Gateway Tracing 有効化コンストラクト
 *
 * CloudWatch Logs Vended Logs API (PutDeliverySource / PutDeliveryDestination / CreateDelivery)
 * を AwsCustomResource で呼び出し、Gateway のトレースを X-Ray / aws/spans に出力する。
 * CloudFormation に L1 construct がないため AwsCustomResource を使用。
 *
 * 前提: CloudWatch Transaction Search が有効であること。
 */
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import {
  AwsCustomResource,
  AwsCustomResourcePolicy,
  PhysicalResourceId,
  PhysicalResourceIdReference,
} from 'aws-cdk-lib/custom-resources';
import { Arn, ArnFormat, Stack } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { type Gateway } from '@aws-cdk/aws-bedrock-agentcore-alpha';

export interface GatewayTracingProps {
  readonly gateway: Gateway;
}

export class GatewayTracing extends Construct {
  constructor(scope: Construct, id: string, props: GatewayTracingProps) {
    super(scope, id);

    const gatewayArn = props.gateway.gatewayArn;
    const gatewayId = props.gateway.gatewayId;

    const logsPolicy = new PolicyStatement({
      actions: [
        'logs:PutDeliverySource',
        'logs:DeleteDeliverySource',
        'logs:GetDeliverySource',
        'logs:PutDeliveryDestination',
        'logs:DeleteDeliveryDestination',
        'logs:GetDeliveryDestination',
        'logs:CreateDelivery',
        'logs:DeleteDelivery',
        'logs:GetDelivery',
        'logs:DescribeDeliveries',
        'logs:DescribeDeliverySources',
        'logs:DescribeDeliveryDestinations',
        'logs:DescribeConfigurationTemplates',
        'logs:PutResourcePolicy',
      ],
      resources: ['*'],
    });

    const xrayPolicy = new PolicyStatement({
      actions: ['xray:PutResourcePolicy', 'xray:ListResourcePolicies', 'xray:GetTraceSegmentDestination'],
      resources: ['*'],
    });

    const agentcorePolicy = new PolicyStatement({
      actions: ['bedrock-agentcore:AllowVendedLogDeliveryForResource'],
      resources: ['*'],
    });

    const allPolicies = AwsCustomResourcePolicy.fromStatements([logsPolicy, xrayPolicy, agentcorePolicy]);

    // Delivery Source (traces)
    const sourceName = `${gatewayId}-traces`;
    const source = new AwsCustomResource(this, 'DeliverySource', {
      onCreate: {
        service: 'CloudWatchLogs',
        action: 'putDeliverySource',
        parameters: { name: sourceName, logType: 'TRACES', resourceArn: gatewayArn },
        physicalResourceId: PhysicalResourceId.of(sourceName),
      },
      onDelete: {
        service: 'CloudWatchLogs',
        action: 'deleteDeliverySource',
        parameters: { name: sourceName },
        ignoreErrorCodesMatching: 'ResourceNotFoundException',
      },
      policy: allPolicies,
    });

    // Delivery Destination (X-Ray)
    const destName = `${gatewayId}-traces-dest`;
    const dest = new AwsCustomResource(this, 'DeliveryDestination', {
      onCreate: {
        service: 'CloudWatchLogs',
        action: 'putDeliveryDestination',
        parameters: { name: destName, deliveryDestinationType: 'XRAY' },
        physicalResourceId: PhysicalResourceId.of(destName),
      },
      onDelete: {
        service: 'CloudWatchLogs',
        action: 'deleteDeliveryDestination',
        parameters: { name: destName },
        ignoreErrorCodesMatching: 'ResourceNotFoundException',
      },
      policy: allPolicies,
    });

    // Delivery (connect source → destination)
    const destArn = Arn.format(
      {
        service: 'logs',
        resource: 'delivery-destination',
        resourceName: destName,
        arnFormat: ArnFormat.COLON_RESOURCE_NAME,
      },
      Stack.of(this),
    );
    const delivery = new AwsCustomResource(this, 'Delivery', {
      onCreate: {
        service: 'CloudWatchLogs',
        action: 'createDelivery',
        parameters: {
          deliverySourceName: sourceName,
          deliveryDestinationArn: destArn,
        },
        physicalResourceId: PhysicalResourceId.fromResponse('delivery.id'),
      },
      onDelete: {
        service: 'CloudWatchLogs',
        action: 'deleteDelivery',
        parameters: { id: new PhysicalResourceIdReference() },
        ignoreErrorCodesMatching: 'ResourceNotFoundException',
      },
      policy: allPolicies,
    });

    delivery.node.addDependency(source);
    delivery.node.addDependency(dest);
  }
}
