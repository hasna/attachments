import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ensureAttachmentsDataDir } from "./paths";

const originalHome = process.env.HOME;
const homes: string[] = [];

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  for (const home of homes) rmSync(home, { recursive: true, force: true });
  homes.length = 0;
});

describe("ensureAttachmentsDataDir", () => {
  it("copies missing files, directories, and symlinks from legacy data dirs", () => {
    const home = join(tmpdir(), `attachments-home-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    homes.push(home);
    process.env.HOME = home;
    const legacy = join(home, ".open-attachments");
    mkdirSync(join(legacy, "nested"), { recursive: true });
    writeFileSync(join(legacy, "legacy.txt"), "legacy", "utf8");
    writeFileSync(join(legacy, "nested", "child.txt"), "child", "utf8");
    symlinkSync("legacy.txt", join(legacy, "legacy-link"));

    const dir = ensureAttachmentsDataDir();

    expect(dir).toBe(join(home, ".hasna", "attachments"));
    expect(existsSync(join(dir, "legacy.txt"))).toBe(true);
    expect(existsSync(join(dir, "nested", "child.txt"))).toBe(true);
    expect(readlinkSync(join(dir, "legacy-link"))).toBe("legacy.txt");
  });
});
