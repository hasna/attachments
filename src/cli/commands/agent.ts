import { Command } from "commander";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { randomBytes } from "crypto";
import { ensureAttachmentsDataDir } from "../../core/paths";

function getAgentFilePath(): string {
  return join(ensureAttachmentsDataDir(), "agent.json");
}

interface AgentState {
  id: string;
  name: string;
  last_seen_at: string;
  project_id?: string;
}

function loadAgent(): AgentState | null {
  const agentFile = getAgentFilePath();
  if (!existsSync(agentFile)) return null;
  try { return JSON.parse(readFileSync(agentFile, "utf-8")); } catch { return null; }
}

function saveAgent(agent: AgentState): void {
  writeFileSync(getAgentFilePath(), JSON.stringify(agent, null, 2));
}

export function initCommand(): Command {
  return new Command("init")
    .description("Register this agent session for upload attribution")
    .argument("<name>", "Agent name")
    .action((name: string) => {
      const id = randomBytes(4).toString("hex");
      const agent: AgentState = { id, name, last_seen_at: new Date().toISOString() };
      saveAgent(agent);
      process.stdout.write(`Agent registered: ${agent.name} (${agent.id})\n`);
    });
}

export function heartbeatCommand(): Command {
  return new Command("heartbeat")
    .description("Update last_seen_at to signal this agent is still active")
    .action(() => {
      const agent = loadAgent();
      if (!agent) { process.stderr.write("No agent registered. Run: attachments init <name>\n"); process.exit(1); }
      agent.last_seen_at = new Date().toISOString();
      saveAgent(agent);
      process.stdout.write(`♥ ${agent.name} (${agent.id}) — heartbeat sent\n`);
    });
}

export function focusCommand(): Command {
  return new Command("focus")
    .description("Set (or clear) the active project for this agent")
    .argument("[project]", "Project ID to focus on (omit to clear)")
    .action((project?: string) => {
      const agent = loadAgent();
      if (!agent) { process.stderr.write("No agent registered. Run: attachments init <name>\n"); process.exit(1); }
      agent.project_id = project;
      saveAgent(agent);
      if (project) process.stdout.write(`Focused on project: ${project}\n`);
      else process.stdout.write("Focus cleared.\n");
    });
}
