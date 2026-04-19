# Changelog

All notable changes to this project should be documented in this file.

The format is intentionally simple:

- add a new version heading for each release or meaningful update
- list user-visible changes in plain language
- include breaking changes, new features, fixes, and documentation updates when relevant

## Unreleased

- No unreleased changes yet.

## 1.0.1 - 2026-04-19

- Added an optional checkbox to automatically resume resolving after an X rate-limit wait ends.
- Added background auto-resume scheduling so resolving can continue without a manual click after the cooldown.

## 1.0.0 - 2026-04-19

- Initial public release of the Chrome extension.
- Added support for loading an exported `block.js` file from an X archive.
- Added account resolution for display names and usernames where available.
- Added status detection for `Currently blocked`, `Already unblocked`, and `ACCOUNT DELETED`.
- Added unblock actions from the extension popup.
- Added filtering by account status.
- Added `Save HTML` export for the currently visible rows.
- Added live status updates, rate-limit countdown handling, and resume behavior for large block lists.
- Added first-time-user documentation, installation steps, privacy notes, troubleshooting, and uninstall instructions.
