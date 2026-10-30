import type { PublicModel } from "../../ir/models";
import type { RenderContext } from "../types";
import { jsonHttpResponse } from "./http";

/** OpenAI 家族共用的模型列表响应。 */
export function renderOpenAIModelList(
  models: PublicModel[],
  ctx: RenderContext,
): ReturnType<typeof jsonHttpResponse> {
  return jsonHttpResponse(
    {
      object: "list",
      data: models.map((model) => ({
        id: model.id,
        object: "model",
        created: Math.floor((model.createdAt ?? ctx.created) / 1000),
        owned_by: model.providerName,
      })),
    },
    200,
    { "x-request-id": ctx.requestId },
  );
}
