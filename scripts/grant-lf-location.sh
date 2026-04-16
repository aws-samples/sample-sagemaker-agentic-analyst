#!/bin/bash
# =============================================================================
# Lake Formation ロケーション登録 + DATA_LOCATION_ACCESS 付与
#
# S3バケットをLake Formationに登録し、SMUSプロジェクトロールに
# DATA_LOCATION_ACCESS を付与する。これにより、SMUSクエリエディタから
# CREATE EXTERNAL TABLE でそのS3ロケーションを参照するテーブルを作成できる。
#
# Usage:
#   ./scripts/grant-lf-location.sh <S3_BUCKET> <DOMAIN_ID> <PROJECT_ID>
#
# Example:
#   ./scripts/grant-lf-location.sh my-data-bucket dzd-xxxxxxxxx 6jz916tzk41sm1
# =============================================================================

set -euo pipefail

if [ $# -ne 3 ]; then
    echo "Usage: $0 <S3_BUCKET> <DOMAIN_ID> <PROJECT_ID>"
    exit 1
fi

S3_BUCKET=$1
DOMAIN_ID=$2
PROJECT_ID=$3
REGION="${AWS_REGION:-ap-northeast-1}"

echo "🔧 Lake Formation ロケーション設定"
echo "   S3_BUCKET: $S3_BUCKET"
echo "   DOMAIN_ID: $DOMAIN_ID"
echo "   PROJECT_ID: $PROJECT_ID"

# --- LFロケーション登録 ---
echo ""
echo "📍 Lake Formation ロケーション登録中..."

aws lakeformation register-resource \
    --resource-arn "arn:aws:s3:::$S3_BUCKET" \
    --use-service-linked-role \
    --region "$REGION" 2>/dev/null \
    && echo "   ✅ 登録完了" \
    || echo "   ⏭️  既に登録済み"

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

echo "   ✅ $PROJECT_ROLE_ARN"

# --- DATA_LOCATION_ACCESS 付与 ---
echo ""
echo "🔐 DATA_LOCATION_ACCESS を付与中..."

aws lakeformation grant-permissions \
    --principal "{\"DataLakePrincipalIdentifier\": \"$PROJECT_ROLE_ARN\"}" \
    --resource "{\"DataLocation\": {\"ResourceArn\": \"arn:aws:s3:::$S3_BUCKET\"}}" \
    --permissions DATA_LOCATION_ACCESS \
    --region "$REGION" 2>/dev/null \
    && echo "   ✅ 付与完了" \
    || echo "   ⏭️  既に付与済み"

echo ""
echo "✅ 完了 — SMUSクエリエディタから CREATE EXTERNAL TABLE を実行できます"
