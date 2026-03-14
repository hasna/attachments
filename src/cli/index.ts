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

const program = new Command()
  .name("attachments")
  .description("File transfer for AI agents — S3-backed")
  .version("0.1.0");

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

// TODO: register list, delete, link, config

program.parse(process.argv);
