import { randomBytes } from "node:crypto";
import { and, asc, count, eq, sql } from "drizzle-orm";
import { v7 } from "uuid";
import type { AppDatabase } from "../db/database.js";
import { room, roomInvite, roomMembership } from "../db/schema.js";
import { prepareCommand } from "../commands/commands.js";
import { readCommandResource, recordCommandResource } from "../commands/receipts.js";
import type { NeteaseBinding } from "../netease/binding.js";
import type { SessionPrincipal } from "../auth.js";
import type { RoomCreateCommand, RoomCreateView, RoomSummary } from "../shared/room-contracts.js";
import { roomCreateCommand, roomCreateDisabledReason } from "../shared/room-contracts.js";
import { BusinessError } from "../shared/errors.js";

export function assertRoomCapacity(counts: { owned: number; joined: number; total: number }): void {
  if (counts.owned >= 3) throw new BusinessError(409, "OWNED_ROOM_LIMIT", "最多自建 3 个房间");
  if (counts.joined >= 10) throw new BusinessError(409, "JOINED_ROOM_LIMIT", "最多归属 10 个房间");
  if (counts.total >= 20) throw new BusinessError(409, "GLOBAL_ROOM_LIMIT", "全站房间数量已达上限");
}

export class Rooms {
  constructor(readonly database: AppDatabase, readonly binding: NeteaseBinding, readonly now = () => Date.now()) {}

  #counts(userId: string) {
    return {
      owned: this.database.select({ value: count() }).from(room).where(eq(room.ownerUserId, userId)).get()!.value,
      joined: this.database.select({ value: count() }).from(roomMembership).where(eq(roomMembership.userId, userId)).get()!.value,
      total: this.database.select({ value: count() }).from(room).get()!.value
    };
  }

  readCreateView(principal: SessionPrincipal): RoomCreateView {
    const current = this.binding.readBinding(principal).binding;
    let disabledReason: RoomCreateView["disabledReason"] = current ? null : "NETEASE_AUTH_REQUIRED";
    if (!disabledReason) {
      try { assertRoomCapacity(this.#counts(principal.userId)); }
      catch (error) { if (!(error instanceof BusinessError)) throw error; disabledReason = roomCreateDisabledReason.parse(error.code); }
    }
    return { authorization: current ? { id: current.id, identity: current.identity } : null,
      allowedActions: disabledReason ? [] : ["createRoom"], disabledReason };
  }

  #visible(userId: string, roomId?: string) {
    return this.database.select({ id: room.id, name: room.name, nickname: roomMembership.nickname,
      role: sql<"owner" | "roommate">`CASE WHEN ${room.ownerUserId} = ${roomMembership.userId} THEN 'owner' ELSE 'roommate' END`, version: room.version
    }).from(roomMembership).innerJoin(room, eq(room.id, roomMembership.roomId))
      .where(and(eq(roomMembership.userId, userId), roomId ? eq(room.id, roomId) : undefined)).orderBy(asc(room.id));
  }

  readList(userId: string) {
    return { rooms: this.#visible(userId).all().map(({ version: _version, ...summary }) => summary) };
  }

  readShell(userId: string, roomId: string) {
    const visible = this.#visible(userId, roomId).get();
    if (!visible) throw new BusinessError(404, "ROOM_UNAVAILABLE", "房间不存在或你已不是当前成员");
    const { version, ...summary } = visible;
    return { room: summary, version };
  }

  readMembers(userId: string, roomId: string) {
    this.readShell(userId, roomId);
    return { members: this.database.select({ id: roomMembership.id, nickname: roomMembership.nickname,
      role: sql<"owner" | "roommate">`CASE WHEN ${room.ownerUserId} = ${roomMembership.userId} THEN 'owner' ELSE 'roommate' END`,
      isSelf: sql<boolean>`(${roomMembership.userId} = ${userId})`.mapWith(Boolean)
    }).from(roomMembership).innerJoin(room, eq(room.id, roomMembership.roomId)).where(eq(roomMembership.roomId, roomId)).orderBy(asc(roomMembership.id)).all() };
  }

  async create(principal: SessionPrincipal, input: RoomCreateCommand): Promise<RoomSummary> {
    const command = roomCreateCommand.parse(input);
    const { idempotencyKey, ...content } = command;
    const prepared = prepareCommand(principal.userId, idempotencyKey, "createRoom", content, this.now());
    this.binding.readBinding(principal);
    const replay = () => {
      const resourceId = readCommandResource(this.database, prepared, this.now());
      return resourceId ? this.readShell(principal.userId, resourceId).room : undefined;
    };
    const existing = replay();
    if (existing) return existing;
    assertRoomCapacity(this.#counts(principal.userId));
    const version = await this.binding.verifyAuthorization(principal, command.authorizationId);
    return this.database.transaction(tx => {
      // 上游调用期间会话、授权、容量或同键命令均可能变化；提交事务重新核验。
      this.binding.assertAuthorization(principal, command.authorizationId, version);
      prepareCommand(principal.userId, idempotencyKey, "createRoom", content, this.now());
      const concurrent = replay();
      if (concurrent) return concurrent;
      assertRoomCapacity(this.#counts(principal.userId));
      const roomId = v7();
      tx.insert(room).values({ id: roomId, name: command.name, ownerUserId: principal.userId }).run();
      tx.insert(roomMembership).values({ id: v7(), roomId, userId: principal.userId, nickname: command.nickname }).run();
      // 八字节取前六十位，十个 base64url 字符均保持完整六位随机熵。
      const code = randomBytes(8).toString("base64url").slice(0, 10);
      tx.insert(roomInvite).values({ roomId, code }).run();
      recordCommandResource(tx, prepared, roomId, this.now());
      return this.readShell(principal.userId, roomId).room;
    }, { behavior: "immediate" });
  }
}
