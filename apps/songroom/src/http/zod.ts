import type { FastifyInstance, FastifyTypeProvider } from "fastify";
import { z } from "zod";
import { errorResponse } from "../shared/contracts.js";
import { BusinessError } from "../shared/errors.js";

export interface ZodProvider extends FastifyTypeProvider {
  validator: this["schema"] extends z.ZodType ? z.output<this["schema"]> : unknown;
  serializer: this["schema"] extends z.ZodType ? z.input<this["schema"]> : unknown;
}

export function installZod(app: FastifyInstance): void {
  app.setValidatorCompiler<z.ZodType>(({ schema }) => data => {
    const parsed = schema.safeParse(data);
    return parsed.success
      ? { value: parsed.data }
      : { error: new BusinessError(400, "VALIDATION_FAILED", "请求格式不正确") };
  });
  app.setSerializerCompiler<z.ZodType>(({ schema }) => data => JSON.stringify(schema.parse(data)));
  app.setErrorHandler((error, request, reply) => {
    const httpStatus = error && typeof error === "object" && "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : 500;
    const status = error instanceof BusinessError ? error.status : httpStatus;
    const code = error instanceof BusinessError ? error.code
      : status === 400 ? "VALIDATION_FAILED"
      : status === 413 ? "BODY_TOO_LARGE" : "INTERNAL_ERROR";
    const message = error instanceof BusinessError ? error.publicMessage
      : status < 500 ? "请求未被接受" : "服务暂时无法处理请求";
    request.log[status >= 500 ? "error" : "info"]({ code, route: request.routeOptions.url }, "request rejected");
    void reply.status(status).send(errorResponse.parse({ error: { code, message } }));
  });
}
