import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export function readVersion(): string {
  try {
    const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    return JSON.parse(fs.readFileSync(pkg, "utf8")).version as string;
  } catch {
    return "unknown";
  }
}
