// Use the Desktop tests workflow to run Obsidian on a separate virtual display.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";

const linux = process.platform === "linux";
if (linux && !process.env.DISPLAY)
  throw new Error("Start the native tests with xvfb-run on Linux.");
if (!linux && (process.platform !== "darwin" || process.env.DORA_ALLOW_MAC_WINDOWS !== "1"))
  throw new Error("Run the Desktop tests workflow for an isolated virtual display. Local macOS testing can show windows and requires DORA_ALLOW_MAC_WINDOWS=1.");
const repo = fileURLToPath(new URL("../", import.meta.url));
const dist = join(repo, "dist");
const manifest = JSON.parse(
  await readFile(join(dist, "manifest.json"), "utf8"),
);
const id = manifest.id;
assert.equal(id, "dora-dashboard");
const bundle = process.env.OBSIDIAN_APP ||
  (linux ? "/opt/Obsidian/obsidian" : "/Applications/Obsidian.app");
const work = await mkdtemp(
  join(await realpath(tmpdir()), "dora-public-native-"),
);
const output = join(repo, "test-results/native");
await mkdir(output, { recursive: true });
const checks = [];
const accepted = (label) => {
  checks.push(label);
  console.log("PASS " + label);
};
const key = "d04ad04ad04ad04a";
const binaryAssets = ["main.js", "manifest.json", "styles.css"];
const assetHashes = Object.fromEntries(
  await Promise.all(
    binaryAssets.map(async (name) => [
      name,
      createHash("sha256")
        .update(await readFile(join(dist, name)))
        .digest("hex"),
    ]),
  ),
);
const hostAgents = new Set();
let current, page, browser, mainPid;
const click = (name, parent = page) =>
  parent.getByRole("button", { name, exact: true }).click();
const slug = (date = new Date()) =>
  [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
const today = slug();
const noteAt = (path) => readFile(join(current.vault, path), "utf8");

async function put(path, text) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}
async function makeHost(name, preinstall = true) {
  const root = join(work, name),
    profile = join(root, "profile"),
    vault = join(root, "vault");
  const plugin = join(vault, ".obsidian/plugins", id);
  if (preinstall) await mkdir(plugin, { recursive: true });
  await put(
    join(vault, ".obsidian/community-plugins.json"),
    JSON.stringify(preinstall ? [id] : []),
  );
  await put(
    join(vault, ".obsidian/appearance.json"),
    JSON.stringify({ theme: "moonstone", showRibbon: false }),
  );
  await put(
    join(profile, "obsidian.json"),
    JSON.stringify({
      updateDisabled: true,
      vaults: { [key]: { path: vault, ts: Date.now(), open: true } },
    }),
  );
  await put(
    join(profile, key + ".json"),
    JSON.stringify({
      x: linux ? 0 : -15000,
      y: 40,
      width: 1440,
      height: 950,
      isMaximized: false,
      devTools: false,
      zoom: 0,
    }),
  );
  return { root, vault, profile, plugin };
}
async function install(host, predecessor = false) {
  for (const name of binaryAssets)
    await copyFile(join(dist, name), join(host.plugin, name));
  if (!predecessor) return;
  await copyFile(
    join(repo, "tests/upgrade-baseline.cjs"),
    join(host.plugin, "main.js"),
  );
  await put(
    join(host.plugin, "manifest.json"),
    JSON.stringify({ ...manifest, version: "0.9.0" }),
  );
}
async function endpoint(profile, child) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (child && (child.exitCode !== null || child.signalCode !== null))
      throw new Error("Obsidian exited during startup: " + (child.exitCode ?? child.signalCode));
    try {
      const [port, path] = (
        await readFile(join(profile, "DevToolsActivePort"), "utf8")
      )
        .trim()
        .split(/\r?\n/);
      if (/^\d+$/.test(port) && path.startsWith("/devtools/browser/"))
        return "ws://127.0.0.1:" + port + path;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await delay(150);
  }
  throw new Error(
    "The hidden Obsidian instance did not open its debug endpoint.",
  );
}
async function boot(host, version = manifest.version) {
  current = host;
  await rm(join(host.profile, "DevToolsActivePort"), { force: true });
  const args = [
    "--user-data-dir=" + host.profile,
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
  ];
  let child;
  if (linux) {
    child = spawn(bundle, [...args, "--disable-dev-shm-usage"], {
      stdio: ["ignore", "ignore", "inherit"],
    });
    await once(child, "spawn");
    mainPid = child.pid;
  } else {
    execFileSync("/usr/bin/open", ["-n", "-g", "-j", "-a", bundle, "--args", ...args]);
  }
  browser = await chromium.connectOverCDP(await endpoint(host.profile, child));
  const session = await browser.newBrowserCDPSession();
  mainPid = (await session.send("SystemInfo.getProcessInfo")).processInfo.find(
    (p) => p.type === "browser",
  )?.id;
  await session.detach();
  const ctx = browser.contexts()[0];
  page = ctx.pages()[0] || (await ctx.waitForEvent("page"));
  page.setDefaultTimeout(12000);
  if (linux) await page.bringToFront();
  ctx.on("weberror", (event) => console.error("Desktop error:", event.error().message));
  await page.waitForFunction(
    () =>
      window.app?.workspace?.layoutReady &&
      window.app.vault?.adapter?.getBasePath(),
    null,
    { timeout: 60000 },
  );
  const loaded = await page.evaluate(
    (id) => ({
      vault: app.vault.adapter.getBasePath(),
      version: app.plugins.manifests[id]?.version,
      manifests: Object.keys(app.plugins.manifests),
    }),
    id,
  );
  assert.equal(
    await realpath(loaded.vault),
    await realpath(host.vault),
    "Only operate the temporary QA vault.",
  );
  assert.deepEqual(loaded.manifests, version ? [id] : []);
  assert.equal(loaded.version, version ?? undefined);
  hostAgents.add(await page.evaluate(() => navigator.userAgent));
  await page.setViewportSize({ width: 1400, height: 920 });
  if (!version) return ctx;
  await page.waitForFunction(
    (id) =>
      !!app.plugins.plugins[id] ||
      [...document.querySelectorAll(".modal button")].some((b) =>
        /^(Trust author and enable plugins|信任仓库作者并启用插件)$/.test(
          b.textContent.trim(),
        ),
      ),
    id,
    { timeout: 30000 },
  );
  const trust = page.getByRole("button", {
    name: /^(Trust author and enable plugins|信任仓库作者并启用插件)$/,
  });
  if (await trust.isVisible()) await confirmTrust(trust);
  await page.waitForFunction((id) => window.app?.workspace?.layoutReady && !!app.plugins.plugins[id], id, {
    timeout: 30000,
  });
  await ctx.setOffline(true);
  return ctx;
}
async function confirmTrust(button) {
  // The desktop client can reload the vault after the user accepts.
  const navigation = page.waitForNavigation({
    waitUntil: "domcontentloaded",
    timeout: 5000,
  }).catch((error) => {
    if (error.name !== "TimeoutError") throw error;
  });
  await button.click();
  await navigation;
  await page.waitForFunction(() => window.app?.workspace?.layoutReady);
}
async function visibleControl(locate, description, timeout = 16000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    for (const candidate of browser.contexts().flatMap((context) => context.pages())) {
      const control = locate(candidate);
      if (await control.isVisible().catch(() => false)) return control;
    }
    await delay(100);
  }
  throw new Error("Obsidian did not show " + description);
}
function verifiedPid(pid, profile) {
  if (!pid || !profile?.startsWith(work + "/")) return false;
  try {
    return execFileSync("/bin/ps", ["-ww", "-p", String(pid), "-o", "command="], {
      encoding: "utf8",
    }).includes("--user-data-dir=" + profile);
  } catch {
    return false;
  }
}
async function stop() {
  // Disconnect before the host closes its windows and fires beforeunload.
  if (browser?.isConnected()) await browser.close();
  if (verifiedPid(mainPid, current?.profile)) process.kill(mainPid, "SIGTERM");
  for (let i = 0; verifiedPid(mainPid, current?.profile) && i < 40; i++) {
    await delay(100);
  }
  assert.equal(
    verifiedPid(mainPid, current?.profile),
    false,
    "Temporary Obsidian process exited.",
  );
  page = browser = mainPid = undefined;
}
async function openBoard() {
  await page.evaluate(async (id) => {
    const p = app.plugins.plugins[id];
    if (p.uiLanguage() !== "en")
      await p.update((cfg) => {
        cfg.language = "en";
      });
    app.workspace.leftSplit.collapse();
    app.workspace.rightSplit.collapse();
    await p.openDashboard();
  }, id);
  await page.locator(".dd-app").waitFor();
}
async function submit(fields, action = "Save") {
  const modal = await visibleControl((p) => p.locator(".dd-modal").last(), "the dashboard form");
  for (const [label, value] of Object.entries(fields))
    await modal.getByLabel(label, { exact: true }).fill(value);
  await click(action, modal);
  await modal.waitFor({ state: "hidden" });
}
async function waitRaw(path, contains) {
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      if ((await noteAt(path)).includes(contains)) return;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await delay(75);
  }
  throw Error("Expected persisted content in " + path + ": " + contains);
}
async function emptyCase() {
  const host = await makeHost("Empty");
  await install(host);
  await boot(host);
  assert.deepEqual(
    await page.evaluate(() => app.vault.getMarkdownFiles().map((f) => f.path)),
    [],
  );
  await openBoard();
  await page.getByRole("button", { name: "Write your first task" }).waitFor();
  assert.deepEqual(
    await page.evaluate(() => app.vault.getMarkdownFiles().map((f) => f.path)),
    [],
  );
  assert.equal(
    await page
      .locator(".dd-nav .dd-nav-item")
      .allTextContents()
      .then((x) => x.join(",")),
    "Home,Settings",
  );
  const inbox = "Dora Dashboard/Inbox.md",
    title = "Pack the sketchbook";
  await click("Write your first task");
  await submit({ Title: title });
  await waitRaw(inbox, title);
  await click("Toggle task · " + title);
  await waitRaw(inbox, "[x] " + title);
  await click("Undo last change");
  await waitRaw(inbox, "[ ] " + title);
  await click("Add habit");
  await submit({ "Habit name": "Morning walk" });
  const habit = page.getByRole("button", { name: /^Morning walk/ });
  await habit.click();
  await page.locator(".dd-habit[aria-pressed=true]").waitFor();
  assert.match(await noteAt("Dora Dashboard/Habits.md"), new RegExp(today));
  await click("Write today");
  await submit({ "Journal entry": "A new page in the sketchbook." });
  await waitRaw("Dora Dashboard/Journal/" + today + ".md", "A new page");
  await page
    .locator('.dd-cell[title="' + today + '"][data-written=true]')
    .waitFor();
  accepted(
    "Offline empty vault, zero startup notes, task writeback/undo, first habit check-in, and first daily note",
  );
  await page.evaluate(async (id) => {
    await app.plugins.plugins[id].update((c) => {
      c.modules.finance = true;
    });
  }, id);
  await click("Finances");
  await click("Record your first snapshot");
  await submit({
    Date: today,
    "Assets (CNY)": "1200.30",
    "Liabilities (CNY)": "100.10",
  });
  await waitRaw(
    "Dora Dashboard/Finance/" + today + ".md",
    '"netCents": 110020',
  );
  await click("Record cash flow");
  await submit({
    Month: today.slice(0, 7),
    "Income (CNY)": "40",
    "Expenses (CNY)": "3.50",
  });
  await waitRaw(
    "Dora Dashboard/Finance/" + today.slice(0, 7) + ".md",
    '"expenseCents": 350',
  );
  await click("Set a goal");
  await submit({ "Goal amount (clear to remove)": "1200.00" });
  await page.waitForFunction(
    (id) => app.plugins.plugins[id].cfg.financeGoal === "1200.00",
    id,
  );
  await page.evaluate(async (id) => {
    const p = app.plugins.plugins[id];
    await p.update((c) => {
      c.sources.journal = "My journal";
      c.journalMode = "monthly";
    });
  }, id);
  await click("Home");
  await click("Write today");
  await submit({
    "Journal entry": "A monthly note, written in its own dated section.",
  });
  const monthPath =
    "My journal/" + today.slice(0, 4) + "/" + today.slice(0, 7) + ".md";
  await waitRaw(monthPath, "## " + today);
  assert.ok((await noteAt(monthPath)).includes("A monthly note"));
  assert.ok(
    (await noteAt("Dora Dashboard/Journal/" + today + ".md")).includes(
      "A new page",
    ),
  );
  accepted(
    "Both daily and monthly journal layouts using independently configured folders",
  );
  accepted(
    "Offline finance snapshot, monthly cash flow and goal through native forms",
  );
  await stop();
}
async function seedLibrary(host) {
  const files = {
    "Inbox.md":
      "# Today\n- [ ] Book the print workshop <!-- dora-day:" +
      today +
      " --> ^print-workshop\n- [ ] Select six trail photos <!-- dora-day:" +
      today +
      " --> ^trail-photos\n- [x] Fold the sample booklet <!-- dora-day:" +
      today +
      " --> ^sample-booklet\n",
    "Field guide.md":
      "# Pocket field guide\n- [x] Choose the paper stock\n- [ ] Sketch the first trail map\n## Milestones\n- [ ] Print a proof copy\n",
    "Learning/Letterpress.md":
      "# Letterpress\n- [x] Tour the studio\n- [ ] Set a short line of metal type\n## Milestones\n- [ ] Pull a two-color proof\n",
    "Library/Field notes.md":
      "# Details along the way\n> Look closely at the edge of the trail. A small change in the shape of a leaf can tell a whole story.\n\n> A hand-drawn map remembers the stops along the way. ^map-note\n",
    "Ideas.md":
      "# Commonplace book\n\nA pocket notebook is the right size for a walk with no destination.\n",
  };
  for (let i = 0; i < 95; i++) {
    if (i % 3 === 1 || i % 7 === 4) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      files["Journal/" + slug(d) + ".md"] =
        "The light changed on the walk home.\n";
    }
  }
  for (const [name, content] of Object.entries(files))
    await put(join(host.vault, name), content);
}
async function screenshots() {
  await page.evaluate(() => {
    app.workspace.leftSplit.collapse();
    app.workspace.rightSplit.collapse();
  });
  await page.setViewportSize({ width: 1400, height: 920 });
  const dashboard = page.locator(".dd-app");
  await page.evaluate(async (id) => {
    const p = app.plugins.plugins[id];
    for (const view of p.views) {
      view.undo = undefined;
      await view.refresh();
    }
    await document.fonts.ready;
  }, id);
  assert.ok((await dashboard.boundingBox()).width > 900);
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  // Clip to the dashboard's populated region inside the host window. Obsidian's
  // global status bar is unrelated to the dashboard and can overlap its lower edge.
  const clip = await dashboard.evaluate((node) => {
    const box = node.getBoundingClientRect(),
      cards = [...node.querySelectorAll(".dd-card")];
    const lastCard = Math.max(
      ...cards.map((card) => card.getBoundingClientRect().bottom),
    );
    const firstTask = node.querySelector(
      '[aria-label="Toggle task · Book the print workshop"]',
    );
    if (!firstTask || firstTask.getAttribute("aria-pressed") !== "false")
      throw Error("The final checkbox differs from its persisted note.");
    return {
      x: Math.ceil(box.left),
      y: Math.ceil(box.top),
      width: Math.floor(box.width),
      height: Math.floor(
        Math.min(
          box.height,
          lastCard - box.top + 12,
          window.innerHeight - box.top - 28,
        ),
      ),
    };
  });
  const style = ".status-bar { visibility: hidden !important; }";
  await page.screenshot({
    path: join(repo, "docs/dashboard.png"),
    clip,
    style,
    animations: "disabled",
  });
  // Theme classes are the host's documented selectors; these changes stay in this temporary renderer.
  await page.evaluate(() => {
    document.body.classList.remove("theme-light");
    document.body.classList.add("theme-dark");
  });
  await page.screenshot({
    path: join(output, "dashboard-dark.png"),
    clip,
    style,
    animations: "disabled",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(
    () => document.querySelector(".dd-app")?.clientWidth < 395,
  );
  const size = await dashboard.evaluate((el) => ({
    width: el.clientWidth,
    scroll: el.scrollWidth,
  }));
  assert.ok(
    size.scroll <= size.width + 2,
    "390px dashboard fits its pane: " + JSON.stringify(size),
  );
  await page.screenshot({
    path: join(output, "dashboard-390.png"),
    animations: "disabled",
  });
  accepted(
    "Synthetic wide light screenshot, themed dark screenshot, and 390-pixel narrow pane",
  );
}
async function libraryCase() {
  const host = await makeHost("Library");
  await install(host);
  await seedLibrary(host);
  await boot(host);
  await openBoard();
  await page.evaluate(async (id) => {
    const p = app.plugins.plugins[id];
    await p.update((c) => {
      c.nickname = "Alex";
      c.root = "Studio";
      c.sources = {
        ...c.sources,
        inbox: "Inbox.md",
        journal: "Journal",
        highlights: "Library",
        thoughts: "Ideas.md",
      };
      c.visible = [
        "tasks",
        "projects",
        "habits",
        "journal",
        "highlights",
        "thoughts",
      ];
      c.modules.study = true;
      c.projects = [
        {
          id: "guide",
          name: "Pocket field guide",
          path: "Field guide.md",
          learning: false,
        },
        {
          id: "press",
          name: "Learn letterpress",
          path: "Learning/Letterpress.md",
          learning: true,
        },
      ];
    });
    await p.notes.editHabits(p.cfg.root, (d) => {
      d.items.push(
        ...[
          ["walk", "Walk outside", "footprints"],
          ["write", "Write a page", "feather"],
          ["water", "Water plants", "sprout"],
        ].map(([id, name, icon], i) => ({
          id,
          name,
          icon,
          days: [0, 1, 2, 3, 4, 5, 6],
          checks: Array.from({ length: 6 - i * 2 }, (_, offset) => {
            const d = new Date();
            d.setDate(d.getDate() - offset - (i ? 1 : 0));
            return d.toLocaleDateString("sv-SE");
          }),
        })),
      );
    });
    await Promise.all([...p.views].map((v) => v.refresh()));
  }, id);
  const task = "Book the print workshop";
  await click("Toggle task · " + task);
  await waitRaw("Inbox.md", "[x] " + task);
  await page.evaluate(async () => {
    await app.fileManager.renameFile(
      app.vault.getAbstractFileByPath("Inbox.md"),
      "Studio inbox.md",
    );
  });
  await page.waitForFunction(
    (id) =>
      app.plugins.plugins[id].cfg.sources.inbox === "Studio inbox.md" &&
      document
        .querySelector('[aria-label="Toggle task · Book the print workshop"]')
        ?.dataset.focus?.includes("Studio inbox.md"),
    id,
  );
  await click("Toggle task · " + task);
  await waitRaw("Studio inbox.md", "[ ] " + task);
  assert.equal(
    await page
      .locator('[data-card="highlights"] blockquote')
      .textContent()
      .then((s) => s.includes("leaf")),
    true,
  );
  await click("Next excerpt", page.locator('[data-card="highlights"]'));
  await page
    .getByText("A hand-drawn map remembers the stops along the way.", {
      exact: true,
    })
    .waitFor();
  await click("Previous excerpt", page.locator('[data-card="highlights"]'));
  await click("Learning");
  await page
    .getByRole("button", { name: "Pull a two-color proof", exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Pocket field guide", exact: true })
      .count(),
    0,
  );
  await page.evaluate(async (id) => {
    await app.plugins.plugins[id].update((c) => {
      c.language = "zh";
    });
  }, id);
  await page.getByRole("heading", { name: "学习", exact: true }).waitFor();
  await click("首页");
  await page.getByRole("heading", { name: "今日待办", exact: true }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: task, exact: true }).count(),
    1,
  );
  await page.evaluate(async (id) => {
    await app.plugins.plugins[id].update((c) => {
      c.language = "en";
    });
  }, id);
  await page
    .getByRole("heading", { name: "Today's tasks", exact: true })
    .waitFor();
  await page.locator('[data-card="highlights"] blockquote').waitFor();
  assert.match(
    await noteAt("Studio inbox.md"),
    /- \[ \] Book the print workshop/,
  );
  await screenshots();
  await page.setViewportSize({ width: 1400, height: 920 });
  await click("Settings", page.locator(".dd-nav"));
  const settings = await visibleControl((p) => p.locator(".dd-settings-dialog").last(), "dashboard settings");
  for (const tab of [
    "Appearance & layout",
    "Pages & cards",
    "Note sources",
    "Accounts & connections",
  ]) {
    await settings.getByRole("button", { name: tab, exact: true }).waitFor();
  }
  await click("Pages & cards", settings);
  const highlights = settings.getByRole("checkbox", {
    name: "Recent highlights",
    exact: true,
  });
  await highlights.uncheck();
  await page.waitForFunction(
    (id) => !app.plugins.plugins[id].cfg.visible.includes("highlights"),
    id,
  );
  await page.waitForFunction(
    () => !document.querySelector('[data-card="highlights"]'),
  );
  assert.ok(
    await page.evaluate(
      (id) => ![...app.plugins.plugins[id].views][0].watched.has("Library"),
      id,
    ),
  );
  await click("New page", settings);
  await submit({ "Page name": "Planning desk" });
  await click("Add widget", settings);
  const editor = await visibleControl((p) => p.locator(".dd-modal").last(), "the widget editor");
  await editor.getByLabel("Type").selectOption("milestones");
  await click("Save", editor);
  await editor.waitFor({ state: "hidden" });
  await settings.page().keyboard.press("Escape");
  await settings.waitFor({ state: "hidden" });
  await click("Planning desk");
  await page
    .getByRole("button", { name: "Print a proof copy", exact: true })
    .waitFor();
  accepted(
    "All four settings groups, disabling the read source and card, custom page and milestone widget",
  );
  accepted(
    "Existing root Markdown, rename/rebind and second write, reading navigation, study-only sources, Chinese/English switching",
  );
  await stop();
}
function fixtureAccounts() {
  return ["Studio", "Workshop"].map((name) => ({
    key: "sample-" + name.toLowerCase(),
    platform: "xhs",
    name: name + " notebook",
    profileId: "sample-session-" + name.toLowerCase(),
    accountId: "sample-user-" + name.toLowerCase(),
  }));
}
async function creatorCase() {
  const host = await makeHost("Creator");
  await install(host);
  await boot(host);
  await openBoard();
  await page.evaluate(
    async ({ id, accounts }) => {
      const p = app.plugins.plugins[id];
      // Replace the external collector at its interface. The controller, Obsidian note writes,
      // cancellation and UI all remain the production implementation.
      const state = (window.creatorFixture = {
        calls: 0,
        closes: 0,
        hold: false,
        aborted: false,
      });
      const standard = p.mediaController.bind(p);
      p.mediaController = async () => {
        const controller = await standard();
        if (controller)
          controller.collector = {
            async step(job, signal) {
              ++state.calls;
              if (state.hold)
                return new Promise((_, reject) => {
                  const cancel = () => {
                    state.aborted = true;
                    reject(new Error("Fixture cancelled"));
                  };
                  if (signal.aborted) cancel();
                  else signal.addEventListener("abort", cancel, { once: true });
                });
              if (job.accountId === accounts[1].accountId)
                throw new Error("Test account requires sign-in");
              return {
                id: job.accountId,
                name: accounts[0].name,
                inventory: 1,
                next: null,
                posts: [
                  {
                    id: "sample-work",
                    title: "Printing a pocket map",
                    published: job.day,
                    counts: { views: 10, likes: 2 },
                    detail: {},
                  },
                ],
              };
            },
            async close() {
              ++state.closes;
            },
          };
        return controller;
      };
      await p.update((c) => {
        c.modules.creator = true;
        c.modules.media = true;
        c.accounts = accounts;
      });
    },
    { id, accounts: fixtureAccounts() },
  );
  await click("Creator");
  await page.getByRole("button", { name: "Sync works", exact: true }).waitFor();
  assert.equal(await page.evaluate(() => creatorFixture.calls), 0);
  await click("Sync works");
  await page.getByRole("link", { name: "Printing a pocket map" }).waitFor();
  await page
    .getByText("Workshop notebook · Test account requires sign-in", {
      exact: true,
    })
    .waitFor();
  const committed = await page.evaluate((id) => {
    const p = app.plugins.plugins[id];
    return {
      sources: p.media.sources.map((s) => s.platform),
      ok: p.media.progress.succeeded,
      failed: Object.keys(p.media.progress.failures),
    };
  }, id);
  assert.deepEqual(committed, {
    sources: ["xhs", "xhs"],
    ok: 1,
    failed: ["sample-workshop"],
  });
  await page.evaluate(() => {
    creatorFixture.hold = true;
  });
  await click("Sync works");
  await page.waitForFunction(() => creatorFixture.calls >= 3);
  await page.evaluate(async (id) => {
    await app.plugins.plugins[id].update((c) => {
      c.modules.creator = false;
    });
  }, id);
  await page
    .getByRole("heading", { name: "Today's tasks", exact: true })
    .waitFor();
  assert.equal(
    await page
      .locator(".dd-nav")
      .getByRole("button", { name: "Creator", exact: true })
      .count(),
    0,
  );
  assert.equal(await page.evaluate(() => creatorFixture.aborted), true);
  assert.equal(
    await page.evaluate(
      (id) => app.plugins.plugins[id].cfg.accounts.length,
      id,
    ),
    2,
  );
  accepted(
    "Two synthetic accounts on one platform, manual-only sync, isolated login failure, preserved bindings and abort on module disable",
  );
  await stop();
}
async function upgradeCase() {
  const host = await makeHost("Upgrade");
  await install(host, true);
  await put(
    join(host.vault, "Notebook.md"),
    "# My existing note\n- [ ] Draw a cover\n",
  );
  await boot(host, "0.9.0");
  await page.evaluate(
    async ({ id, accounts }) => {
      await app.plugins.plugins[id].prepareUpgrade({
        language: "en",
        nickname: "Rowan",
        cards: ["journal", "tasks"],
        order: ["journal", "tasks"],
        colors: { tasks: "#aabbcc" },
        sources: { inbox: "Notebook.md" },
        accounts,
      });
      await app.vault.create(
        "Day one.md",
        "# Prior entry\n\nAn early sketch.\n",
      );
    },
    { id, accounts: fixtureAccounts() },
  );
  const before = await noteAt("Notebook.md"),
    historic = await noteAt("Day one.md");
  const data = join(host.plugin, "data.json");
  assert.equal(JSON.parse(await readFile(data, "utf8")).version, 0);
  await stop();
  await install(host);
  assert.equal(JSON.parse(await readFile(data, "utf8")).version, 0);
  await boot(host);
  await page.evaluate(async (id) => {
    await app.plugins.plugins[id].openDashboard();
  }, id);
  const cfg = await page.evaluate((id) => app.plugins.plugins[id].cfg, id);
  assert.equal(cfg.version, 1);
  assert.equal(cfg.nickname, "Rowan");
  assert.deepEqual(cfg.visible, ["journal", "tasks"]);
  assert.deepEqual(cfg.order.slice(0, 2), ["journal", "tasks"]);
  assert.equal(cfg.colors.tasks, "#aabbcc");
  assert.deepEqual(cfg.accounts, fixtureAccounts());
  assert.equal(cfg.sources.inbox, "Notebook.md");
  assert.equal(cfg.modules.creator, false);
  assert.equal(JSON.parse(await readFile(data, "utf8")).version, 1);
  assert.deepEqual(
    [await noteAt("Notebook.md"), await noteAt("Day one.md")],
    [before, historic],
  );
  await page.locator('[data-card="tasks"]').waitFor();
  assert.deepEqual(
    await page
      .locator("[data-card]")
      .evaluateAll((els) => els.map((e) => e.dataset.card)),
    ["journal", "tasks"],
  );
  accepted(
    "Actual host replacement of synthetic 0.9.0 baseline by installed release; persisted v0 layout, bindings and original Markdown survive migration",
  );
  await stop();
}

async function storeCase() {
  const host = await makeHost("Community directory", false);
  await boot(host, null);
  const openSettings = () => page.evaluate(() => {
    app.setting.open();
    app.setting.openTabById("community-plugins");
  });
  await openSettings();
  const browse = (p) => p.getByRole("button", { name: /^(Browse|浏览)$/i }).first();
  const trust = (p) => p.getByRole("button", {
    name: /^(Exit Restricted mode|Trust author and enable plugins|Turn on community plugins|退出受限模式|信任仓库作者并启用插件|启用第三方插件|开启第三方插件|关闭安全模式)$/i,
  }).first();
  const choice = await visibleControl((p) => browse(p).or(trust(p)).first(), "community plugin settings");
  if (await trust(choice.page()).isVisible()) {
    await confirmTrust(trust(choice.page()));
    await openSettings();
  }
  await (await visibleControl(browse, "Browse")).click();
  const search = await visibleControl(
    (p) => p.locator(".mod-community-modal input:visible, .community-modal input:visible, .community-modal-search input:visible, .modal:has(.community-item) input:visible").first(),
    "the community search field",
  );
  const dialog = search.page().locator("body");
  await search.fill("Dataview");
  await dialog.getByText("Dataview", { exact: true }).first().waitFor({ timeout: 30000 });
  accepted("Native community search loaded a known listing in a new vault");

  await search.fill(manifest.name);
  const listing = dialog.getByText(manifest.name, { exact: true }).first();
  try {
    await listing.waitFor({ timeout: 15000 });
  } catch (error) {
    const message = "The native directory loaded, but did not return " + manifest.name + ".";
    console.error(message, (await dialog.innerText()).slice(0, 550));
    if (process.env.GITHUB_STEP_SUMMARY)
      await writeFile(process.env.GITHUB_STEP_SUMMARY, message + "\n", { flag: "a" });
    throw error;
  }
  await listing.click();
  await (await visibleControl((p) => p.getByRole("button", { name: /^(Install|安装)$/ }).last(), "Install")).click();
  await (await visibleControl((p) => p.getByRole("button", { name: /^(Enable|启用)$/ }).last(), "Enable", 40000)).click();
  await page.waitForFunction((id) => !!app.plugins.plugins[id], id);
  if (!search.page().isClosed()) await search.page().keyboard.press("Escape");
  if (!choice.page().isClosed()) await choice.page().keyboard.press("Escape");
  await page.evaluate((id) => app.commands.executeCommandById(id + ":open"), id);
  await page.locator(".dd-app [data-card=tasks]").waitFor();
  const installed = JSON.parse(await readFile(join(host.plugin, "manifest.json"), "utf8"));
  assert.equal(installed.id, id);
  assert.equal(installed.version, manifest.version);
  assert.deepEqual(await page.evaluate(() => app.vault.getMarkdownFiles().map((f) => f.path)), []);
  accepted("Installed " + installed.version + " from Browse, enabled it and opened the dashboard");
  // Obsidian writes the enabled list asynchronously. Reopen the actual vault
  // after the write to verify it can load the installed plugin again.
  await waitRaw(".obsidian/community-plugins.json", JSON.stringify(id));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    (id) => window.app?.workspace?.layoutReady && app.plugins.plugins[id]?.manifest.version,
    id,
    { timeout: 30000 },
  );
  assert.equal(await page.evaluate((id) => app.plugins.plugins[id].manifest.version, id), installed.version);
  accepted("Community installation remained enabled on reopening the vault");
  // Obsidian 1.15.1 can append this exact comment to a script it installs.
  const hostFooter = Buffer.from("\n/* nosourcemap */");
  for (const asset of binaryAssets) {
    const released = await readFile(join(dist, asset));
    const installedFile = await readFile(join(host.plugin, asset));
    if (installedFile.equals(released)) continue;
    if (asset === "main.js" && installedFile.equals(Buffer.concat([released, hostFooter]))) continue;
    await put(join(output, "installed", asset), installedFile);
    assert.fail("Community-installed file differs from the published release: " + asset);
  }
  accepted("Verified the contents of all three files received through the community directory");
  await stop();
}

const cases = {
  empty: emptyCase,
  library: libraryCase,
  creator: creatorCase,
  upgrade: upgradeCase,
  store: storeCase,
};
const which = process.argv.slice(2);
const selected = which.length ? which : ["empty", "library", "creator", "upgrade"];
for (const key of selected)
  if (!Object.hasOwn(cases, key)) throw new Error("Unknown test case " + key);
let succeeded = false;
try {
  for (const key of selected) {
    console.log("RUN " + key);
    await cases[key]();
  }
  succeeded = true;
} catch (error) {
  // All these windows belong to the disposable profile checked in boot().
  for (const [index, view] of (browser?.contexts().flatMap((c) => c.pages()) ?? []).entries()) {
    if (view.isClosed()) continue;
    console.error("Desktop UI:", await view.title(), (await view.locator("body").innerText().catch(() => "")).slice(-2000));
    console.error("Visible inputs:", await view.locator("input:visible").evaluateAll((els) =>
      els.map((el) => [el.type, el.placeholder, el.className, el.parentElement.className])).catch(() => []));
    await view.screenshot({ path: join(output, "failure-" + index + ".png"), timeout: 3000 }).catch(() => {});
  }
  throw error;
} finally {
  try {
    await stop();
  } finally {
    const report = {
      plugin: manifest.id,
      version: manifest.version,
      hostAgents: [...hostAgents],
      assetHashes,
      cases: selected,
      ok: succeeded,
      checks,
    };
    const name = which.length ? "report-" + selected.join("-") : "report";
    await put(
      join(output, name + ".json"),
      JSON.stringify(report, null, 2) + "\n",
    );
    if (succeeded) await rm(work, { force: true, recursive: true });
    else console.error("Failure artifacts retained at " + work);
  }
}
