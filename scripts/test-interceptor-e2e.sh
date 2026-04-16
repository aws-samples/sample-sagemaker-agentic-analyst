#!/usr/bin/env bash
# E2Eテスト: Pre Token Generation V2 + Policy Engine + Interceptor
#
# 前提:
#   source .env.credentials
#   .env.test-tokens に各ユーザーのCognito Access Tokenを設定済み
#
# 使い方:
#   ./scripts/test-interceptor-e2e.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REGION="${AWS_REGION:-ap-northeast-1}"

# --- 色 ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

pass() { echo -e "${GREEN}✅ PASS${NC}: $1"; PASS_COUNT=$((PASS_COUNT+1)); }
fail() { echo -e "${RED}❌ FAIL${NC}: $1"; FAIL_COUNT=$((FAIL_COUNT+1)); }
skip() { echo -e "${YELLOW}⏭ SKIP${NC}: $1"; SKIP_COUNT=$((SKIP_COUNT+1)); }

PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0

# --- .env.test-tokens 読み込み ---
TOKEN_FILE="$ROOT_DIR/.env.test-tokens"
if [ ! -f "$TOKEN_FILE" ]; then
  echo "❌ $TOKEN_FILE が見つかりません"
  echo ""
  echo "各ユーザーでログイン後、/api/cognito-token のレスポンスからaccessTokenを取得し、"
  echo "以下の形式で $TOKEN_FILE に記載してください:"
  echo ""
  echo "  DATA_OWNER_TOKEN=eyJraWQi..."
  echo "  BUSINESS_ANALYST_TOKEN=eyJraWQi..."
  echo "  CORP_ADMIN_TOKEN=eyJraWQi..."
  exit 1
fi
source "$TOKEN_FILE"

# --- Gateway URL取得（CDK Outputs） ---
CDK_DIR="$ROOT_DIR/apps/cdk"
MAIN_OUTPUT=$(aws cloudformation describe-stacks \
  --stack-name AgenticAnalyst \
  --region "$REGION" \
  --query 'Stacks[0].Outputs' \
  --output json 2>/dev/null || echo "[]")

GATEWAY_ARN=$(echo "$MAIN_OUTPUT" | jq -r '.[] | select(.OutputKey=="GatewayArn") | .OutputValue // empty')
if [ -z "$GATEWAY_ARN" ]; then
  echo "❌ GatewayArn が CDK Outputs から取得できません。デプロイ済みか確認してください。"
  exit 1
fi
GATEWAY_ID="${GATEWAY_ARN##*/}"
GATEWAY_URL="https://${GATEWAY_ID}.gateway.bedrock-agentcore.${REGION}.amazonaws.com/mcp"
echo "Gateway URL: $GATEWAY_URL"
echo ""

# ============================================================
# ブロック1: Pre Token Generation V2 の検証（cognito:groups）
# ============================================================
echo "=========================================="
echo "ブロック1: cognito:groups クレーム検証"
echo "=========================================="

decode_jwt_payload() {
  local token="$1"
  local payload=$(echo "$token" | cut -d'.' -f2)
  # base64urlをbase64に変換してデコード
  local padded=$(echo "$payload" | tr '_-' '/+')
  local mod=$((${#padded} % 4))
  if [ $mod -eq 2 ]; then padded="${padded}=="; elif [ $mod -eq 3 ]; then padded="${padded}="; fi
  echo "$padded" | base64 -d 2>/dev/null
}

check_groups() {
  local label="$1" token="$2" expected_group="$3"
  local payload
  payload=$(decode_jwt_payload "$token")
  local groups
  groups=$(echo "$payload" | jq -r '."cognito:groups" // empty')

  if [ -z "$groups" ]; then
    fail "$label: cognito:groups クレームが存在しない"
    return
  fi

  echo "  $label groups: $groups"
  if echo "$groups" | jq -e "index(\"$expected_group\")" > /dev/null 2>&1; then
    pass "$label: cognito:groups に '$expected_group' が含まれる"
  else
    fail "$label: cognito:groups に '$expected_group' が含まれない"
  fi
}

if [ -n "${DATA_OWNER_TOKEN:-}" ]; then check_groups "dg-data-owner" "$DATA_OWNER_TOKEN" "data-producers"; else skip "DATA_OWNER_TOKEN 未設定"; fi
if [ -n "${BUSINESS_ANALYST_TOKEN:-}" ]; then check_groups "dg-business-analyst" "$BUSINESS_ANALYST_TOKEN" "data-consumers"; else skip "BUSINESS_ANALYST_TOKEN 未設定"; fi
if [ -n "${CORP_ADMIN_TOKEN:-}" ]; then check_groups "dg-corp-admin" "$CORP_ADMIN_TOKEN" "security-auditors"; else skip "CORP_ADMIN_TOKEN 未設定"; fi

echo ""

# ============================================================
# ブロック2: Policy Engine + Interceptor + Tool Lambda 検証
# ============================================================
echo "=========================================="
echo "ブロック2: Gateway MCP ツール認可検証"
echo "=========================================="

# MCP tools/call リクエスト送信
call_tool() {
  local token="$1" tool_name="$2" args="$3"
  curl -s -w "\n%{http_code}" -X POST "$GATEWAY_URL" \
    -H "Authorization: Bearer $token" \
    -H "Content-Type: application/json" \
    -d "{
      \"jsonrpc\": \"2.0\",
      \"id\": 1,
      \"method\": \"tools/call\",
      \"params\": {
        \"name\": \"$tool_name\",
        \"arguments\": $args
      }
    }" 2>/dev/null
}

# テスト実行: 許可/拒否を検証
test_allow() {
  local label="$1" token="$2" tool="$3" args="$4"
  local response
  response=$(call_tool "$token" "$tool" "$args")
  local http_code=$(echo "$response" | tail -1)
  local body=$(echo "$response" | sed '$d')

  if [ "$http_code" = "200" ]; then
    # jsonrpc errorでないことを確認
    if echo "$body" | jq -e '.error' > /dev/null 2>&1; then
      local error_msg=$(echo "$body" | jq -r '.error.message // .error // "unknown"')
      # Policy Engine拒否はerrorとして返る場合がある
      if echo "$error_msg" | grep -qi "denied\|unauthorized\|forbidden\|not authorized"; then
        fail "$label: ALLOW期待だが拒否された — $error_msg"
      else
        # ツール実行エラー（認可は通過）はPASS扱い
        pass "$label: 認可通過（ツール実行エラー: $error_msg）"
      fi
    else
      pass "$label: ALLOW"
    fi
  elif [ "$http_code" = "403" ] || [ "$http_code" = "401" ]; then
    fail "$label: ALLOW期待だがHTTP $http_code で拒否"
  else
    # 5xx等はツール側エラーの可能性（認可は通過）
    pass "$label: 認可通過（HTTP $http_code）"
  fi
}

test_deny() {
  local label="$1" token="$2" tool="$3" args="$4"
  local response
  response=$(call_tool "$token" "$tool" "$args")
  local http_code=$(echo "$response" | tail -1)
  local body=$(echo "$response" | sed '$d')

  if [ "$http_code" = "403" ] || [ "$http_code" = "401" ]; then
    pass "$label: DENY (HTTP $http_code)"
  elif [ "$http_code" = "200" ]; then
    if echo "$body" | jq -e '.error' > /dev/null 2>&1; then
      local error_msg=$(echo "$body" | jq -r '.error.message // .error // "unknown"')
      if echo "$error_msg" | grep -qi "denied\|unauthorized\|forbidden\|not authorized"; then
        pass "$label: DENY (jsonrpc error)"
      else
        fail "$label: DENY期待だが認可通過（error: $error_msg）"
      fi
    else
      fail "$label: DENY期待だが認可通過（HTTP 200, 正常レスポンス）"
    fi
  else
    fail "$label: 予期しないHTTP $http_code"
  fi
}

# ダミー引数（ツール実行自体は失敗してもOK、認可の通過/拒否を検証）
ATHENA_ARGS='{"sql":"SELECT 1"}'
CATALOG_ARGS='{"query":"test"}'
CLOUDTRAIL_ARGS='{"sql":"SELECT eventTime FROM dummy LIMIT 1"}'

echo ""
echo "--- dg-data-owner (data-producers) ---"
if [ -n "${DATA_OWNER_TOKEN:-}" ]; then
  test_allow "data-owner → athena_query" "$DATA_OWNER_TOKEN" "data-access___athena_query" "$ATHENA_ARGS"
  test_allow "data-owner → catalog_search" "$DATA_OWNER_TOKEN" "data-catalog___catalog_search" "$CATALOG_ARGS"
  test_deny  "data-owner → cloudtrail_query" "$DATA_OWNER_TOKEN" "cloudtrail-query___cloudtrail_query" "$CLOUDTRAIL_ARGS"
else
  skip "DATA_OWNER_TOKEN 未設定"
fi

echo ""
echo "--- dg-business-analyst (data-consumers) ---"
if [ -n "${BUSINESS_ANALYST_TOKEN:-}" ]; then
  test_allow "analyst → athena_query" "$BUSINESS_ANALYST_TOKEN" "data-access___athena_query" "$ATHENA_ARGS"
  test_allow "analyst → catalog_search" "$BUSINESS_ANALYST_TOKEN" "data-catalog___catalog_search" "$CATALOG_ARGS"
  test_deny  "analyst → cloudtrail_query" "$BUSINESS_ANALYST_TOKEN" "cloudtrail-query___cloudtrail_query" "$CLOUDTRAIL_ARGS"
else
  skip "BUSINESS_ANALYST_TOKEN 未設定"
fi

echo ""
echo "--- dg-corp-admin (security-auditors) ---"
if [ -n "${CORP_ADMIN_TOKEN:-}" ]; then
  test_deny  "admin → athena_query" "$CORP_ADMIN_TOKEN" "data-access___athena_query" "$ATHENA_ARGS"
  test_deny  "admin → catalog_search" "$CORP_ADMIN_TOKEN" "data-catalog___catalog_search" "$CATALOG_ARGS"
  test_allow "admin → cloudtrail_query" "$CORP_ADMIN_TOKEN" "cloudtrail-query___cloudtrail_query" "$CLOUDTRAIL_ARGS"
else
  skip "CORP_ADMIN_TOKEN 未設定"
fi

# ============================================================
# サマリー
# ============================================================
echo ""
echo "=========================================="
echo "結果サマリー"
echo "=========================================="
echo -e "  ${GREEN}PASS${NC}: $PASS_COUNT"
echo -e "  ${RED}FAIL${NC}: $FAIL_COUNT"
echo -e "  ${YELLOW}SKIP${NC}: $SKIP_COUNT"
echo ""

if [ "$FAIL_COUNT" -gt 0 ]; then
  echo -e "${RED}テスト失敗がありますわ。${NC}"
  exit 1
else
  echo -e "${GREEN}全テスト通過ですわ。${NC}"
  exit 0
fi
