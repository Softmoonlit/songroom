import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { SongRoomAuth } from "../auth.js";
import { neteaseBindingView, qrFlowView, qrFlowParams, qrStartCommand, qrConfirmCommand, qrCheckCommand } from "../shared/netease-contracts.js";
import { BusinessError } from "../shared/errors.js";
import type { NeteaseBinding } from "../netease/binding.js";
import type { ZodProvider } from "./zod.js";

async function requireSession(auth: SongRoomAuth, request: FastifyRequest, reply: FastifyReply) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  const result = await auth.api.getSession({ headers, returnHeaders: true });
  const cookies = result.headers.getSetCookie();
  if (cookies.length > 0) reply.header("set-cookie", cookies);
  if (!result.response) throw new BusinessError(401, "SESSION_REQUIRED", "请重新登录点歌台");
  return { userId: result.response.user.id, sessionId: result.response.session.id };
}

export function registerNeteaseRoutes(app: FastifyInstance, auth: SongRoomAuth, binding: NeteaseBinding): void {
  const typed = app.withTypeProvider<ZodProvider>();
  typed.get("/api/netease/binding", { schema: { response: { 200: neteaseBindingView } } }, async (request, reply) => {
    return binding.readBinding(await requireSession(auth, request, reply));
  });
  typed.post("/api/netease/qr-flows", { schema: { body: qrStartCommand, response: { 200: qrFlowView } } }, async (request, reply) => {
    return binding.start(await requireSession(auth, request, reply), request.body.idempotencyKey);
  });
  typed.get("/api/netease/qr-flows/:flowId", { schema: { params: qrFlowParams, response: { 200: qrFlowView } } }, async (request, reply) => {
    return binding.readFlow(await requireSession(auth, request, reply), request.params.flowId);
  });
  typed.post("/api/netease/qr-flows/:flowId/check", { schema: { params: qrFlowParams, body: qrCheckCommand, response: { 200: qrFlowView } } }, async (request, reply) => {
    return binding.check(await requireSession(auth, request, reply), request.params.flowId);
  });
  typed.post("/api/netease/qr-flows/:flowId/confirm", { schema: { params: qrFlowParams, body: qrConfirmCommand, response: { 200: neteaseBindingView } } }, async (request, reply) => {
    return binding.confirm(await requireSession(auth, request, reply), request.params.flowId, request.body.idempotencyKey);
  });
}
