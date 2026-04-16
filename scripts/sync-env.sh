#!/bin/bash
# =============================================================================
# 環境変数の自動解決スクリプト
#
# ルートの .env.local（手動設定値）+ CDK Outputs + AWS API から値を解決し、
# 各サブモジュールに必要な変数だけを書き出す。
#
# Usage:
#   source .env.credentials && ./scripts/sync-env.sh           # 無印環境
#   source .env.credentials && ./scripts/sync-env.sh dev       # dev環境
#   source .env.credentials && ./scripts/sync-env.sh stg       # stg環境
#   source .env.credentials && ./scripts/sync-env.sh --dry-run # 無印 dry-run
#   source .env.credentials && ./scripts/sync-env.sh dev --dry-run
#
# 解決する値:
#   ルート .env.local:
#     - IDC_INSTANCE_ARN → IDENTITY_STORE_ID, IDC_PORTAL_URL
#   apps/webapp/.env.local:
#     - CDK Outputs → Cognito, AgentCore, IDC_PORTAL_URL
#     - ルート .env.local → DATAZONE_DOMAIN_ID
#   apps/chat-agent/.env.local:
#     - CDK Outputs → AGENTCORE_GATEWAY_URL
# =============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# --- 引数パース: [ENV_NAME] [--dry-run] ---
ENV_NAME=""
DRY_RUN=false
for arg in "$@"; do
    case "$arg" in
        --dry-run) DRY_RUN=true ;;
        -*) echo "❌ 不明なオプション: $arg"; exit 1 ;;
        *) ENV_NAME="$arg" ;;
    esac
done

# 環境名に応じたファイル・スタック名
if [ -n "$ENV_NAME" ]; then
    ROOT_ENV_FILE="$PROJECT_ROOT/.env.local.${ENV_NAME}"
    MAIN_STACK="${ENV_NAME}-AgenticAnalyst"
    ID_STORE_STACK="${ENV_NAME}-AgenticAnalystIdStore"
else
    ROOT_ENV_FILE="$PROJECT_ROOT/.env.local"
    MAIN_STACK="AgenticAnalyst"
    ID_STORE_STACK="AgenticAnalystIdStore"
fi

WEBAPP_ENV_FILE="$PROJECT_ROOT/apps/webapp/.env.local"
CHAT_ENV_FILE="$PROJECT_ROOT/apps/chat-agent/.env.local"
REGION="${AWS_REGION:-ap-northeast-1}"

# AWS_PROFILEの確認
if [ -z "$AWS_PROFILE" ]; then
    echo "❌ AWS_PROFILEが設定されていません"
    echo "   例: source .env.credentials && ./scripts/sync-env.sh"
    exit 1
fi

echo "🔄 環境変数を自動解決中..."
[ -n "$ENV_NAME" ] && echo "   Environment: $ENV_NAME"
echo "   Region: $REGION"
echo "   Profile: $AWS_PROFILE"
echo "   Env file: $ROOT_ENV_FILE"

# --- ヘルパー関数 ---

GENERATED_HEADER='# ╔══════════════════════════════════════════════════════════════════╗
# ║  DO NOT EDIT — このファイルは scripts/sync-env.sh が自動生成    ║
# ║  手動設定はルートの .env.local を編集してください               ║
# ╚══════════════════════════════════════════════════════════════════╝'

get_root_env() {
    local key="$1"
    if [ -f "$ROOT_ENV_FILE" ]; then
        grep "^${key}=" "$ROOT_ENV_FILE" 2>/dev/null | cut -d'=' -f2- | head -1
    fi
}

set_root_env() {
    local key=$1
    local value=$2
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

write_env_file() {
    local file="$1"
    shift
    # $@ = KEY=VALUE pairs
    {
        echo "$GENERATED_HEADER"
        echo ""
        for pair in "$@"; do
            echo "$pair"
        done
    } > "$file"
}

get_stack_output() {
    local stack_name="$1"
    aws cloudformation describe-stacks \
        --stack-name "$stack_name" \
        --region "$REGION" \
        --output json 2>/dev/null || echo "{}"
}

get_output() {
    local output="$1"
    local key_pattern="$2"
    echo "$output" | jq -r ".Stacks[0].Outputs[] | select(.OutputKey | contains(\"$key_pattern\")) | .OutputValue" 2>/dev/null | head -1
}

# =============================================================================
# Phase 1: ルート .env.local の自動解決（API経由）
# =============================================================================
if [ -f "$ROOT_ENV_FILE" ]; then
    echo ""
    echo "📦 ルート $ROOT_ENV_FILE の値を自動解決中..."

    # IDC_INSTANCE_ARN → IDENTITY_STORE_ID, IDC_PORTAL_URL
    IDC_INSTANCE_ARN=$(get_root_env "IDC_INSTANCE_ARN")
    if [ -n "$IDC_INSTANCE_ARN" ]; then
        IDC_INSTANCES=$(aws sso-admin list-instances --region "$REGION" --output json 2>/dev/null)
        IDENTITY_STORE_ID=$(echo "$IDC_INSTANCES" | jq -r ".Instances[] | select(.InstanceArn == \"$IDC_INSTANCE_ARN\") | .IdentityStoreId" | head -1)
        IDC_PORTAL_URL=$(echo "$IDC_INSTANCES" | jq -r ".Instances[] | select(.InstanceArn == \"$IDC_INSTANCE_ARN\") | .PortalUrl // empty" | head -1)

        if [ -n "$IDENTITY_STORE_ID" ]; then
            set_root_env "IDENTITY_STORE_ID" "$IDENTITY_STORE_ID"
            echo "   ✅ IDENTITY_STORE_ID: $IDENTITY_STORE_ID"
        fi
        # PortalUrlがAPIから取得できない場合、Identity Store IDから生成
        if [ -z "$IDC_PORTAL_URL" ] && [ -n "$IDENTITY_STORE_ID" ]; then
            IDC_PORTAL_URL="https://${IDENTITY_STORE_ID}.awsapps.com/start"
        fi
        if [ -n "$IDC_PORTAL_URL" ]; then
            set_root_env "IDC_PORTAL_URL" "$IDC_PORTAL_URL"
            echo "   ✅ IDC_PORTAL_URL: $IDC_PORTAL_URL"
        fi
    fi
else
    echo "⚠️  $ROOT_ENV_FILE が見つかりません。.env.local.example からコピーしてください。"
    exit 1
fi

# =============================================================================
# Phase 2: CDK Outputsの取得
# =============================================================================
echo ""
echo "📦 CDK Outputsから取得中... (stack: $MAIN_STACK, $ID_STORE_STACK)"

MAIN_OUTPUT=$(get_stack_output "$MAIN_STACK")
ID_STORE_OUTPUT=$(get_stack_output "$ID_STORE_STACK")

# IdStoreStackから取得
USER_POOL_ID=$(get_output "$ID_STORE_OUTPUT" "UserPoolId")
USER_POOL_CLIENT_ID=$(get_output "$ID_STORE_OUTPUT" "UserPoolClientId")
COGNITO_DOMAIN=$(get_output "$ID_STORE_OUTPUT" "CognitoDomainName")

# MainStackから取得
RUNTIME_ARN=$(get_output "$MAIN_OUTPUT" "RuntimeArn")
CDK_IDC_PORTAL_URL=$(get_output "$MAIN_OUTPUT" "IdcPortalUrl")
GATEWAY_ARN=$(get_output "$MAIN_OUTPUT" "GatewayArn")
AGENTCORE_MEMORY_ID=$(get_output "$MAIN_OUTPUT" "AgentCoreMemoryId")
DSQL_ENDPOINT=$(get_output "$MAIN_OUTPUT" "DsqlEndpoint")

# CloudTrail Event Data Store ARN
CLOUDTRAIL_EVENT_DATA_STORE_ID=$(aws cloudformation describe-stack-resources \
    --stack-name "$MAIN_STACK" \
    --region "$REGION" \
    --output json 2>/dev/null \
    | jq -r '.StackResources[] | select(.ResourceType == "AWS::CloudTrail::EventDataStore") | .PhysicalResourceId' \
    | head -1)

# ルート .env.local から取得
DATAZONE_DOMAIN_ID=$(get_root_env "SMUS_DOMAIN_ID")
IDC_IDENTITY_STORE_ID=$(get_root_env "IDENTITY_STORE_ID")
IDC_APPLICATION_ARN=$(get_root_env "IDC_APPLICATION_ARN")
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text 2>/dev/null)

[ -n "$USER_POOL_ID" ] && echo "   ✅ Cognito: $USER_POOL_ID"
[ -n "$RUNTIME_ARN" ] && echo "   ✅ AgentCore Runtime: $RUNTIME_ARN"
[ -n "$AGENTCORE_MEMORY_ID" ] && echo "   ✅ AgentCore Memory ID: $AGENTCORE_MEMORY_ID"
[ -n "$DSQL_ENDPOINT" ] && echo "   ✅ DSQL Endpoint: $DSQL_ENDPOINT"
[ -n "$DATAZONE_DOMAIN_ID" ] && echo "   ✅ DataZone Domain ID: $DATAZONE_DOMAIN_ID"
[ -n "$CDK_IDC_PORTAL_URL" ] && echo "   ✅ IdC Portal URL: $CDK_IDC_PORTAL_URL"
[ -n "$CLOUDTRAIL_EVENT_DATA_STORE_ID" ] && echo "   ✅ CloudTrail Event Data Store: $CLOUDTRAIL_EVENT_DATA_STORE_ID"
[ -n "$AWS_ACCOUNT_ID" ] && echo "   ✅ AWS_ACCOUNT_ID: $AWS_ACCOUNT_ID"

if [ -z "$USER_POOL_ID" ] && [ -z "$RUNTIME_ARN" ]; then
    echo "   ⚠️  CDKスタックが未デプロイです（デプロイ後に再実行してください）"
fi

if [ "$DRY_RUN" = true ]; then
    echo ""
    echo "🧪 DRY-RUNモード: サブモジュールの .env.local は更新されません"
    exit 0
fi

# =============================================================================
# Phase 3: apps/webapp/.env.local の生成
# =============================================================================
echo ""
echo "📝 apps/webapp/.env.local を生成中..."

WEBAPP_VARS=()
[ -n "$COGNITO_DOMAIN" ] && WEBAPP_VARS+=("COGNITO_DOMAIN=$COGNITO_DOMAIN")
[ -n "$USER_POOL_ID" ] && WEBAPP_VARS+=("USER_POOL_ID=$USER_POOL_ID")
[ -n "$USER_POOL_CLIENT_ID" ] && WEBAPP_VARS+=("USER_POOL_CLIENT_ID=$USER_POOL_CLIENT_ID")
WEBAPP_VARS+=("AMPLIFY_APP_ORIGIN=http://localhost:3012")
WEBAPP_VARS+=("NEXT_PUBLIC_AWS_REGION=$REGION")
WEBAPP_VARS+=("AWS_REGION=$REGION")
WEBAPP_VARS+=("AWS_PROFILE=$AWS_PROFILE")
[ -n "$AWS_ACCOUNT_ID" ] && WEBAPP_VARS+=("AWS_ACCOUNT_ID=$AWS_ACCOUNT_ID")
[ -n "$RUNTIME_ARN" ] && WEBAPP_VARS+=("AGENTCORE_RUNTIME_ARN=$RUNTIME_ARN")
WEBAPP_VARS+=("AGENTCORE_ENDPOINT=http://localhost:8082")
[ -n "$DATAZONE_DOMAIN_ID" ] && WEBAPP_VARS+=("DATAZONE_DOMAIN_ID=$DATAZONE_DOMAIN_ID")
[ -n "$CDK_IDC_PORTAL_URL" ] && WEBAPP_VARS+=("IDC_PORTAL_URL=$CDK_IDC_PORTAL_URL")
[ -n "$IDC_IDENTITY_STORE_ID" ] && WEBAPP_VARS+=("IDC_IDENTITY_STORE_ID=$IDC_IDENTITY_STORE_ID")
[ -n "$IDC_APPLICATION_ARN" ] && WEBAPP_VARS+=("IDC_APPLICATION_ARN=$IDC_APPLICATION_ARN")
[ -n "$CLOUDTRAIL_EVENT_DATA_STORE_ID" ] && WEBAPP_VARS+=("CLOUDTRAIL_EVENT_DATA_STORE_ID=$CLOUDTRAIL_EVENT_DATA_STORE_ID")

write_env_file "$WEBAPP_ENV_FILE" "${WEBAPP_VARS[@]}"
echo "   ✅ $(wc -l < "$WEBAPP_ENV_FILE" | tr -d ' ') 行"

# =============================================================================
# Phase 4: apps/chat-agent/.env.local の生成
# =============================================================================
echo ""
echo "📝 apps/chat-agent/.env.local を生成中..."

CHAT_VARS=()
CHAT_VARS+=("PORT=8082")
CHAT_VARS+=("NODE_ENV=development")
CHAT_VARS+=("AWS_REGION=$REGION")
CHAT_VARS+=("AWS_PROFILE=$AWS_PROFILE")

if [ -n "$GATEWAY_ARN" ]; then
    GATEWAY_ID="${GATEWAY_ARN##*/}"
    GATEWAY_URL="https://${GATEWAY_ID}.gateway.bedrock-agentcore.${REGION}.amazonaws.com/mcp"
    CHAT_VARS+=("AGENTCORE_GATEWAY_URL=$GATEWAY_URL")
    echo "   ✅ AGENTCORE_GATEWAY_URL: $GATEWAY_URL"
fi

[ -n "$AGENTCORE_MEMORY_ID" ] && CHAT_VARS+=("AGENTCORE_MEMORY_ID=$AGENTCORE_MEMORY_ID") && echo "   ✅ AGENTCORE_MEMORY_ID: $AGENTCORE_MEMORY_ID"
[ -n "$DSQL_ENDPOINT" ] && CHAT_VARS+=("DSQL_ENDPOINT=$DSQL_ENDPOINT") && echo "   ✅ DSQL_ENDPOINT: $DSQL_ENDPOINT"

[ -n "$CLOUDTRAIL_EVENT_DATA_STORE_ID" ] && CHAT_VARS+=("CLOUDTRAIL_EVENT_DATA_STORE_ID=$CLOUDTRAIL_EVENT_DATA_STORE_ID")
[ -n "$IDC_APPLICATION_ARN" ] && CHAT_VARS+=("IDC_APPLICATION_ARN=$IDC_APPLICATION_ARN") && echo "   ✅ IDC_APPLICATION_ARN: $IDC_APPLICATION_ARN"

write_env_file "$CHAT_ENV_FILE" "${CHAT_VARS[@]}"
echo "   ✅ $(wc -l < "$CHAT_ENV_FILE" | tr -d ' ') 行"

echo ""
echo "✅ 完了"
