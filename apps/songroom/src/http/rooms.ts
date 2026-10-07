import type { FastifyInstance } from "fastify";
import type { SongRoomAuth } from "../auth.js";
import type { Rooms } from "../rooms/rooms.js";
import { roomListView, roomCreateView, roomCreateCommand, roomSummary, roomParams, roomShellView, roomMembersView, roomRenameCommand, nicknameRenameCommand, memberParams, roomLeaveCommand, roomLeaveResult, roomMemberRemoveCommand, roomDeletionView, roomDeleteCommand, roomDeleteResult, publicPlaylistCleanupList } from "../shared/room-contracts.js";
import type { ZodProvider } from "./zod.js";
import { requireSession } from "./session.js";

export function registerRoomRoutes(app: FastifyInstance, auth: SongRoomAuth, rooms: Rooms): void {
  const typed = app.withTypeProvider<ZodProvider>();
  typed.get("/api/rooms", { schema: { response: { 200: roomListView } } }, async (request, reply) => {
    return rooms.readList((await requireSession(auth, request, reply)).userId);
  });
  typed.get("/api/rooms/create-view", { schema: { response: { 200: roomCreateView } } }, async (request, reply) => {
    return rooms.readCreateView(await requireSession(auth, request, reply));
  });
  typed.post("/api/rooms", { schema: { body: roomCreateCommand, response: { 200: roomSummary } } }, async (request, reply) => {
    return rooms.create(await requireSession(auth, request, reply), request.body);
  });
  typed.get("/api/rooms/:roomId", { schema: { params: roomParams, response: { 200: roomShellView } } }, async (request, reply) => {
    return rooms.readShell((await requireSession(auth, request, reply)).userId, request.params.roomId);
  });
  typed.post("/api/rooms/:roomId/name", { schema: { params: roomParams, body: roomRenameCommand, response: { 200: roomShellView } } }, async (request, reply) => {
    return rooms.renameRoom((await requireSession(auth, request, reply)).userId, request.params.roomId, request.body);
  });
  typed.post("/api/rooms/:roomId/nickname", { schema: { params: roomParams, body: nicknameRenameCommand, response: { 200: roomShellView } } }, async (request, reply) => {
    return rooms.renameNickname((await requireSession(auth, request, reply)).userId, request.params.roomId, request.body);
  });
  typed.get("/api/rooms/:roomId/members", { schema: { params: roomParams, response: { 200: roomMembersView } } }, async (request, reply) => {
    return rooms.readMembers((await requireSession(auth, request, reply)).userId, request.params.roomId);
  });
  typed.post("/api/rooms/:roomId/leave", { schema: { params: roomParams, body: roomLeaveCommand, response: { 200: roomLeaveResult } } }, async (request, reply) => {
    return rooms.leave((await requireSession(auth, request, reply)).userId, request.params.roomId, request.body);
  });
  typed.post("/api/rooms/:roomId/members/:memberId/remove", { schema: { params: memberParams, body: roomMemberRemoveCommand, response: { 200: roomMembersView } } }, async (request, reply) => {
    return rooms.removeMember((await requireSession(auth, request, reply)).userId, request.params.roomId, request.params.memberId, request.body);
  });
  typed.get("/api/rooms/:roomId/deletion", { schema: { params: roomParams, response: { 200: roomDeletionView } } }, async (request, reply) => {
    return rooms.readDeletion((await requireSession(auth, request, reply)).userId, request.params.roomId);
  });
  typed.post("/api/rooms/:roomId/delete", { schema: { params: roomParams, body: roomDeleteCommand, response: { 200: roomDeleteResult } } }, async (request, reply) => {
    return rooms.deleteRoom((await requireSession(auth, request, reply)).userId, request.params.roomId, request.body);
  });
  typed.get("/api/cleanups/public-playlists", { schema: { response: { 200: publicPlaylistCleanupList } } }, async (request, reply) => {
    return rooms.readCleanups((await requireSession(auth, request, reply)).userId);
  });
}
