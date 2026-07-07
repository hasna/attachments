export function getMcpVersion(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return (require("../../package.json") as { version: string }).version;
  } catch {
    return process.env.npm_package_version ?? "1.0.0";
  }
}
