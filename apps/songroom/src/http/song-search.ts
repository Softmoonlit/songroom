import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { SongRoomAuth } from "../auth.js";
import type { SongSearchService } from "../operations/song-search.js";
import { roomParams } from "../shared/room-contracts.js";
import { searchCommand, searchInitiatedResponse, searchView } from "../shared/song-search-contracts.js";
import { requireSession } from "./session.js";
import type { ZodProvider } from "./zod.js";
import { uuidv7 } from "../shared/contracts.js";

const searchParams = roomParams.extend({
  searchId: uuidv7
});

export function registerSongSearchRoutes(app: FastifyInstance, auth: SongRoomAuth, searchService: SongSearchService): void {
  const typed = app.withTypeProvider<ZodProvider>();

  typed.post("/api/rooms/:roomId/search", {
    schema: {
      params: roomParams,
      body: searchCommand,
      response: { 202: searchInitiatedResponse }
    }
  }, async (request, reply) => {
    const principal = await requireSession(auth, request, reply);
    const result = await searchService.search(principal.userId, request.params.roomId, request.body.query);
    return reply.code(202).send(result);
  });

  typed.post("/api/rooms/:roomId/search/:searchId/more", {
    schema: {
      params: searchParams,
      response: { 202: searchInitiatedResponse }
    }
  }, async (request, reply) => {
    const principal = await requireSession(auth, request, reply);
    const result = searchService.loadMore(principal.userId, request.params.roomId, request.params.searchId);
    return reply.code(202).send(result);
  });

  typed.get("/api/rooms/:roomId/search/:searchId", {
    schema: {
      params: searchParams,
      response: { 200: searchView }
    }
  }, async (request, reply) => {
    const principal = await requireSession(auth, request, reply);
    return searchService.getSearch(principal.userId, request.params.roomId, request.params.searchId);
  });

  typed.delete("/api/rooms/:roomId/search/:searchId", {
    schema: {
      params: searchParams,
      response: { 200: z.strictObject({ ok: z.literal(true) }) }
    }
  }, async (request, reply) => {
    const principal = await requireSession(auth, request, reply);
    searchService.cancelSearch(principal.userId, request.params.roomId, request.params.searchId);
    return reply.code(200).send({ ok: true });
  });
}
