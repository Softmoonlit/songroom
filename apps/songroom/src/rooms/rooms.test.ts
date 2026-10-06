import { expect, it } from "vitest";
import { assertRoomCapacity } from "./rooms.js";
import { roomName, roomNickname } from "../shared/room-contracts.js";

it("建房在自建三、当前归属十、全站二十的各自边界拒绝新增", () => {
  expect(() => assertRoomCapacity({ owned: 2, joined: 9, total: 19 })).not.toThrow();
  expect(() => assertRoomCapacity({ owned: 3, joined: 3, total: 3 })).toThrowError("OWNED_ROOM_LIMIT");
  expect(() => assertRoomCapacity({ owned: 2, joined: 10, total: 19 })).toThrowError("JOINED_ROOM_LIMIT");
  expect(() => assertRoomCapacity({ owned: 2, joined: 9, total: 20 })).toThrowError("GLOBAL_ROOM_LIMIT");
});

it("昵称去首尾空白并规范 NFC，保留大小写敏感语义和码点长度", () => {
  expect(roomNickname.parse(" e\u0301 ")).toBe("é");
  expect(roomNickname.parse(" alice ")).toBe("alice");
  expect(roomNickname.parse("Alice")).toBe("Alice");
  expect(roomNickname.safeParse("😀".repeat(12)).success).toBe(true);
  expect(roomNickname.safeParse("😀".repeat(13)).success).toBe(false);
  expect(roomName.safeParse("😀".repeat(16)).success).toBe(true);
  expect(roomName.safeParse("😀".repeat(17)).success).toBe(false);
});
