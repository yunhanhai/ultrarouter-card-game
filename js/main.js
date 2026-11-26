/* =====================================================
 * main.js —— 启动入口与全局事件
 * ===================================================== */

function boot() {
  Store.init();
  lockGame("正在确认站点登录并读取数据库档案…");
  syncSiteAccount();
}

function lockGame(message) {
  document.getElementById("app").classList.add("hidden");
  document.getElementById("title-screen").classList.remove("hidden");
  document.getElementById("auth-status").textContent = message;
  document.getElementById("auth-actions").classList.toggle("hidden", Store.connecting);
  closeModal(true);
  clearRoster();
  document.getElementById("summon-fx").classList.add("hidden");
  if (BAT) BAT.abort = true;
  BAT = null;
  battleRunning = false;
  document.body.classList.remove("in-battle");
}

function requireGame() {
  if (Store.ready()) return true;
  lockGame(Store.connecting ? "正在验证站点账号…" : "请登录站点后进入游戏");
  return false;
}

function unlockGame() {
  if (!Store.ready()) return;
  const alreadyOpen = !document.getElementById("app").classList.contains("hidden");
  document.getElementById("title-screen").classList.add("hidden");
  document.getElementById("app").classList.remove("hidden");
  // A same-account refresh must not rebuild tabs, dialogs, or an in-progress form.
  if (alreadyOpen) { renderTopbar(); return; }
  if (battleRunning && BAT) { renderTopbar(); return; }
  const hash = (location.hash || "").replace(/^#/, "");
  let page = document.body.dataset.page || "page-home";
  if (hash && hash !== "battle" && document.getElementById("page-" + hash)) page = "page-" + hash;
  if (page === "page-battle") page = "page-stage";
  nav(page);
  if (Store.activeRun && Store.activeRun.result) resumeBattle(Store.activeRun);
}

/* 兜底：任何未捕获错误都提示出来，避免白屏无反馈 */
window.addEventListener("error", e => {
  if (typeof toast === "function") toast("运行错误：" + e.message);
});

/* 底部导航 */
document.querySelectorAll(".nav-btn").forEach(b =>
  b.addEventListener("click", () => {
    if (battleRunning && b.dataset.nav !== "page-battle") {
      return toast("战斗进行中，等结算后再离开");
    }
    nav(b.dataset.nav);
  }));

/* 页内跳转按钮（主页 -> 副本/召唤） */
document.querySelectorAll("[data-nav]").forEach(el => {
  if (!el.classList.contains("nav-btn")) {
    el.addEventListener("click", () => nav(el.dataset.nav));
  }
});

/* 召唤按钮 */
document.getElementById("btn-gacha-1").addEventListener("click", () => doGacha(1));
document.getElementById("btn-gacha-10").addEventListener("click", () => doGacha(10));

/* 图鉴筛选只更新展示，保留输入焦点，不发起账号操作。 */
document.getElementById("roster-filters").addEventListener("submit", event => event.preventDefault());
document.getElementById("roster-search").addEventListener("input", event => updateRosterFilter("query", event.target.value));
document.querySelectorAll("#roster-filters select").forEach(select => {
  select.addEventListener("change", () => updateRosterFilter(select.id.replace("roster-", ""), select.value));
});
document.getElementById("roster-reset").addEventListener("click", () => {
  resetRosterFilters();
  document.getElementById("roster-search").focus();
});

/* 点遮罩关弹窗 */
document.getElementById("modal-mask").addEventListener("click", e => {
  if (e.target.id === "modal-mask") closeModal();
});

/* 弹窗内循环键盘焦点；退出仍遵守未确认结算的关闭限制。 */
document.addEventListener("keydown", e => {
  if (e.defaultPrevented || document.getElementById("modal-mask").classList.contains("hidden")) return;
  if (e.key === "Escape") {
    e.preventDefault();
    closeModal();
    return;
  }
  if (e.key !== "Tab") return;
  const box = document.getElementById("modal-box");
  const controls = [...box.querySelectorAll('a[href], button, input, select, textarea, [tabindex], [contenteditable="true"]')]
    .filter(el => el.tabIndex >= 0 && !el.matches(':disabled, input[type="hidden"]') &&
      !el.closest('[hidden], .hidden, [inert]') &&
      getComputedStyle(el).display !== "none" && getComputedStyle(el).visibility !== "hidden");
  const first = controls[0] || box, last = controls[controls.length - 1] || box;
  if (!controls.includes(document.activeElement) ||
      (e.shiftKey ? document.activeElement === first : document.activeElement === last)) {
    e.preventDefault();
    (e.shiftKey ? last : first).focus();
  }
});

/* 返回游戏或站点切换账号时，同步账号；不在后台定时轮转登录 Cookie。 */
window.addEventListener("focus", () => syncSiteAccount(true));
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") syncSiteAccount(true);
});

function onSiteSessionEvent(event) {
  if (!event || !["authenticated", "signed_out"].includes(event.kind) ||
      typeof event.sid !== "string" || !Number.isFinite(event.timestamp) ||
      Math.abs(Date.now() - event.timestamp) > 60000) return;
  if (event.kind === "signed_out" && event.sid !== Store.sessionId) return;
  if (event.kind === "authenticated" && event.sid === Store.sessionId) return;
  Store.clearSession();
  Store.lastError = "AUTH";
  if (event.kind === "authenticated") {
    const pending = Store.profilePromise || Promise.resolve();
    pending.then(() => {
      if (Store.sessionId !== event.sid) syncSiteAccount();
    });
  }
}

if (typeof BroadcastChannel !== "undefined") {
  const channel = new BroadcastChannel("new-api:auth-session");
  channel.addEventListener("message", event => onSiteSessionEvent(event.data));
} else {
  window.addEventListener("storage", event => {
    if (event.key !== "new-api:auth-session:event" || !event.newValue) return;
    try { onSiteSessionEvent(JSON.parse(event.newValue)); } catch (e) {}
  });
}

boot();
