import { Command } from "commander";
import { deleteCommand } from "./delete";

/** remove — alias for delete, consistent with open-* CLI conventions */
export function removeCommand(): Command {
  const cmd = deleteCommand();
  cmd.name("remove").description("Remove/delete an attachment by ID (alias for delete)");
  return cmd;
}
