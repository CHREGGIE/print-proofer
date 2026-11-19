// Competitor monitoring: photos of ads, flyers, menus and storefronts over time,
// with prices / offers / promo codes extracted and compared to the last capture.
import { extractEntities, diffCaptures, type Entities } from "../extract";
import { ocrBase64 } from "../ocr";
import * as db from "../db";
import { $, el, show, hide, prepareImage, thumbnail, fmtDate } from "../util";
import { iconEl } from "../icons";

interface Competitor {
  id: string;
  name: string;
  created: number;
}
interface Capture {
  id: string;
  competitorId: string;
  at: number;
  thumb: string;
  text: string;
  entities: Entities;
}

let competitors: Competitor[] = [];
let captures: Capture[] = [];
let current: Competitor | null = null;
let loaded = false;

export function initComp() {
  const nameInput = $<HTMLInputElement>("compName");
  const add = async () => {
    const name = nameInput.value.trim();
    if (!name) return;
    const c: Competitor = { id: db.newId(), name, created: Date.now() };
    await db.put("competitors", c);
    competitors.push(c);
    nameInput.value = "";
    open(c);
  };
  $<HTMLFormElement>("compForm").onsubmit = (e) => {
    e.preventDefault();
    add();
  };
  $("compBack").onclick = () => {
    current = null;
    renderList();
  };
  $("compDelete").onclick = async () => {
    if (!current || !confirm(`Delete ${current.name} and all its captures?`)) return;
    for (const cap of captures.filter((x) => x.competitorId === current!.id)) await db.del("captures", cap.id);
    await db.del("competitors", current.id);
    captures = captures.filter((x) => x.competitorId !== current!.id);
    competitors = competitors.filter((x) => x.id !== current!.id);
    current = null;
    renderList();
  };
  for (const id of ["compCamera", "compUpload"]) {
    const input = $<HTMLInputElement>(id);
    input.onchange = async () => {
      if (input.files && current) await addCaptures([...input.files], current);
      input.value = "";
    };
  }
}

export async function showComp() {
  if (!loaded) {
    loaded = true;
    [competitors, captures] = await Promise.all([db.all<Competitor>("competitors"), db.all<Capture>("captures")]).catch(() => [[], []] as [Competitor[], Capture[]]);
  }
  current ? renderDetail() : renderList();
}

const capsFor = (c: Competitor) => captures.filter((x) => x.competitorId === c.id).sort((a, b) => b.at - a.at);

function renderList() {
  hide($("compDetail"));
  show($("compHome"));
  if (!competitors.length) {
    $("compList").replaceChildren(el("div", { class: "empty" }, "Add a competitor above, then photograph their ads, menus or signs whenever you pass them."));
    return;
  }
  const rows = competitors
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((c) => {
      const caps = capsFor(c);
      const latest = caps[0];
      const changes = caps.length >= 2 ? countChanges(caps[1].entities, caps[0].entities) : 0;
      const prices = latest?.entities.prices.slice(0, 4).join(" · ");
      const b = el(
        "button",
        { class: "row-btn comp-row" },
        latest ? el("img", { src: latest.thumb, alt: "" }) : el("span", { class: "comp-ph" }, iconEl("image", 22)),
        el(
          "span",
          { class: "grow" },
          el("span", { class: "t", textContent: c.name }),
          el("span", { class: "meta", textContent: latest ? `${caps.length} capture${caps.length === 1 ? "" : "s"} · ${fmtDate(latest.at)}` : "No captures yet" }),
          prices ? el("span", { class: "meta", textContent: prices }) : "",
        ),
        changes ? el("span", { class: "pill error", textContent: `${changes} new` }) : iconEl("chevron", 18, "chev"),
      );
      b.onclick = () => open(c);
      return el("li", {}, b);
    });
  $("compList").replaceChildren(el("section", { class: "panel flush" }, el("ul", { class: "list" }, ...rows)));
}

function countChanges(a: Entities, b: Entities) {
  const d = diffCaptures(a, b);
  return [d.prices, d.offers, d.promoCodes].reduce((s, x) => s + x.added.length + x.removed.length, 0);
}

function open(c: Competitor) {
  current = c;
  renderDetail();
}

function renderDetail() {
  if (!current) return;
  hide($("compHome"));
  show($("compDetail"));
  $("compTitle").textContent = current.name;
  $("compStatus").textContent = "";
  const caps = capsFor(current);

  // What changed between the two most recent captures
  const changesBox = $("compChanges");
  changesBox.replaceChildren();
  if (caps.length >= 2) {
    const d = diffCaptures(caps[1].entities, caps[0].entities);
    const rows: HTMLElement[] = [];
    const add = (label: string, x: { added: string[]; removed: string[] }) => {
      for (const a of x.added) rows.push(el("li", {}, el("span", { class: "pill error", textContent: "New" }), el("span", { class: "grow" }, a, " ", el("span", { class: "what", textContent: label }))));
      for (const r of x.removed) rows.push(el("li", {}, el("span", { class: "pill neutral", textContent: "Gone" }), el("span", { class: "grow" }, el("span", { class: "gone", textContent: r }), " ", el("span", { class: "what", textContent: label }))));
    };
    add("price", d.prices);
    add("offer", d.offers);
    add("promo code", d.promoCodes);
    changesBox.append(
      el(
        "section",
        { class: "panel flush" },
        el("header", { class: "panel-head" }, el("h2", { textContent: "What changed" }), el("span", { class: "meta", textContent: `since ${fmtDate(caps[1].at)}` })),
        rows.length ? el("ul", { class: "list diff" }, ...rows) : el("p", { class: "why pad", textContent: "Same prices, offers and promo codes as last time." }),
      ),
    );
  }

  $("compTimeline").replaceChildren(
    ...caps.map((cap) => {
      const e = cap.entities;
      const chips = (xs: string[], cls: string) => xs.slice(0, 12).map((x) => el("span", { class: `chip static ${cls}`, textContent: x }));
      const details = el("details", {}, el("summary", { textContent: "All text" }), el("div", { class: "textblock", textContent: cap.text || "(no text found)" }));
      const rm = el("button", { class: "btn small ghost", ariaLabel: "Delete capture" }, iconEl("trash", 16));
      rm.onclick = async () => {
        await db.del("captures", cap.id);
        captures = captures.filter((x) => x.id !== cap.id);
        renderDetail();
      };
      const found = e.prices.length + e.offers.length + e.promoCodes.length;
      return el(
        "article",
        { class: "panel capture" },
        el("img", { src: cap.thumb, alt: "" }),
        el(
          "div",
          { class: "capture-main" },
          el("div", { class: "panel-head" }, el("h3", { textContent: new Date(cap.at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) }), rm),
          found
            ? el("div", { class: "chips" }, ...chips(e.prices, "price"), ...chips(e.offers, "offer"), ...chips(e.promoCodes.map((p) => `Code ${p}`), "offer"))
            : el("p", { class: "meta", textContent: "No prices or offers found in this one." }),
          details,
        ),
      );
    }),
  );
  if (!caps.length) $("compTimeline").append(el("div", { class: "empty" }, "No captures yet. Photograph an ad, flyer, menu or sign."));
}

async function addCaptures(files: File[], c: Competitor) {
  const status = $("compStatus");
  let i = 0;
  for (const f of files) {
    i++;
    status.textContent = `Reading ${i} of ${files.length}…`;
    try {
      const img = await prepareImage(f, 2000);
      const text = await ocrBase64(img.base64);
      const cap: Capture = {
        id: db.newId(),
        competitorId: c.id,
        at: f.lastModified && Date.now() - f.lastModified < 365 * 864e5 ? f.lastModified : Date.now(),
        thumb: await thumbnail(img.dataUrl, 480),
        text,
        entities: extractEntities(text),
      };
      await db.put("captures", cap);
      captures.push(cap);
    } catch (e) {
      status.textContent = `Couldn't read ${f.name}: ${String(e)}`;
      return;
    }
  }
  renderDetail();
  status.textContent = `Saved ${files.length} capture${files.length === 1 ? "" : "s"}.`;
}
