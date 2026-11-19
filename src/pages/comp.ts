// Competitor monitoring: photos of ads, flyers, menus and storefronts over time,
// with prices / offers / promo codes extracted and compared to the last capture.
import { extractEntities, diffCaptures, type Entities } from "../extract";
import { ocrBase64 } from "../ocr";
import * as db from "../db";
import { $, el, show, hide, prepareImage, thumbnail, fmtDate } from "../util";

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
  $("compAdd").onclick = add;
  nameInput.onkeydown = (e) => e.key === "Enter" && add();
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
  show($("compList"));
  if (!competitors.length) {
    $("compList").replaceChildren(el("div", { class: "card empty" }, "Add a competitor above, then snap their ads, menus or signs whenever you see them."));
    return;
  }
  $("compList").replaceChildren(
    ...competitors
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((c) => {
        const caps = capsFor(c);
        const latest = caps[0];
        const changes = caps.length >= 2 ? countChanges(caps[1].entities, caps[0].entities) : 0;
        const b = el(
          "button",
          { class: "card comp-item" },
          latest ? el("img", { src: latest.thumb, alt: "" }) : el("div", { class: "comp-ph", textContent: "📈" }),
          el(
            "div",
            {},
            el("strong", { textContent: c.name }),
            el("div", { class: "hint", textContent: latest ? `${caps.length} capture${caps.length === 1 ? "" : "s"} · last ${fmtDate(latest.at)}` : "No captures yet" }),
            latest ? el("div", { class: "hint", textContent: latest.entities.prices.slice(0, 4).join(" · ") || "No prices found" }) : "",
            changes ? el("span", { class: "pill warning", textContent: `${changes} change${changes === 1 ? "" : "s"} since previous` }) : "",
          ),
        );
        b.onclick = () => open(c);
        return b;
      }),
  );
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
  hide($("compList"));
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
      for (const a of x.added) rows.push(el("li", { class: "added" }, el("strong", { textContent: `New ${label}: ` }), a));
      for (const r of x.removed) rows.push(el("li", { class: "removed" }, el("strong", { textContent: `Gone ${label}: ` }), r));
    };
    add("price", d.prices);
    add("offer", d.offers);
    add("promo code", d.promoCodes);
    changesBox.append(
      el(
        "div",
        { class: "card" },
        el("h2", { textContent: "What changed" }),
        el("p", { class: "hint", textContent: `${fmtDate(caps[1].at)} → ${fmtDate(caps[0].at)}` }),
        rows.length ? el("ul", { class: "diff" }, ...rows) : el("p", { textContent: "No change in prices, offers or promo codes." }),
      ),
    );
  }

  $("compTimeline").replaceChildren(
    ...caps.map((cap) => {
      const e = cap.entities;
      const chips = (xs: string[], cls: string) => xs.slice(0, 12).map((x) => el("span", { class: `chip static ${cls}`, textContent: x }));
      const details = el("details", {}, el("summary", { textContent: "All text" }), el("div", { class: "textblock", textContent: cap.text || "(no text found)" }));
      const rm = el("button", { class: "btn small", textContent: "Delete" });
      rm.onclick = async () => {
        await db.del("captures", cap.id);
        captures = captures.filter((x) => x.id !== cap.id);
        renderDetail();
      };
      return el(
        "article",
        { class: "card capture" },
        el("img", { src: cap.thumb, alt: "" }),
        el(
          "div",
          {},
          el("div", { class: "row-between" }, el("strong", { textContent: fmtDate(cap.at) }), rm),
          el("div", { class: "chips" }, ...chips(e.prices, "price"), ...chips(e.offers, "offer"), ...chips(e.promoCodes.map((p) => `Code ${p}`), "offer")),
          e.prices.length + e.offers.length + e.promoCodes.length ? "" : el("p", { class: "hint", textContent: "No prices or offers found in this one." }),
          details,
        ),
      );
    }),
  );
  if (!caps.length) $("compTimeline").append(el("div", { class: "card empty" }, "No captures yet. Take a photo of an ad, flyer, menu or sign."));
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
