import { Command } from "commander";
import { sendFeedback } from "../../core/feedback";
import { exitError } from "../utils";

type FeedbackSendOptions = {
  message?: string;
  service?: string;
  version?: string;
  email?: string;
  timestamp?: string;
  endpoint?: string;
  format?: string;
  skipCloud?: boolean;
};

function formatHuman(result: Awaited<ReturnType<typeof sendFeedback>>): string {
  const lines = [
    "Feedback saved locally.",
    `ID: ${result.feedback.id}`,
    `Service: ${result.feedback.service}`,
    `Timestamp: ${result.feedback.timestamp}`,
  ];
  if (result.cloud.ok) {
    lines.push(`Cloud: delivered${result.cloud.status ? ` (${result.cloud.status})` : ""}`);
  } else if (result.cloud.attempted) {
    lines.push(`Cloud: failed${result.cloud.status ? ` (${result.cloud.status})` : ""}: ${result.cloud.error ?? "unknown error"}`);
  } else {
    lines.push(`Cloud: not sent: ${result.cloud.error ?? "endpoint not configured"}`);
  }
  return `${lines.join("\n")}\n`;
}

export function feedbackCommand(): Command {
  const feedback = new Command("feedback").description("Send feedback about attachments");

  feedback
    .command("send")
    .description("Save feedback locally and submit it to the configured Hasna cloud endpoint")
    .argument("[message...]", "Feedback message")
    .option("--message <message>", "Feedback message, alternative to the positional argument")
    .option("--service <service>", "Service name", "attachments")
    .option("--version <version>", "Service version")
    .option("--email <email>", "Optional follow-up email")
    .option("--timestamp <timestamp>", "Feedback timestamp; defaults to now")
    .option("--endpoint <url>", "Override the cloud feedback endpoint")
    .option("--skip-cloud", "Only save feedback locally")
    .option("--format <format>", "Output format: human or json", "human")
    .action(async (messageParts: string[], options: FeedbackSendOptions) => {
      const format = options.format ?? "human";
      if (format !== "human" && format !== "json") {
        exitError("--format must be one of: human, json");
      }

      const message = (options.message ?? messageParts.join(" ")).trim();
      try {
        const result = await sendFeedback({
          service: options.service,
          version: options.version,
          message,
          email: options.email,
          timestamp: options.timestamp,
        }, {
          endpoint: options.endpoint,
          skipCloud: options.skipCloud,
        });

        process.stdout.write(format === "json" ? `${JSON.stringify(result, null, 2)}\n` : formatHuman(result));
      } catch (error) {
        exitError(error instanceof Error ? error.message : String(error));
      }
    });

  return feedback;
}
