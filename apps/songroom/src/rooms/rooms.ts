import { randomBytes } from "node:crypto";
import { and, asc, count, eq, sql } from "drizzle-orm";
import { v7 } from "uuid";
import type { AppDatabase } from "../db/database.js";
import { room, roomInvite, roomMembership, joinApplication, neteaseAuthorization, requesterTag, retiredRoomInvite, publicPlaylistCleanup } from "../db/schema.js";
import { prepareCommand } from "../commands/commands.js";
import { readCommandResource, recordCommandResource } from "../commands/receipts.js";
import type { NeteaseBinding } from "../netease/binding.js";
import type { SessionPrincipal } from "../auth.js";
import type { RoomCreateCommand, RoomCreateView, RoomSummary, RoomMember, roomShellView, roomListView, roomMembersView, RoomLeaveCommand, RoomLeaveResult, RoomMemberRemoveCommand, RoomDeleteCommand, RoomDeleteResult, roomDeletionView, publicPlaylistCleanupList } from "../shared/room-contracts.js";
import { roomCreateCommand, roomCreateDisabledReason, roomRenameCommand, nicknameRenameCommand, roomLeaveCommand, roomLeaveResult, roomMemberRemoveCommand, roomDeleteCommand, roomDeleteResult } from "../shared/room-contracts.js";
import type { z } from "zod";
import type { EventStreamService } from "../events/event-stream.js";
import type { PublicPlaylists } from "../operations/public-playlists.js";
import { BusinessError } from "../shared/errors.js";

export function assertRoomCapacity(counts: { owned: number; joined: number; total: number }): void {
  if (counts.owned >= 3) throw new BusinessError(409, "OWNED_ROOM_LIMIT", "最多自建 3 个房间");
  if (counts.joined >= 10) throw new BusinessError(409, "JOINED_ROOM_LIMIT", "最多归属 10 个房间");
  if (counts.total >= 20) throw new BusinessError(409, "GLOBAL_ROOM_LIMIT", "全站房间数量已达上限");
}

function identityPermissions(role: "owner" | "roommate"): Pick<z.infer<typeof roomShellView>, "allowedActions" | "disabledReasons"> {
  return role === "owner"
    ? { allowedActions: ["renameRoom", "renameNickname", "reviewApplications", "readInvite", "deleteRoom"], disabledReasons: {} }
    : { allowedActions: ["renameNickname", "leaveRoom"],
      disabledReasons: { renameRoom: "OWNER_ONLY", reviewApplications: "OWNER_ONLY", readInvite: "OWNER_ONLY", deleteRoom: "OWNER_ONLY" } };
}

export class Rooms {
  readonly eventStream?: EventStreamService;
  readonly now: () => number;
  readonly publicPlaylists?: PublicPlaylists;

  constructor(
    readonly database: AppDatabase,
    readonly binding: NeteaseBinding,
    eventStreamOrNow?: EventStreamService | (() => number),
    now: () => number = () => Date.now(),
    publicPlaylists?: PublicPlaylists
  ) {
    if (typeof eventStreamOrNow === "function") {
      this.now = eventStreamOrNow;
      this.eventStream = undefined;
      this.publicPlaylists = publicPlaylists;
    } else {
      this.eventStream = eventStreamOrNow;
      this.now = now;
      this.publicPlaylists = publicPlaylists;
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
    let disabledReason: RoomCreateView["disabledReason"] = current && current.status === "active" ? null : "NETEASE_AUTH_REQUIRED";
    if (!disabledReason) {
      try { assertRoomCapacity(this.#counts(principal.userId)); }
      catch (error) { if (!(error instanceof BusinessError)) throw error; disabledReason = roomCreateDisabledReason.parse(error.code); }
    }
    return { authorization: current && current.status === "active" ? { id: current.id, identity: current.identity } : null,
      allowedActions: disabledReason ? [] : ["createRoom"], disabledReason };
  }

  #visible(userId: string, roomId?: string) {
    return this.database.select({ id: room.id, name: room.name, nickname: roomMembership.nickname,
      ownerUserId: room.ownerUserId,
      role: sql<"owner" | "roommate">`CASE WHEN ${room.ownerUserId} = ${roomMembership.userId} THEN 'owner' ELSE 'roommate' END`, version: room.version
    }).from(roomMembership).innerJoin(room, eq(room.id, roomMembership.roomId))
      .where(and(eq(roomMembership.userId, userId), roomId ? eq(room.id, roomId) : undefined)).orderBy(asc(room.id));
  }

  readList(userId: string): z.infer<typeof roomListView> {
    const list = this.#visible(userId).all();
    const ownerAuths = this.database.select({
      userId: neteaseAuthorization.userId,
      status: neteaseAuthorization.status
    }).from(neteaseAuthorization).all();
    const authMap = new Map(ownerAuths.map(a => [a.userId, a.status]));

    return {
      rooms: list.map(({ ownerUserId, ...summary }) => ({
        ...summary,
        allowedActions: ["enterRoom"],
        disabledReasons: {},
        ...(authMap.get(ownerUserId) === "waitingAuthorization" ? { authorizationStatus: "waitingAuthorization" as const } : {})
      })),
      allowedActions: ["openCreateRoom", "openJoin"],
      disabledReasons: {}
    };
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
    return {
      version: shell.version,
      members: members.map((member): RoomMember => {
        const allowedActions: ("renameNickname" | "removeMember")[] = [];
        const disabledReasons: RoomMember["disabledReasons"] = {};
        if (member.isSelf) {
          allowedActions.push("renameNickname");
        } else {
          disabledReasons.renameNickname = "SELF_ONLY";
        }
        if (shell.room.role === "owner" && member.role === "roommate") {
          allowedActions.push("removeMember");
        }
        return { ...member, allowedActions, disabledReasons };
      }),
      ...identityPermissions(shell.room.role)
    };
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

  #terminateMemberInTx(tx: any, roomId: string, targetMember: { id: string; userId: string; nickname: string }) {
    // 1. 硬删除当前成员关系，释放昵称
    tx.delete(roomMembership).where(eq(roomMembership.id, targetMember.id)).run();

    // 2. 删除该成员在当前公共绑定上的全部点歌人标签
    tx.delete(requesterTag).where(eq(requesterTag.memberId, targetMember.id)).run();

    // 3. 委派操作模块处理点歌操作终止清理
    this.publicPlaylists?.terminateMemberInTx(tx, roomId, targetMember.userId);

    // 4. 递增房间版本
    tx.update(room).set({ version: sql`${room.version} + 1` }).where(eq(room.id, roomId)).run();
  }

  #notifyMemberTermination(roomId: string, targetUserId: string, version: number) {
    this.eventStream?.notifyRoom(this.database, roomId, { type: "room", resourceId: roomId, version });
    this.eventStream?.notifyRoom(this.database, roomId, { type: "permission", resourceId: roomId, version });
    this.eventStream?.notifyRoom(this.database, roomId, { type: "snapshot", resourceId: roomId, version });
    this.eventStream?.notifyUser(targetUserId, { type: "room", resourceId: roomId, version });
    this.eventStream?.notifyUser(targetUserId, { type: "permission", resourceId: roomId, version });
  }

  leave(userId: string, roomId: string, input: RoomLeaveCommand): RoomLeaveResult {
    const command = roomLeaveCommand.parse(input);
    const prepared = prepareCommand(userId, command.idempotencyKey, "leaveRoom", { roomId }, this.now());
    const outcome = this.database.transaction(tx => {
      const replay = readCommandResource(tx, prepared, this.now());
      if (replay) return { kind: "replayed" as const, roomId };
      const current = this.readShell(userId, roomId);
      if (current.room.role === "owner") {
        throw new BusinessError(403, "OWNER_CANNOT_LEAVE", "房主不能以室友退出流程离开自己的房间");
      }
      const member = tx.select().from(roomMembership).where(and(eq(roomMembership.roomId, roomId), eq(roomMembership.userId, userId))).get();
      if (!member) {
        throw new BusinessError(404, "ROOM_UNAVAILABLE", "房间不存在或你已不是当前成员");
      }
      this.#terminateMemberInTx(tx, roomId, member);
      recordCommandResource(tx, prepared, roomId, this.now());
      const nextVersion = tx.select({ version: room.version }).from(room).where(eq(room.id, roomId)).get()!.version;
      return { kind: "terminated" as const, roomId, targetUserId: userId, version: nextVersion };
    }, { behavior: "immediate" });

    if (outcome.kind === "terminated") {
      this.#notifyMemberTermination(outcome.roomId, outcome.targetUserId, outcome.version);
    }
    return { ok: true, roomId: outcome.roomId };
  }

  removeMember(userId: string, roomId: string, memberId: string, input: RoomMemberRemoveCommand): z.infer<typeof roomMembersView> {
    const command = roomMemberRemoveCommand.parse(input);
    const prepared = prepareCommand(userId, command.idempotencyKey, "removeMember", { roomId, memberId, version: command.version }, this.now());
    const outcome = this.database.transaction(tx => {
      const current = this.readShell(userId, roomId);
      if (current.room.role !== "owner") {
        throw new BusinessError(404, "ROOM_OWNER_REQUIRED", "只有当前房主可移除成员");
      }
      const replay = readCommandResource(tx, prepared, this.now());
      if (replay) return { kind: "replayed" as const, members: this.readMembers(userId, roomId) };

      if (command.version !== current.version) {
        throw new BusinessError(409, "ROOM_VERSION_CONFLICT", "房间状态或成员信息已变化，请核对最新影响范围后再试");
      }

      const targetMember = tx.select().from(roomMembership).where(and(eq(roomMembership.roomId, roomId), eq(roomMembership.id, memberId))).get();
      if (!targetMember) {
        throw new BusinessError(409, "ROOM_VERSION_CONFLICT", "成员已不在房间中，请核对最新成员列表");
      }
      if (targetMember.userId === userId) {
        throw new BusinessError(409, "CANNOT_REMOVE_OWNER", "不能移除房主本人");
      }

      this.#terminateMemberInTx(tx, roomId, targetMember);
      recordCommandResource(tx, prepared, roomId, this.now());
      const updatedMembers = this.readMembers(userId, roomId);
      return { kind: "terminated" as const, members: updatedMembers, targetUserId: targetMember.userId, version: updatedMembers.version };
    }, { behavior: "immediate" });

    if (outcome.kind === "terminated") {
      this.#notifyMemberTermination(roomId, outcome.targetUserId, outcome.version);
    }
    return outcome.members;
  }

  #requirePublicPlaylists(): PublicPlaylists {
    if (!this.publicPlaylists) throw new Error("PublicPlaylists 模块未就绪");
    return this.publicPlaylists;
  }

  readDeletion(userId: string, roomId: string): z.infer<typeof roomDeletionView> {
    const shell = this.readShell(userId, roomId);
    if (shell.room.role !== "owner") {
      throw new BusinessError(404, "ROOM_OWNER_REQUIRED", "只有当前房主可查看删除影响范围");
    }
    const memberCount = this.database.select({ value: count() })
      .from(roomMembership).where(eq(roomMembership.roomId, roomId)).get()!.value;
    const pendingApplicationCount = this.database.select({ value: count() })
      .from(joinApplication).where(and(eq(joinApplication.roomId, roomId), eq(joinApplication.status, "pending"))).get()!.value;

    const target = this.#requirePublicPlaylists().readPublicPlaylistTarget(roomId);
    const publicPlaylist = target ? {
      id: target.id,
      name: target.name
    } : null;

    return {
      room: { id: shell.room.id, name: shell.room.name },
      version: shell.version,
      memberCount,
      pendingApplicationCount,
      publicPlaylist,
      allowedActions: ["deleteRoom"],
      disabledReasons: {}
    };
  }

  deleteRoom(userId: string, roomId: string, input: RoomDeleteCommand): RoomDeleteResult {
    const command = roomDeleteCommand.parse(input);
    const prepared = prepareCommand(userId, command.idempotencyKey, "deleteRoom", { roomId, version: command.version }, this.now());
    const outcome = this.database.transaction(tx => {
      const replay = readCommandResource(tx, prepared, this.now());
      if (replay) {
        try {
          const parsed = JSON.parse(replay) as { roomId: string; cleanupId: string | null };
          return { kind: "replayed" as const, roomId: parsed.roomId, cleanupId: parsed.cleanupId };
        } catch {
          return { kind: "replayed" as const, roomId: replay, cleanupId: null };
        }
      }

      const current = this.readShell(userId, roomId);
      if (current.room.role !== "owner") {
        throw new BusinessError(404, "ROOM_OWNER_REQUIRED", "只有当前房主可删除房间");
      }
      if (command.version !== current.version) {
        throw new BusinessError(409, "ROOM_VERSION_CONFLICT", "房间状态或成员信息已变化，请核对最新影响范围后再试");
      }

      const members = tx.select({ userId: roomMembership.userId }).from(roomMembership).where(eq(roomMembership.roomId, roomId)).all();
      const memberUserIds = members.map(m => m.userId);

      const { cleanupId } = this.#requirePublicPlaylists().terminateRoomInTx(tx, roomId, userId);

      tx.delete(joinApplication).where(eq(joinApplication.roomId, roomId)).run();
      tx.delete(roomInvite).where(eq(roomInvite.roomId, roomId)).run();
      tx.delete(retiredRoomInvite).where(eq(retiredRoomInvite.roomId, roomId)).run();
      tx.delete(roomMembership).where(eq(roomMembership.roomId, roomId)).run();
      tx.delete(room).where(eq(room.id, roomId)).run();

      const receiptPayload = JSON.stringify({ roomId, cleanupId });
      recordCommandResource(tx, prepared, receiptPayload, this.now());

      return {
        kind: "deleted" as const,
        roomId,
        cleanupId,
        memberUserIds,
        version: current.version + 1
      };
    }, { behavior: "immediate" });

    if (outcome.kind === "deleted") {
      this.eventStream?.notifyRoom(this.database, outcome.roomId, { type: "room", resourceId: outcome.roomId, version: outcome.version });
      this.eventStream?.notifyRoom(this.database, outcome.roomId, { type: "permission", resourceId: outcome.roomId, version: outcome.version });
      for (const mId of outcome.memberUserIds) {
        this.eventStream?.notifyUser(mId, { type: "room", resourceId: outcome.roomId, version: outcome.version });
        this.eventStream?.notifyUser(mId, { type: "permission", resourceId: outcome.roomId, version: outcome.version });
      }

      if (outcome.cleanupId) {
        this.#requirePublicPlaylists().dispatchCleanup(outcome.cleanupId);
      }
    }

    let cleanupInfo: RoomDeleteResult["cleanup"] = null;
    if (outcome.cleanupId) {
      const cRow = this.database.select({ id: publicPlaylistCleanup.id, status: publicPlaylistCleanup.status })
        .from(publicPlaylistCleanup).where(eq(publicPlaylistCleanup.id, outcome.cleanupId)).get();
      if (cRow) cleanupInfo = { id: cRow.id, status: cRow.status };
    }

    return {
      ok: true,
      roomId: outcome.roomId,
      cleanup: cleanupInfo
    };
  }

  readCleanups(userId: string): z.infer<typeof publicPlaylistCleanupList> {
    return this.#requirePublicPlaylists().readCleanups(userId);
  }
}
