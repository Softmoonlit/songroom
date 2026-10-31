import type { FastifyInstance } from "fastify";
import type { SongRoomAuth } from "../auth.js";
import type { PersonalPlaylists } from "../operations/personal-playlists.js";
import {
  bindPersonalPlaylistCommand,
  favoritePlaylistCandidatesView,
  personalPlaylistView
} from "../shared/personal-playlist-contracts.js";
import { roomParams } from "../shared/room-contracts.js";
import { requireSession } from "./session.js";
import type { ZodProvider } from "./zod.js";

export function registerPersonalPlaylistRoutes(app: FastifyInstance, auth: SongRoomAuth, playlists: PersonalPlaylists): void {
  const typed = app.withTypeProvider<ZodProvider>();

  typed.get("/api/rooms/:roomId/personal-playlist", {
    schema: { params: roomParams, response: { 200: personalPlaylistView } }
  }, async (request, reply) => {
    const principal = await requireSession(auth, request, reply);
    return playlists.read(principal.userId, request.params.roomId);
  });

  typed.post("/api/rooms/:roomId/personal-playlist/refresh", {
    schema: { params: roomParams, response: { 200: personalPlaylistView } }
  }, async (request, reply) => {
    const principal = await requireSession(auth, request, reply);
    return playlists.refresh(principal.userId, request.params.roomId);
  });

  typed.get("/api/rooms/:roomId/personal-playlist/candidates", {
    schema: { params: roomParams, response: { 200: favoritePlaylistCandidatesView } }
  }, async (request, reply) => {
    const principal = await requireSession(auth, request, reply);
    return playlists.getCandidates(principal.userId, request.params.roomId);
  });

  typed.post("/api/rooms/:roomId/personal-playlist/bind", {
    schema: { params: roomParams, body: bindPersonalPlaylistCommand, response: { 200: personalPlaylistView } }
  }, async (request, reply) => {
    const principal = await requireSession(auth, request, reply);
    return playlists.bind(principal.userId, request.params.roomId, request.body);
  });
}
