import type { QueryClient } from "@tanstack/react-query";

export function invalidateRoomIdentity(client: QueryClient, sessionId: string, roomId: string) {
  return Promise.all([
    ...["room-shell", "room-members", "room-invite", "room-applications"].map(resource =>
      client.invalidateQueries({ queryKey: [resource, sessionId, roomId] })),
    client.invalidateQueries({ queryKey: ["rooms", sessionId] }),
    client.invalidateQueries({ queryKey: ["join-applications"] }),
    client.invalidateQueries({ queryKey: ["join-application"] })
  ]);
}
