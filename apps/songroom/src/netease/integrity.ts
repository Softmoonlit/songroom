import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { z } from "zod";

// Review anchor for the full audited source manifest; changing it requires reacceptance.
export const VENDOR_MANIFEST_SHA256 = "538ca5b851f2c93628f922bb52f4715fdd4b480c0c6394cd3bd28a76c609c283";
const manifestSchema = z.strictObject({
  version: z.literal("4.40.1"),
  commit: z.literal("a8c781fd64faab17fedfd46e0615a2609307f163"),
  files: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/))
});

/** Checks all source and provenance files. node_modules is generated installation state. */
export async function assertVendorIntegrity(root: string): Promise<void> {
  try {
    const manifestPath = join(root, "integrity.json");
    if (!(await lstat(manifestPath)).isFile()) throw Error();
    const bytes = await readFile(manifestPath);
    if (createHash("sha256").update(bytes).digest("hex") !== VENDOR_MANIFEST_SHA256) throw Error();
    const manifest = manifestSchema.parse(JSON.parse(bytes.toString("utf8")));
    const found = new Set<string>();
    const visit = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        const name = relative(root, path).split("\\").join("/");
        if (name === "node_modules") continue;
        if (entry.isSymbolicLink()) throw Error();
        if (entry.isDirectory()) { await visit(path); continue; }
        if (!entry.isFile()) throw Error();
        if (name === "integrity.json") continue;
        if (!Object.hasOwn(manifest.files, name)) throw Error();
        const hash = createHash("sha256").update(await readFile(path)).digest("hex");
        if (hash !== manifest.files[name]) throw Error();
        found.add(name);
      }
    };
    await visit(root);
    if (found.size !== Object.keys(manifest.files).length) throw Error();
  } catch { throw new Error("INTEGRITY_ERROR"); }
}
