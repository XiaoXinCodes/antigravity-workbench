<p align="center">
  <img src="media/brand-logo.png" width="144" height="144" alt="Antigravity Workbench A logo">
</p>

<h1 align="center">Antigravity Workbench</h1>

<p align="center">Manage Google Antigravity accounts, check quota and create images in VS Code.</p>

<p align="center"><strong>Source-available · Sustainable Use License 1.0</strong></p>

<p align="center"><a href="https://github.com/XiaoXinCodes/antigravity-workbench/blob/main/README.md">简体中文</a> · English</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=xiaoxincodes.antigravity-account-manager">Install from Marketplace</a> ·
  <a href="https://github.com/XiaoXinCodes/antigravity-workbench/blob/main/docs/GETTING_STARTED.en.md">Getting started</a> ·
  <a href="https://github.com/XiaoXinCodes/antigravity-workbench/blob/main/CHANGELOG_EN.md">Changelog</a> ·
  <a href="https://github.com/XiaoXinCodes/antigravity-workbench/issues">Report an issue</a>
</p>

Workbench brings accounts, quotas and image creation into one VS Code workbench: compare model quotas across accounts, choose an image account independently and continue from history. Enable quota alerts and scheduled requests when you need them.

This project is independently developed and is not affiliated with, authorized by or endorsed by Google. Available models, permissions and quota depend on the selected account's server responses.

[Quick installation](#quick-installation) · [Getting started](#getting-started) · [Feature walkthrough](#feature-walkthrough) · [FAQ](#faq) · [Contributing](#contributing)

## Quick installation

**Before installing:** VS Code 1.95 or later, with an available Google Antigravity extension and login. Both extensions must run on the same local or WSL host.

1. Search for **Antigravity Workbench** in VS Code's Extensions view. Verify publisher **XiaoXinCodes** and extension ID `xiaoxincodes.antigravity-account-manager`.
2. Select **Install**. You can also open the [VS Code Marketplace listing](https://marketplace.visualstudio.com/items?itemName=xiaoxincodes.antigravity-account-manager) and select **Install** to install in VS Code.
3. Reload when prompted and open **Antigravity Workbench** in the activity bar.

**WSL workspaces:** In a VS Code window connected to WSL, check where Google Antigravity actually runs. If the official extension runs in WSL, select **Install in WSL: &lt;distribution&gt;** on the extension page to install Workbench on that same remote host. If the official extension runs locally, keep both extensions on the local host.

Installation and upgrades do not require clearing saved accounts, official login files, sessions or images. Release notes, source and checksum files are in the [latest Release](https://github.com/XiaoXinCodes/antigravity-workbench/releases/latest); see the [changelog](CHANGELOG_EN.md) for version changes.

Supports local extension hosts on Windows, macOS and Linux, plus WSL Linux workspace hosts. See [compatibility](docs/COMPATIBILITY.md) for other remote hosts.

<details>
<summary>Offline alternative: install from VSIX</summary>

If Marketplace is unavailable, download the `.vsix` attachment from the [latest Release](https://github.com/XiaoXinCodes/antigravity-workbench/releases/latest). In the target VS Code window, run **Extensions: Install from VSIX…** from the Command Palette, select the file and reload when prompted. With WSL, still check the actual installation host.

</details>

## What you can do

| Feature | What it helps you do |
| --- | --- |
| Accounts and migration | Add with browser OAuth, save the current login, switch and verify identity; import and export encrypted accounts, replacing or skipping matching emails |
| Multi-account quota overview | Read server-reported remaining fractions and reset times; search accounts, compare the same model, sort by quota, update or reset time, and cancel batch refresh |
| Favorite models and history | Favorite models and collapse families; browse quotas in native QuickPick, pin one account/model to the status bar, and filter or clear quota history |
| Image studio | Follow the current login or choose an account independently; compare accounts by the exact selected model's quota, with prompts, references, ratios, sizes and request counts |
| Creation history and reuse | Restore drafts and task cards, reuse historical request parameters, continue editing and compare versions; missing references are flagged and interrupted tasks are not resent automatically |
| Use in your project | Preview PNG/JPEG, copy paths or Markdown, insert into the editor or copy images into the project; originals are kept, insertion does not save, and copying does not overwrite |
| Optional alerts and scheduled requests | Disabled by default; low, exhausted and recovered quota alerts, plus text requests on daily/weekly, interval, five-field cron or confirmed full-quota recovery triggers |
| Shared interface language | Manually choose Simplified Chinese or English globally; Chinese is the default and account, image, history and automation pages update immediately |

## Getting started

### Save or add an account

1. If you already have an official login, select **Save current account**. To add another account, select **Add account** and complete OAuth authorization in your browser. Adding restores the original login afterwards; using the new account requires a separate switch.
2. Select **Switch** on an account card and confirm the displayed background and task scope. Workbench handles that scope, restarts the official component and verifies the target identity before reporting completion. Active tasks in the confirmed scope, including related windows, may be interrupted. Unverifiable backgrounds or login scope show conflict and recovery details.
3. Select **Refresh** on an account card to query its server quota without first switching logins.

To migrate accounts, use **Export accounts / Import accounts** with an encrypted `.agwenc` file. Import verifies candidate identity and quota; matching emails can be replaced or skipped, while the current official login stays unchanged. See [account management](docs/INDEPENDENT_ACCOUNTS.md) and [encrypted migration](docs/ACCOUNT_MIGRATION.md) (Chinese).

### Compare quotas and browse history

1. Select a model in the quota overview, then sort by remaining quota, update time or reset time. You can cancel **Refresh all** at any time.
2. Star favorite models and collapse families. Browse accounts in **Quick quota view**, or pin one account/model to the status bar.
3. Open **Quota history** to filter observations by account, model and time, inspect details or clear history.

Unknown quota stays unknown, and older readings retain their query time. Family grouping does not establish shared quota pools. See [quota workflows](docs/QUOTA_WORKFLOWS.md) (Chinese).

### Generate images and use them in your project

1. Open the image studio and follow the current login or choose a saved account. Models come from that account's server catalog; compare and select accounts by the exact model's quota when needed.
2. Select a model, enter a prompt, ratio and request count, then add references or choose another output directory if needed.
3. Select **Generate**, check the account, model, request count and destination in the confirmation, then submit. Results default to the current project and can be previewed directly.
4. Reuse a historical task's model and parameters, checking any missing-reference warning. You can also continue editing a result, compare versions or copy paths, Markdown and images into the project.

Drafts and task cards stay on the current host and return after reload. Existing images can be recovered without generating them again. Normal use needs no endpoint configuration; failed image requests do not automatically retry, switch accounts or change endpoints. See [image generation](docs/IMAGE_GENERATION.md) and [project actions](docs/IMAGE_RESULTS.md) (Chinese).

### Enable alerts and scheduled requests when needed

Open **Manage scheduled requests and alerts** to select low, exhausted or recovered quota alerts. Text requests use a chosen account, model and timezone, with daily/weekly, interval or five-field cron schedules. They can also run when the server reports a transition from partial quota to exactly full quota.

Alerts, the master switch and new tasks are disabled by default. Preview the schedule, then explicitly enable the task; manual test, pause, cancel and run results are available. Tasks send the fixed short input `Hi` and may consume quota. The VS Code extension host must remain running; occurrences more than five minutes late are skipped. See [alerts and scheduled requests](docs/QUOTA_WORKFLOWS.md#提醒与定时请求) (Chinese).

## Feature walkthrough

Screenshots show actual Chromium / VS Code rendering with fictional accounts, mock quota and local demonstration images. No real account login or image-generation request was made. They illustrate the source interface; use Marketplace for everyday installation and updates.

### Accounts and quota

Add and save share a toolbar, and the current login is clearly marked. Refresh an account to see remaining fractions, reset times and query time; compare, sort and batch-refresh accounts in the quota overview. Accounts and percentages below are demonstration values.

<img src="docs/images/accounts-en.png" width="410" alt="English account workbench with grouped Add and Saved buttons, current-login badge and mock model quota">

### Image studio

Select an independent image account and a model from its server catalog, then prepare a prompt, references and parameters. Submission requires confirmation. Creation history stays on the right for parameter reuse and continued editing. Image quota percentages are not converted into image counts.

<img src="docs/images/image-studio-en.png" width="960" alt="English image studio with independent account selection, mock model quota, references and saved demonstration result">

### Clear references and continue creating

Remove references individually or clear them all. The screenshot below follows the actual host's clear action: current references are gone, while original files and saved results remain available for continued editing.

<img src="docs/images/image-studio-cleared-en.png" width="960" alt="English image studio after clearing references, with saved results and original images retained">

## Interface language

Simplified Chinese is the default. Open **Settings / 设置** in the workbench or use `antigravityAccounts.language` in VS Code to choose `zh-CN` or `en` manually. This shared user setting updates account, image, automation and history pages, QuickPick, the status bar and messages immediately, preserving current forms, selections and tasks.

Command Palette entries, view titles and setting descriptions follow VS Code's display language. See the [Chinese walkthrough](README.md#功能演示).

## FAQ

| Question | Answer |
| --- | --- |
| Why is Saved disabled? | The verified current identity already has a usable local copy, so it does not need saving again. This does not guarantee server authorization. |
| Why is an image model missing? | Availability, including Nano Banana 2.1, depends on the selected account's server catalog and permissions; a subscription name does not guarantee access. See [catalog troubleshooting](docs/TROUBLESHOOTING.md#图片模型目录与-pro-排查) (Chinese). |
| Can quota percentages be converted into image counts? | No. They represent the selected model's server-reported remaining fraction; stale readings are marked. Request counts do not guarantee output counts either. |
| Does selecting another image account switch the official login? | No. Independent selection affects the image task only; confirmation fixes the selected account and model. |
| What if switching is unavailable or WSL cannot find my accounts? | Check both extensions' hosts and any pending recovery operation, then follow the recovery prompt. Storage is separate per host. See [troubleshooting](docs/TROUBLESHOOTING.md) (Chinese). |
| Will generation resume automatically after reload? | No. Drafts and task cards return, but interrupted tasks retain their status. Resubmission requires your explicit action. |
| Will text requests run if I leave scheduling off? | No. Alerts and scheduled requests are disabled by default and require manual enabling; manual tests also require an explicit action. |

## Privacy and usage boundaries

Account credentials are stored in VS Code SecretStorage or restricted storage on the current host. Account exports use encrypted `.agwenc` files. Drafts, reference paths and task records stay on the current host; images go to your selected directory. Logs and account export bundles are never automatically uploaded.

Generation sends the selected account's authorization, prompt and selected references to the relevant Google service. Submit only content you are entitled to use. Switching writes local credentials for the official component and restarts it; follow recovery prompts if a transaction remains unfinished or identity verification fails. Server responses determine model availability, call permissions and quota semantics.

## Documentation and feedback

The English quick start and this README cover the user workflow. Detailed technical guides linked below are currently in Chinese.

| What you need | Documentation |
| --- | --- |
| Complete user workflow | [Quick start](docs/GETTING_STARTED.en.md) · [Documentation index](docs/README.md) |
| Accounts, switching and migration | [Account management](docs/INDEPENDENT_ACCOUNTS.md) · [Switching and recovery](docs/ACCOUNT_SWITCHING.md) · [Encrypted migration](docs/ACCOUNT_MIGRATION.md) |
| Quotas, history and scheduling | [Quota workflows](docs/QUOTA_WORKFLOWS.md) · [Server queries](docs/INDEPENDENT_ACCOUNT_QUOTA.md) |
| Images and project actions | [Image generation](docs/IMAGE_GENERATION.md) · [Quota](docs/IMAGE_QUOTA.md) · [Continued editing and project actions](docs/IMAGE_RESULTS.md) |
| Troubleshooting and support scope | [Troubleshooting](docs/TROUBLESHOOTING.md) · [Debug logs](docs/DEBUG_LOGS.md) · [Compatibility](docs/COMPATIBILITY.md) |
| Versions and usage conditions | [Changelog](CHANGELOG_EN.md) · [Project and service notices](docs/PROJECT_NOTICES.md) |

In [Issues](https://github.com/XiaoXinCodes/antigravity-workbench/issues), include the extension version, operating system and host, reproduction steps and error codes. Follow [debug log guidance](docs/DEBUG_LOGS.md) to preview logs before exporting; omit credentials and private content. Report suspected vulnerabilities privately through the [security reporting process](SECURITY.md).

## Contributing

Documentation improvements, reproducible bug reports, feature suggestions and pull requests are welcome. Discuss larger changes in [Issues](https://github.com/XiaoXinCodes/antigravity-workbench/issues) first, then follow the [contribution guide](CONTRIBUTING.md) (Chinese). Contribute only material you are entitled to provide and retain third-party licenses and provenance.

Development uses Node.js 20+; CI uses Node.js 22. See the [contribution guide](CONTRIBUTING.md) for build and validation steps.

## License

Project-owned material uses the [Sustainable Use License 1.0](LICENSE), a source-available license rather than an OSI-standard open-source license.

Use and modification are allowed for personal, non-commercial and your own internal business purposes. Distribution or provision to others must be free of charge and for non-commercial purposes. Uses outside the license require separate permission from the rights holder. Paid consulting or support is not categorically prohibited, but use, distribution and provision of the software must still meet the license conditions. This summary neither adds to nor replaces [LICENSE](LICENSE).

Third-party code shipped with the software retains its own licenses; see [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt). This license grants no Google service access and does not cover rights in third-party code, assets or trademarks. See [project and service notices](docs/PROJECT_NOTICES.md).
