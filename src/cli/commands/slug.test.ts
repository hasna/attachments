import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Command } from "commander";

const mockIsSlugAvailable = mock(async (_slug: string) => true);
const mockClose = mock(() => {});

import { slugCommand } from "./slug";

const resolveStore = () => ({
  isSlugAvailable: mockIsSlugAvailable,
  close: mockClose,
});

describe("slug command", () => {
  beforeEach(() => {
    mockIsSlugAvailable.mockReset();
    mockIsSlugAvailable.mockImplementation(async () => true);
    mockClose.mockReset();
    process.exitCode = 0;
  });

  test("prints JSON availability from the store", async () => {
    const output: string[] = [];
    const stdout = spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      output.push(String(chunk));
      return true;
    });
    try {
      const program = new Command();
      program.exitOverride();
      program.addCommand(slugCommand(resolveStore));
      await program.parseAsync(["slug", "company-closing-packet", "--format", "json"], { from: "user" });
      expect(mockIsSlugAvailable).toHaveBeenCalledWith("company-closing-packet");
      expect(JSON.parse(output.join(""))).toEqual({
        slug: "company-closing-packet",
        available: true,
      });
      expect(mockClose).toHaveBeenCalled();
    } finally {
      stdout.mockRestore();
    }
  });

  test("uses exit code 2 for an unavailable but valid slug", async () => {
    mockIsSlugAvailable.mockImplementation(async () => false);
    const stdout = spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const program = new Command();
      program.exitOverride();
      program.addCommand(slugCommand(resolveStore));
      await program.parseAsync(["slug", "company-closing-packet", "--brief"], { from: "user" });
      expect(process.exitCode).toBe(2);
    } finally {
      process.exitCode = 0;
      stdout.mockRestore();
    }
  });
});
