#!/usr/bin/env bun
import { Command } from "commander";
import { registerUpload } from "./commands/upload";
import { registerDownload } from "./commands/download";
import { registerServe } from "./commands/serve";
import { registerMcp } from "./commands/mcp";

const program = new Command()
  .name("attachments")
  .description("File transfer for AI agents — S3-backed")
  .version("0.1.0");

// Register all subcommands
registerUpload(program);
registerDownload(program);
registerServe(program);
registerMcp(program);

// TODO: register list, delete, link, config

program.parse(process.argv);
