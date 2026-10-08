import { cp, mkdir, rm, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { assertVendorIntegrity } from "../dist/netease/integrity.js";

const require = createRequire(import.meta.url);
const source = dirname(require.resolve("@songroom/netease-vendor/package.json"));
const destination = fileURLToPath(new URL("../dist/netease/vendor", import.meta.url));
await assertVendorIntegrity(source);
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await cp(source, destination, {
  recursive: true,
  filter: path => path !== join(source, "node_modules")
});
// Keep dependency resolution rooted at the frozen workspace installation via relative symlink.
const relativeSourceNodeModules = relative(destination, join(source, "node_modules"));
await symlink(relativeSourceNodeModules, join(destination, "node_modules"), "dir");
await assertVendorIntegrity(destination);
