const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");

const css = fs.readFileSync(path.join(__dirname, "../style.css"), "utf8");
const markup = `<div id="modal-box"><div class="mb-scroll">
  <div class="gc-head"><div class="gc-info">
    <div class="gc-desc">Character description</div>
    <div class="gc-lv">Lv1</div>
    <div class="mat-line">Crystals 0 <span>Required 20</span></div>
  </div></div>
  <div class="gc-body"><div class="gc-stats"><span>HP <b>780</b></span></div>
    <div class="gc-skills"><div>Skill damage 320%</div></div></div>
  <div class="modal-btns"><button class="gbtn" disabled><span>Upgrade</span>
    <span class="sub">40 shards + 20 materials</span></button></div>
</div></div>`;

function luminance(color) {
  const channels = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrast(foreground, background) {
  const a = luminance(foreground), b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

test("character details keep numeric values and explanations legible on cream panels", t => {
  const dom = new JSDOM(`<style>${css}</style>${markup}`);
  t.after(() => dom.window.close());
  const style = selector => dom.window.getComputedStyle(dom.window.document.querySelector(selector));
  for (const selector of [".gc-stats", ".gc-stats b", ".gc-desc", ".gc-skills", ".gc-lv", ".mat-line", ".mat-line span", ".modal-btns .sub", ".gbtn:disabled"]) {
    for (const background of ["rgb(253, 246, 234)", "rgb(246, 231, 212)"]) {
      assert.ok(contrast(style(selector).color, background) >= 4.5,
        `${selector} must meet 4.5:1 contrast, got ${style(selector).color}`);
    }
  }
  assert.ok(parseFloat(style(".gc-stats b").fontSize) >= 18, "Attribute numbers are at least 18px");
  assert.ok(Number(style(".gc-stats b").fontWeight) >= 700, "Attribute numbers use bold type");
  assert.equal(style(".modal-btns .sub").textShadow, "none", "Costs do not have blurry dark shadows");
});

test("roster controls and locked-character labels retain readable colors and touch targets", t => {
  const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
  const dom = new JSDOM(html);
  t.after(() => dom.window.close());
  const d = dom.window.document;
  const sheet = d.createElement("style");
  sheet.textContent = css;
  d.head.appendChild(sheet);
  d.getElementById("owned-list").innerHTML = `<article class="card r-R card-locked"><button class="roster-detail"><span class="name">未获得角色<i>未获得</i></span><span class="roster-traits">R · 木 · 守护</span></button><button class="quick-toggle">+</button></article>`;
  const style = selector => dom.window.getComputedStyle(d.querySelector(selector));
  for (const selector of [".roster-tools label", "#roster-search", "#roster-status", ".roster-reset", "#squad-status", ".team-tip"]) {
    assert.ok(contrast(style(selector).color, "rgb(248, 233, 219)") >= 4.5, `${selector} uses readable ink on paper`);
  }
  for (const selector of ["#owned-list .name", "#owned-list .name i", ".roster-traits"]) {
    assert.ok(contrast(style(selector).color, "rgb(52, 34, 20)") >= 4.5, `${selector} remains legible over its dark strip`);
  }
  assert.ok(parseFloat(style("#roster-search").minHeight) >= 44);
  assert.ok(parseFloat(style("#roster-status").minHeight) >= 44);
  assert.ok(parseFloat(style("#owned-list .quick-toggle").width) >= 44);
  assert.ok(parseFloat(style("#owned-list .quick-toggle").height) >= 44);
});
