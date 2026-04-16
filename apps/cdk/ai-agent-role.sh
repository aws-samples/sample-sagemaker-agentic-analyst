#!/bin/bash
set -euo pipefail

STACK_NAME="AgenticAnalyst-OperatorRole"
TEMPLATE_FILE="ai-agent-role.template.yml"
REGION="${AWS_REGION:-ap-northeast-1}"

cd "$(dirname "$0")"

aws cloudformation deploy \
  --stack-name "$STACK_NAME" \
  --template-file "$TEMPLATE_FILE" \
  --capabilities CAPABILITY_NAMED_IAM \
  --region "$REGION" \
  --tags Application="Agentic Analyst"

echo "Deployed: $STACK_NAME"
aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$REGION" \
  --query 'Stacks[0].Outputs' --output table
