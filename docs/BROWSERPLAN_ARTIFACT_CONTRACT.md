# BrowserPlan Artifact Contract

This contract lets open-chrome publish BrowserPlan macOS app builds through
open-attachments, and lets target machines resolve, download, verify, and plan
installation through the same artifact registry.

Contract version: `1`

## Artifact Identity

BrowserPlan artifacts are attachment-backed records with these stable identity
fields:

```json
{
  "name": "browserplan",
  "version": "1.2.3",
  "channel": "stable",
  "platform": "darwin",
  "arch": "arm64",
  "kind": "mac-app-zip",
  "app_name": "BrowserPlan.app"
}
```

`version` must be semantic version syntax such as `1.2.3`,
`1.2.3-beta.1`, or `v1.2.3`. Latest resolution rejects non-semver artifact
versions instead of applying lexical ordering.

Supported macOS install-plan kinds:

- `mac-app-zip` or `zip`: ZIP containing `BrowserPlan.app`
- `dmg` or `mac-dmg`: DMG containing `BrowserPlan.app`
- `pkg` or `mac-pkg`: macOS installer package

The registry always stores `checksum_sha256`. If `signature_type` is
`codesign` or `apple-codesign`, generated install scripts verify the installed
app with `codesign --verify`; when `signature` is present, they also match it
against `codesign -dv` output.

## Publish From open-chrome

open-chrome should build a ZIP/DMG/PKG, then publish it with:

```bash
attachments artifact publish ./dist/BrowserPlan.zip \
  --name browserplan \
  --version 1.2.3 \
  --channel stable \
  --platform darwin \
  --arch arm64 \
  --kind mac-app-zip \
  --app-name BrowserPlan.app \
  --signature-type codesign \
  --signature "Developer ID Application: Hasna" \
  --expiry never \
  --link-type server \
  --format json
```

Cloud mode uses the same command after configuring `ATTACHMENTS_MODE=cloud`,
`ATTACHMENTS_API_URL`, and `ATTACHMENTS_API_TOKEN`.

If open-chrome already uploaded the file as an attachment, it can register the
artifact without re-uploading:

```bash
attachments artifact register \
  --attachment-id att_xxx \
  --name browserplan \
  --version 1.2.3 \
  --channel stable \
  --platform darwin \
  --arch arm64 \
  --kind mac-app-zip \
  --app-name BrowserPlan.app \
  --checksum-sha256 <64-hex-sha256> \
  --format json
```

## Resolve Latest

Latest resolution is semver-aware and ignores artifacts whose backing
attachment is expired:

```bash
attachments artifact latest \
  --name browserplan \
  --channel stable \
  --platform darwin \
  --arch arm64 \
  --kind mac-app-zip \
  --format json
```

REST equivalent:

```http
GET /api/artifacts/latest?name=browserplan&channel=stable&platform=darwin&arch=arm64&kind=mac-app-zip
```

## Download And Verify

Targets can download by artifact id:

```bash
attachments artifact download art_xxx --output /tmp --format json
```

Or resolve latest and download in one step:

```bash
attachments artifact download \
  --name browserplan \
  --channel stable \
  --platform darwin \
  --arch arm64 \
  --kind mac-app-zip \
  --output /tmp \
  --format json
```

Download verifies SHA-256 by default. Use `--no-verify` only when a generated
install script performs checksum verification separately.

## Install Plan

Generate a target-local macOS install script:

```bash
attachments artifact install-plan art_xxx \
  --app-name BrowserPlan.app \
  --install-dir /Applications \
  --format shell
```

The script:

1. Downloads the backing attachment through `attachments download`.
2. Verifies `checksum_sha256` with `shasum -a 256 -c -`.
3. Extracts/mounts the ZIP or DMG, or verifies PKG signature metadata when present.
4. Verifies staged app code signature before replacing an installed app.
5. Replaces `/Applications/BrowserPlan.app` with rollback to the previous app
   if the copy fails.
6. Clears quarantine attributes.
7. Verifies the installed app code signature when `signature_type` is
   `codesign` or `apple-codesign`.

Target prerequisites:

- `attachments` CLI is installed on each target machine.
- The generated script downloads from `artifact.attachment.link` when present,
  so the target needs network access to that link.
- If an artifact has no backing link, targets must have shared local artifact
  state or `ATTACHMENTS_MODE=cloud`, `ATTACHMENTS_API_URL`, and
  `ATTACHMENTS_API_TOKEN` configured so `attachments download <attachment-id>`
  can resolve the backing attachment.
- BrowserPlan fleet artifacts should be published with `--expiry never` and
  `--link-type server` so target machines do not need artifact-registry state
  to perform installs.

## Fleet Plan

The BrowserPlan fleet target is:

```text
machine001-machine011
```

Final target excludes `spark01` and `spark02`.

Generate open-machines route commands:

```bash
attachments artifact install-plan art_xxx \
  --app-name BrowserPlan.app \
  --install-dir /Applications \
  --browserplan-fleet \
  --format json
```

Equivalent explicit target form:

```bash
attachments artifact install-plan art_xxx \
  --app-name BrowserPlan.app \
  --machines machine001-machine011 \
  --exclude spark01,spark02 \
  --format json
```

The JSON includes:

- `target_machines`: expanded machine ids
- `excluded_machines`: exclusions applied
- `install_plan.install_script`: target-side shell script
- `open_machines.commands[].route_command`: `machines ssh --machine ... --cmd ... --private-metadata --json`

open-machines remains responsible for route trust, idle/approval checks, and
actual execution/apply semantics.

## REST Endpoints

Operational artifact API endpoints use the same auth model as attachments:

- `POST /api/artifacts/register`
- `GET /api/artifacts`
- `GET /api/artifacts/latest`
- `GET /api/artifacts/:id`
- `GET /api/artifacts/:id/install-plan`

Artifact JSON uses snake_case for API fields and includes the backing
attachment summary:

```json
{
  "contract_version": 1,
  "id": "art_xxx",
  "attachment_id": "att_xxx",
  "name": "browserplan",
  "version": "1.2.3",
  "channel": "stable",
  "platform": "darwin",
  "arch": "arm64",
  "kind": "mac-app-zip",
  "filename": "BrowserPlan.zip",
  "size": 12345678,
  "checksum_sha256": "<64-hex-sha256>",
  "signature": "Developer ID Application: Hasna",
  "signature_type": "codesign",
  "app_name": "BrowserPlan.app",
  "metadata": {},
  "created_at": 1782200000000,
  "attachment": {
    "id": "att_xxx",
    "filename": "BrowserPlan.zip",
    "size": 12345678,
    "content_type": "application/zip",
    "link": "https://files.example/a/token",
    "expires_at": null,
    "created_at": 1782200000000
  }
}
```
