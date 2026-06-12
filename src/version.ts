import { createRequire } from "node:module";

/** Package version read at runtime (dist/version.js → ../package.json) */
export const VERSION: string = createRequire(import.meta.url)("../package.json").version;
