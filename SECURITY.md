# Security policy

electron2web exposes your app's Electron main process (full filesystem and native access) to a
browser tab. Its protections are described in the
[package README](packages/electron2web/README.md#security).

## Reporting a vulnerability

Please **don't** open a public issue. Use GitHub's private reporting instead:
**Security → Report a vulnerability** on this repository. Include steps to reproduce and the
version you used. You should hear back within a few days.

## Scope

In scope: anything that lets a website, another local user, or someone without the access
link reach the bridge or the token, or crash the main process.

Out of scope: someone who already has the access link controlling the app (that is the
intended behaviour), and apps that load untrusted remote content into a window with a preload
(the same risk exists in Electron itself).

## Supported versions

Only the latest release gets fixes during the beta.
