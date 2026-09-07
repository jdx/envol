import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, stat, unlink, rename } from "node:fs/promises";
import { resolve, dirname, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Storage } from "./storage.ts";
export class LocalStorage implements Storage {
  constructor(private root: string) {}
  private path(key: string) {
    const root = resolve(this.root);
    const path = resolve(root, key);
    if (!path.startsWith(root + sep)) throw new Error("Invalid artifact key");
    return path;
  }
  async put(key: string, body: ReadableStream<Uint8Array>) {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true });
    const tmp = path + "." + crypto.randomUUID() + ".tmp";
    try {
      await pipeline(
        Readable.fromWeb(body as never),
        createWriteStream(tmp, { flags: "wx" }),
      );
      await rename(tmp, path);
    } catch (e) {
      await unlink(tmp).catch(() => {});
      throw e;
    }
  }
  async get(key: string) {
    const path = this.path(key);
    try {
      const s = await stat(path);
      return {
        body: Readable.toWeb(
          createReadStream(path),
        ) as ReadableStream<Uint8Array>,
        size: s.size,
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }
  async delete(key: string) {
    await unlink(this.path(key)).catch((e) => {
      if (e.code !== "ENOENT") throw e;
    });
  }
}
