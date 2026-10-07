import { randomBytes } from "node:crypto";
import { and, asc, count, eq, sql } from "drizzle-orm";
import { v7 } from "uuid";
import type { AppDatabase } from "../db/database.js";
import { room, roomInvite, roomMembership, joinApplication } from "../db/schema.js";
import { prepareCommand } from "../commands/commands.js";
import { readCommandResource, recordCommandResource } from "../commands/receipts.js";
import type { NeteaseBinding } from "../netease/binding.js";
import type { SessionPrincipal } from "../auth.js";
import type { RoomCreateCommand, RoomCreateView, RoomSummary, RoomMember, roomShellView, roomListView } from "../shared/room-contracts.js";
import { roomCreateCommand, roomCreateDisabledReason, roomRenameCommand, nicknameRenameCommand } from "../shared/room-contracts.js";
import type { z } from "zod";
import type { EventStreamService } from "../events/event-stream.js";
import { BusinessError } from "../shared/errors.js";

export function assertRoomCapacity(counts: { owned: number; joined: number; total: number }): void {
  if (counts.owned >= 3) throw new BusinessError(409, "OWNED_ROOM_LIMIT", "最多自建 3 个房间");
  if (counts.joined >= 10) throw new BusinessError(409, "JOINED_ROOM_LIMIT", "最多归属 10 个房间");
  if (counts.total >= 20) throw new BusinessError(409, "GLOBAL_ROOM_LIMIT", "全站房间数量已达上限");
}

function identityPermissions(role: "owner" | "roommate"): Pick<z.infer<typeof roomShellView>, "allowedActions" | "disabledReasons"> {
  return role === "owner"
    ? { allowedActions: ["renameRoom", "renameNickname", "reviewApplications", "readInvite"], disabledReasons: {} }
    : { allowedActions: ["renameNickname"],
      disabledReasons: { renameRoom: "OWNER_ONLY", reviewApplications: "OWNER_ONLY", readInvite: "OWNER_ONLY" } };
}

export class Rooms {
  readonly eventStream?: EventStreamService;
  readonly now: () => number;

  constructor(
    readonly database: AppDatabase,
    readonly binding: NeteaseBinding,
    eventStreamOrNow?: EventStreamService | (() => number),
    now: () => number = () => Date.now()
  ) {
    if (typeof eventStreamOrNow === "function") {
      this.now = eventStreamOrNow;
      this.eventStream = undefined;
    } else {
      this.eventStream = eventStreamOrNow;
      this.now = now;
    }
  }

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

  readList(userId: string): z.infer<typeof roomListView> {
    return { rooms: this.#visible(userId).all().map(summary => ({ ...summary, allowedActions: ["enterRoom"], disabledReasons: {} })),
      allowedActions: ["openCreateRoom", "openJoin"], disabledReasons: {} };
  }

  readShell(userId: string, roomId: string) {
    const visible = this.#visible(userId, roomId).get();
    if (!visible) throw new BusinessError(404, "ROOM_UNAVAILABLE", "房间不存在或你已不是当前成员");
    const { version, ...summary } = visible;
    const pendingCount = summary.role === "owner" ? this.database.select({ value: count() }).from(joinApplication)
      .where(and(eq(joinApplication.roomId, roomId), eq(joinApplication.status, "pending"))).get()!.value : null;
    return { room: summary, version, pendingCount, ...identityPermissions(summary.role) };
  }

  readMembers(userId: string, roomId: string) {
    const shell = this.readShell(userId, roomId);
    const members = this.database.select({ id: roomMembership.id, nickname: roomMembership.nickname,
      role: sql<"owner" | "roommate">`CASE WHEN ${room.ownerUserId} = ${roomMembership.userId} THEN 'owner' ELSE 'roommate' END`,
      isSelf: sql<boolean>`(${roomMembership.userId} = ${userId})`.mapWith(Boolean)
    }).from(roomMembership).innerJoin(room, eq(room.id, roomMembership.roomId)).where(eq(roomMembership.roomId, roomId)).orderBy(asc(roomMembership.id)).all();
    return { version: shell.version, members: members.map((member): RoomMember => ({ ...member,
      allowedActions: member.isSelf ? ["renameNickname" as const] : [],
      disabledReasons: member.isSelf ? {} : { renameNickname: "SELF_ONLY" }
    })), ...identityPermissions(shell.room.role) };
  }

  renameRoom(userId: string, roomId: string, input: z.infer<typeof roomRenameCommand>) {
    const command = roomRenameCommand.parse(input);
    const prepared = prepareCommand(userId, command.idempotencyKey, "renameRoom", { roomId, name: command.name }, this.now());
    const result = this.database.transaction(tx => {
      const current = this.readShell(userId, roomId);
      if (current.room.role !== "owner") throw new BusinessError(404, "ROOM_OWNER_REQUIRED", "只有当前房主可修改房间名称");
      if (readCommandResource(tx, prepared, this.now())) return current;
      if (current.room.name !== command.name) {
        tx.update(room).set({ name: command.name, version: sql`${room.version} + 1` }).where(eq(room.id, roomId)).run();
      }
      recordCommandResource(tx, prepared, roomId, this.now());
      return this.readShell(userId, roomId);
    }, { behavior: "immediate" });
    if (result) {
      this.eventStream?.notifyRoom(this.database, roomId, { type: "room", resourceId: roomId, version: result.version });
    }
    return result;
  }

  renameNickname(userId: string, roomId: string, input: z.infer<typeof nicknameRenameCommand>) {
    const command = nicknameRenameCommand.parse(input);
    const prepared = prepareCommand(userId, command.idempotencyKey, "renameNickname", { roomId, nickname: command.nickname }, this.now());
    const result = this.database.transaction(tx => {
      const current = this.readShell(userId, roomId);
      if (readCommandResource(tx, prepared, this.now())) return current;
      if (current.room.nickname !== command.nickname) {
        if (tx.select({ id: roomMembership.id }).from(roomMembership)
          .where(and(eq(roomMembership.roomId, roomId), eq(roomMembership.nickname, command.nickname))).get()) {
          throw new BusinessError(409, "NICKNAME_TAKEN", "昵称已被当前成员使用，请换一个昵称");
        }
        tx.update(roomMembership).set({ nickname: command.nickname })
          .where(and(eq(roomMembership.roomId, roomId), eq(roomMembership.userId, userId))).run();
        tx.update(room).set({ version: sql`${room.version} + 1` }).where(eq(room.id, roomId)).run();
      }
      recordCommandResource(tx, prepared, roomId, this.now());
      return this.readShell(userId, roomId);
    }, { behavior: "immediate" });
    if (result) {
      this.eventStream?.notifyRoom(this.database, roomId, { type: "permission", resourceId: roomId, version: result.version });
    }
    return result;
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
    const created = this.database.transaction(tx => {
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
    this.eventStream?.notifyUser(principal.userId, { type: "room", resourceId: created.id, version: 1 });
    return created;
  }
}
