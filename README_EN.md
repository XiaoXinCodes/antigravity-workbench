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

Workbench brings multiple accounts, server quota and an image studio into one VS Code workbench. Save or switch accounts, choose a saved account independently for image tasks, and use the results in your current project.

This project is independently developed and is not affiliated with, authorized by or endorsed by Google. Available models, permissions and quota depend on the selected account's server responses.

[Quick installation](#quick-installation) · [Getting started](#getting-started) · [Feature walkthrough](#feature-walkthrough) · [FAQ](#faq) · [Contributing](#contributing)

## Quick installation

**Before installing:** VS Code 1.95 or later, with an available Google Antigravity extension and login. Both extensions must run on the same local or WSL host.

1. Search for **Antigravity Workbench** in VS Code's Extensions view. Verify publisher **XiaoXinCodes** and extension ID `xiaoxincodes.antigravity-account-manager`.
2. Select **Install**. You can also open the [VS Code Marketplace listing](https://marketplace.visualstudio.com/items?itemName=xiaoxincodes.antigravity-account-manager) and select **Install** to install in VS Code.
3. Reload when prompted and open **Antigravity Workbench** in the activity bar.

**WSL workspaces:** In a VS Code window connected to WSL, check where Google Antigravity actually runs. If the official extension runs in WSL, select **Install in WSL: &lt;distribution&gt;** on the extension page to install Workbench on that same remote host. If the official extension runs locally, keep both extensions on the local host.

Installation and upgrades do not require clearing saved accounts, official login files, sessions or images. Release notes, source and checksum files are in the [latest Release](https://github.com/XiaoXinCodes/antigravity-workbench/releases/latest); see the [changelog](CHANGELOG_EN.md) for version changes.

Windows, macOS and Linux local extension hosts and WSL Linux workspace hosts are supported. SSH and container hosts have not been verified. Three-platform automated checks do not establish that every real-account scenario works; see [compatibility](docs/COMPATIBILITY.md) (Chinese).

<details>
<summary>Offline alternative: install from VSIX</summary>

If Marketplace is unavailable, download the `.vsix` attachment from the [latest Release](https://github.com/XiaoXinCodes/antigravity-workbench/releases/latest). In the target VS Code window, run **Extensions: Install from VSIX…** from the Command Palette, select the file and reload when prompted. With WSL, still check the actual installation host.

</details>

## What you can do

| Feature | Purpose |
| --- | --- |
| Multiple accounts | Add accounts through browser OAuth, save the current login, and switch to saved accounts with automatic official-component restart and identity verification. |
| Server quota | Query model fractions, reset times and update times independently for each account without first switching logins. |
| Image studio | Follow the current login or select a saved account independently. Choose its image model, prompt, references, aspect ratio and request count; save and preview PNG/JPEG files. |
| Creative history and versions | Restore drafts and task cards, continue editing saved results and compare versions. Original images are retained; interrupted tasks are not automatically resubmitted. |
| Use results in your project | Copy relative paths or Markdown; explicitly insert into the displayed text file without saving it automatically. Copying an image into the project refuses to overwrite existing files. |
| Migration and recovery | Export and import encrypted account bundles, recover existing official-session PNG files, and run diagnostics or export logs on demand. |

## Getting started

### Save or add an account

1. If you already have an official login, select **Save current account**. To add another account, select **Add account** and complete OAuth authorization in your browser. Adding restores the original login afterwards; using the new account requires a separate switch.
2. Select **Switch** on an account card and confirm. Completion is reported after component restart and identity verification. Finish active tasks in the official component before adding or switching accounts.
3. Select **Refresh** on an account card to query its server quota without first switching logins.

A usable local saved record displays a disabled **Saved** button. Missing or unusable credentials can update the existing record without creating a duplicate. Saved describes local checks and does not guarantee that server authorization remains valid. See [account management](docs/INDEPENDENT_ACCOUNTS.md) (Chinese).

### Generate images and use them in a project

1. Open the image studio. Follow the current login or select another saved account, then wait for that account's own model catalog.
2. Choose a model, enter a prompt, aspect ratio and request count, and optionally add references or choose another output directory.
3. Select **Generate images** and check the account, model, request count and save location in the confirmation before submitting. Results save to the current project by default and can be previewed directly.
4. Continue editing or compare saved versions, or copy paths, Markdown or images into the project. Inserting text requires an explicit click and does not save the editor automatically.

Drafts and task cards stay on the current host and return after reload. Use recovery to restore existing images without generating them again. Normal usage needs no endpoint configuration; failed image requests never automatically retry, change accounts or change endpoints. See [image generation](docs/IMAGE_GENERATION.md) and [project actions](docs/IMAGE_RESULTS.md) (Chinese).

## Feature walkthrough

Screenshots show actual Chromium / VS Code rendering with fictional accounts, mock quota and local demonstration images. No real account login or image-generation request was made. They illustrate the source interface; use Marketplace for everyday installation and updates.

### Accounts and quota

Add and save share a toolbar, and the current login is clearly marked. Select **Refresh** on an account card to see its remaining fractions, reset times and update time. Accounts and percentages below are demonstration values.

<img src="docs/images/accounts-en.png" width="410" alt="English account workbench with grouped Add and Saved buttons, current-login badge and mock model quota">

### Image studio

Select an independent image account and a model from its server catalog, then prepare a prompt, references and parameters. Submission requires confirmation. Saved results stay on the right; image quota percentages are not converted into image counts.

<img src="docs/images/image-studio-en.png" width="960" alt="English image studio with independent account selection, mock model quota, references and saved demonstration result">

### Clear references and continue creating

Remove references individually or clear them all. The screenshot below follows the actual host's clear action: current references are gone, while original files and saved results remain available for continued editing.

<img src="docs/images/image-studio-cleared-en.png" width="960" alt="English image studio after clearing references, with saved results and original images retained">

## Interface language

Simplified Chinese is the default. Open **Settings / 设置** from the workbench, or search VS Code settings for `antigravityAccounts.language`, and manually select `zh-CN` or `en`. Open workbench and image panels, messages and the quick start update immediately while retaining input, references, account selection, layout and tasks. See the [Chinese walkthrough](README.md#功能演示).

Command Palette entries, view titles and settings descriptions are static contributions that follow VS Code's display language. Changing that display language may require a reload. The extension's manual language selection does not change these static entries.

## FAQ

| Question | Answer |
| --- | --- |
| Why is Saved disabled? | The verified current identity already has a usable local copy, so it does not need saving again. This does not guarantee server authorization. |
| Why is an image model missing? | The list comes from the selected account's server catalog. You can check again, but a model or subscription name does not guarantee that it is listed or callable. See [catalog troubleshooting](docs/TROUBLESHOOTING.md#图片模型目录与-pro-排查) (Chinese). |
| Can quota percentages be converted into image counts? | No. They represent the selected model's server-reported remaining fraction; stale readings are marked. Request counts do not guarantee output counts either. |
| Does selecting another image account switch the official login? | No. Independent selection affects the image task only; confirmation fixes the selected account and model. |
| What if switching is unavailable or WSL cannot find my accounts? | Check both extensions' hosts and any pending recovery operation, then follow the recovery prompt. Storage is separate per host. See [troubleshooting](docs/TROUBLESHOOTING.md) (Chinese). |
| Will generation resume automatically after reload? | No. Drafts and task cards return, but interrupted tasks retain their status. Resubmission requires your explicit action. |
| How do I install and update? | Search for Antigravity Workbench in VS Code's Extensions view, verify publisher XiaoXinCodes and extension ID `xiaoxincodes.antigravity-account-manager`, then select Install. You can also open the [Marketplace listing](https://marketplace.visualstudio.com/items?itemName=xiaoxincodes.antigravity-account-manager). Use the Extensions view for updates; no manual VSIX download is needed. |
| Why does the Marketplace description differ from the repository README? | The Marketplace description updates with the uploaded VSIX. Committing the repository README does not automatically update that description. |

## Privacy and usage boundaries

Account credentials are stored in VS Code SecretStorage or restricted storage on the current host. Account exports use encrypted `.agwenc` files. Drafts, reference paths and task records stay on the current host; images go to your selected directory. Logs and account export bundles are never automatically uploaded.

Generation sends the selected account's authorization, prompt and selected references to the relevant Google service. Submit only content you are entitled to use. Switching writes local credentials for the official component and restarts it; follow recovery prompts if a transaction remains unfinished or identity verification fails. Server responses determine model availability, call permissions and quota semantics.

## Documentation and feedback

The English quick start and this README cover the user workflow. Detailed technical guides linked below are currently in Chinese.

| What you need | Documentation |
| --- | --- |
| Complete user workflow | [Quick start](docs/GETTING_STARTED.en.md) · [Documentation index](docs/README.md) |
| Accounts, switching and migration | [Account management](docs/INDEPENDENT_ACCOUNTS.md) · [Switching and recovery](docs/ACCOUNT_SWITCHING.md) · [Encrypted migration](docs/ACCOUNT_MIGRATION.md) |
| Images and project actions | [Image generation](docs/IMAGE_GENERATION.md) · [Quota](docs/IMAGE_QUOTA.md) · [Continued editing and project actions](docs/IMAGE_RESULTS.md) |
| Troubleshooting and support scope | [Troubleshooting](docs/TROUBLESHOOTING.md) · [Debug logs](docs/DEBUG_LOGS.md) · [Compatibility](docs/COMPATIBILITY.md) |
| Versions and usage conditions | [Changelog](CHANGELOG_EN.md) · [Project and service notices](docs/PROJECT_NOTICES.md) |

In [Issues](https://github.com/XiaoXinCodes/antigravity-workbench/issues), include the extension version, operating system and host, minimal reproduction steps, expected result and error codes. If logs are needed, open **Antigravity Workbench: Advanced troubleshooting…** from the Command Palette, enable debugging, reproduce the necessary operation once, then disable logging before previewing and exporting.

Do not submit tokens, credential files, account export bundles, private prompts or unchecked raw logs. Report suspected vulnerabilities privately through the [security reporting process](SECURITY.md).

## Contributing

Documentation improvements, reproducible bug reports, feature suggestions and pull requests are welcome. Discuss larger changes in [Issues](https://github.com/XiaoXinCodes/antigravity-workbench/issues) first, then follow the [contribution guide](CONTRIBUTING.md) (Chinese). Contribute only material you are entitled to provide and retain third-party licenses and provenance.

Development uses Node.js 20+; CI uses Node.js 22. The source includes TypeScript, tests, build scripts and a lockfile, with no runtime npm dependencies.

```sh
npm ci --ignore-scripts
npm run check
npm run test:host
npm run package
```

On Linux without a display, use `xvfb-run -a npm run test:host`. CI covers checks, isolated VS Code hosts and packaging on Linux, Windows and macOS. Default checks use synthetic data and need no real Google login or image generation.

## License

Project-owned material uses the [Sustainable Use License 1.0](LICENSE), a source-available license rather than an OSI-standard open-source license.

Use and modification are allowed for personal, non-commercial and your own internal business purposes. Distribution or provision to others must be free of charge and for non-commercial purposes. Uses outside the license require separate permission from the rights holder. Paid consulting or support is not categorically prohibited, but use, distribution and provision of the software must still meet the license conditions. This summary neither adds to nor replaces [LICENSE](LICENSE).

Third-party code shipped with the software retains its own licenses; see [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt). This license grants no Google service access and does not cover rights in third-party code, assets or trademarks. See [project and service notices](docs/PROJECT_NOTICES.md).
