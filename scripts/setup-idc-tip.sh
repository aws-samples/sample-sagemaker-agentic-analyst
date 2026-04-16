#!/bin/bash
# =============================================================================
# IdC OAuth CMA + Trusted Token Issuer 設定スクリプト
#
# デプロイガイド Phase 4b の全ステップを自動実行する。
# 既存リソースがある場合はスキップする（再実行安全）。
#
# Usage:
#   source .env.credentials && ./scripts/setup-idc-tip.sh           # 無印環境
#   source .env.credentials && ./scripts/setup-idc-tip.sh stg       # stg環境
#
# 前提条件:
#   - .env.credentials が source 済み（AWS_PROFILE, IDC_AWS_PROFILE）
#   - .env.local に IDC_INSTANCE_ARN, IDENTITY_STORE_ID が設定済み
#   - AgenticAnalystIdStore スタックがデプロイ済み（Phase 3）
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# --- 引数パース ---
ENV_NAME="${1:-}"
if [ -n "$ENV_NAME" ]; then
    ROOT_ENV_FILE="$PROJECT_ROOT/.env.local.${ENV_NAME}"
    ID_STORE_STACK="${ENV_NAME}-AgenticAnalystIdStore"
else
    ROOT_ENV_FILE="$PROJECT_ROOT/.env.local"
    ID_STORE_STACK="AgenticAnalystIdStore"
fi

# --- 前提条件チェック ---
if [ -z "${AWS_PROFILE:-}" ]; then
    echo "❌ AWS_PROFILEが設定されていません"
    echo "   例: source .env.credentials && ./scripts/setup-idc-tip.sh"
    exit 1
fi
if [ ! -f "$ROOT_ENV_FILE" ]; then
    echo "❌ $ROOT_ENV_FILE が見つかりません"
    exit 1
fi

# --- ヘルパー関数 ---
get_root_env() {
    grep "^${1}=" "$ROOT_ENV_FILE" 2>/dev/null | cut -d'=' -f2- | head -1 || true
}

set_root_env() {
    local key=$1 value=$2
    [ -z "$value" ] && return
    if grep -q "^${key}=" "$ROOT_ENV_FILE" 2>/dev/null; then
        if [[ "$OSTYPE" == "darwin"* ]]; then
            sed -i '' "s|^${key}=.*|${key}=${value}|" "$ROOT_ENV_FILE"
        else
            sed -i "s|^${key}=.*|${key}=${value}|" "$ROOT_ENV_FILE"
        fi
    else
        echo "${key}=${value}" >> "$ROOT_ENV_FILE"
    fi
}

# --- 変数ロード ---
REGION="${AWS_REGION:-ap-northeast-1}"
IDC_PROFILE="${IDC_AWS_PROFILE:-$AWS_PROFILE}"
IDC_REGION="${IDC_AWS_REGION:-$REGION}"
IDC_INSTANCE_ARN=$(get_root_env "IDC_INSTANCE_ARN")
IDENTITY_STORE_ID=$(get_root_env "IDENTITY_STORE_ID")
IDC_ALL_USERS_GROUP=$(get_root_env "IDC_ALL_USERS_GROUP")

if [ -z "$IDC_INSTANCE_ARN" ] || [ -z "$IDENTITY_STORE_ID" ]; then
    echo "❌ IDC_INSTANCE_ARN または IDENTITY_STORE_ID が $ROOT_ENV_FILE に未設定です"
    echo "   先に ./scripts/sync-env.sh を実行してください"
    exit 1
fi
if [ -z "$IDC_ALL_USERS_GROUP" ]; then
    echo "❌ IDC_ALL_USERS_GROUP が $ROOT_ENV_FILE に未設定です"
    exit 1
fi

echo "🔧 IdC OAuth CMA + TTI を設定中..."
[ -n "$ENV_NAME" ] && echo "   Environment: $ENV_NAME"
echo "   IDC_INSTANCE_ARN: $IDC_INSTANCE_ARN"
echo "   IdC Profile: $IDC_PROFILE ($IDC_REGION)"

# --- CfnOutputからCognito情報を取得 ---
echo ""
echo "📦 CfnOutputからCognito情報を取得中... (stack: $ID_STORE_STACK)"

USER_POOL_ID=$(aws cloudformation describe-stacks \
    --stack-name "$ID_STORE_STACK" --region "$REGION" \
    --query 'Stacks[0].Outputs[?OutputKey==`UserPoolId`].OutputValue' --output text)
COGNITO_APP_CLIENT_ID=$(aws cloudformation describe-stacks \
    --stack-name "$ID_STORE_STACK" --region "$REGION" \
    --query 'Stacks[0].Outputs[?OutputKey==`UserPoolClientId`].OutputValue' --output text)

if [ -z "$USER_POOL_ID" ] || [ -z "$COGNITO_APP_CLIENT_ID" ]; then
    echo "❌ $ID_STORE_STACK スタックからCognito情報を取得できません"
    echo "   Phase 3 (IdStoreスタックのデプロイ) を先に実行してください"
    exit 1
fi
echo "   ✅ USER_POOL_ID: $USER_POOL_ID"
echo "   ✅ COGNITO_APP_CLIENT_ID: $COGNITO_APP_CLIENT_ID"

# --- TTI作成（既存ならスキップ） ---
echo ""
echo "🔑 Trusted Token Issuer を作成中..."

TTI_NAME="Agentic-Analyst-Cognito${ENV_NAME:+-$ENV_NAME}"
TTI_ARN=$(aws sso-admin list-trusted-token-issuers \
    --instance-arn "$IDC_INSTANCE_ARN" \
    --profile "$IDC_PROFILE" --region "$IDC_REGION" \
    --query "TrustedTokenIssuers[?Name==\`$TTI_NAME\`].TrustedTokenIssuerArn" --output text)

EXPECTED_ISSUER_URL="https://cognito-idp.${REGION}.amazonaws.com/${USER_POOL_ID}"

if [ -n "$TTI_ARN" ]; then
    # 既存TTIのIssuer URLを検証（User Pool再作成時に不整合が発生しうる）
    CURRENT_ISSUER_URL=$(aws sso-admin describe-trusted-token-issuer \
        --trusted-token-issuer-arn "$TTI_ARN" \
        --profile "$IDC_PROFILE" --region "$IDC_REGION" \
        --query 'TrustedTokenIssuerConfiguration.OidcJwtConfiguration.IssuerUrl' --output text)

    if [ "$CURRENT_ISSUER_URL" = "$EXPECTED_ISSUER_URL" ]; then
        echo "   ⏭️  既存TTIを使用: $TTI_ARN"
    else
        echo "   ⚠️  Issuer URL不整合を検出"
        echo "      現在: $CURRENT_ISSUER_URL"
        echo "      期待: $EXPECTED_ISSUER_URL"
        echo "   🔄 TTIを削除して再作成中..."
        aws sso-admin delete-trusted-token-issuer \
            --trusted-token-issuer-arn "$TTI_ARN" \
            --profile "$IDC_PROFILE" --region "$IDC_REGION"
        TTI_ARN=""
    fi
fi

if [ -z "$TTI_ARN" ]; then
    TTI_ARN=$(aws sso-admin create-trusted-token-issuer \
        --instance-arn "$IDC_INSTANCE_ARN" \
        --name "$TTI_NAME" \
        --trusted-token-issuer-type "OIDC_JWT" \
        --trusted-token-issuer-configuration '{
          "OidcJwtConfiguration": {
            "IssuerUrl": "https://cognito-idp.'"$REGION"'.amazonaws.com/'"$USER_POOL_ID"'",
            "ClaimAttributePath": "email",
            "IdentityStoreAttributePath": "emails.value",
            "JwksRetrievalOption": "OPEN_ID_DISCOVERY"
          }
        }' \
        --profile "$IDC_PROFILE" --region "$IDC_REGION" \
        --query 'TrustedTokenIssuerArn' --output text)
    echo "   ✅ 作成: $TTI_ARN"
fi

# --- OAuth CMA作成（既存ならスキップ） ---
echo ""
echo "📱 OAuth CMA を作成中..."

CMA_NAME="agentic-analyst-tip${ENV_NAME:+-$ENV_NAME}"
IDC_OAUTH_APP_ARN=$(aws sso-admin list-applications \
    --instance-arn "$IDC_INSTANCE_ARN" \
    --profile "$IDC_PROFILE" --region "$IDC_REGION" \
    --query "Applications[?Name==\`$CMA_NAME\`].ApplicationArn" --output text)

if [ -n "$IDC_OAUTH_APP_ARN" ]; then
    echo "   ⏭️  既存CMAを使用: $IDC_OAUTH_APP_ARN"
else
    IDC_OAUTH_APP_ARN=$(aws sso-admin create-application \
        --application-provider-arn "arn:aws:sso::aws:applicationProvider/custom" \
        --instance-arn "$IDC_INSTANCE_ARN" \
        --name "$CMA_NAME" \
        --description "Agentic Analyst - TIP OAuth Application" \
        --portal-options '{"Visibility":"DISABLED"}' \
        --profile "$IDC_PROFILE" --region "$IDC_REGION" \
        --query 'ApplicationArn' --output text)
    echo "   ✅ 作成: $IDC_OAUTH_APP_ARN"
fi

# --- IAM認証方法設定（PUT = 冪等） ---
echo ""
echo "🔐 IAM認証方法を設定中..."

aws sso-admin put-application-authentication-method \
    --application-arn "$IDC_OAUTH_APP_ARN" \
    --authentication-method-type IAM \
    --authentication-method '{"Iam":{"ActorPolicy":{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"AWS":"*"},"Action":"sso-oauth:CreateTokenWithIAM","Resource":"*"}]}}}' \
    --profile "$IDC_PROFILE" --region "$IDC_REGION"
echo "   ✅ IAM認証方法"

# --- TTI Grant設定（PUT = 冪等） ---
echo ""
echo "🔗 TTI Grant を設定中..."

aws sso-admin put-application-grant \
    --application-arn "$IDC_OAUTH_APP_ARN" \
    --grant-type "urn:ietf:params:oauth:grant-type:jwt-bearer" \
    --grant '{"JwtBearer":{"AuthorizedTokenIssuers":[{"TrustedTokenIssuerArn":"'"$TTI_ARN"'","AuthorizedAudiences":["'"$COGNITO_APP_CLIENT_ID"'"]}]}}' \
    --profile "$IDC_PROFILE" --region "$IDC_REGION"
echo "   ✅ JWT Bearer Grant"

# --- アクセススコープ設定（PUT = 冪等） ---
echo ""
echo "🔒 アクセススコープを設定中..."

aws sso-admin put-application-access-scope \
    --application-arn "$IDC_OAUTH_APP_ARN" \
    --scope "datazone:domain:access" \
    --profile "$IDC_PROFILE" --region "$IDC_REGION"
echo "   ✅ datazone:domain:access"

aws sso-admin put-application-access-scope \
    --application-arn "$IDC_OAUTH_APP_ARN" \
    --scope "sso:account:access" \
    --profile "$IDC_PROFILE" --region "$IDC_REGION"
echo "   ✅ sso:account:access"

# --- グループ割り当て（既存なら ConflictException → 無視） ---
echo ""
echo "👥 グループ割り当て中..."

GROUP_ID=$(aws identitystore get-group-id \
    --identity-store-id "$IDENTITY_STORE_ID" \
    --alternate-identifier '{"UniqueAttribute":{"AttributePath":"displayName","AttributeValue":"'"$IDC_ALL_USERS_GROUP"'"}}' \
    --profile "$IDC_PROFILE" --region "$IDC_REGION" \
    --query 'GroupId' --output text)

ASSIGN_OUTPUT=$(aws sso-admin create-application-assignment \
    --application-arn "$IDC_OAUTH_APP_ARN" \
    --principal-id "$GROUP_ID" \
    --principal-type GROUP \
    --profile "$IDC_PROFILE" --region "$IDC_REGION" 2>&1) && {
    echo "   ✅ $IDC_ALL_USERS_GROUP を割り当て"
} || {
    if echo "$ASSIGN_OUTPUT" | grep -q "ConflictException"; then
        echo "   ⏭️  既に割り当て済み"
    else
        echo "   ❌ 割り当て失敗: $ASSIGN_OUTPUT"
        exit 1
    fi
}

# --- .env.local に書き込み ---
echo ""
echo "📝 $ROOT_ENV_FILE を更新中..."
set_root_env "IDC_APPLICATION_ARN" "$IDC_OAUTH_APP_ARN"
echo "   ✅ IDC_APPLICATION_ARN=$IDC_OAUTH_APP_ARN"

echo ""
echo "✅ 完了"
