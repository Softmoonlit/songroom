import type { FastifyInstance } from "fastify";
import type { SongRoomAuth } from "../auth.js";
import type { PersonalPlaylists } from "../operations/personal-playlists.js";
import {
  personalPlaylistCreateCommand,
  personalPlaylistView,
  personalSongAddCommand,
  personalSongRemoveCommand,
  personalSongRemoveResponse,
  personalSongAddResponse,
  personalSongOperationView
} from "../shared/personal-playlist-contracts.js";
import { roomParams } from "../shared/room-contracts.js";
import { uuidv7 } from "../shared/contracts.js";
import { requireSession } from "./session.js";
import type { ZodProvider } from "./zod.js";

const memberPersonalPlaylistParams = roomParams.extend({
  memberId: uuidv7
});

const personalSongOperationParams = roomParams.extend({
  operationId: uuidv7
});

export function registerPersonalPlaylistRoutes(app: FastifyInstance, auth: SongRoomAuth, playlists: PersonalPlaylists): void {
  const typed = app.withTypeProvider<ZodProvider>();

  typed.get("/api/rooms/:roomId/personal-playlist", {
    schema: { params: roomParams, response: { 200: personalPlaylistView } }
  }, async (request, reply) => {
    const principal = await requireSession(auth, request, reply);
    return playlists.read(principal.userId, request.params.roomId);
  });


  typed.post("/api/rooms/:roomId/personal-playlist/create", {
    schema: { params: roomParams, body: personalPlaylistCreateCommand, response: { 200: personalPlaylistView, 202: personalPlaylistView } }
  }, async (request, reply) => {
    const principal = await requireSession(auth, request, reply);
    const result = playlists.create(principal.userId, request.params.roomId, request.body);
    return reply.code(result.accepted ? 202 : 200).send(result.view);
  });



  typed.post("/api/rooms/:roomId/personal-playlist/refresh", {
    schema: { params: roomParams, response: { 200: personalPlaylistView } }
  }, async (request, reply) => {
    const principal = await requireSession(auth, request, reply);
    return playlists.refresh(principal.userId, request.params.roomId);
  });

  typed.post("/api/rooms/:roomId/personal-playlist/songs", {
    schema: {
      params: roomParams,
      body: personalSongAddCommand,
      response: {
        200: personalSongAddResponse,
        202: personalSongAddResponse
      }
    }
  }, async (request, reply) => {
    const principal = await requireSession(auth, request, reply);
    const result = playlists.addSong(principal.userId, request.params.roomId, request.body);
    const statusCode = result.replay || result.operation.status === "succeeded" ? 200 : 202;
    return reply.code(statusCode).send(result);
  });

  typed.post("/api/rooms/:roomId/personal-playlist/songs/remove", {
    schema: { params: roomParams, body: personalSongRemoveCommand,
      response: { 200: personalSongRemoveResponse, 202: personalSongRemoveResponse } }
  }, async (request, reply) => {
    const principal = await requireSession(auth, request, reply);
    const result = playlists.removeSong(principal.userId, request.params.roomId, request.body);
    return reply.code(result.replay || result.operation.status === "succeeded" ? 200 : 202).send(result);
  });

  typed.get("/api/rooms/:roomId/personal-playlist/songs/:operationId", {
    schema: {
      params: personalSongOperationParams,
      response: {
        200: personalSongOperationView
      }
    }
  }, async (request, reply) => {
    const principal = await requireSession(auth, request, reply);
    return playlists.readSongOperation(principal.userId, request.params.roomId, request.params.operationId);
  });

  typed.get("/api/rooms/:roomId/members/:memberId/personal-playlist", {
    schema: { params: memberPersonalPlaylistParams, response: { 200: personalPlaylistView } }
  }, async (request, reply) => {
    const principal = await requireSession(auth, request, reply);
    return playlists.read(principal.userId, request.params.roomId, request.params.memberId);
  });

  typed.post("/api/rooms/:roomId/members/:memberId/personal-playlist/refresh", {
    schema: { params: memberPersonalPlaylistParams, response: { 200: personalPlaylistView } }
  }, async (request, reply) => {
    const principal = await requireSession(auth, request, reply);
    return playlists.refresh(principal.userId, request.params.roomId, request.params.memberId);
  });
}
