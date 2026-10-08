# Changelog

[简体中文](CHANGELOG.md) · English

User-visible features and fixes in this repository's formal releases. Release dates use UTC; see each release's notes for installation and validation scope.

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
