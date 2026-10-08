import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { SongRoomAuth } from "../auth.js";
import type { AppConfig } from "../config.js";
import { BusinessError } from "../shared/errors.js";
import type { AbnormalOperationsService } from "../operations/abnormal-operations.js";
import {
  abnormalActionRequestSchema,
  abnormalActionResultSchema,
  abnormalOperationDetailSchema,
  abnormalOperationListResponseSchema
} from "../shared/admin-contracts.js";
import { requireSession } from "./session.js";
import type { ZodProvider } from "./zod.js";

const idParamsSchema = z.object({
  id: z.string().min(1)
});

async function requireAdminSession(
  auth: SongRoomAuth,
  config: AppConfig,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<string> {
  const principal = await requireSession(auth, request, reply);
  const allowedAdmins = config.adminUserIds ?? [];
  if (!allowedAdmins.includes(principal.userId)) {
    throw new BusinessError(403, "FORBIDDEN", "该操作仅限配置的受限管理员执行");
  }
  return principal.userId;
}

export function registerAdminOperationRoutes(
  fastify: FastifyInstance,
  auth: SongRoomAuth,
  config: AppConfig,
  service: AbnormalOperationsService
): void {
  const typed = fastify.withTypeProvider<ZodProvider>();

  // 1. 获取脱敏异常操作列表
  typed.get(
    "/api/admin/abnormal-operations",
    {
      schema: {
        response: {
          200: abnormalOperationListResponseSchema
        }
      }
    },
    async (request, reply) => {
      await requireAdminSession(auth, config, request, reply);
      const operations = service.listAbnormalOperations();
      return { operations };
    }
  );

  // 2. 获取单个脱敏异常操作详情
  typed.get(
    "/api/admin/abnormal-operations/:id",
    {
      schema: {
        params: idParamsSchema,
        response: {
          200: abnormalOperationDetailSchema
        }
      }
    },
    async (request, reply) => {
      await requireAdminSession(auth, config, request, reply);
      return service.getAbnormalOperation(request.params.id);
    }
  );

  // 3. 终结普通未知歌曲写入
  typed.post(
    "/api/admin/abnormal-operations/:id/resolve-song-write",
    {
      schema: {
        params: idParamsSchema,
        body: abnormalActionRequestSchema,
        response: {
          200: abnormalActionResultSchema
        }
      }
    },
    async (request, reply) => {
      const adminUserId = await requireAdminSession(auth, config, request, reply);
      return service.resolveSongWrite(adminUserId, request.params.id, request.body);
    }
  );

  // 4. 处置未知公共歌单创建
  typed.post(
    "/api/admin/abnormal-operations/:id/resolve-playlist-create",
    {
      schema: {
        params: idParamsSchema,
        body: abnormalActionRequestSchema,
        response: {
          200: abnormalActionResultSchema
        }
      }
    },
    async (request, reply) => {
      const adminUserId = await requireAdminSession(auth, config, request, reply);
      return service.resolvePlaylistCreate(adminUserId, request.params.id, request.body);
    }
  );

  // 5. 授权公共歌单删除单次重试
  typed.post(
    "/api/admin/abnormal-operations/:id/authorize-cleanup-retry",
    {
      schema: {
        params: idParamsSchema,
        body: abnormalActionRequestSchema,
        response: {
          200: abnormalActionResultSchema
        }
      }
    },
    async (request, reply) => {
      const adminUserId = await requireAdminSession(auth, config, request, reply);
      return service.authorizeCleanupRetry(adminUserId, request.params.id, request.body);
    }
  );

  // 6. 记录手工清理并触发只读核验
  typed.post(
    "/api/admin/abnormal-operations/:id/verify-manual-cleanup",
    {
      schema: {
        params: idParamsSchema,
        body: abnormalActionRequestSchema,
        response: {
          200: abnormalActionResultSchema
        }
      }
    },
    async (request, reply) => {
      const adminUserId = await requireAdminSession(auth, config, request, reply);
      return service.verifyManualCleanup(adminUserId, request.params.id, request.body);
    }
  );

  // 7. 恢复风控暂停账号
  typed.post(
    "/api/admin/abnormal-operations/:id/resume-risk-pause",
    {
      schema: {
        params: idParamsSchema,
        body: z.object({
          reason: z.string().min(1).max(500)
        }),
        response: {
          200: abnormalActionResultSchema
        }
      }
    },
    async (request, reply) => {
      const adminUserId = await requireAdminSession(auth, config, request, reply);
      return service.resumeRiskPause(adminUserId, request.params.id, request.body);
    }
  );
}
