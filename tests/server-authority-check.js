/* Browser integration for login gating and server-owned game state. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { JSDOM } = require("jsdom");

const root = path.resolve(process.env.GACHA_TEST_ROOT || path.join(__dirname, ".."));
const ep = {
  auth: "/api/user/auth/refresh", profile: "/api/user/gacha/profile", action: "/api/user/gacha/action",
  start: "/api/user/gacha/run/start", finish: "/api/user/gacha/run/finish",
  warehouse: "/api/user/gacha/warehouse", activate: "/api/user/gacha/card/activate",
};
const copy = value => JSON.parse(JSON.stringify(value));
const reply = (data, status = 200) => ({ status, ok: status >= 200 && status < 300, json: async () => data });
const ok = data => reply({ success: true, data });
const fail = (status, code) => reply({ success: false, code, message: code }, status);
function deferred() {
  let resolve;
  const promise = new Promise(res => { resolve = res; });
  return { promise, resolve };
}
async function until(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "Expected asynchronous state was not reached");
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}
function initialState() {
  const d = new Date();
  return {
    stamina: 120, staminaMax: 120, staminaTs: Date.now(), token: 0, gold: 600,
    multi: 1, multiOn: false, daily: { date: `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`, tokenGained: 0 },
    pity: 0, totalPull: 0, girls: Object.fromEntries(["c08", "c06", "c01", "c12"].map(id => [id, { star: 1, level: 1, exp: 0, shards: 0 }])),
    squad: ["c08", "c06", "c01", "c12"], cleared: {}, stars: {}, history: [], mats: { mat_r: 0, mat_sr: 0, mat_ssr: 0 },
  };
}

function harness(t, { signedIn = true, responder, url = "https://example.test/gacha/", clock } = {}) {
  const dom = new JSDOM(fs.readFileSync(path.join(root, "index.html"), "utf8"), {
    runScripts: "outside-only", url, pretendToBeVisual: true,
  });
  const w = dom.window;
  if (clock) {
    w.Date.now = () => clock.wall;
    Object.defineProperty(w.performance, "now", { value: () => clock.mono, configurable: true });
  }
  const calls = [], reads = [], writes = [], errors = [];
  const storage = w.Storage.prototype;
  const get = storage.getItem, set = storage.setItem;
  set.call(w.localStorage, "h5gacha_save_v1", JSON.stringify({ gold: 999999999, mats: { mat_r: 999999999 }, cleared: { s6: true } }));
  set.call(w.localStorage, "h5gacha_bind_v2", JSON.stringify({ token: "never-send-old-manual-token" }));
  storage.getItem = function(key) { reads.push(key); return get.call(this, key); };
  storage.setItem = function(key, value) { writes.push({ key, value }); return set.call(this, key, value); };
  Object.defineProperty(w.crypto, "randomUUID", { value: randomUUID, configurable: true });
  const database = { state: initialState(), revision: 1, userID: 7, run: null };
  const profile = () => ({ user_id: database.userID, name: "account-" + database.userID, quota: 700000,
    save: copy(database.state), revision: database.revision, active_run: database.run });
  const defaultRespond = call => {
    if (call.path === ep.auth) return signedIn ? ok({
      access_token: "memory-site-token", token_type: "Bearer", access_expires_at: Math.floor((clock ? clock.server : Date.now()) / 1000) + 300,
      user: { id: database.userID }, session: { sid: "session-" + database.userID, current: true },
    }) : fail(401, "AUTH");
    if (call.path === ep.profile) return ok(profile());
    if (call.path === ep.action) {
      const b = call.body;
      if (b.action === "gacha") {
        const cost = b.count === 10 ? 1400 : 150;
        if (database.state.gold < cost) return fail(409, "GACHA_RESOURCES_REQUIRED");
        database.state.gold -= cost; database.state.totalPull += b.count;
      }
      if (b.action === "level") database.state.girls[b.girl_id].level++;
      if (b.action === "squad") database.state.squad = b.squad;
      if (b.action === "multi") database.state.multiOn = b.enabled;
      database.revision++;
      return ok({ save: copy(database.state), revision: database.revision, results: [{ girl_id: "c01", is_new: false, dup: true, shards: 8 }] });
    }
    if (call.path === ep.start) {
      database.state.stamina -= 10; database.revision++;
      const now = clock ? clock.server : Date.now();
      database.run = { id: "run-a", stage: call.body.stage, ready_at: now + 30000, expire_at: now + 900000,
        save: copy(database.state), revision: database.revision,
        result: { allies: [{ uid: "a0", side: "ally", girlId: "c08", name: "tank", img: "assets/c08-xiaohua.webp", hp: 500, maxHp: 500, atk: 100, def: 80, spd: 90, rage: 0, alive: true }],
          waves: [[{ uid: "e0", side: "enemy", name: "wolf", img: "assets/gen/enemy-wolf.webp", hp: 100, maxHp: 100, atk: 30, def: 20, spd: 100, rage: 0, alive: true }]],
          events: [], win: true, stars: 1, rounds: 8, alive_n: 1, total_n: 1, duration_ms: 30000 },
      };
      return ok(copy(database.run));
    }
    if (call.path === ep.finish) {
      database.revision++; database.run = null;
      return ok({ save: copy(database.state), revision: database.revision, win: call.body.abandon !== true,
        stars: call.body.abandon === true ? 0 : 1, rounds: 8, alive_n: 1, total_n: 1, drops: [], quota: 0 });
    }
    if (call.path === ep.warehouse) return ok({ cards: [], active: null });
    if (call.path === ep.activate) return ok({ id: call.body.card_id, name: "card" });
    throw new Error("Unexpected request " + call.path);
  };
  let respond = responder;
  w.fetch = (url, options) => {
    assert.equal(new URL(url).origin, w.location.origin, "Credentials must remain on the current site");
    assert.equal(options.credentials, "same-origin");
    assert.equal(options.cache, "no-store");
    const call = { path: new URL(url).pathname, url: String(url), options,
      headers: { ...options.headers }, body: options.body ? JSON.parse(options.body) : undefined };
    calls.push(call);
    return Promise.resolve().then(() => respond ? respond(call, defaultRespond, database) : defaultRespond(call)).then(response => {
      if (clock) response.headers = { get: key => key.toLowerCase() === "date" ? new Date(clock.server).toUTCString() : null };
      return response;
    });
  };
  w.addEventListener("error", event => errors.push(event.message));
  const files = ["config.js", "store.js", "data.js", "ui.js", "progression.js", "battle.js", "main.js"];
  w.eval(files.map(file => fs.readFileSync(path.join(root, "js", file), "utf8")).join("\n;\n") + `
    window.__authority = { Store, SITE, nav, doGacha, levelUp, starUp, toggleSquad, unslot, toggleMulti,
      openGirl, pickChapter, pickStage, openWarehouse, startBattle, resumeBattle, exitBattle, recoverBattle,
      showModal, closeModal, activateCard, retryGameAction, onSiteSessionEvent, battleEnd, syncSiteAccount,
      renderSquad, updateRosterFilter, resetRosterFilters, focusRosterReserve,
      get save(){return SAVE;}, setSave(s){SAVE=s;}, get battle(){return BAT;},
      get running(){return battleRunning;},
      setSleep(fn){sleep=fn;}, setStrike(fn){playStrike=fn;},
      battleControl(...args){return battleControl(...args);},
      stopPlayback(){playServerBattle=async()=>{};} };
  `);
  t.after(() => w.close());
  return { game: w.__authority, w, d: w.document, database, calls, reads, writes, errors, profile,
    count: endpoint => calls.filter(call => call.path === endpoint).length,
    respond(fn) { respond = fn; }, defaultRespond };
}

function assertLocked(h) {
  assert.equal(h.game.save, null);
  assert.equal(h.game.Store.ready(), false);
  assert.ok(h.d.getElementById("app").classList.contains("hidden"));
  assert.ok(!h.d.getElementById("title-screen").classList.contains("hidden"));
}
function assertPrivateStorage(h) {
  assert.deepEqual(h.reads, [], "Game must never load a browser save or binding credential");
  assert.deepEqual(h.writes, [], "Game assets and credentials must never be saved to browser storage");
  assert.ok(!JSON.stringify(h.calls).includes("never-send-old-manual-token"));
}
function assertIntentOnly(call, keys) {
  assert.deepEqual(Object.keys(call.body).sort(), [...keys].sort());
  assert.equal(call.options.credentials, "same-origin");
  assert.equal(call.options.cache, "no-store");
  assert.equal(call.headers.Authorization, "Bearer memory-site-token");
  if (call.body.request_id) assert.match(call.body.request_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
}

test("game home retains upstream attribution without linking a maintainer server", async t => {
  const h = harness(t);
  await until(() => h.count(ep.profile) > 0 && !h.game.Store.connecting);
  const notice = h.d.querySelector("#page-home .source-notice");
  const link = notice.querySelector("a");
  assert.equal(link.href, "https://github.com/QuantumNous/new-api");
  assert.equal(link.target, "_blank");
  assert.equal(link.rel, "noopener noreferrer");
  assert.ok(notice.textContent.includes("Frontend design and development by New API contributors."));
});

test("dialogs have an accessible title, contain keyboard focus and restore their opener", async t => {
  const h = harness(t); await until(() => h.game.Store.ready());
  const opener = h.d.querySelector('[data-nav="page-stage"]');
  opener.focus();
  h.game.showModal('<h3>测试弹窗</h3><button disabled>不可用</button><button hidden>隐藏</button><input id="dialog-input"><button id="dialog-last">完成</button>');
  const box = h.d.getElementById("modal-box"), close = box.querySelector(".mb-close");
  assert.equal(box.getAttribute("role"), "dialog");
  assert.equal(box.getAttribute("aria-modal"), "true");
  assert.equal(h.d.getElementById(box.getAttribute("aria-labelledby")).textContent, "测试弹窗");
  assert.equal(h.d.activeElement, close);
  for (const id of ["pages", "topbar", "navbar"]) assert.ok(h.d.getElementById(id).hasAttribute("inert"));
  const key = (value, shiftKey = false) => h.d.activeElement.dispatchEvent(new h.w.KeyboardEvent("keydown", { key: value, shiftKey, bubbles: true, cancelable: true }));
  key("Tab", true);
  assert.equal(h.d.activeElement.id, "dialog-last", "Shift+Tab wraps to the last usable control");
  key("Tab");
  assert.equal(h.d.activeElement, close, "Tab wraps to the first usable control");
  key("Escape");
  assert.ok(h.d.getElementById("modal-mask").classList.contains("hidden"));
  assert.equal(h.d.activeElement, opener);
  for (const id of ["pages", "topbar", "navbar"]) assert.ok(!h.d.getElementById(id).hasAttribute("inert"));
});

test("replacing dialog content preserves its opener and removes a stale title reference", async t => {
  const h = harness(t); await until(() => h.game.Store.ready());
  const opener = h.d.querySelector('[data-nav="page-stage"]');
  opener.focus();
  h.game.showModal('<h3>加载中</h3><button>取消</button>');
  h.game.showModal('<p>加载完成</p><button>关闭</button>');
  const box = h.d.getElementById("modal-box");
  assert.equal(box.hasAttribute("aria-labelledby"), false);
  assert.equal(box.getAttribute("aria-label"), "游戏弹窗");
  h.game.closeModal();
  assert.equal(h.d.activeElement, opener);
});

test("Escape cannot dismiss an unconfirmed battle settlement", async t => {
  const h = harness(t); await until(() => h.game.Store.ready());
  h.game.stopPlayback();
  await h.game.resumeBattle(await h.game.Store.startRun("s1"), true);
  h.game.battle.playbackComplete = true;
  h.game.showModal('<h3>结算待确认</h3><button>重试</button>');
  h.d.activeElement.dispatchEvent(new h.w.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  assert.ok(!h.d.getElementById("modal-mask").classList.contains("hidden"));
  assert.ok(h.d.getElementById("pages").hasAttribute("inert"));
});

test("sign-out closes dialogs and releases the background focus lock", async t => {
  const h = harness(t); await until(() => h.game.Store.ready());
  h.game.showModal('<h3>角色详情</h3><button>关闭</button>');
  h.game.Store.clearSession();
  assertLocked(h);
  assert.ok(h.d.getElementById("modal-mask").classList.contains("hidden"));
  for (const id of ["pages", "topbar", "navbar"]) assert.ok(!h.d.getElementById(id).hasAttribute("inert"));
});

test("late warehouse replies cannot reopen or replace a dismissed dialog", async t => {
  for (const action of ["close", "replace", "newer request", "failed request"]) await t.test(action, async t => {
    const pending = deferred();
    const h = harness(t); await until(() => h.game.Store.ready());
    h.respond((call, next) => call.path === ep.warehouse ? pending.promise : next(call));
    const loading = h.game.openWarehouse();
    await until(() => h.count(ep.warehouse) === 1);
    if (action === "replace") h.game.openGirl("c08");
    else if (action === "newer request") {
      h.respond((call, next) => call.path === ep.warehouse ? ok({ cards: [], active: { name: "较新的仓库", discount: 10 } }) : next(call));
      await h.game.openWarehouse();
    } else h.game.closeModal();
    const content = h.d.getElementById("modal-box").innerHTML;
    pending.resolve(action === "failed request" ? fail(503, "WAREHOUSE_UNAVAILABLE") : ok({ cards: [], active: null }));
    await loading;
    assert.equal(h.d.getElementById("modal-box").innerHTML, content);
    assert.equal(h.d.getElementById("modal-mask").classList.contains("hidden"), ["close", "failed request"].includes(action));
  });
});

test("warehouse text and activation IDs stay inert even when they contain markup", async t => {
  const name = '<img src=x onerror="bad()">';
  const cardId = "card' onclick='bad()";
  const h = harness(t); await until(() => h.game.Store.ready());
  h.respond((call, next) => call.path === ep.warehouse ? ok({
    active: { name, discount: '<svg onload="bad()">', expire_at: Date.now() + 60000 },
    cards: [{ id: cardId, name, discount: 10, duration_min: 30, status: "stored" },
      { name, discount: 5, status: "expired" }],
  }) : next(call));
  await h.game.openWarehouse();
  const box = h.d.getElementById("modal-box");
  assert.equal(box.querySelector("img, svg"), null);
  assert.ok(box.textContent.includes(name));
  const activate = box.querySelector("[data-card-id]");
  assert.equal(activate.dataset.cardId, cardId);
  assert.equal(activate.hasAttribute("onclick"), false);
  activate.disabled = false;
  activate.click();
  await until(() => h.count(ep.activate) === 1);
  assert.deepEqual(h.calls.find(call => call.path === ep.activate).body, { card_id: cardId });
});

test("activation refreshes account data without reopening a closed warehouse", async t => {
  const pending = deferred();
  const h = harness(t); await until(() => h.game.Store.ready());
  await h.game.openWarehouse();
  h.respond((call, next) => call.path === ep.activate ? pending.promise : next(call));
  const activation = h.game.activateCard("stored-card");
  await until(() => h.count(ep.activate) === 1);
  h.game.closeModal();
  pending.resolve(ok({ id: "stored-card", name: "已激活卡片" }));
  await activation;
  assert.equal(h.count(ep.profile), 2, "The account still refreshes after activation");
  assert.equal(h.count(ep.warehouse), 1, "A dismissed warehouse is not requested again");
  assert.ok(h.d.getElementById("modal-mask").classList.contains("hidden"));
});

test("roster search and combined filters use display data without game requests or storage", async t => {
  const h = harness(t); await until(() => h.game.Store.ready());
  h.game.nav("page-squad");
  const requests = h.calls.length;
  const ids = () => [...h.d.querySelectorAll("#owned-list .card")].map(card => card.dataset.id);
  assert.equal(ids().length, 28);
  h.game.updateRosterFilter("query", "  小椛   r  ");
  assert.deepEqual(ids(), ["c08"]);
  h.game.updateRosterFilter("elem", "water");
  assert.deepEqual(ids(), []);
  assert.ok(h.d.querySelector(".roster-empty button"), "Empty filters provide a way back to the complete roster");
  h.game.resetRosterFilters();
  h.game.updateRosterFilter("status", "owned");
  assert.equal(ids().length, 4);
  h.game.updateRosterFilter("role", "tank");
  assert.deepEqual(ids(), ["c08"]);
  h.game.resetRosterFilters();
  h.game.updateRosterFilter("query", "治疗");
  assert.ok(ids().length > 0);
  h.game.updateRosterFilter("status", "locked");
  assert.ok([...h.d.querySelectorAll("#owned-list .card")].every(card => card.classList.contains("card-locked")));
  assert.equal(h.calls.length, requests);
  assertPrivateStorage(h);
});

test("roster sorting respects explicit levels and stars while default keeps the squad first", async t => {
  const h = harness(t); await until(() => h.game.Store.ready());
  h.database.state.girls.c04 = { star: 3, level: 60, exp: 0, shards: 0 };
  h.database.state.girls.c06.star = 4;
  h.database.revision++;
  await h.game.Store.refresh();
  h.game.nav("page-squad");
  const first = () => h.d.querySelector("#owned-list .card").dataset.id;
  assert.equal(first(), "c08");
  h.game.updateRosterFilter("sort", "level");
  assert.equal(first(), "c04");
  h.game.updateRosterFilter("sort", "star");
  assert.equal(first(), "c06");
  h.game.updateRosterFilter("sort", "rarity");
  const sorted = [...h.d.querySelectorAll("#owned-list .card")].map(card => card.dataset.id);
  assert.ok(sorted.indexOf("c28") < sorted.indexOf("c08"), "Explicit rarity sorting includes unowned SSR characters before R characters");
  h.game.updateRosterFilter("rarity", "SSR");
  assert.equal(first(), "c04");
});

test("roster search keeps text input focus and treats markup as plain text", async t => {
  const h = harness(t); await until(() => h.game.Store.ready());
  h.game.nav("page-squad");
  const input = h.d.getElementById("roster-search");
  input.focus();
  input.value = "<img src=x onerror=bad()>";
  input.dispatchEvent(new h.w.Event("input", { bubbles: true }));
  assert.equal(h.d.getElementById("roster-search"), input, "Typing must not rebuild the form");
  assert.equal(h.d.activeElement, input);
  assert.equal(h.d.querySelector(".roster-empty img"), null);
  assert.equal(h.d.querySelectorAll("#owned-list .card").length, 0);
  h.d.querySelector(".roster-empty button").click();
  assert.equal(input.value, "");
  assert.equal(h.d.querySelectorAll("#owned-list .card").length, 28);
});

test("roster cards and slots expose separate keyboard buttons and explain a full squad", async t => {
  const h = harness(t); await until(() => h.game.Store.ready());
  h.database.state.girls.c04 = { star: 3, level: 1, exp: 0, shards: 0 };
  h.database.revision++;
  await h.game.Store.refresh();
  h.game.nav("page-squad");
  assert.equal(h.d.querySelectorAll("#squad-slots button").length, 4);
  assert.equal(h.d.querySelectorAll("#owned-list .roster-detail").length, 28);
  assert.equal(h.d.querySelector("#owned-list button button"), null);
  const reserve = h.d.querySelector('[data-id="c04"] .quick-toggle');
  assert.equal(reserve.disabled, true);
  assert.match(reserve.getAttribute("aria-label"), /队伍已满/);
  assert.equal(h.d.querySelector('[data-id="c14"] .quick-toggle'), null);
  h.d.querySelector('[data-id="c08"] .roster-detail').focus();
  h.d.activeElement.click();
  assert.ok(h.d.getElementById("modal-box").textContent.includes("小椛"));
  h.game.closeModal();
  assert.equal(h.d.activeElement.getAttribute("aria-label"), "查看小椛详情");
});

test("squad changes show pending feedback, keep filters and wait for the server", async t => {
  const pending = deferred();
  const h = harness(t); await until(() => h.game.Store.ready());
  h.game.nav("page-squad");
  h.game.updateRosterFilter("query", "小椛");
  h.respond((call, next) => call.path === ep.action ? pending.promise : next(call));
  const saving = h.game.toggleSquad("c08");
  await until(() => h.count(ep.action) === 1);
  assert.equal(h.game.save.squad.length, 4);
  assert.equal(h.d.querySelector('[data-id="c08"] .quick-toggle').disabled, true);
  assert.equal(h.d.getElementById("squad-slots").getAttribute("aria-busy"), "true");
  assert.match(h.d.getElementById("squad-status").textContent, /保存/);
  await h.game.unslot(1);
  assert.equal(h.count(ep.action), 1);
  const call = h.calls.find(call => call.path === ep.action);
  assertIntentOnly(call, ["action", "squad", "request_id"]);
  pending.resolve(h.defaultRespond(call));
  await saving;
  assert.equal(h.game.save.squad.length, 3);
  assert.equal(h.d.querySelector('[data-id="c08"] .quick-toggle').disabled, false);
  assert.equal(h.d.getElementById("roster-search").value, "小椛");
  assert.equal(h.d.querySelectorAll("#owned-list .card").length, 1);
  assert.match(h.d.getElementById("squad-status").textContent, /已.*移出/);
});

test("a filtered-out squad card returns focus to search and a rejected save keeps the squad", async t => {
  const h = harness(t); await until(() => h.game.Store.ready());
  h.game.nav("page-squad");
  h.game.updateRosterFilter("status", "squad");
  h.d.querySelector('[data-id="c08"] .quick-toggle').focus();
  await h.game.toggleSquad("c08");
  assert.equal(h.d.querySelector('[data-id="c08"]'), null);
  assert.equal(h.d.activeElement, h.d.getElementById("roster-search"));
  h.respond((call, next) => call.path === ep.action ? fail(409, "GACHA_RESOURCES_REQUIRED") : next(call));
  await h.game.unslot(0);
  assert.equal(h.game.save.squad.length, 3);
  assert.equal(h.d.querySelectorAll("#squad-slots .filled").length, 3);
  assert.equal(h.game.Store.pendingAction, null);
  assert.equal(h.d.querySelector('[data-id="c06"] .quick-toggle').disabled, false);
  assert.match(h.d.getElementById("squad-status").textContent, /保存失败/);
});

test("uncertain squad replies retain the original intent without changing the visible squad", async t => {
  const h = harness(t); await until(() => h.game.Store.ready());
  h.game.nav("page-squad");
  let attempts = 0;
  h.respond((call, next) => call.path === ep.action && ++attempts === 1 ? fail(503, "UNCONFIRMED") : next(call));
  await h.game.unslot(0);
  assert.equal(h.game.save.squad.length, 4);
  assert.equal(h.d.querySelectorAll("#squad-slots .filled").length, 4);
  assert.match(h.d.getElementById("squad-status").textContent, /尚未确认/);
  const requestId = h.calls.find(call => call.path === ep.action).body.request_id;
  await h.game.retryGameAction();
  assert.equal(h.game.save.squad.length, 3);
  assert.equal(h.calls.filter(call => call.path === ep.action).at(-1).body.request_id, requestId);
  assert.equal(h.d.getElementById("squad-status").textContent, "");
});

test("an empty squad slot opens the available roster and a full squad sends no fifth member", async t => {
  const h = harness(t); await until(() => h.game.Store.ready());
  h.database.state.girls.c04 = { star: 3, level: 1, exp: 0, shards: 0 };
  h.database.revision++;
  await h.game.Store.refresh();
  h.game.nav("page-squad");
  await h.game.toggleSquad("c04");
  assert.equal(h.count(ep.action), 0);
  await h.game.unslot(0);
  h.d.querySelector("#squad-slots .empty").click();
  assert.equal(h.d.getElementById("roster-status").value, "reserve");
  assert.equal(h.d.activeElement, h.d.getElementById("roster-search"));
  assert.equal(h.d.querySelectorAll("#owned-list .card").length, 2);
});

test("roster preferences survive same-account navigation and clear on sign-out", async t => {
  const h = harness(t); await until(() => h.game.Store.ready());
  h.game.nav("page-squad");
  h.game.updateRosterFilter("query", "小椛");
  h.game.updateRosterFilter("status", "owned");
  h.game.nav("page-home");
  h.game.nav("page-squad");
  assert.equal(h.d.getElementById("roster-search").value, "小椛");
  h.game.Store.clearSession();
  assert.equal(h.d.getElementById("roster-search").value, "");
  assert.equal(h.d.querySelectorAll("#owned-list .card").length, 0);
  h.database.userID = 8;
  await h.game.syncSiteAccount();
  h.game.nav("page-squad");
  assert.equal(h.d.getElementById("roster-status").value, "all");
  assert.equal(h.d.querySelectorAll("#owned-list .card").length, 28);
  assertPrivateStorage(h);
});

test("anonymous boot and deep links cannot render or use any game entry", async t => {
  for (const hash of ["", "#gacha", "#squad", "#stage", "#modes", "#growth", "#bag", "#battle"]) await t.test(hash || "home", async t => {
    const h = harness(t, { signedIn: false, url: "https://example.test/gacha/" + hash });
    await until(() => !h.game.Store.connecting);
    assertLocked(h);
    for (const page of ["home", "gacha", "squad", "stage", "modes", "growth", "bag", "battle"]) h.game.nav("page-" + page);
    for (const [fn, args] of [
      ["doGacha", [1]], ["startBattle", ["s1"]], ["levelUp", ["c08"]], ["starUp", ["c08"]],
      ["toggleSquad", ["c08"]], ["unslot", [0]], ["toggleMulti", []], ["openGirl", ["c08"]],
      ["pickChapter", [0]], ["pickStage", ["s1"]], ["openWarehouse", []],
    ]) await assert.doesNotReject(async () => h.game[fn](...args), "Anonymous entry " + fn + " must fail closed");
    assert.equal(h.d.body.dataset.page, undefined);
    assert.equal(h.d.getElementById("home-info").innerHTML, "");
    assert.equal(h.d.getElementById("gacha-pity").innerHTML, "");
    assert.equal(h.d.getElementById("modal-box").innerHTML, "");
    assert.ok(h.calls.every(call => call.path === ep.auth));
    assertPrivateStorage(h);
    assert.deepEqual(h.errors, []);
  });
});

test("pending login keeps game locked and does not hydrate the malicious local save", async t => {
  const auth = deferred();
  const h = harness(t, { responder: (call, defaultRespond) => call.path === ep.auth ? auth.promise : defaultRespond(call) });
  await until(() => h.count(ep.auth) === 1);
  assertLocked(h);
  h.game.nav("page-gacha");
  await h.game.doGacha(1); await h.game.startBattle("s1");
  assert.equal(h.count(ep.action), 0); assert.equal(h.count(ep.start), 0);
  assertPrivateStorage(h);
  auth.resolve(h.defaultRespond(h.calls[0]));
  await until(() => h.game.Store.ready());
  assert.equal(h.game.save.gold, 600);
  assert.ok(!h.d.getElementById("app").classList.contains("hidden"));
  assert.ok(h.d.getElementById("title-screen").classList.contains("hidden"));
});

test("a forged display snapshot cannot unlock an anonymous session", async t => {
  const h = harness(t, { signedIn: false });
  await until(() => !h.game.Store.connecting);
  h.game.setSave(initialState());
  assert.equal(h.game.Store.ready(), false);
  h.game.nav("page-gacha"); await h.game.doGacha(1); await h.game.startBattle("s1");
  assert.equal(h.count(ep.action), 0); assert.equal(h.count(ep.start), 0);
  assert.ok(h.d.getElementById("app").classList.contains("hidden"));
});

test("tampered display assets are neither uploaded nor credited by a summon", async t => {
  const h = harness(t); await until(() => h.game.Store.ready());
  Object.assign(h.game.save, { gold: 999999999, squad: ["c04"], stars: { s6: 3 }, cleared: { s3: true } });
  h.game.save.mats.mat_r = 999999999;
  await h.game.doGacha(1);
  const call = h.calls.find(call => call.path === ep.action);
  assertIntentOnly(call, ["action", "count", "request_id"]);
  assert.equal(call.body.action, "gacha");
  assert.equal(h.game.save.gold, 450);
  assert.equal(h.game.save.mats.mat_r, 0);
  assert.deepEqual(copy(h.game.save.squad), ["c08", "c06", "c01", "c12"]);
  assert.deepEqual(copy(h.game.save.stars), {});
  assert.deepEqual(copy(h.game.save.cleared), {});
  assertPrivateStorage(h);
});

test("all economic UI actions send only explicit intent fields", async t => {
  const h = harness(t); await until(() => h.game.Store.ready());
  for (const [fn, args, action, fields] of [
    ["starUp", ["c08"], "star", ["girl_id"]],
    ["unslot", [0], "squad", ["squad"]], ["toggleMulti", [], "multi", ["enabled"]],
  ]) {
    h.game.save.gold = 999999999; h.game.save.mats.mat_r = 999999999;
    await h.game[fn](...args);
    const call = h.calls.filter(call => call.path === ep.action).at(-1);
    assert.equal(call.body.action, action);
    assertIntentOnly(call, ["action", "request_id", ...fields]);
    assert.equal(h.game.save.gold, h.database.state.gold);
    assert.equal(h.game.save.mats.mat_r, h.database.state.mats.mat_r);
  }
  assertPrivateStorage(h);
});

test("insufficient server balance cannot be bypassed by editing SAVE.gold", async t => {
  const h = harness(t); await until(() => h.game.Store.ready());
  h.database.state.gold = 0;
  h.game.save.gold = 999999999;
  assert.equal(await h.game.Store.mutate("gacha", { count: 1 }), null);
  assert.equal(h.database.state.gold, 0);
  assert.equal(h.database.state.totalPull, 0);
  assert.equal(h.count(ep.action), 1);
  await h.game.Store.refresh();
  assert.equal(h.game.save.gold, 0);
});

test("uncertain mutations retain one UUID and block competing actions until retried", async t => {
  const h = harness(t); await until(() => h.game.Store.ready());
  let attempts = 0;
  h.respond((call, defaultRespond) => call.path === ep.action && ++attempts === 1 ? fail(500, "SERVER_UNAVAILABLE") : defaultRespond(call));
  assert.equal(await h.game.Store.mutate("gacha", { count: 1 }), null);
  const first = h.calls.find(call => call.path === ep.action).body.request_id;
  assert.equal(await h.game.Store.mutate("level", { girl_id: "c08" }), null);
  assert.equal(h.count(ep.action), 1);
  assert.ok(await h.game.Store.mutate("gacha", { count: 1 }));
  assert.equal(h.calls.filter(call => call.path === ep.action).at(-1).body.request_id, first);
  assert.equal(h.database.state.totalPull, 1);
});

test("explicit retry of an uncertain toggle preserves the original value and UUID", async t => {
  const h = harness(t); await until(() => h.game.Store.ready());
  let attempts = 0;
  h.respond((call, defaultRespond, db) => {
    if (call.path === ep.action && ++attempts === 1) {
      db.state.multiOn = true; db.revision++;
      throw new TypeError("RESPONSE_LOST_AFTER_COMMIT");
    }
    return defaultRespond(call);
  });
  await h.game.toggleMulti();
  const first = h.calls.find(call => call.path === ep.action).body;
  assert.equal(first.enabled, true);
  assert.equal(h.game.save.multiOn, false);
  await h.game.Store.refresh();
  assert.equal(h.game.save.multiOn, true);
  await h.game.toggleMulti();
  assert.equal(h.count(ep.action), 1, "A newly inverted toggle must not replace the uncertain original operation");
  assert.ok(h.d.querySelector('[onclick="retryGameAction()"]'));
  await h.game.retryGameAction();
  const retried = h.calls.filter(call => call.path === ep.action).at(-1).body;
  assert.deepEqual(retried, first);
  assert.equal(h.game.save.multiOn, true);
  assert.equal(h.game.Store.pendingAction, null);
});

test("concurrent UI mutations produce a single request and no optimistic asset change", async t => {
  const pending = deferred();
  const h = harness(t); await until(() => h.game.Store.ready());
  h.respond((call, defaultRespond) => call.path === ep.action ? pending.promise : defaultRespond(call));
  const first = h.game.Store.mutate("gacha", { count: 1 });
  await until(() => h.count(ep.action) === 1);
  assert.equal(await h.game.Store.mutate("gacha", { count: 1 }), null);
  assert.equal(h.game.save.gold, 600);
  pending.resolve(h.defaultRespond(h.calls.find(call => call.path === ep.action)));
  await first;
  assert.equal(h.count(ep.action), 1); assert.equal(h.game.save.gold, 450);
});

test("start and finish do not upload local squad, stars or combat results", async t => {
  const h = harness(t); await until(() => h.game.Store.ready());
  h.game.save.squad = ["c04"]; h.game.save.stars.s1 = 999;
  const run = await h.game.Store.startRun("s1");
  assert.ok(run);
  assertIntentOnly(h.calls.find(call => call.path === ep.start), ["stage", "request_id"]);
  assert.equal(h.game.save.stamina, 110);
  assert.ok(await h.game.Store.finishRun(run.id, 999));
  assertIntentOnly(h.calls.find(call => call.path === ep.finish), ["run_id"]);
  const second = await h.game.Store.startRun("s1");
  assert.ok(await h.game.Store.finishRun(second.id, true));
  assertIntentOnly(h.calls.filter(call => call.path === ep.finish).at(-1), ["run_id", "abandon"]);
  assert.equal(h.calls.filter(call => call.path === ep.finish).at(-1).body.abandon, true);
  assertPrivateStorage(h);
});

test("uncertain run starts retain their UUID and cannot start a different stage", async t => {
  const h = harness(t); await until(() => h.game.Store.ready());
  let attempts = 0;
  h.respond((call, defaultRespond) => call.path === ep.start && ++attempts === 1 ? fail(500, "SERVER_UNAVAILABLE") : defaultRespond(call));
  assert.equal(await h.game.Store.startRun("s1"), null);
  const id = h.calls.find(call => call.path === ep.start).body.request_id;
  assert.equal(await h.game.Store.startRun("s6"), null);
  assert.equal(h.count(ep.start), 1);
  assert.ok(await h.game.Store.startRun("s1"));
  assert.equal(h.calls.filter(call => call.path === ep.start).at(-1).body.request_id, id);
});

test("account switch while a battle click awaits profile cannot start in the new account", async t => {
  const oldProfile = deferred();
  const h = harness(t); await until(() => h.game.Store.ready());
  const oldData = h.profile();
  let profiles = 0;
  h.respond((call, defaultRespond) => call.path === ep.profile && ++profiles === 1 ? oldProfile.promise : defaultRespond(call));
  const refresh = h.game.Store.refresh();
  await until(() => profiles === 1);
  const start = h.game.startBattle("s1");
  h.game.Store.clearSession();
  h.database.userID = 8;
  h.database.state = initialState();
  oldProfile.resolve(ok(oldData));
  await refresh; await start;
  assert.equal(h.game.Store.authUserId, 8);
  assert.equal(h.game.Store.ready(), true);
  assert.equal(h.count(ep.start), 0);
  assert.equal(h.game.battle, null);
  assert.equal(h.game.save.stamina, 120);
});

test("failed retreat after playback completes exposes a safe settlement retry", async t => {
  const retreat = deferred();
  const h = harness(t); await until(() => h.game.Store.ready());
  h.game.stopPlayback();
  const run = await h.game.Store.startRun("s1");
  await h.game.resumeBattle(run, true);
  let finishes = 0;
  h.respond((call, defaultRespond) => call.path === ep.finish
    ? (++finishes === 1 ? retreat.promise : fail(500, "SETTLEMENT_UNAVAILABLE")) : defaultRespond(call));
  const exit = h.game.exitBattle();
  await until(() => finishes === 1);
  h.game.battle.playbackComplete = true;
  retreat.resolve(fail(500, "RETREAT_UNAVAILABLE"));
  await exit;
  const calls = h.calls.filter(call => call.path === ep.finish);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].body, { run_id: "run-a", abandon: true });
  assert.deepEqual(calls[1].body, { run_id: "run-a" });
  assert.equal(h.game.battle.settled, undefined);
  assert.ok(h.d.querySelector('[onclick*="battleEnd(BAT)"]'));
  h.game.closeModal();
  assert.ok(!h.d.getElementById("modal-mask").classList.contains("hidden"), "Unconfirmed settlement must retain its retry controls");
});

test("HTTP server time follows a monotonic clock instead of a changed device clock", async t => {
  const base = Date.UTC(2026, 10, 17, 8, 0, 0);
  const clock = { server: base, wall: base - 2 * 3600000, mono: 100 };
  const h = harness(t, { clock }); await until(() => h.game.Store.ready());
  const calibrated = h.game.Store.serverNow();
  assert.ok(Math.abs(calibrated - clock.server) <= 1000, "HTTP Date calibrates a device two hours behind");
  clock.wall += 7 * 3600000;
  clock.mono += 1750;
  clock.server += 1750;
  assert.equal(h.game.Store.serverNow() - calibrated, 1750, "Subsequent wall-clock changes cannot extend or skip a battle");
  assert.ok(Math.abs(h.game.Store.serverNow() - clock.server) <= 1000);
});

test("site login validates token expiry against server time on a skewed phone", async t => {
  for (const offset of [-2 * 3600000, 2 * 3600000]) await t.test(String(offset), async t => {
    const base = Date.UTC(2026, 10, 17, 8, 0, 0);
    const clock = { server: base, wall: base + offset, mono: 100 };
    const h = harness(t, { clock }); await until(() => !h.game.Store.connecting);
    assert.equal(h.game.Store.ready(), true, "A valid server-issued token cannot be rejected by the phone clock");
    const refreshes = h.count(ep.auth);
    clock.wall += 5 * 3600000;
    assert.ok(await h.game.Store.warehouse());
    assert.equal(h.count(ep.auth), refreshes, "Changing device time must not trigger token-refresh loops");
    clock.server += 280000;
    clock.mono += 280000;
    assert.ok(await h.game.Store.warehouse());
    assert.equal(h.count(ep.auth), refreshes + 1, "Actual server expiry still renews the session");
    assertPrivateStorage(h);
  });
});

test("a genuinely expired server token cannot unlock the game even on a slow phone clock", async t => {
  const base = Date.UTC(2026, 10, 17, 8, 0, 0);
  const clock = { server: base, wall: base - 2 * 3600000, mono: 100 };
  const h = harness(t, { clock, responder(call, defaultRespond) {
    const response = defaultRespond(call);
    if (call.path === ep.auth) response.json = async () => ({ success: true, data: {
      access_token: "expired-test-token", token_type: "Bearer", access_expires_at: base / 1000 - 60,
      user: { id: 7 }, session: { sid: "session-7", current: true },
    } });
    return response;
  } });
  await until(() => !h.game.Store.connecting);
  assertLocked(h);
  assert.equal(h.count(ep.profile), 0);
});

test("temporary entry failures show an actionable cause rather than a database diagnosis", async t => {
  for (const [status, expected] of [[429, /频繁/], [502, /暂时不可用/], [503, /暂时不可用/]]) await t.test(String(status), async t => {
    const h = harness(t, { responder: () => fail(status, "UPSTREAM_ERROR") });
    await until(() => !h.game.Store.connecting);
    assertLocked(h);
    const message = h.d.getElementById("auth-status").textContent;
    assert.match(message, expected);
    assert.doesNotMatch(message, /数据库档案/);
    assert.equal(h.count(ep.auth), 1, "An uncertain refresh must not be automatically replayed");
  });
});

test("entry network failures remain locked and offer a safe manual retry", async t => {
  for (const [name, error, expected] of [
    ["timeout", Object.assign(new Error("Aborted"), { name: "AbortError" }), /超时/],
    ["offline", new TypeError("Failed to fetch"), /网络连接失败/],
  ]) await t.test(name, async t => {
    const h = harness(t, { responder() { throw error; } });
    await until(() => !h.game.Store.connecting);
    assertLocked(h);
    assert.match(h.d.getElementById("auth-status").textContent, expected);
    assert.equal(h.count(ep.auth), 1);
    assertPrivateStorage(h);
  });
});

test("a naturally played report waits visibly for the server minimum and settles with a skewed device clock", async t => {
  for (const { name, offset, cached } of [
    { name: "device behind", offset: -2 * 3600000 },
    { name: "device ahead", offset: 2 * 3600000 },
    { name: "cached previous HTML", offset: 0, cached: true },
  ]) await t.test(name, async t => {
    const base = Date.UTC(2026, 10, 17, 8, 0, 0);
    const clock = { server: base, wall: base + offset, mono: 100 };
    const h = harness(t, { clock }); await until(() => h.game.Store.ready());
    if (cached) {
      h.d.getElementById("bh-status").remove();
      const button = h.d.getElementById("btn-flee");
      button.setAttribute("onclick", "exitBattle()");
      button.onclick = () => h.game.exitBattle();
    }
    const status = [];
    let virtualElapsed = 0;
    let readyAt = 0;
    let recovered = false;
    h.game.setSleep(async ms => {
      const text = h.d.getElementById("bh-status")?.textContent || "";
      status.push({ text, control: h.d.getElementById("btn-flee").textContent });
      if ((offset > 0 || cached) && text.includes("战报已结束") && !recovered) {
        recovered = true;
        const original = h.game.battle;
        if (cached) {
          const status = h.d.getElementById("bh-status");
          assert.equal(status.getAttribute("role"), "status");
          assert.equal(status.getAttribute("aria-live"), "polite");
          h.d.getElementById("btn-flee").click();
          await until(() => h.game.battle !== original);
        } else await h.game.battleControl();
        assert.equal(original.abort, true, "Resynchronizing stops only the old playback");
        assert.notEqual(h.game.battle, original);
        assert.equal(h.game.battle.runId, original.runId, "The recovery button resumes the server-owned run instead of abandoning it");
      }
      virtualElapsed += ms;
      assert.ok(virtualElapsed <= 40000, "Clock skew must not produce hours of silent waiting");
      clock.mono += ms; clock.server += ms; clock.wall += ms;
    });
    h.respond((call, defaultRespond) => {
      if (call.path === ep.finish) {
        assert.ok(clock.server >= readyAt, "The browser must not request early settlement");
        assert.deepEqual(call.body, { run_id: "run-a" });
      }
      const response = defaultRespond(call);
      if (call.path === ep.start) {
        return Promise.resolve(response.json()).then(payload => {
          const run = payload.data;
          readyAt = run.ready_at;
          run.result.events = [
            { kind: "wave", wave: 0, round: 0, duration_ms: 600, units: [] },
            { kind: "action", wave: 0, round: 1, src: "a0", duration_ms: 450,
              targets: [{ uid: "e0", damage: 100, absorbed: 0, crit: false }],
              units: [{ uid: "e0", hp: 0, rage: 0, shield: 0, alive: false }] },
          ];
          return ok(run);
        });
      }
      return response;
    });
    await h.game.startBattle("s1");
    await until(() => h.game.battle.settled);
    assert.equal(h.count(ep.finish), 1);
    assert.equal(h.game.battle.settled, true);
    assert.equal(h.game.running, false);
    assert.ok(status.some(({ text, control }) => text.includes("战报已结束") && text.includes("秒") && control === "重新同步"), "The minimum-duration wait has an explicit live countdown and recovery control");
    assert.equal(h.d.getElementById("bh-status").textContent, "已结算");
    assert.equal(h.d.getElementById("btn-flee").textContent, "返回副本");
    assert.ok(h.d.getElementById("modal-box").textContent.includes("战斗胜利"));
    assert.equal(h.calls.filter(call => call.path === ep.finish && call.body.abandon).length, 0);
    if (offset > 0 || cached) assert.equal(recovered, true);
    assert.deepEqual(h.errors, []);
    if (cached) h.d.getElementById("btn-flee").click();
    else await h.game.battleControl();
    assert.equal(h.d.body.dataset.page, "page-stage");
    assert.equal(h.count(ep.finish), 1, "Returning after settlement must not abandon or reward the run again");
  });
});

test("an exact-duration report settles after its last event without an artificial countdown", async t => {
  const base = Date.UTC(2026, 10, 17, 8, 0, 0) + 400;
  const clock = { server: base, wall: base, mono: 100 };
  const h = harness(t, { clock }); await until(() => h.game.Store.ready());
  const log = h.d.getElementById("battle-log");
  h.d.getElementById("battle-scene").append(log);
  const statuses = [];
  let readyAt = 0, settledAt = 0;
  h.game.setSleep(async ms => {
    statuses.push(h.d.getElementById("bh-status")?.textContent || "");
    clock.mono += ms; clock.server += ms; clock.wall += ms;
  });
  h.respond((call, defaultRespond) => {
    if (call.path === ep.finish) {
      settledAt = clock.server;
      assert.equal(settledAt, readyAt, "Finish must follow all authoritative event time, without added waiting");
      assert.deepEqual(call.body, { run_id: "run-a" });
    }
    const response = defaultRespond(call);
    if (call.path !== ep.start) return response;
    return response.json().then(payload => {
      const run = payload.data;
      run.result.events = [
        { kind: "wave", wave: 0, round: 0, duration_ms: 600, units: [] },
        { kind: "action", wave: 0, round: 1, src: "a0", duration_ms: 450,
          targets: [{ uid: "e0", damage: 100, absorbed: 0, crit: false }],
          units: [{ uid: "e0", hp: 0, rage: 0, shield: 0, alive: false }] },
      ];
      run.result.duration_ms = 1050;
      run.ready_at = readyAt = clock.server + run.result.duration_ms;
      return ok(run);
    });
  });
  await h.game.startBattle("s1");
  assert.equal(h.game.battle.settled, true);
  assert.equal(settledAt - base, 1050, "Subsecond HTTP Date precision must not add a hidden delay");
  assert.equal(h.count(ep.finish), 1);
  assert.equal(statuses.some(text => text.includes("战报已结束")), false);
  assert.equal(log.parentElement.id, "page-battle", "A cached in-scene report moves to the independent report panel");
  assert.equal(log.previousElementSibling.id, "battle-scene");
  assert.ok(log.querySelectorAll(".bl-lines p").length >= 3, "The report retains separate battle history lines");
  assert.equal(log.querySelector(".bl-lines").getAttribute("tabindex"), "0");
  await h.game.battleEnd(h.game.battle);
  assert.equal(h.count(ep.finish), 1, "A completed report must not settle twice");
  assert.deepEqual(h.errors, []);
});

test("a playback exception exposes recovery controls instead of trapping the battle", async t => {
  for (const failure of ["animation", "initial render"]) await t.test(failure, async t => {
    const base = Date.UTC(2026, 10, 17, 8, 0, 0);
    const clock = { server: base, wall: base, mono: 100 };
    const h = harness(t, { clock }); await until(() => h.game.Store.ready());
    h.game.setSleep(async ms => { clock.mono += ms; clock.server += ms; clock.wall += ms; });
    h.game.setStrike(async () => { throw new Error("ANIMATION_INTERRUPTED"); });
    if (failure === "initial render") h.d.getElementById("scene-bg").remove();
    h.respond((call, defaultRespond) => {
      const response = defaultRespond(call);
      if (call.path !== ep.start) return response;
      return response.json().then(payload => {
        payload.data.result.events = [{ kind: "action", wave: 0, round: 1, src: "a0", duration_ms: 450,
          targets: [{ uid: "e0", damage: 10 }], units: [] }];
        return ok(payload.data);
      });
    });
    await h.game.startBattle("s1");
    assert.equal(h.count(ep.finish), 0, "An animation error must not award client-side results");
    assert.equal(h.game.save.gold, 600);
    assert.ok(!h.d.getElementById("modal-mask").classList.contains("hidden"));
    assert.ok(h.d.querySelector('[onclick*="battleEnd(BAT)"]'));
    assert.ok(h.d.querySelector('[onclick*="recoverBattle()"]'));
    assert.equal(h.d.getElementById("btn-flee").textContent, "同步战报");
  });
});

test("settlement errors retain an explicit retry until the server confirms the same run", async t => {
  const h = harness(t); await until(() => h.game.Store.ready());
  h.game.stopPlayback();
  h.game.setSleep(async () => {});
  const run = await h.game.Store.startRun("s1");
  await h.game.resumeBattle(run, true);
  h.game.battle.playbackComplete = true;
  let attempts = 0;
  h.respond((call, defaultRespond) => call.path === ep.finish && ++attempts === 1
    ? fail(503, "SETTLEMENT_UNAVAILABLE") : defaultRespond(call));
  await h.game.battleEnd(h.game.battle);
  assert.ok(h.d.querySelector('[onclick*="battleEnd(BAT)"]'));
  assert.equal(h.game.battle.settled, undefined);
  assert.equal(h.game.Store.activeRun.id, run.id);
  assert.equal(h.game.save.gold, 600);
  await h.game.battleEnd(h.game.battle);
  assert.equal(h.game.battle.settled, true);
  assert.equal(h.game.running, false);
  assert.equal(h.game.Store.activeRun, null);
  const calls = h.calls.filter(call => call.path === ep.finish);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].body, { run_id: run.id });
  assert.deepEqual(calls[1].body, calls[0].body);
});

test("recovering an expired active run uses the server profile without local rewards", async t => {
  const h = harness(t); await until(() => h.game.Store.ready());
  h.game.stopPlayback();
  const run = await h.game.Store.startRun("s1");
  await h.game.resumeBattle(run, true);
  h.database.run = null; h.database.revision++;
  await h.game.recoverBattle();
  assert.equal(h.game.battle, null);
  assert.equal(h.game.Store.activeRun, null);
  assert.equal(h.d.body.dataset.page, "page-stage");
  assert.equal(h.game.save.gold, 600);
  assert.equal(h.game.save.stamina, 110);
  assert.equal(h.count(ep.finish), 0);
});

test("a pending recovery response cannot replace a battle whose settlement has started", async t => {
  const h = harness(t); await until(() => h.game.Store.ready());
  h.game.stopPlayback();
  h.game.setSleep(async () => {});
  const run = await h.game.Store.startRun("s1");
  await h.game.resumeBattle(run, true);
  const battle = h.game.battle;
  battle.playbackComplete = true;
  const refresh = deferred(), finish = deferred();
  let refreshed = false, finishing = false;
  h.respond((call, defaultRespond) => {
    if (call.path === ep.profile && !refreshed) {
      refreshed = true;
      return refresh.promise;
    }
    if (call.path === ep.finish) {
      finishing = true;
      return finish.promise;
    }
    return defaultRespond(call);
  });
  const recovery = h.game.recoverBattle();
  await until(() => refreshed);
  const settlement = h.game.battleEnd(battle);
  await until(() => finishing);
  assert.equal(battle.settling, true);
  refresh.resolve(ok(h.profile()));
  await recovery;
  assert.equal(h.game.battle, battle, "A late profile must not swap out the battle that owns the finish request");
  assert.equal(battle.abort, false);
  assert.equal(battle.settling, true);
  assert.equal(h.d.body.dataset.page, "page-battle");
  const call = h.calls.find(call => call.path === ep.finish);
  finish.resolve(h.defaultRespond(call));
  await settlement;
  assert.equal(h.game.battle, battle);
  assert.equal(battle.settled, true);
  assert.equal(h.game.running, false);
  assert.equal(h.game.Store.activeRun, null);
  assert.equal(h.count(ep.finish), 1);
  assert.ok(h.d.getElementById("modal-box").textContent.includes("战斗胜利"));
});

test("lower-revision responses cannot roll back server assets or active runs", async t => {
  const h = harness(t); await until(() => h.game.Store.ready());
  await h.game.Store.mutate("gacha", { count: 1 });
  const run = await h.game.Store.startRun("s1");
  const revision = h.game.Store.revision;
  h.respond((call, defaultRespond) => call.path === ep.profile ? ok({ ...h.profile(), save: initialState(), revision: 1, active_run: null }) : defaultRespond(call));
  await h.game.Store.refresh();
  assert.equal(h.game.Store.revision, revision);
  assert.equal(h.game.save.gold, 450);
  assert.equal(h.game.Store.activeRun.id, run.id);
});

test("logout clears snapshots, pending intents and visible game state", async t => {
  const h = harness(t); await until(() => h.game.Store.ready());
  const save = h.game.save;
  await h.game.Store.startRun("s1");
  h.game.onSiteSessionEvent({ kind: "signed_out", sid: h.game.Store.sessionId, timestamp: Date.now() });
  assertLocked(h);
  assert.equal(h.game.Store.activeRun, null);
  assert.equal(h.game.Store.pendingAction, null); assert.equal(h.game.Store.pendingStart, null);
  assert.equal(h.game.Store.accessToken, ""); assert.equal(h.game.battle, null);
  assert.equal(await h.game.Store.finishRun("run-a"), null);
  assert.equal(h.count(ep.finish), 0);
  assert.notEqual(save, h.game.save);
  assertPrivateStorage(h);
});

test("post-logout stale mutation success cannot restore old account assets", async t => {
  const pending = deferred();
  const h = harness(t); await until(() => h.game.Store.ready());
  h.respond((call, defaultRespond) => call.path === ep.action ? pending.promise : defaultRespond(call));
  const mutation = h.game.Store.mutate("gacha", { count: 1 });
  await until(() => h.count(ep.action) === 1);
  h.game.Store.clearSession();
  pending.resolve(ok({ save: initialState(), revision: 99 }));
  assert.equal(await mutation, null);
  assertLocked(h);
  assert.equal(h.count(ep.action), 1);
});

test("cross-origin configuration cannot send site credentials or game intents", async t => {
  const h = harness(t); await until(() => h.game.Store.ready());
  const count = h.calls.length;
  h.game.SITE.apiBase = "https://untrusted.test";
  await assert.rejects(h.game.Store.api(ep.action, "POST", { action: "gacha", count: 1, request_id: randomUUID() }));
  assert.equal(h.calls.length, count);
  assert.equal(h.database.state.gold, 600);
  assertPrivateStorage(h);
});

test("a second unauthorized response locks the game instead of retrying indefinitely", async t => {
  const h = harness(t); await until(() => h.game.Store.ready());
  h.respond((call, defaultRespond) => call.path === ep.action ? fail(401, "AUTH") : defaultRespond(call));
  assert.equal(await h.game.Store.mutate("gacha", { count: 1 }), null);
  assert.equal(h.count(ep.action), 2);
  assert.equal(h.count(ep.auth), 2);
  assert.deepEqual(h.calls.filter(call => call.path === ep.action)[0].body, h.calls.filter(call => call.path === ep.action)[1].body);
  assertLocked(h);
  assert.equal(h.game.Store.pendingAction, null);
  assert.equal(h.game.Store.lastError, "AUTH");
});

test("network failure and timeout retain the original intent without automatic replay", async t => {
  const h = harness(t); await until(() => h.game.Store.ready());
  h.respond((call, defaultRespond) => {
    if (call.path === ep.action) throw new TypeError("NETWORK_OFFLINE");
    return defaultRespond(call);
  });
  assert.equal(await h.game.Store.mutate("gacha", { count: 1 }), null);
  assert.equal(h.game.Store.lastError, "NETWORK_OFFLINE");
  const intent = copy(h.game.Store.pendingAction.body);
  assert.equal(h.count(ep.action), 1);
  h.game.SITE.requestTimeoutMs = 5;
  h.respond((call, defaultRespond) => call.path === ep.action ? new Promise((resolve, reject) => {
    call.options.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
  }) : defaultRespond(call));
  assert.equal(await h.game.Store.retryPendingAction(), null);
  assert.equal(h.game.Store.lastError, "TIMEOUT");
  assert.deepEqual(copy(h.game.Store.pendingAction.body), intent);
  assert.equal(h.count(ep.action), 2);
  assert.equal(h.game.save.gold, 600);
  assert.equal(h.database.state.totalPull, 0);
});

test("temporary profile failure does not discard owned-run settlement or replay a server error", async t => {
  const h = harness(t); await until(() => h.game.Store.ready());
  const run = await h.game.Store.startRun("s1");
  h.respond((call, defaultRespond) => call.path === ep.profile || call.path === ep.finish
    ? fail(503, "TEMPORARILY_UNAVAILABLE") : defaultRespond(call));
  assert.equal(await h.game.Store.refresh(), null);
  assert.equal(h.game.Store.serverOK, true);
  assert.equal(await h.game.Store.finishRun(run.id), null);
  assert.equal(h.count(ep.finish), 1, "A server-side settlement error must not automatically replay");
  assert.equal(h.game.Store.activeRun.id, run.id);
  h.respond(null);
  assert.ok(await h.game.Store.finishRun(run.id));
  assert.equal(h.count(ep.finish), 2);
  assert.equal(h.game.Store.activeRun, null);
  h.game.Store.clearSession();
  assert.equal(await h.game.Store.finishRun(run.id), null);
  assert.equal(h.count(ep.finish), 2);
});

test("same-account focus preserves the current DOM, dialog and selected page", async t => {
  const h = harness(t); await until(() => h.game.Store.ready());
  h.game.nav("page-squad");
  h.game.openGirl("c08");
  const card = h.d.querySelector("#owned-list .card");
  const dialog = h.d.querySelector("#modal-box .mb-scroll");
  await h.game.syncSiteAccount();
  assert.equal(h.d.body.dataset.page, "page-squad");
  assert.equal(h.d.querySelector("#owned-list .card"), card);
  assert.equal(h.d.querySelector("#modal-box .mb-scroll"), dialog);
  assert.equal(h.d.getElementById("modal-mask").classList.contains("hidden"), false);
  await h.game.syncSiteAccount(true);
  const count = h.count(ep.profile);
  await h.game.syncSiteAccount(true);
  assert.equal(h.count(ep.profile), count, "focus and visibility events share a short debounce");
});

test("late profile snapshots cannot overwrite a newly settled wallet receipt", async t => {
  const h = harness(t); await until(() => h.game.Store.ready());
  const run = await h.game.Store.startRun("s1");
  const pending = deferred();
  const oldProfile = h.profile();
  h.respond((call, next) => {
    if (call.path === ep.profile) return pending.promise;
    if (call.path === ep.finish) {
      h.database.revision++;
      return ok({save:copy(h.database.state), revision:h.database.revision, wallet_quota:950000, quota:250000});
    }
    return next(call);
  });
  const refresh = h.game.Store.refresh();
  await until(() => h.count(ep.profile) === 2);
  await h.game.Store.finishRun(run.id);
  h.w.eval("renderTopbar()");
  assert.match(h.d.getElementById("res-site").textContent, /1\.9000 E/);
  pending.resolve(ok(oldProfile));
  await refresh;
  h.w.eval("renderTopbar()");
  assert.match(h.d.getElementById("res-site").textContent, /1\.9000 E/);
});

test("lost token-exchange reply retries one intent and preserves its wallet receipt", async t => {
  const h = harness(t); await until(() => h.game.Store.ready());
  let receipt;
  const oldProfile = h.profile();
  h.respond((call, next) => {
    if (call.path === ep.action) {
      if (!receipt) {
        h.database.state.token += 1; h.database.revision++;
        receipt = {save:copy(h.database.state), revision:h.database.revision, exchange:{count:1,cost_quota:500000,wallet_quota:200000}};
        throw new TypeError("REPLY_LOST_AFTER_COMMIT");
      }
      return ok(receipt);
    }
    return next(call);
  });
  assert.equal(await h.game.Store.mutate("token_exchange", {count:1}), null);
  assert.equal(h.game.save.token, 0, "no optimistic currency change");
  await h.game.Store.retryPendingAction();
  const intents = h.calls.filter(call => call.path === ep.action).map(call => call.body);
  assert.deepEqual(intents[0], intents[1]);
  assert.equal(h.game.save.token, 1);
  h.w.eval("renderTopbar()");
  assert.match(h.d.getElementById("res-site").textContent, /0\.4000 E/);
  h.respond((call, next) => call.path === ep.profile ? ok(oldProfile) : next(call));
  await h.game.Store.refresh();
  h.w.eval("renderTopbar()");
  assert.match(h.d.getElementById("res-site").textContent, /0\.4000 E/);
  assert.equal(h.game.save.token, 1);
  assertPrivateStorage(h);
});
