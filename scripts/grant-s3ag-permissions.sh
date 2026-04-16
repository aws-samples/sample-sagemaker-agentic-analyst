#!/bin/bash
# =============================================================================
# S3 Access Grants 用プロジェクトロール権限付与
#
# Publisherプロジェクトロールに以下を付与する:
#   1. S3バケットアクセス権限（GetObject, ListBucket）
#   2. S3 Access Grants Location管理権限
#
# これにより、SMUSのS3ロケーション追加時にS3AG Locationが自動作成され、
# Publish/Share時にSubscriberへのGrantが自動作成される。
#
# 詳細: design/data-access-control.md「S3 Access Grants自動作成の必須条件」
#
# Usage:
#   ./scripts/grant-s3ag-permissions.sh <S3_BUCKET> <S3_PREFIX> <DOMAIN_ID> <PROJECT_ID>
#
# Example:
#   ./scripts/grant-s3ag-permissions.sh my-data-bucket unstructured dzd-65lqyegmxyu9nd 6jz916tzk41sm1
# =============================================================================

set -euo pipefail

if [ $# -ne 4 ]; then
    echo "Usage: $0 <S3_BUCKET> <S3_PREFIX> <DOMAIN_ID> <PROJECT_ID>"
    exit 1
fi

S3_BUCKET=$1
S3_PREFIX=$2
DOMAIN_ID=$3
PROJECT_ID=$4
REGION="${AWS_REGION:-ap-northeast-1}"

echo "🔧 S3 Access Grants 用権限設定"
echo "   S3_BUCKET:  $S3_BUCKET"
echo "   S3_PREFIX:  $S3_PREFIX"
echo "   DOMAIN_ID:  $DOMAIN_ID"
echo "   PROJECT_ID: $PROJECT_ID"

# --- プロジェクトロール取得 ---
echo ""
echo "🔍 プロジェクトロールを取得中..."

TOOLING_ENV_ID=$(aws datazone list-environments \
    --domain-identifier "$DOMAIN_ID" \
    --project-identifier "$PROJECT_ID" \
    --region "$REGION" \
    --query "items[?name=='Tooling'].id | [0]" --output text)

if [ -z "$TOOLING_ENV_ID" ] || [ "$TOOLING_ENV_ID" = "None" ]; then
    echo "❌ Tooling 環境が見つかりません"
    exit 1
fi

PROJECT_ROLE_ARN=$(aws datazone get-environment \
    --domain-identifier "$DOMAIN_ID" \
    --identifier "$TOOLING_ENV_ID" \
    --region "$REGION" \
    --query "provisionedResources[?name=='userRoleArn'].value | [0]" --output text)
ROLE_NAME="${PROJECT_ROLE_ARN##*/}"

echo "   ✅ $PROJECT_ROLE_ARN"

# --- S3バケットアクセス権限 ---
echo ""
echo "🔐 S3BucketAccess ポリシーを付与中..."

cat > /tmp/s3-bucket-access.json << EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:GetObjectVersion", "s3:ListBucket"],
      "Resource": [
        "arn:aws:s3:::${S3_BUCKET}",
        "arn:aws:s3:::${S3_BUCKET}/${S3_PREFIX}/*"
      ]
    }
  ]
}
EOF

aws iam put-role-policy \
    --role-name "$ROLE_NAME" \
    --policy-name S3BucketAccess \
    --policy-document file:///tmp/s3-bucket-access.json
echo "   ✅ S3BucketAccess 付与完了"

# --- S3AG Location管理権限 ---
echo ""
echo "🔐 S3AccessGrantsManagement ポリシーを付与中..."

cat > /tmp/s3ag-management.json << EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:CreateAccessGrantsLocation",
        "s3:DeleteAccessGrantsLocation",
        "s3:GetAccessGrantsLocation",
        "s3:ListAccessGrantsLocations",
        "s3:UpdateAccessGrantsLocation",
        "s3:CreateAccessGrant",
        "s3:DeleteAccessGrant",
        "s3:GetAccessGrant",
        "s3:ListAccessGrants",
        "s3:GetAccessGrantsInstance",
        "s3:TagResource",
        "s3:ListTagsForResource"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": "${PROJECT_ROLE_ARN}"
    }
  ]
}
EOF

aws iam put-role-policy \
    --role-name "$ROLE_NAME" \
    --policy-name S3AccessGrantsManagement \
    --policy-document file:///tmp/s3ag-management.json
echo "   ✅ S3AccessGrantsManagement 付与完了"

# --- クリーンアップ ---
rm -f /tmp/s3-bucket-access.json /tmp/s3ag-management.json

echo ""
echo "✅ 完了 — SMUSでS3ロケーション追加時にS3AG Locationが自動作成されます"
