import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { playbackView, playNextCommand, playNextResponse, playNextOperationView } from "../shared/public-playlist-contracts.js";
import type { SongRoomAuth } from "../auth.js";
import type { PublicPlaylists } from "../operations/public-playlists.js";
import { publicPlaylistCreateCommand, publicPlaylistView, publicSongRequestCommand, songRequestOperationView, songRequestResponse } from "../shared/public-playlist-contracts.js";
import { roomParams } from "../shared/room-contracts.js";
import { uuidv7 } from "../shared/contracts.js";
import { requireSession } from "./session.js";
import type { ZodProvider } from "./zod.js";

const operationParams = roomParams.extend({
  operationId: uuidv7
});

export function registerPublicPlaylistRoutes(app: FastifyInstance, auth: SongRoomAuth, playlists: PublicPlaylists): void {
  const typed = app.withTypeProvider<ZodProvider>();
  typed.get("/api/rooms/:roomId/public-playlist", { schema: { params: roomParams, response: { 200: publicPlaylistView } } }, async (request, reply) => {
    const principal = await requireSession(auth, request, reply);
    return playlists.read(principal.userId, request.params.roomId);
  });
  typed.post("/api/rooms/:roomId/public-playlist", { schema: { params: roomParams, body: publicPlaylistCreateCommand, response: { 200: publicPlaylistView, 202: publicPlaylistView } } }, async (request, reply) => {
    const principal = await requireSession(auth, request, reply);
    const accepted = playlists.create(principal.userId, request.params.roomId, request.body);
    return reply.code(accepted.replay ? 200 : 202).send(accepted.view);
  });
  typed.post("/api/rooms/:roomId/public-playlist/refresh", { schema: { params: roomParams, response: { 200: publicPlaylistView } } }, async (request, reply) => {
    const principal = await requireSession(auth, request, reply);
    const view = await playlists.refresh(principal.userId, request.params.roomId);
    return reply.code(200).send(view);
  });
  typed.post("/api/rooms/:roomId/song-requests", { schema: { params: roomParams, body: publicSongRequestCommand, response: { 200: songRequestResponse, 202: songRequestResponse } } }, async (request, reply) => {
    const principal = await requireSession(auth, request, reply);
    const accepted = playlists.requestSong(principal.userId, request.params.roomId, request.body);
    return reply.code(accepted.replay ? 200 : 202).send(accepted);
  });
  typed.get("/api/rooms/:roomId/song-requests/:operationId", { schema: { params: operationParams, response: { 200: songRequestOperationView } } }, async (request, reply) => {
    const principal = await requireSession(auth, request, reply);
    return playlists.readOperation(principal.userId, request.params.roomId, request.params.operationId);
  });
  typed.get("/api/rooms/:roomId/public-playlist/playback", { schema: { params: roomParams, response: { 200: playbackView } } }, async (request, reply) => {
    const principal = await requireSession(auth, request, reply);
    return playlists.readPlayback(principal.userId, request.params.roomId);
  });
  typed.post("/api/rooms/:roomId/public-playlist/playback/refresh", { schema: { params: roomParams, body: z.strictObject({}), response: { 200: playbackView } } }, async (request, reply) => {
    const principal = await requireSession(auth, request, reply);
    return playlists.readPlayback(principal.userId, request.params.roomId, true);
  });
  typed.post("/api/rooms/:roomId/public-playlist/play-next", { schema: { params: roomParams, body: playNextCommand, response: { 200: playNextResponse, 202: playNextResponse } } }, async (request, reply) => {
    const principal = await requireSession(auth, request, reply);
    const accepted = playlists.playNext(principal.userId, request.params.roomId, request.body);
    return reply.code(accepted.replay ? 200 : 202).send(accepted);
  });
  typed.get("/api/rooms/:roomId/public-playlist/play-next/:operationId", { schema: { params: operationParams, response: { 200: playNextOperationView } } }, async (request, reply) => {
    const principal = await requireSession(auth, request, reply);
    return playlists.readPlayNextOperation(principal.userId, request.params.roomId, request.params.operationId);
  });

}
