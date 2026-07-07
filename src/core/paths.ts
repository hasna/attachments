import { homedir } from "os";
import { dirname, join } from "path";
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

function expandHomePath(path: string): string {
  if (path === "~") return getHomeDir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(getHomeDir(), path.slice(2));
  return path;
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

function copyLegacyDbIfMissing(dataDir: string, dbPath: string): void {
  const oldDb = join(dataDir, "attachments.db");
  if (existsSync(oldDb) && !existsSync(dbPath)) {
    copyFileSync(oldDb, dbPath);
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

export const HASNA_ATTACHMENTS_DB_PATH_ENV = "HASNA_ATTACHMENTS_DB_PATH";

export function getAttachmentsDbPath(): string {
  const dataDir = ensureAttachmentsDataDir();
  const override = process.env[HASNA_ATTACHMENTS_DB_PATH_ENV]?.trim();
  if (override) {
    const dbPath = expandHomePath(override);
    mkdirSync(dirname(dbPath), { recursive: true });
    copyLegacyDbIfMissing(dataDir, dbPath);
    return dbPath;
  }

  const newDb = join(dataDir, "db.sqlite");
  copyLegacyDbIfMissing(dataDir, newDb);
  return newDb;
}
