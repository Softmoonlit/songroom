import type { FastifyReply, FastifyRequest } from "fastify";
import type { SessionPrincipal, SongRoomAuth } from "../auth.js";
import { BusinessError } from "../shared/errors.js";

export async function requireSession(auth: SongRoomAuth, request: FastifyRequest, reply: FastifyReply): Promise<SessionPrincipal> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  const result = await auth.api.getSession({ headers, returnHeaders: true });
  const cookies = result.headers.getSetCookie();
  if (cookies.length > 0) reply.header("set-cookie", cookies);
  if (!result.response) throw new BusinessError(401, "SESSION_REQUIRED", "请重新登录点歌台");
  return {
    userId: result.response.user.id,
    sessionId: result.response.session.id,
    expiresAt: result.response.session.expiresAt
  };
}
