# Dora Dashboard

Plan today's work, check in on habits, and see when you last wrote in your journal. Dora Dashboard opens as a workspace tab in Obsidian. Its cards use your own Markdown files. A new vault starts with an empty dashboard.

[简体中文](README.zh-CN.md)

![A populated dashboard with a project checklist, habit tiles, journal calendar, highlights and thoughts. All content is fictional.](docs/dashboard.png)

## Install and update

In Obsidian **Settings → Community plugins → Browse**, search for **Dora Dashboard**, then select **Install → Enable**. Open the dashboard from the ribbon or the command palette. To update, use **Check for updates → Update** in Community plugins. The dashboard supports desktop Obsidian 1.11.5 and later, in English and Simplified Chinese. [Open the community listing](https://community.obsidian.md/plugins/dora-dashboard)

## Your first day

1. Click **Write your first task**, type the task and press Enter. Escape cancels the edit. Use the same pencil, checkbox and calendar in Today, Projects, Learning or a custom page. **Undo** restores the last dashboard change.
2. **New project** creates a checklist. **Link checklist** uses a Markdown note already in the vault. Creating a project in Learning makes it a learning project.
3. Give a habit a name to track it daily. Choose **Weekdays** or **Custom days** for another schedule. Click the tile to check in and click again to undo.
4. **Write today** edits the daily note’s body or today’s section of a monthly note. Closing the editor keeps your draft for this session. Clearing an existing entry asks for confirmation. Use the arrow keys to select dates in the calendar.

Opening the dashboard creates no content files. By default, the first save uses `Dora Dashboard/`. Choose a different destination in **Note sources**. Existing files stay at their current locations when you change that setting. Per-vault layout, bindings and switches live in Obsidian's plugin settings. Upgrading the plugin preserves both these settings and your notes.

## Make it yours

Both the sidebar gear and the plugin's settings tab open the same controls.

| Where                  | What you can change                                                                                                                                            |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Appearance & layout    | Language, greeting name, startup behavior, card order and colors.                                                                                              |
| Pages & cards          | Turn each home card on or off. Enable Learning, Creator or Finances. Name custom pages and combine note links, today's tasks, milestones and project progress. |
| Note sources           | Choose an inbox, journal folder, books, thoughts, draft/idea folders or financial ledger. Link, rebind or unlink project checklists.                           |
| Accounts & connections | Set up optional creator sync, WeRead or a model for reflections.                                                                                               |

For highlights, select a note or folder with Markdown blockquotes (`> …`) or WeRead Markdown exports. For thoughts, select your own note or folder. Choosing a source also shows its card. The arrows move between excerpts, long entries expand and the source title opens the original note. The **Learning** page shows the next unchecked task and milestones for projects marked **Learning**. The local **Finances** page records dated asset/liability snapshots, monthly income/expenses and a separate goal for each ledger currency.

## Optional connections and privacy

The core dashboard works offline. It has no telemetry, server, scheduled system task or external folder to install.

- **Creator sync.** Turn on the Creator page, then enable platform sync separately. Install [Ego Lite](https://lite.ego.app/download) yourself and sign in to the desired creator platforms in its browser. Click **Add creator account**, choose a platform and, when there is more than one, a browser profile. Verify the signed-in identity, then confirm the binding. Click **Sync works** to read published works, account metrics and follower observations from Douyin, Xiaohongshu, Kuaishou or Bilibili. Each account keeps a separate local archive. If the browser is missing or a login expires, your notes and the last completed archive remain available. Partial batches resume from a local checkpoint.
- **External browser access.** Creator sync invokes the installed `ego-browser` executable with the read-only platform adapters included in this release. This access outside the vault is needed for the browser the user authorized. Platform login sessions remain in Ego Lite. The plugin stores the chosen profile ID and creator account ID in vault-specific settings. It does not publish posts.
- **WeRead.** Local reading cards need no account. To fetch official highlights and comments, select your own [WeRead API key](https://weread.qq.com/r/weread-skills) in Obsidian's secret storage, test the connection, then sync under **Accounts & connections**. Requests go to `i.weread.qq.com`. Book notes and sync state stay in your selected dashboard folder. Each key has its own cache.
- **AI reflections.** Enter your own HTTPS Chat Completions endpoint and model, select a key in Obsidian's secret storage, and select which task, project or habit fields it may receive. You can inspect the destination and the complete request before enabling and before each generation. Journal text, financial records and creator analytics are outside the available fields. The configured provider may charge for requests. Reflections save to dated Markdown notes.

Creator identity, first works batches and follower reads have been tested on macOS (Apple Silicon) with Ego Lite. Xiaohongshu and Kuaishou detailed metrics were also sampled. Other desktop OS/browser combinations have not been verified. Platform dashboards can change; the plugin only replaces a confirmed archive after a complete successful run.

## Development

Use Node.js 24 and run `npm ci`, `npm test`, then `npm run build`. The three release assets are built in `dist/`. Run **Actions → Desktop tests → Run workflow** to test the published files and the community installer in Obsidian on a remote virtual display. These tests use temporary vaults and fictional data. For an interactive local run on macOS, explicitly allow test windows with `DORA_ALLOW_MAC_WINDOWS=1 npm run test:native`.

For a release, update `manifest.json`, the package version and `versions.json`, commit, then push the matching numeric Git tag (for example `1.0.1`). The release workflow runs tests and attaches `main.js`, `manifest.json` and `styles.css` individually. Users receive updates in Obsidian.

[MIT license](LICENSE) · [Third-party notices](THIRD-PARTY-NOTICES.md)
