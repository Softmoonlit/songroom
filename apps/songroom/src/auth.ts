import { APIError } from "better-auth/api";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import type { AppConfig } from "./config.js";
import { type AppDatabase } from "./db/database.js";
import { authSchema } from "./db/schema.js";

export const MAX_ACCOUNTS = 100;
export const SESSION_EXPIRES_IN_SECONDS = 7 * 24 * 60 * 60;
export const SESSION_UPDATE_AGE_SECONDS = 24 * 60 * 60;

export type SongRoomAuth = ReturnType<typeof createAuth>;

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
    logger: { disabled: true },
    databaseHooks: {
      user: {
        create: {
          before: async () => {
            const count = database.$client.prepare("SELECT COUNT(*) AS count FROM user").pluck().get() as number;
            if (count >= MAX_ACCOUNTS) {
              throw new APIError("FORBIDDEN", { message: "ACCOUNT_LIMIT_REACHED" });
            }
          }
        }
      }
    }
  });
}
