#!/usr/bin/env bash
# FufuGateway 本地/新环境初始化示例。
# 需要：curl、jq。执行前请确认目标网关与管理员令牌。
set -euo pipefail

GATEWAY="${GATEWAY:-http://localhost:8787}"
ADMIN_TOKEN="${ADMIN_TOKEN:-change-me-admin-token}"

admin() {
  curl -sS -X "$1" "$GATEWAY$2" \
    -H "authorization: Bearer $ADMIN_TOKEN" \
    -H "content-type: application/json" \
    ${3:+--data "$3"}
}

echo "1. 创建用户"
USER_JSON=$(admin POST /admin/users '{"email":"demo@example.com","displayName":"Demo","role":"user"}')
USER_ID=$(echo "$USER_JSON" | jq -r '.data.id')
echo "userId=$USER_ID"

echo "2. 创建 API Key（明文只显示一次）"
KEY_JSON=$(admin POST /admin/api-keys "{\"userId\":\"$USER_ID\",\"name\":\"demo\",\"scopes\":[\"inference\"],\"rpmLimit\":60}")
FUFU_KEY=$(echo "$KEY_JSON" | jq -r '.key')
echo "FUFU_KEY=$FUFU_KEY"

echo "3. 创建 OpenAI 兼容 Provider"
PROVIDER_JSON=$(admin POST /admin/providers '{
  "name":"openai",
  "type":"OPENAI_COMPATIBLE",
  "protocol":"openai-chat",
  "baseUrl":"https://api.openai.com/v1",
  "maxRetries":2
}')
PROVIDER_ID=$(echo "$PROVIDER_JSON" | jq -r '.data.id')
echo "providerId=$PROVIDER_ID"

echo "4. 添加上游账户"
read -r -s -p "OpenAI API Key: " OPENAI_KEY
echo
admin POST "/admin/providers/$PROVIDER_ID/accounts" "{\"name\":\"primary\",\"apiKey\":\"$OPENAI_KEY\"}" > /dev/null

echo "5. 创建模型"
admin POST /admin/models "{
  \"providerId\":\"$PROVIDER_ID\",
  \"modelId\":\"gpt-4o-mini\",
  \"upstreamModelId\":\"gpt-4o-mini\",
  \"supportsStream\":true,
  \"supportsTools\":true,
  \"supportsVision\":true,
  \"inputPrice\":0.15,
  \"outputPrice\":0.6
}" > /dev/null

echo "6. 创建 Alias 与 Combo"
admin POST /admin/aliases '{"name":"coding-model","target":"openai/gpt-4o-mini"}' > /dev/null
admin POST /admin/combos '{
  "name":"coding-combo",
  "strategy":"fallback",
  "nodes":["openai/gpt-4o-mini","coding-model"],
  "sticky":{"enabled":true,"ttlSeconds":600,"mode":"round_robin"}
}' > /dev/null

echo "7. 配置已在保存时自动发布；跨实例生效最迟约 60 秒"

echo
echo "尝试一次推理："
curl -sS "$GATEWAY/v1/chat/completions" \
  -H "authorization: Bearer $FUFU_KEY" \
  -H "content-type: application/json" \
  -d '{"model":"coding-combo","messages":[{"role":"user","content":"用一句话介绍你自己"}]}' | jq .
