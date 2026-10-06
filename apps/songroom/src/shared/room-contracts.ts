import { z } from "zod";
import { uuidv7 } from "./contracts.js";

function normalizedText(max: number) {
  return z.string().transform(value => value.trim().normalize("NFC"))
    .refine(value => [...value].length >= 1 && [...value].length <= max && !/\p{Cc}/u.test(value), `请输入 1 到 ${max} 个字符，不能包含控制字符`);
}
export const roomName = normalizedText(16);
export const roomNickname = normalizedText(12);
export const roomRole = z.enum(["owner", "roommate"]);
export const roomSummary = z.object({ id: uuidv7, name: roomName, role: roomRole, nickname: roomNickname });
export const roomListItem = roomSummary.extend({ version: z.number().int().positive(), allowedActions: z.array(z.literal("enterRoom")), disabledReasons: z.strictObject({}) });
export const roomListView = z.object({ rooms: z.array(roomListItem), allowedActions: z.array(z.enum(["openCreateRoom", "openJoin"])), disabledReasons: z.strictObject({}) });
export const roomCreateDisabledReason = z.enum(["NETEASE_AUTH_REQUIRED", "OWNED_ROOM_LIMIT", "JOINED_ROOM_LIMIT", "GLOBAL_ROOM_LIMIT"]);
export const roomCreateView = z.object({
  authorization: z.object({ id: uuidv7, identity: z.object({ accountId: z.string(), nickname: z.string() }) }).nullable(),
  allowedActions: z.array(z.literal("createRoom")),
  disabledReason: roomCreateDisabledReason.nullable()
});
export const roomCreateCommand = z.strictObject({ idempotencyKey: uuidv7, authorizationId: uuidv7, name: roomName, nickname: roomNickname });
export const roomParams = z.strictObject({ roomId: uuidv7 });
export const roomIdentityActions = z.enum(["renameRoom", "renameNickname", "reviewApplications", "readInvite"]);
export const roomIdentityDisabledReasons = z.strictObject({
  renameRoom: z.literal("OWNER_ONLY").optional(),
  reviewApplications: z.literal("OWNER_ONLY").optional(),
  readInvite: z.literal("OWNER_ONLY").optional()
});
export const roomMember = z.object({ id: uuidv7, nickname: roomNickname, role: roomRole, isSelf: z.boolean(), allowedActions: z.array(z.literal("renameNickname")), disabledReasons: z.strictObject({ renameNickname: z.literal("SELF_ONLY").optional() }) });
export const roomShellView = z.object({ room: roomSummary, version: z.number().int().positive(), pendingCount: z.number().int().nonnegative().nullable(), allowedActions: z.array(roomIdentityActions), disabledReasons: roomIdentityDisabledReasons });
export const roomMembersView = z.object({ version: z.number().int().positive(), members: z.array(roomMember), allowedActions: z.array(roomIdentityActions), disabledReasons: roomIdentityDisabledReasons });
export const roomRenameCommand = z.strictObject({ idempotencyKey: uuidv7, name: roomName });
export const nicknameRenameCommand = z.strictObject({ idempotencyKey: uuidv7, nickname: roomNickname });
export type RoomSummary = z.infer<typeof roomSummary>;
export type RoomCreateCommand = z.infer<typeof roomCreateCommand>;
export type RoomCreateView = z.infer<typeof roomCreateView>;
export type RoomMember = z.infer<typeof roomMember>;
