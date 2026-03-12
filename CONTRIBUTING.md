# Contributing to @hasna/attachments

Thank you for your interest in contributing. Here is everything you need to get started.

## Development Setup

**Prerequisites:** [Bun](https://bun.sh) >= 1.0

```bash
# 1. Fork and clone the repository
git clone https://github.com/hasnaxyz/open-attachments.git
cd open-attachments

# 2. Install dependencies
bun install

# 3. Run tests
bun test

# 4. Build
bun run build:cli
```

## Project Structure

```
open-attachments/
├── src/
│   ├── cli/
│   │   ├── index.ts          # CLI entry point
│   │   └── commands/         # One file per subcommand
│   ├── mcp/
│   │   └── server.ts         # MCP server (lean stubs + full schemas)
│   ├── api/
│   │   └── server.ts         # Hono REST API
│   └── core/
│       ├── config.ts         # Config read/write
│       ├── db.ts             # SQLite attachment database
│       ├── upload.ts         # Upload logic
│       ├── download.ts       # Download logic
│       ├── links.ts          # Presigned URL / server link generation
│       └── s3.ts             # S3 client wrapper
├── sdk/
│   └── src/
│       └── index.ts          # @hasna/attachments-sdk
└── package.json
```

## Running Tests

```bash
# Run all tests
bun test

# Run with coverage
bun test --coverage

# Run a specific file
bun test src/cli/commands/upload.test.ts
```

All pull requests must pass the full test suite with zero failures. New features and bug fixes must include tests.

## Coding Standards

- TypeScript strict mode is enabled. No `any` without a comment explaining why.
- Use `bun fmt` (Prettier) for formatting before committing.
- Keep functions small and focused. Prefer explicit error messages over opaque ones.
- Comments should explain *why*, not *what*.

## Submitting a Pull Request

1. Create a branch from `main`:
   ```bash
   git checkout -b feat/my-feature
   ```
2. Make your changes. Write or update tests.
3. Run the full test suite:
   ```bash
   bun test
   ```
4. Commit with a clear message:
   ```
   feat: add --tag option to list command
   ```
   We follow [Conventional Commits](https://www.conventionalcommits.org/).
5. Push your branch and open a pull request against `main`.
6. Describe what the PR does and why. Link any related issues.

## Bug Reports

Open an issue and include:
- What you did
- What you expected to happen
- What actually happened
- Your OS, Bun version, and `@hasna/attachments` version

Do not include AWS credentials or secret keys in issues.

## Questions

Open a discussion on GitHub or reach out at andrei@hasna.com.
