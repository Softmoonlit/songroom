import { z } from "zod";

export const abnormalOperationTypeSchema = z.enum([
  "unknown_song_write",
  "unknown_playlist_create",
  "unknown_cleanup",
  "risk_control_pause"
]);
export type AbnormalOperationType = z.infer<typeof abnormalOperationTypeSchema>;

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
  songId: z.string().nullable().optional(),
  checkRound: z.number().nullable().optional(),
  lastErrorCode: z.string().nullable().optional(),
  checkFact: z.string().nullable().optional(),
  candidatePlaylistsCount: z.number().nullable().optional(),
  candidatePlaylistId: z.string().nullable().optional(),
  candidatePlaylistName: z.string().nullable().optional(),
  impactDescription: z.string(),
  updatedAt: z.number()
});
export type AbnormalOperationDetail = z.infer<typeof abnormalOperationDetailSchema>;

export const abnormalActionRequestSchema = z.object({
  reason: z.string().min(1).max(500),
  expectedVersion: z.number().int().positive().optional()
});
export type AbnormalActionRequest = z.infer<typeof abnormalActionRequestSchema>;

export const abnormalActionResultSchema = z.object({
  ok: z.boolean(),
  action: z.string(),
  targetId: z.string(),
  previousStatus: z.string().nullable().optional(),
  nextStatus: z.string().nullable().optional(),
  conclusion: z.string(),
  message: z.string()
});
export type AbnormalActionResult = z.infer<typeof abnormalActionResultSchema>;
