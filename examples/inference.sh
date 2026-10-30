#!/usr/bin/env bash
# 推理入口示例。FUFU_KEY 为下游 API Key。
set -euo pipefail
GATEWAY="${GATEWAY:-http://localhost:8787}"
FUFU_KEY="${FUFU_KEY:?set FUFU_KEY}"

echo "== OpenAI Chat =="
curl -sS "$GATEWAY/v1/chat/completions" \
  -H "authorization: Bearer $FUFU_KEY" \
  -H "content-type: application/json" \
  -d '{"model":"openai/gpt-5","messages":[{"role":"user","content":"hello"}]}'

echo
echo "== OpenAI Responses =="
curl -sS "$GATEWAY/v1/responses" \
  -H "authorization: Bearer $FUFU_KEY" \
  -H "content-type: application/json" \
  -d '{"model":"openai/gpt-5","input":"hello"}'

echo
echo "== Anthropic Messages =="
curl -sS "$GATEWAY/v1/messages" \
  -H "x-api-key: $FUFU_KEY" \
  -H "content-type: application/json" \
  -d '{"model":"anthropic/claude-sonnet-4-5","max_tokens":256,"messages":[{"role":"user","content":"hello"}]}'

echo
echo "== Gemini =="
curl -sS "$GATEWAY/v1beta/models/google/gemini-2.5-pro:generateContent" \
  -H "x-goog-api-key: $FUFU_KEY" \
  -H "content-type: application/json" \
  -d '{"contents":[{"role":"user","parts":[{"text":"hello"}]}]}'

echo
echo "== OpenAI Chat Stream =="
curl -sN "$GATEWAY/v1/chat/completions" \
  -H "authorization: Bearer $FUFU_KEY" \
  -H "content-type: application/json" \
  -d '{"model":"openai/gpt-5","stream":true,"messages":[{"role":"user","content":"hello"}]}'
