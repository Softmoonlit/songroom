import type { FastifyInstance } from "fastify";
import type { SongRoomAuth } from "../auth.js";
import type { PublicPlaylists } from "../operations/public-playlists.js";
import { publicPlaylistCreateCommand, publicPlaylistView } from "../shared/public-playlist-contracts.js";
import { roomParams } from "../shared/room-contracts.js";
import { requireSession } from "./session.js";
import type { ZodProvider } from "./zod.js";

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
}
