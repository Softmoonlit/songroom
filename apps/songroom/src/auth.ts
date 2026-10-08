import { APIError } from "better-auth/api";
import { betterAuth } from "better-auth";
import { admin } from "better-auth/plugins";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import type { AppConfig } from "./config.js";
import { type AppDatabase } from "./db/database.js";
import { authSchema } from "./db/schema.js";
import { accountName } from "./shared/contracts.js";

export const MAX_ACCOUNTS = 100;
export const SESSION_EXPIRES_IN_SECONDS = 7 * 24 * 60 * 60;
export const SESSION_UPDATE_AGE_SECONDS = 24 * 60 * 60;

export type SongRoomAuth = ReturnType<typeof createAuth>;
export type SessionPrincipal = { userId: string; sessionId: string; expiresAt?: Date };

export function createAuth(database: AppDatabase, config: AppConfig) {
  return betterAuth({
    appName: "SongRoom",
    baseURL: config.baseUrl,
    basePath: "/api/auth",
    secret: config.authSecret,
    database: drizzleAdapter(database, {
      provider: "sqlite",
      schema: authSchema,
      transaction: false
    }),
    emailAndPassword: {
      enabled: true,
      autoSignIn: true,
      minPasswordLength: 8,
      maxPasswordLength: 128
    },
    session: {
      expiresIn: SESSION_EXPIRES_IN_SECONDS,
      updateAge: SESSION_UPDATE_AGE_SECONDS,
      cookieCache: { enabled: false }
    },
    rateLimit: {
      enabled: config.nodeEnv === "production",
      storage: "memory"
    },
    advanced: {
      useSecureCookies: config.nodeEnv === "production"
    },
    plugins: [
      admin({
        adminUserIds: config.adminUserIds ?? []
      })
    ],
    logger: { disabled: true },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            const count = database.$client.prepare("SELECT COUNT(*) AS count FROM user").pluck().get() as number;
            if (count >= MAX_ACCOUNTS) {
              throw new APIError("FORBIDDEN", { message: "ACCOUNT_LIMIT_REACHED" });
            }
            if (user.name) {
              const validated = accountName.safeParse(user.name);
              if (!validated.success) {
                throw new APIError("BAD_REQUEST", { message: "请输入 1 到 40 个字符，不能包含控制字符" });
              }
              return { data: { ...user, name: validated.data } };
            }
          }
        },
        update: {
          before: async (user) => {
            if (user.name !== undefined) {
              const validated = accountName.safeParse(user.name);
              if (!validated.success) {
                throw new APIError("BAD_REQUEST", { message: "请输入 1 到 40 个字符，不能包含控制字符" });
              }
              return { data: { ...user, name: validated.data } };
            }
          }
        }
      }
    }
  });
}
