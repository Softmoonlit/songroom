import { cpSync, rmSync } from "node:fs";

rmSync(new URL("../dist/db/migrations", import.meta.url), { recursive: true, force: true });
cpSync(new URL("../src/db/migrations", import.meta.url), new URL("../dist/db/migrations", import.meta.url), { recursive: true });
