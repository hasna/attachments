#!/usr/bin/env bun
import { Command } from "commander";
import { registerUpload } from "./commands/upload";
import { registerDownload } from "./commands/download";
import { registerServe } from "./commands/serve";
import { registerMcp } from "./commands/mcp";
import { registerClean } from "./commands/clean";
import { registerWhoami } from "./commands/whoami";
import { registerStatus } from "./commands/status";
import { registerPresign } from "./commands/presign";
import { registerLinkTask } from "./commands/link-task";
import { registerCompleteTask } from "./commands/complete-task";
import { registerSnapshotSession } from "./commands/snapshot-session";
import { registerHealthCheck } from "./commands/health-check";
import { registerWatch } from "./commands/watch";
import { registerTaskJournal } from "./commands/task-journal";
import { registerReport } from "./commands/report";
import { registerResolveEvidence } from "./commands/resolve-evidence";
import { registerDoctor } from "./commands/doctor";
import { listCommand } from "./commands/list";
import { deleteCommand } from "./commands/delete";
import { removeCommand } from "./commands/remove";
import { linkCommand } from "./commands/link";
import { configCommand } from "./commands/config";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const pkgVersion: string = (() => { try { return (require("../../package.json") as { version: string }).version; } catch { return process.env.npm_package_version ?? "unknown"; } })();

const program = new Command()
  .name("attachments")
  .description("File transfer for AI agents — S3-backed")
  .version(pkgVersion);

// Register all subcommands
registerUpload(program);
registerDownload(program);
registerServe(program);
registerMcp(program);
registerClean(program);
registerWhoami(program);
registerStatus(program);
registerPresign(program);
registerLinkTask(program);
registerCompleteTask(program);
registerSnapshotSession(program);
registerHealthCheck(program);
registerWatch(program);
registerTaskJournal(program);
registerReport(program);
registerResolveEvidence(program);
registerDoctor(program);
program.addCommand(listCommand());
program.addCommand(deleteCommand());
program.addCommand(removeCommand());
program.addCommand(linkCommand());
program.addCommand(configCommand());

program.parse(process.argv);
