import type { FastifyInstance } from "fastify";
import type { SongRoomAuth } from "../auth.js";
import { neteaseBindingView, qrFlowView, qrFlowParams, qrStartCommand, qrConfirmCommand, qrCheckCommand } from "../shared/netease-contracts.js";
import { requireSession } from "./session.js";
import type { NeteaseBinding } from "../netease/binding.js";
import type { ZodProvider } from "./zod.js";

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
