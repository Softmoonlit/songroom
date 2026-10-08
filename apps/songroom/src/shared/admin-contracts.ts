import { z } from "zod";

export const abnormalOperationTypeSchema = z.enum([
  "unknown_song_write",
  "unknown_playlist_create",
  "unknown_cleanup",
  "risk_control_pause"
]);
export type AbnormalOperationType = z.infer<typeof abnormalOperationTypeSchema>;

export const abnormalActionTypeSchema = z.enum([
  "resolve_song_write",
  "resolve_playlist_create",
  "authorize_cleanup_retry",
  "verify_manual_cleanup",
  "resume_risk_pause"
]);
export type AbnormalActionName = z.infer<typeof abnormalActionTypeSchema>;

export const abnormalConclusionSchema = z.enum([
  "unconfirmed_terminal",
  "ambiguous_continued_pause",
  "binding_restored",
  "transferred_to_cleanup",
  "retry_authorized",
  "manual_verification_triggered",
  "risk_pause_resumed"
]);
export type AbnormalConclusion = z.infer<typeof abnormalConclusionSchema>;

export const abnormalOperationSummarySchema = z.object({
  id: z.string(),
  type: abnormalOperationTypeSchema,
  accountId: z.string(),
  targetId: z.string(),
  status: z.string(),
  version: z.number().nullable().optional(),
  summary: z.string(),
  updatedAt: z.number()
});
export type AbnormalOperationSummary = z.infer<typeof abnormalOperationSummarySchema>;

export const abnormalOperationListResponseSchema = z.object({
  operations: z.array(abnormalOperationSummarySchema)
});
export type AbnormalOperationListResponse = z.infer<typeof abnormalOperationListResponseSchema>;

export const abnormalOperationDetailSchema = z.object({
  id: z.string(),
  type: abnormalOperationTypeSchema,
  accountId: z.string(),
  targetId: z.string(),
  status: z.string(),
  version: z.number().nullable().optional(),
  roomId: z.string().nullable().optional(),
  playlistId: z.string().nullable().optional(),
  checkRound: z.number().nullable().optional(),
  lastErrorCode: z.string().nullable().optional(),
  checkFact: z.string().nullable().optional(),
  candidatePlaylistsCount: z.number().nullable().optional(),
  candidatePlaylistId: z.string().nullable().optional(),
  candidatePlaylistName: z.string().nullable().optional(),
  pauseReason: z.string().nullable().optional(),
  impactDescription: z.string(),
  updatedAt: z.number()
});
export type AbnormalOperationDetail = z.infer<typeof abnormalOperationDetailSchema>;

export const abnormalActionRequestSchema = z.object({
  reason: z.string().min(1).max(500),
  expectedVersion: z.number().int().positive()
});
export type AbnormalActionRequest = z.infer<typeof abnormalActionRequestSchema>;

export const abnormalActionResultSchema = z.object({
  ok: z.boolean(),
  action: abnormalActionTypeSchema,
  targetId: z.string(),
  previousStatus: z.string().nullable().optional(),
  nextStatus: z.string().nullable().optional(),
  conclusion: abnormalConclusionSchema,
  message: z.string()
});
export type AbnormalActionResult = z.infer<typeof abnormalActionResultSchema>;
