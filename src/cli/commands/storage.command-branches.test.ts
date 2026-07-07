import { beforeEach, describe, expect, it, mock, spyOn, afterAll } from "bun:test";
import { Command } from "commander";

const mockGetStorageStatus = mock(() => ({ configured: true, mode: "hybrid", tables: ["attachments"] }));
const mockStoragePush = mock(async (_options?: { tables?: string[] }) => [{ table: "attachments", rowsRead: 1, rowsWritten: 1, errors: [] }]);
const mockStoragePull = mock(async (_options?: { tables?: string[] }) => [{ table: "share_links", rowsRead: 2, rowsWritten: 2, errors: [] }]);
const mockStorageSync = mock(async (_options?: { tables?: string[] }) => ({
  push: [{ table: "attachments", rowsRead: 1, rowsWritten: 1, errors: [] }],
  pull: [{ table: "attachments", rowsRead: 1, rowsWritten: 1, errors: [] }],
}));

mock.module("../../db/storage-sync", () => ({
  getStorageStatus: mockGetStorageStatus,
  storagePush: mockStoragePush,
  storagePull: mockStoragePull,
  storageSync: mockStorageSync,
}));

afterAll(() => mock.restore());

const { storageCommand } = await import("./storage");

function buildProgram(): Command {
  const program = new Command("attachments");
  program.exitOverride();
  program.addCommand(storageCommand());
  return program;
}

async function runCommand(args: string[]): Promise<{ out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const logSpy = spyOn(console, "log").mockImplementation((value?: unknown) => {
    out.push(String(value ?? ""));
  });
  const errorSpy = spyOn(console, "error").mockImplementation((value?: unknown) => {
    err.push(String(value ?? ""));
  });
  try {
    await buildProgram().parseAsync(args, { from: "user" });
  } finally {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  }
  return { out, err };
}

describe("attachments storage command branches", () => {
  beforeEach(() => {
    mockGetStorageStatus.mockClear();
    mockStoragePush.mockClear();
    mockStoragePull.mockClear();
    mockStorageSync.mockClear();
  });

  it("runs status by default", async () => {
    const { out } = await runCommand(["storage"]);
    expect(mockGetStorageStatus).toHaveBeenCalledTimes(1);
    expect(JSON.parse(out[0]!)).toMatchObject({ configured: true, mode: "hybrid" });
  });

  it("runs push, pull, and sync with parsed table filters", async () => {
    await runCommand(["storage", "push", "--tables", "attachments, share_links, ,"]);
    await runCommand(["storage", "pull", "--tables", "feedback"]);
    await runCommand(["storage", "sync"]);

    expect(mockStoragePush).toHaveBeenCalledWith({ tables: ["attachments", "share_links"] });
    expect(mockStoragePull).toHaveBeenCalledWith({ tables: ["feedback"] });
    expect(mockStorageSync).toHaveBeenCalledWith(undefined);
  });

  it("exits for unknown actions", async () => {
    const exitSpy = spyOn(process, "exit").mockImplementation((_code?: number) => {
      throw new Error("process.exit called");
    });
    try {
      await expect(runCommand(["storage", "rotate"])).rejects.toThrow("process.exit called");
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("exits when sync helpers throw", async () => {
    mockStoragePush.mockImplementationOnce(async () => {
      throw new Error("database unavailable");
    });
    const exitSpy = spyOn(process, "exit").mockImplementation((_code?: number) => {
      throw new Error("process.exit called");
    });
    try {
      const result = await expect(runCommand(["storage", "push"])).rejects.toThrow("process.exit called");
      void result;
    } finally {
      exitSpy.mockRestore();
    }
  });
});
