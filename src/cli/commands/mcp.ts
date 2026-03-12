import { Command } from "commander";
import { execSync } from "child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { exitError } from "../utils";

// ---------------------------------------------------------------------------
// Per-agent install / uninstall helpers
// ---------------------------------------------------------------------------

function installClaude(): void {
  execSync("claude mcp add --transport stdio --scope user attachments -- attachments-mcp", {
    stdio: "inherit",
  });
  process.stdout.write("\u2713 Installed attachments MCP in Claude Code\n");
}

function uninstallClaude(): void {
  execSync("claude mcp remove attachments", { stdio: "inherit" });
  process.stdout.write("\u2713 Removed attachments MCP from Claude Code\n");
}

function installCodex(): void {
  const configPath = join(homedir(), ".codex", "config.toml");
  const entry = '\n[mcp_servers.attachments]\ncommand = "attachments-mcp"\nargs = []\n';

  let existing = "";
  if (existsSync(configPath)) {
    existing = readFileSync(configPath, "utf-8");
  } else {
    mkdirSync(join(homedir(), ".codex"), { recursive: true });
  }

  if (existing.includes("[mcp_servers.attachments]")) {
    // Replace existing entry
    const updated = existing.replace(
      /\[mcp_servers\.attachments\][^\[]*/s,
      '[mcp_servers.attachments]\ncommand = "attachments-mcp"\nargs = []\n'
    );
    writeFileSync(configPath, updated, "utf-8");
  } else {
    writeFileSync(configPath, existing + entry, "utf-8");
  }

  process.stdout.write("\u2713 Installed attachments MCP in Codex\n");
}

function uninstallCodex(): void {
  const configPath = join(homedir(), ".codex", "config.toml");
  if (!existsSync(configPath)) {
    process.stdout.write("\u2713 Removed attachments MCP from Codex (not present)\n");
    return;
  }

  const existing = readFileSync(configPath, "utf-8");
  const updated = existing.replace(/\n?\[mcp_servers\.attachments\][^\[]*/s, "");
  writeFileSync(configPath, updated, "utf-8");
  process.stdout.write("\u2713 Removed attachments MCP from Codex\n");
}

function installGemini(): void {
  const configPath = join(homedir(), ".gemini", "settings.json");
  let settings: Record<string, unknown> = {};

  if (existsSync(configPath)) {
    try {
      settings = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
    } catch {
      exitError(`Cannot parse ${configPath} — invalid JSON`);
    }
  } else {
    mkdirSync(join(homedir(), ".gemini"), { recursive: true });
  }

  if (!settings.mcpServers || typeof settings.mcpServers !== "object") {
    settings.mcpServers = {};
  }

  (settings.mcpServers as Record<string, unknown>).attachments = {
    command: "attachments-mcp",
    args: [],
  };

  writeFileSync(configPath, JSON.stringify(settings, null, 2), "utf-8");
  process.stdout.write("\u2713 Installed attachments MCP in Gemini\n");
}

function uninstallGemini(): void {
  const configPath = join(homedir(), ".gemini", "settings.json");
  if (!existsSync(configPath)) {
    process.stdout.write("\u2713 Removed attachments MCP from Gemini (not present)\n");
    return;
  }

  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
  } catch {
    exitError(`Cannot parse ${configPath} — invalid JSON`);
  }

  if (settings.mcpServers && typeof settings.mcpServers === "object") {
    delete (settings.mcpServers as Record<string, unknown>).attachments;
  }

  writeFileSync(configPath, JSON.stringify(settings, null, 2), "utf-8");
  process.stdout.write("\u2713 Removed attachments MCP from Gemini\n");
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerMcp(program: Command): void {
  program
    .command("mcp")
    .description("Install or uninstall the attachments MCP server in AI agents")
    .option("--claude", "Target Claude Code")
    .option("--codex", "Target Codex")
    .option("--gemini", "Target Gemini")
    .option("--all", "Target all agents (Claude Code, Codex, Gemini)")
    .option("--uninstall", "Remove the MCP server instead of installing")
    .action(
      (options: {
        claude?: boolean;
        codex?: boolean;
        gemini?: boolean;
        all?: boolean;
        uninstall?: boolean;
      }) => {
        const targetClaude = options.all || options.claude;
        const targetCodex = options.all || options.codex;
        const targetGemini = options.all || options.gemini;

        if (!targetClaude && !targetCodex && !targetGemini) {
          exitError("Specify at least one target: --claude, --codex, --gemini, or --all");
        }

        try {
          if (targetClaude) {
            options.uninstall ? uninstallClaude() : installClaude();
          }
          if (targetCodex) {
            options.uninstall ? uninstallCodex() : installCodex();
          }
          if (targetGemini) {
            options.uninstall ? uninstallGemini() : installGemini();
          }
        } catch (err: unknown) {
          exitError(err instanceof Error ? err.message : String(err));
        }
      }
    );
}
