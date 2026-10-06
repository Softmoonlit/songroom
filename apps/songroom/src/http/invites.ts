import type { FastifyInstance } from "fastify";
import type { SongRoomAuth } from "../auth.js";
import type { Invites } from "../invites/invites.js";
import {
  withdrawApplicationCommand, inviteInspectCommand, inviteInspectView, inviteResetCommand, inviteView,
  joinApplicationCommand, joinApplicationList, joinApplicationParams, joinApplicationView,
  applicationDecisionCommand, roomApplicationParams, roomApplicationsView
} from "../shared/invite-contracts.js";
import { roomParams } from "../shared/room-contracts.js";
import { requireSession } from "./session.js";
import type { ZodProvider } from "./zod.js";

export function registerInviteRoutes(app: FastifyInstance, auth: SongRoomAuth, invites: Invites): void {
  const typed = app.withTypeProvider<ZodProvider>();
  typed.get("/api/rooms/:roomId/invite", { schema: { params: roomParams, response: { 200: inviteView } } }, async (request, reply) => {
    return invites.readInvite((await requireSession(auth, request, reply)).userId, request.params.roomId);
  });
  typed.post("/api/rooms/:roomId/invite/reset", { schema: { params: roomParams, body: inviteResetCommand, response: { 200: inviteView } } }, async (request, reply) => {
    return invites.reset((await requireSession(auth, request, reply)).userId, request.params.roomId, request.body);
  });
  typed.get("/api/rooms/:roomId/applications", { schema: { params: roomParams, response: { 200: roomApplicationsView } } }, async (request, reply) => {
    return invites.readPending((await requireSession(auth, request, reply)).userId, request.params.roomId);
  });
  typed.post("/api/rooms/:roomId/applications/:applicationId/decision", { schema: { params: roomApplicationParams, body: applicationDecisionCommand, response: { 200: joinApplicationView } } }, async (request, reply) => {
    return invites.decide((await requireSession(auth, request, reply)).userId, request.params.roomId, request.params.applicationId, request.body);
  });
  typed.post("/api/invites/inspect", { schema: { body: inviteInspectCommand, response: { 200: inviteInspectView } } }, async (request, reply) => {
    return invites.inspect((await requireSession(auth, request, reply)).userId, request.body.code);
  });
  typed.post("/api/join-applications", { schema: { body: joinApplicationCommand, response: { 200: joinApplicationView } } }, async (request, reply) => {
    return invites.submit((await requireSession(auth, request, reply)).userId, request.body);
  });
  typed.get("/api/join-applications", { schema: { response: { 200: joinApplicationList } } }, async (request, reply) => {
    return invites.readList((await requireSession(auth, request, reply)).userId);
  });
  typed.get("/api/join-applications/:applicationId", { schema: { params: joinApplicationParams, response: { 200: joinApplicationView } } }, async (request, reply) => {
    return invites.readApplication((await requireSession(auth, request, reply)).userId, request.params.applicationId);
  });
  typed.post("/api/join-applications/:applicationId/withdraw", { schema: { params: joinApplicationParams, body: withdrawApplicationCommand, response: { 200: joinApplicationView } } }, async (request, reply) => {
    return invites.withdraw((await requireSession(auth, request, reply)).userId, request.params.applicationId, request.body);
  });
}
