import { homedir } from "os";
import { join } from "path";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  symlinkSync,
} from "fs";

function getHomeDir(): string {
  return process.env["HOME"] || process.env["USERPROFILE"] || homedir();
}

function copyMissingEntries(sourceDir: string, targetDir: string): void {
  if (!existsSync(sourceDir)) return;

  mkdirSync(targetDir, { recursive: true });

  for (const entry of readdirSync(sourceDir)) {
    const sourcePath = join(sourceDir, entry);
    const targetPath = join(targetDir, entry);

    if (existsSync(targetPath)) {
      const sourceStat = lstatSync(sourcePath);
      const targetStat = lstatSync(targetPath);
      if (sourceStat.isDirectory() && targetStat.isDirectory()) {
        copyMissingEntries(sourcePath, targetPath);
      }
      continue;
    }

    const sourceStat = lstatSync(sourcePath);
    if (sourceStat.isDirectory()) {
      mkdirSync(targetPath, { recursive: true });
      copyMissingEntries(sourcePath, targetPath);
    } else if (sourceStat.isFile()) {
      copyFileSync(sourcePath, targetPath);
    } else if (sourceStat.isSymbolicLink()) {
      symlinkSync(readlinkSync(sourcePath), targetPath);
    }
  }
}

export function ensureAttachmentsDataDir(): string {
  const home = getHomeDir();
  const canonicalDir = join(home, ".hasna", "attachments");
  const legacyDirs = [join(home, ".open-attachments"), join(home, ".attachments")];

  mkdirSync(canonicalDir, { recursive: true });
  for (const legacyDir of legacyDirs) {
    try {
      copyMissingEntries(legacyDir, canonicalDir);
    } catch {
      // Data-dir migration is best effort; callers still operate from canonical storage.
    }
  }

  return canonicalDir;
}
