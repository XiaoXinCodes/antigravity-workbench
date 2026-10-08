# Changelog

[简体中文](CHANGELOG.md) · English

User-visible features and fixes in this repository's formal releases. Release dates use UTC.

## [0.1.4](https://github.com/XiaoXinCodes/antigravity-workbench/releases/tag/v0.1.4) — 2026-10-08

Inspect and resolve a selected background process when another window or a leftover process blocks account switching.

- Show conflicting processes with their PID, start time and ownership details, with a rescan action.
- Confirm ending one verified process on Linux, or explicitly confirm force termination on Windows.
- Check for remaining conflicts after exit and resume the originally selected account switch.
- Explain unavailable checks or system capabilities and retain inspection and rescanning. macOS currently supports inspection and rescanning.

[Release notes](docs/RELEASE_0.1.4.md) · [Validation scope](docs/VALIDATION_0.1.4.md)

## [0.1.3](https://github.com/XiaoXinCodes/antigravity-workbench/releases/tag/v0.1.3) — 2026-10-08

Improve login display and verification when reopening a window.

- A reopened window can show the last confirmed login, marked as pending background confirmation.
- Allow more time for slow startup and finish the checking indicator promptly after identity is confirmed.
- Show a clear unfinished-save message when saving a local copy takes longer.
- Resume verification when the panel reopens. Rechecking starts a new check, and older responses cannot replace the latest login state.

[Release notes](docs/RELEASE_0.1.3.md#english)

## [0.1.2](https://github.com/XiaoXinCodes/antigravity-workbench/releases/tag/v0.1.2) — 2026-10-08

- Password-encrypted account exports no longer require an actual POSIX permission mode or a filesystem whitelist. Save to local directories the operating system allows the extension to read and write, including Windows mounts in WSL, without changing mount or directory permissions.
- Preserve password encryption, exclusive creation, no overwrite, and file and parent-directory identity checks. Read ciphertext back through the same owned descriptor and compare exact bytes; partial writes, same-length corruption and replacements stop the export, with cleanup limited to its own created file.
- File or directory changes now receive accurate Chinese and English export messages instead of an import-while-reading error. Internal credential, plaintext and log permission protections remain unchanged; operating-system access denial still stops the operation.

Regressions use fictional accounts and cloud files. An actual Windows directory on WSL / DrvFS and real-account migration have not been tested. Native three-platform release gates do not establish real DrvFS validation.

[Release notes](docs/RELEASE_0.1.2.md#english) · [Validation scope](docs/VALIDATION_0.1.2.md)

## [0.1.1](https://github.com/XiaoXinCodes/antigravity-workbench/releases/tag/v0.1.1) — 2026-10-08

- Automatically verify, display and save direct official logins on the same host, deduplicating identities while retaining IDs and labels. An old add transaction can restore only its confirmed full snapshot and cannot overwrite an independent official login.
- Removing the current account first safely switches to the first different account with usable local credentials on the same host, then deletes the old copy after verification. With no replacement, keep the official login and suppress immediate re-adding. Noncurrent or foreign-host removal does not switch.
- Close browser authorization progress when the official Login result is confirmed. Show subsequent verification, saving and restoration stages inline, and refresh the account list after secure saving. Google verification, server proof and storage confirmation remain required.
- Refresh quota without an extra confirmation or success notification. Update the selected account card and query time directly; loading and retryable errors stay on the card.
- WSL switching verifies the current Hub's executable, host, port and process start identity. An external or leftover Hub with unknown task activity blocks switching with a specific explanation; no process is automatically terminated.
- After the official stop hook returns, wait up to ten seconds to observe actual backend exit before continuing. Controlled restarts rebind process identity so consecutive operations do not reuse the old process proof.
- Preserve existing process exclusivity and credential protections. Add regressions for PID reuse, changed start identity, delayed exit, consecutive restarts and macOS / Windows fallback paths.

This update does not change the official component's startup cancellation or claim to prevent all leftover Hubs after host exit. Complete switching with a real account and real image calls were not acceptance tests for this version. Manually stopping a previously identified backend is not live validation of the patch.

[Release notes](docs/RELEASE_0.1.1.md#english) · [Validation scope](docs/VALIDATION_0.1.1.md) (Chinese)

## [0.1.0](https://github.com/XiaoXinCodes/antigravity-workbench/releases/tag/v0.1.0) — 2026-10-08

First release in this repository.

### Features

- **Multiple accounts.** Add and save accounts through browser OAuth. Switching to a saved account restarts the official component and verifies its identity. View model quota and reset times independently for each account.
- **Save the current login.** Add account and Save current login share a toolbar. A uniquely matched verified identity with a usable local copy displays Saved. Missing or unusable credentials update the existing record without adding a duplicate. Saved describes local checks only.
- **Image studio.** Follow the current login or select a saved account independently and load its image models. Use prompts, reference images, aspect ratios and request counts; save and preview PNG/JPEG files or recover existing PNG files. Remove references individually or clear them all.
- **Continue creating and use results in a project.** Save and restore drafts and task cards, continue editing saved results, compare versions, and copy relative paths or Markdown. Insert into the displayed text file only after an explicit click, without automatically saving the editor. Original images are retained; interrupted tasks are not automatically resubmitted.
- **Immediate Chinese / English switching.** Simplified Chinese is the default; select `en` in `antigravityAccounts.language`. Open interfaces and help update immediately while preserving input, references, account selection, layout and tasks. Static commands and view titles follow VS Code's display language.
- **Bilingual documentation.** Chinese and English READMEs, quick starts and actual rendered feature screenshots. Screenshots use fictional accounts, mock quota and local demonstration images.

### Improvements and fixes

- Image account checks retry within a bounded window while the official component starts. Revision checks prevent late results from clearing newer switch or recovery operations.
- Image quota queries use the selected account and model and mark stale readings. Sub-full fractions do not display as 100%, and percentages are not converted into image counts.
- Model IDs are validated against the same account's trusted image catalog, including legitimate IDs without `image`. Sanitized catalog comparisons are available on demand. A model name or catalog membership does not guarantee permission to call it.
- Creative records read existing schema 1 / 2 and write schema 3. Windows drive-letter and path-boundary handling is improved. Retain a data backup before downgrading; older versions may not read newer records.

### Compatibility and validation

Automated checks cover regressions, isolated actual VS Code hosts, packaging and license checks on Linux, Windows and macOS. Real Google account integration and real image generation were not used as release acceptance; available models, permissions and quota depend on actual server responses. SSH and container hosts have not been verified.

Project-owned material uses the [Sustainable Use License 1.0](LICENSE), a source-available license rather than an OSI open-source license. Third-party licenses remain independent; see [third-party notices](THIRD_PARTY_NOTICES.txt). This license grants no Google service access.

[Release notes](docs/RELEASE_0.1.0.md#english) · [Validation scope](docs/VALIDATION_0.1.0.md) (Chinese) · [English README](README_EN.md)
