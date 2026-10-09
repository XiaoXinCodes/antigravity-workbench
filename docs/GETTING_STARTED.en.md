# Antigravity Workbench guide

Download the `.vsix` from the [latest Release](https://github.com/XiaoXinCodes/antigravity-workbench/releases/latest), run **Extensions: Install from VSIX…** in the target VS Code window and select the file. Reload when prompted and open Workbench from the Activity Bar.

Workbench and Google Antigravity must run on the same host. In WSL, install the VSIX in the matching distribution and use that host's extensions, CLI and file paths.

## Accounts

1. Click **Add account**, confirm and authorize the Google account in your system browser. Workbench saves the new account, then restores your previous login state.
2. Signing in directly through official Google Antigravity automatically verifies and displays the current identity and saves an encrypted copy on the same host. Returning to the window triggers a check; a local Hub probe detects changes every five seconds while idle. The same identity retains its account ID and label. Saving failures keep the verified identity visible and report an error; **Save current account** can retry. Local credential readiness does not prove Google still accepts authorization.
3. Click **Switch** on a saved account. Workbench identifies this window's background processes and shows their scope in one confirmation. After confirmation, it handles that scope, restarts the official component and verifies the target identity before treating the switch as complete.
4. Click **Refresh** to query that account's server model quotas and reset times, without switching. Progress, quota and errors appear on the account card without another dialog. If authorization expires, resolve the card error and retry.
5. Removing the current account first safely switches to the first different account with usable local credentials on the same host, then removes the old copy after verification. A failed switch retains that copy. With no replacement, remove only the copy and keep the official login. Background synchronization does not immediately re-add that same current identity; an identity change enables automatic saving again.

Adding and switching are separate operations. The confirmation warns that active tasks in its scope, including related windows, may be interrupted. Unknown window ownership remains visible; handling requires verified process identity and shared login scope plus explicit confirmation. Unverifiable processes receive conflict and recovery details. Incomplete operations retain recovery actions and backups. Do not manually delete credentials or internal locks. Closing an authorization page does not revoke authorization you already granted to Google.

Use **Export accounts / Import accounts** with a separate strong password to migrate saved logins. Import verifies candidate identity and quota automatically. Matching saved accounts can be replaced or skipped; the current official login stays unchanged. Further technical details are available in [encrypted migration](ACCOUNT_MIGRATION.md).

## Images

Open the image studio. It follows the current official login by default; you can select another saved account. Workbench checks that account's own identity and image models before submission. Selecting an image account does not switch the official current login. Confirmation shows the account, model, request count and save folder.

- Choose 1–4 sequential requests. Each response may contain several images. No automatic retry, account switch or endpoint fallback.
- Add up to 3 PNG / JPEG references. Size and detail are preferences; actual output is determined by the service.
- Images save to the current project by default, or another folder on this host. Validated PNG / JPEG files have previews.
- Import an existing image from an explicitly selected official session without requesting image generation.
- Cancelling before submission makes no image request. Cancelling a submitted request may still use service quota.
- Drafts, the selected account and task cards save locally and restore after reload. Interrupted tasks are not automatically resubmitted. Deleting task records keeps image files.
- Continue editing a saved result, compare versions, or copy it into your project. These actions retain original files. Reference editing does not guarantee precise local edits or transparency.
- Query quota for the selected account and model to view server-reported remaining fractions and reset/update times. Values older than a minute are marked stale; fractions are not converted to image counts.

Report errors using error codes and operation records instead of repeatedly submitting requests. Further technical details: [image generation](IMAGE_GENERATION.md) and [image quota](IMAGE_QUOTA.md).

## Language and settings

Click **Settings** at the bottom of Workbench and search for `antigravityAccounts.language`. Select **English** or **简体中文** manually; Simplified Chinese is the default. Open account, image and diagnostic views update without reloading. Drafts, references, account selection and tasks are retained; language changes make no login or image requests.

Runtime interface text follows this setting. Static Command Palette titles and contributed view names follow VS Code's display language and its native localization mechanism; they do not change instantly with this extension setting. The settings command and language setting retain bilingual labels for discovery. Unknown language values fall back to Simplified Chinese. Workspace settings do not override the user-level selection.

Use **Advanced troubleshooting…** to inspect extension hosts. Enable diagnostic logging, reproduce once, disable it, then preview and export the logs. For an [Issue](https://github.com/XiaoXinCodes/antigravity-workbench/issues), include version, OS, host, reproduction steps and error code; never attach credential files or account export packages. Logs are not uploaded automatically. Technical references linked from this guide may currently be in Chinese.
