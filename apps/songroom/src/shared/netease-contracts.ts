import { z } from "zod";
import { commandKey, upstreamId, uuidv7 } from "./contracts.js";

export const neteaseIdentity = z.strictObject({ accountId: upstreamId, nickname: z.string().max(200) });
export const neteaseBindingView = z.strictObject({
  binding: z.strictObject({ id: uuidv7, identity: neteaseIdentity, status: z.enum(["active", "waitingAuthorization"]) }).nullable(),
  allowedActions: z.array(z.enum(["startQr", "revoke"]))
});
export const qrFlowView = z.strictObject({
  id: uuidv7,
  expiresAt: z.iso.datetime(),
  status: z.enum(["waiting", "scanned", "awaitingConfirmation", "completed"]),
  qrImage: z.string().startsWith("data:image/png;base64,").nullable(),
  identity: neteaseIdentity.nullable(),
  allowedActions: z.array(z.enum(["check", "confirm"]))
});
export const qrFlowParams = z.strictObject({ flowId: uuidv7 });
export const qrStartCommand = commandKey;
export const qrConfirmCommand = commandKey;
export const qrCheckCommand = z.strictObject({});
export const qrRevokeCommand = commandKey;
export type NeteaseBindingView = z.infer<typeof neteaseBindingView>;
export type QrFlowView = z.infer<typeof qrFlowView>;
export type QrRevokeCommand = z.infer<typeof qrRevokeCommand>;
