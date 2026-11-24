import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright-core";

// Load the built plugin with an isolated Obsidian vault adapter in Chromium.
function host({code, original}) {
  const read = () => JSON.parse(localStorage.getItem("notes"));
  const write = notes => localStorage.setItem("notes", JSON.stringify(notes));
  if (!read()) write({"Checklist.md":original});
  if (!localStorage.getItem("plugin")) localStorage.setItem("plugin", JSON.stringify({
    language:"en",visible:["tasks","projects"],modules:{study:true},
  }));
  HTMLElement.prototype.addClass = function (...classes) { this.classList.add(...classes); };
  HTMLElement.prototype.setText = function (value) { this.textContent = value; };
  HTMLElement.prototype.empty = function () { this.replaceChildren(); };
  class TFile {
    constructor(path) { this.path = path; this.extension = "md"; }
  }
  class TFolder {}
  class FileSystemAdapter { getFullPath(path) { return path; } }
  const folders = new Map();
  const files = new Map();
  const listeners = new Map();
  const getFile = path => {
    if (Object.hasOwn(read(),path)) {
      if (!files.has(path)) files.set(path,new TFile(path));
      return files.get(path);
    }
    return folders.get(path) ?? null;
  };
  const emit = (event,file) => { for (const callback of listeners.get(event) ?? []) callback(file); };
  const vault = {
    adapter:new FileSystemAdapter(),
    getAbstractFileByPath:getFile,
    getMarkdownFiles:() => Object.keys(read()).map(getFile),
    getAllLoadedFiles:() => Object.keys(read()).map(getFile),
    async cachedRead(file) { return read()[file.path]; },
    async process(file,edit) {
      const notes = read();
      notes[file.path] = edit(notes[file.path]);
      write(notes);
      emit("modify",file);
      return notes[file.path];
    },
    async createFolder(path) { folders.set(path,new TFolder()); },
    async create(path,raw) {
      const notes = read();
      if (Object.hasOwn(notes,path)) throw Error("File exists");
      write({...notes,[path]:raw});
      emit("create",getFile(path));
      return getFile(path);
    },
    on(event,callback) {
      if (!listeners.has(event)) listeners.set(event,new Set());
      listeners.get(event).add(callback);
    },
  };
  let makeView;
  const app = {vault,workspace:{onLayoutReady(){}}};
  class Plugin {
    app = app;
    async loadData() { return JSON.parse(localStorage.getItem("plugin")); }
    async saveData(data) { localStorage.setItem("plugin",JSON.stringify(data)); }
    registerView(_id, create) { makeView = create; }
    addSettingTab() {} addRibbonIcon() {} addCommand() {} registerEvent() {}
  }
  class ItemView {
    app = app;
    contentEl = document.querySelector("main");
    registerEvent() {} registerInterval() {}
  }
  class Modal {
    constructor(app) { this.app = app; }
    open() {
      const node = this.modalEl = document.createElement("section");
      node.setAttribute("role","dialog");
      this.titleEl = node.appendChild(document.createElement("h2"));
      this.contentEl = node.appendChild(document.createElement("div"));
      document.body.append(node);
      this.onOpen();
    }
    close() { this.onClose(); this.modalEl.remove(); }
  }
  const sdk = { Plugin, ItemView, TFile, TFolder, FileSystemAdapter, Modal, PluginSettingTab:class {},
    FuzzySuggestModal:class extends Modal {
      setPlaceholder() {}
      onOpen() {
        for (const file of this.getItems()) {
          const b = this.contentEl.appendChild(document.createElement("button"));
          b.textContent = this.getItemText(file);
          b.onclick = () => { this.close(); this.onChooseItem(file); };
        }
      }
      onClose() {}
    }, Notice:class { constructor(message) { throw Error(message); } },
    setIcon(){},getLanguage:()=>"en" };
  const module = {exports:{}};
  new Function("require","module",code)(id => id === "obsidian" ? sdk : id === "node:fs/promises"
    ? {lstat:async () => ({isSymbolicLink:()=>false})} : {},module);
  const plugin = new module.exports.default();
  window.qa = {
    read:path=>read()[path], config:()=>JSON.parse(localStorage.getItem("plugin")),
    async change(path,edit) { return vault.process(getFile(path),edit); },
    async language(language) { await plugin.update(config => {config.language = language;}); },
  };
  return plugin.onload().then(() => makeView({}).onOpen());
}

const chromiumPath = process.env.DORA_CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const browser = await chromium.launch({headless:true,executablePath:chromiumPath});
try {
  const [code,styles] = await Promise.all(["main.js","styles.css"].map(file => readFile(new URL("../dist/"+file,import.meta.url),"utf8")));
  const original = "# Existing\r\n\r\n## First\r\n- [ ] Read notes ^first\r\n## Second\r\n- [x] Read notes <!-- original comment --> ^second\r\n## Milestones\r\n- [ ] Ready to ship\r\n";
  const page = await browser.newPage({viewport:{width:390,height:850}});
  page.setDefaultTimeout(6000);
  const errors = [];
  page.on("pageerror",error => errors.push(error.message));
  await page.route("http://localhost:12345/",route => route.fulfill({contentType:"text/html",body:`<!doctype html><style>${styles}
    html,body,main.dd-host{height:100%;margin:0}.dd-modal{position:fixed;inset:10% 5% auto;background:white;padding:12px;z-index:10}</style><main></main>`}));
  async function boot() {
    await page.goto("http://localhost:12345/");
    await page.evaluate(host,{code,original});
  }
  await boot();
  const modal = page.getByRole("dialog");
  const inline = page.locator(".dd-inline");
  const button = (label,parent=page) => parent.getByRole("button",{name:label,exact:true});
  const card = id => page.locator('[data-project="'+id+'"]');
  const read = path => page.evaluate(path=>window.qa.read(path),path);
  const config = () => page.evaluate(()=>window.qa.config());
  async function project(name,path="") {
    await button(path ? "Link checklist" : "New project").click();
    if (path) await button(path,modal).click();
    await modal.getByLabel("Project name").fill(name);
    await button("Create project",modal).click();
    await modal.waitFor({state:"hidden"});
    const project = (await config()).projects.find(p => p.name === name);
    const add = button("Add task",card(project.id));
    await add.waitFor();
    await page.waitForFunction(id => document.activeElement?.closest("[data-project]")?.dataset.project === id,project.id);
    return project;
  }
  const created = await project("New workshop");
  await page.keyboard.press("Enter");
  await inline.getByLabel("Title").fill("Set out the tools");
  await inline.getByLabel("Title").press("Enter");
  await button("Set out the tools",card(created.id)).waitFor();
  assert.match(await read(created.path),/- \[ \] Set out the tools \^dora-/);
  const linked = await project("Existing workshop","Checklist.md");
  assert.equal(await read(linked.path),original);
  const linkedCard = card(linked.id);
  await button("Edit project · Existing workshop",linkedCard).click();
  await modal.getByLabel("Project name").fill("Learning workshop");
  await modal.getByLabel("Type",{exact:true}).selectOption("learning");
  await button("Save",modal).click();
  await button("Learning workshop",linkedCard).waitFor();
  assert.deepEqual((await config()).projects.find(p=>p.id===linked.id),{...linked,name:"Learning workshop",learning:true});
  const first = linkedCard.locator(".dd-task-row").filter({has:button("Read notes")}).first();
  await button("Plan for today",first).click();
  const today = page.locator('[data-card="tasks"]');
  await button("Read notes",today).waitFor();
  await button("Toggle task · Read notes",first).click();
  await button("Edit task · Read notes",today).click();
  await inline.getByLabel("Task title").fill("Read another page");
  await inline.getByLabel("Task title").press("Enter");
  const completed = button("Toggle task · Read another page",today);
  await completed.waitFor();
  assert.equal(await completed.getAttribute("aria-pressed"),"true");
  assert.match(await read(linked.path),/- \[x\] Read another page <!-- dora-day:\d{4}-\d{2}-\d{2} --> \^first/);
  assert.ok((await read(linked.path)).endsWith("## Second\r\n- [x] Read notes <!-- original comment --> ^second\r\n## Milestones\r\n- [ ] Ready to ship\r\n"));
  await boot();
  await button("Learning workshop",linkedCard).waitFor();
  assert.equal(await completed.getAttribute("aria-pressed"),"true");
  await button("Edit task · Read another page",linkedCard).click();
  await inline.getByLabel("Task title").fill("Unsaved draft");
  await page.evaluate(path=>window.qa.change(path,raw=>raw.replace("Read another page","External title")),linked.path);
  await button("Save",inline).click();
  await inline.getByRole("alert").filter({hasText:/Task changed/}).waitFor();
  assert.equal(await inline.getByLabel("Task title").inputValue(),"Unsaved draft");
  await inline.getByLabel("Task title").press("Escape");
  await page.evaluate(()=>window.qa.language("zh"));
  await button("新建项目").waitFor();
  await button("编辑待办 · External title",linkedCard).waitFor();
  await page.evaluate(() => window.qa.language("en"));
  await button("New project").waitFor();
  const backlog = today.locator("details");
  await backlog.locator("summary").click();
  const activeSummary = backlog.locator("summary");
  await activeSummary.focus();
  const old = await activeSummary.elementHandle();
  await page.evaluate(path => window.qa.change(path, raw => raw + "\r\nOutside the list.\r\n"), linked.path);
  await page.waitForFunction(node => !node.isConnected, old);
  assert.equal(await backlog.evaluate(node => node.open), true);
  assert.equal(await activeSummary.evaluate(node => node === document.activeElement), true);

  // A repeated click during the same pending save produces one local action.
  const todayTask = today.locator(".dd-task-surface .dd-task-row").filter({has:button("External title")});
  const toggle = button("Toggle task · External title",todayTask);
  await toggle.evaluate(b => { b.click(); b.click(); });
  await page.waitForFunction(() => document.querySelector('[data-card=tasks] [aria-label="Toggle task · External title"]')?.getAttribute("aria-pressed") === "false");
  await button("Remove from today",todayTask).click();
  await todayTask.waitFor({state:"hidden"});
  await button("Undo").click();
  await todayTask.waitFor();
  assert.equal(await button("Remove from today",todayTask).count(),1);
  await button("Edit task · External title",todayTask).click();
  await inline.getByLabel("Task title").fill("Changed in place");
  await inline.getByLabel("Task title").press("Enter");
  await button("Changed in place",today).waitFor();
  await page.evaluate(path=>window.qa.change(path,raw=>raw.replace("Changed in place","Edited in the note")),linked.path);
  await button("Undo").click();
  await page.getByRole("status").filter({hasText:/Task changed/}).waitFor();
  assert.ok((await read(linked.path)).includes("Edited in the note"));
  assert.deepEqual(errors,[]);
  console.log("PASS community project creation, linking, editing, Today and completion state, conflict handling, reopen, Chinese UI at 390px");
} finally {
  await browser.close();
}
