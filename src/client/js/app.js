// Listen + Detail (PDF) + Inline-Edit
// Änderungen: On-Hold entfernt; keine Custom-Header; kein doppeltes routeTo; Bulk & Einzel bleiben.

(function () {
  const API_BASE = "http://localhost:3001";




  // --- Globaler Fetch-Wrapper: hängt X-User an ---
  const __origFetch = window.fetch;
  window.fetch = (input, init = {}) => {
    const headers = new Headers(init?.headers || {});
    const u = localStorage.getItem("ip_user") || "anonymous";
    headers.set("X-User", u);
    return __origFetch(input, { ...init, headers });
  };




  // --- Simple "Login required" ---
  const CURRENT_USER = localStorage.getItem("ip_user");
  if (!CURRENT_USER) {
    location.href = "./login.html";
  }

  // Anzeige im Header + Logout
  document.addEventListener("DOMContentLoaded", () => {
    const elUser = document.getElementById("current-user");
    if (elUser) elUser.textContent = `Angemeldet als ${CURRENT_USER}`;
    const btnLogout = document.getElementById("logout-btn");
    if (btnLogout) {
      btnLogout.addEventListener("click", () => {
        localStorage.removeItem("ip_user");
        location.href = "./login.html";
      });
    }
  });

  const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
  const panels = Array.from(document.querySelectorAll('[role="tabpanel"]'));
  const states = ["inbox","review","hold","processed"];


  const ui = {
    inbox: {
      list: qs("#inbox-list"),
      empty: qs("#inbox-empty"),
      detail: qs("#inbox-detail"),
      refresh: qs("#refresh-inbox"),
      search: qs("#search-inbox"),
      bulkClassify: qs("#bulk-classify"),
      bulkAutoRoute: qs("#bulk-autoroute"),
      uploadBtn: qs("#upload-inbox"),
      fileInput: qs("#filepicker-inbox"),
    },
    review: {
      list: qs("#review-list"), empty: qs("#review-empty"), detail: qs("#review-detail"), refresh: qs("#refresh-review"), search: qs("#search-review")
    },
    hold: {
      list: qs("#hold-list"), empty: qs("#hold-empty"), detail: qs("#hold-detail"), refresh: qs("#refresh-hold"), search: qs("#search-hold")
    },
    processed:{
      list: qs("#processed-list"), empty: qs("#processed-empty"), detail: qs("#processed-detail"), refresh: qs("#refresh-processed"), search: qs("#search-processed")
    }
  };


  // In-Memory Cache
  const cache = {
    inbox:    { items: [], loaded: false },
    review:   { items: [], loaded: false },
    hold:     { items: [], loaded: false },
    processed:{ items: [], loaded: false },
  };
  const selected = { inbox: null, review: null, hold: null, processed: null };


  // --- helpers ---
  function qs(sel, el=document){ return el.querySelector(sel); }
  function fmtDate(iso){
    try{ return new Intl.DateTimeFormat('de-DE', { dateStyle:'medium', timeStyle:'short' }).format(new Date(iso)); }
    catch{ return iso }
  }
  function parseHash(){
    const raw = (location.hash || "#inbox").slice(1);
    const [s, docId] = raw.split("/");
    const state = states.includes(s) ? s : "inbox";
    return { state, docId: docId || null };
  }
  function setHash(state, docId){
    const want = `#${state}${docId ? "/"+docId : ""}`;
    if (location.hash !== want) history.replaceState({}, "", want);
  }
  function activateTab(state){
    const tabId = `tab-${state}`;
    const panelId = `panel-${state}`;
    tabs.forEach(t => t.setAttribute('aria-selected', String(t.id === tabId)));
    panels.forEach(p => p.id === panelId ? p.removeAttribute('hidden') : p.setAttribute('hidden',''));
  }

  // --- data ---
  async function fetchDocs(state){
    const res = await fetch(`${API_BASE}/api/docs?state=${encodeURIComponent(state)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return Array.isArray(data.items) ? data.items : [];
  }
  async function fetchMeta(docId){
    const res = await fetch(`${API_BASE}/api/docs/${encodeURIComponent(docId)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }
  async function patchCorrections(docId, patch){
    const res = await fetch(`${API_BASE}/api/docs/${encodeURIComponent(docId)}/corrections`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }
  async function classifyOne(docId){
    const res = await fetch(`${API_BASE}/api/docs/${encodeURIComponent(docId)}/classify`, { method:"POST" });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { const j = await res.json(); if (j?.message) msg = j.message; } catch {}
      throw new Error(msg);
    }
    return res.json();
  }
  async function autoRouteOne(docId, threshold=0.7){
    const res = await fetch(`${API_BASE}/api/docs/${encodeURIComponent(docId)}/auto-route`, {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ threshold })
    });
    if (!res.ok) {
      const err = await res.json().catch(()=>({}));
      throw new Error(err?.message || `HTTP ${res.status}`);
    }
    return res.json(); // { ok, docId, newState }
  }
  async function routeTo(docId, to){
    const res = await fetch(`${API_BASE}/api/docs/${encodeURIComponent(docId)}/route`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to }),
    });
    if (!res.ok) {
      const err = await res.json().catch(()=>({}));
      throw new Error(err?.message || `HTTP ${res.status}`);
    }
    return res.json(); // volle Meta
  }

  function getInnerResult(classification){
    if (!classification) return null;
    const r = classification.result;
    if (!r) return null;
    return r.result ? r.result : r;
  }
  function collectScores(inner){
    const s = [];
    if (inner?.doc_id?.score != null) s.push(Number(inner.doc_id.score));
    if (inner?.doc_date_sic?.score != null) s.push(Number(inner.doc_date_sic.score));
    if (inner?.doc_subject?.score != null) s.push(Number(inner.doc_subject.score));
    return s;
  }
  function minScore(scores){
    if (!scores?.length) return null;
    return scores.reduce((m,v) => Math.min(m, v), 1);
  }

  // --- list rendering ---
  function renderList(state, items){
    const { list, empty, search } = ui[state];
    list.innerHTML = "";
    const q = (search?.value || "").trim().toLowerCase();

    const filtered = q
      ? items.filter(it =>
          (it.originalFilename || "").toLowerCase().includes(q) ||
          (it.docId || "").toLowerCase().includes(q)
        )
      : items;

    if (!filtered.length){
      empty.hidden = false;
      return;
    }
    empty.hidden = true;

    for (const it of filtered){
      const card = document.createElement("div");
      card.className = "item";
      card.tabIndex = 0;
      card.dataset.docId = it.docId;
      card.innerHTML = `
        <p class="title" title="${it.originalFilename || ""}">${it.originalFilename || "—"}</p>
        <p class="meta">${fmtDate(it.createdAt)} · ${it.docId}</p>
      `;
      list.appendChild(card);
    }
  }
  function renderListFromCache(state){
    renderList(state, cache[state].items);
  }

  // --- detail rendering ---
  async function renderDetail(state, docId){
    const { detail } = ui[state];
    detail.innerHTML = `<div class="placeholder"><h2>Lade…</h2><p>Details werden geladen.</p></div>`;
    try{
      const meta = await fetchMeta(docId);
      const inner = getInnerResult(meta?.classification);
      const scoreList = collectScores(inner);
      const aggMin = minScore(scoreList);

      const scoreBadge = (aggMin == null)
        ? `<span class="badge muted">keine Klassifizierung</span>`
        : `<span class="badge ${aggMin >= 0.7 ? 'good' : 'warn'}">min-confidence: ${aggMin.toFixed(2)}</span>`;

      const pdfUrl = `${API_BASE}/api/docs/${encodeURIComponent(docId)}/preview`;

      const eff = {
        kind: meta.corrections?.kind ?? inner?.kind ?? "",
        doc_id: meta.corrections?.doc_id ?? inner?.doc_id?.value ?? "",
        doc_date_sic: meta.corrections?.doc_date_sic ?? inner?.doc_date_sic?.value ?? "",
        doc_date_parsed: meta.corrections?.doc_date_parsed ?? inner?.doc_date_parsed ?? "",
        doc_subject: meta.corrections?.doc_subject ?? inner?.doc_subject?.value ?? "",
      };
      
      // KI-Scores + optionale Overrides aus corrections
      const fieldScores = {
        doc_id: typeof inner?.doc_id?.score === "number" ? inner.doc_id.score : null,
        doc_date_sic: typeof inner?.doc_date_sic?.score === "number" ? inner.doc_date_sic.score : null,
        doc_subject: typeof inner?.doc_subject?.score === "number" ? inner.doc_subject.score : null,
      };

      const overrides = meta.corrections?.conf_overrides || {};


      const raw = {
        kind: inner?.kind ?? "",
        doc_id: inner?.doc_id?.value ?? "",
        doc_date_sic: inner?.doc_date_sic?.value ?? "",
        doc_date_parsed: inner?.doc_date_parsed ?? "",
        doc_subject: inner?.doc_subject?.value ?? "",
      };

      const canEdit = meta.state !== "processed"; // Review: edit erlaubt; Processed: read-only
      const canClassifySingle = meta.state === "inbox" || meta.state === "review" || meta.state === "hold";
      const canAutoRouteSingle = meta.state === "inbox" && Boolean(inner);

      const renderView = () => {
        let rightButtons = "";
        const editBtn = canEdit ? `<button id="btn-edit" class="icon-btn small ghost" title="Bearbeiten">✎</button>` : ``;
        const classifyBtn = canClassifySingle ? `<button id="btn-classify-one" class="icon-btn small">Klassifizieren</button>` : ``;

        if (meta.state === "inbox") {
          const autoRouteBtn = `<button id="btn-autoroute-one" class="icon-btn small"${canAutoRouteSingle ? "" : " disabled"}>Auto-Routen</button>`;
          rightButtons = `
            ${classifyBtn}
            <button id="btn-to-review" class="icon-btn small">→ Review</button>
            <button id="btn-to-hold" class="icon-btn small">→ Hold</button>
            <button id="btn-to-processed" class="icon-btn small primary">→ Processed</button>
            ${autoRouteBtn}
            ${editBtn}
          `;
        } else if (meta.state === "review") {
          rightButtons = `
            ${classifyBtn}
            <button id="btn-to-processed" class="icon-btn small primary">→ Processed</button>
            ${editBtn}
          `;
        } else if (meta.state === "hold") {
          rightButtons = `
            ${classifyBtn}
            <button id="btn-back-inbox" class="icon-btn small">← Zurück in Review</button>
          `;
        } else {
          rightButtons = ``; // processed
        }


        detail.innerHTML = `
          <div class="detail-grid">
            <div class="viewer">
              <object data="${pdfUrl}" type="application/pdf" class="pdf-box">
                <div class="pdf-fallback">
                  <p>Dein Browser kann das PDF nicht einbetten.</p>
                  <a href="${pdfUrl}" target="_blank" rel="noopener">PDF öffnen</a>
                </div>
              </object>
            </div>

            <div class="info">
              <h2>Details</h2>
              <div class="kv"><span>docId</span><code>${meta.docId}</code></div>
              <div class="kv"><span>Status</span><b>${meta.state}</b> ${scoreBadge}</div>
              <div class="kv"><span>Datei</span><span title="${meta.originalFilename || ""}">${meta.originalFilename || "—"}</span></div>
              <div class="kv"><span>Eingang</span><span>${fmtDate(meta.createdAt)}</span></div>

              <div class="section-title-row">
                <h3 class="section-title">Werte (gültig)</h3>
                <div class="section-actions">
                  ${rightButtons}
                </div>
              </div>

              ${renderInlineValueRow("kind", eff.kind, raw.kind)}
              ${renderInlineValueRow("doc_id", eff.doc_id, raw.doc_id)}
              ${renderInlineValueRow("date (sic)", eff.doc_date_sic, raw.doc_date_sic)}
              ${renderInlineValueRow("date (parsed)", eff.doc_date_parsed, raw.doc_date_parsed)}
              ${renderInlineValueRow("subject", eff.doc_subject, raw.doc_subject)}



              <div class="section-title-row" style="margin-top:10px;">
                <h3 class="section-title">Confidence (KI)</h3>
              </div>
              <div class="kv"><span>doc_id.score</span><span>${formatScore(overrides.doc_id_score, fieldScores.doc_id)}</span></div>
              <div class="kv"><span>doc_date_sic.score</span><span>${formatScore(overrides.doc_date_sic_score, fieldScores.doc_date_sic)}</span></div>
              <div class="kv"><span>doc_subject.score</span><span>${formatScore(overrides.doc_subject_score, fieldScores.doc_subject)}</span></div>




            </div>
          </div>
        `;

        if (canEdit) qs("#btn-edit", detail)?.addEventListener("click", () => renderEdit());

        // Inbox → Review
        qs("#btn-to-review", detail)?.addEventListener("click", async () => {
          try{
            disableActionButtons(true);
            const updated = await routeTo(docId, "review");
            updateCachesAfterRoute(updated, "inbox", "review");
            activateTab("review");
            await loadState("review", updated.docId, { force:true });
          } catch(e){
            alert("Verschieben nach Review fehlgeschlagen: " + String(e?.message || e));
          } finally {
            disableActionButtons(false);
          }
        });


        // Inbox/Review → Processed
        qs("#btn-to-processed", detail)?.addEventListener("click", async () => {
          try{
            disableActionButtons(true);
            const from = meta.state || "inbox";
            const updated = await routeTo(docId, "processed");
            updateCachesAfterRoute(updated, from, "processed");
            activateTab("processed");
            await loadState("processed", updated.docId, { force:true });
          } catch(e){
            alert("Verschieben nach Processed fehlgeschlagen: " + String(e?.message || e));
          } finally {
            disableActionButtons(false);
          }
        });

        // Einzel-Klassifizieren (nur Inbox)
        qs("#btn-classify-one", detail)?.addEventListener("click", async () => {
          try{
            disableActionButtons(true);
            await classifyOne(docId);
            await renderDetail(state, docId); // nur Detail neu
          } catch(e){
            alert("Klassifizieren fehlgeschlagen: " + String(e?.message || e));
          } finally {
            disableActionButtons(false);
          }
        });

        // Einzel-Auto-Route (nur Inbox)
        qs("#btn-autoroute-one", detail)?.addEventListener("click", async () => {
          try{
            disableActionButtons(true);
            await autoRouteOne(docId, 0.7);
            const updated = await fetchMeta(docId);
            updateCachesAfterRoute(updated, "inbox", updated.state);
            activateTab(updated.state);
            await loadState(updated.state, updated.docId, { force:true });
          } catch(e){
            alert("Auto-Routen fehlgeschlagen: " + String(e?.message || e));
          } finally {
            disableActionButtons(false);
          }
        });




        // Inbox/Review → Hold
        qs("#btn-to-hold", detail)?.addEventListener("click", async () => {
          try{
            disableActionButtons(true);
            const from = meta.state || "inbox";
            const updated = await routeTo(docId, "hold");
            updateCachesAfterRoute(updated, from, "hold");
            activateTab("hold");
            await loadState("hold", updated.docId, { force:true });
            toast("Verschoben nach Hold.", "success");
          } catch(e){
            toast("Verschieben nach Hold fehlgeschlagen: " + String(e?.message || e), "error", { timeout: 3500 });
          } finally {
            disableActionButtons(false);
          }
        });

        // Hold → Inbox (Release)
        qs("#btn-back-inbox", detail)?.addEventListener("click", async () => {
          try{
            disableActionButtons(true);
            const updated = await routeTo(docId, "review");
            updateCachesAfterRoute(updated, "hold", "review");
            activateTab("review");
            await loadState("review", updated.docId, { force:true });
            toast("Zurück in die review verschoben.", "success");
          } catch(e){
            toast("Zurückschieben in review fehlgeschlagen: " + String(e?.message || e), "error", { timeout: 3500 });
          } finally {
            disableActionButtons(false);
          }
        });






      };

      const renderEdit = () => {
        detail.innerHTML = `
          <div class="detail-grid">
            <div class="viewer">
              <object data="${pdfUrl}" type="application/pdf" class="pdf-box">
                <div class="pdf-fallback">
                  <p>Dein Browser kann das PDF nicht einbetten.</p>
                  <a href="${pdfUrl}" target="_blank" rel="noopener">PDF öffnen</a>
                </div>
              </object>
            </div>

            <div class="info">
              <div class="section-title-row">
                <h2>Bearbeiten</h2>
                <div class="section-actions">
                  <button id="btn-cancel" class="icon-btn small">Abbrechen</button>
                  <button id="btn-save" class="icon-btn small primary">Speichern</button>
                </div>
              </div>

              <div class="inline-form">
                ${renderInput("kind", "kind", eff.kind)}
                ${renderInput("doc_id", "doc_id", eff.doc_id)}
                ${renderInput("doc_date_sic", "date (sic)", eff.doc_date_sic, "YYYY-MM-DD")}
                ${renderInput("doc_date_parsed", "date (parsed)", eff.doc_date_parsed, "YYYY-MM-DDTHH:mm:ssZ")}
                ${renderInput("doc_subject", "subject", eff.doc_subject)}


                <div class="subsection" style="margin-top:16px;">
                  <h3 class="section-title">Confidence Overrides (0–1)</h3>
                  ${renderNumber("conf_doc_id", "doc_id.score", (overrides?.doc_id_score ?? fieldScores.doc_id ?? ""))}
                  ${renderNumber("conf_date_sic", "doc_date_sic.score", (overrides?.doc_date_sic_score ?? fieldScores.doc_date_sic ?? ""))}
                  ${renderNumber("conf_subject", "doc_subject.score", (overrides?.doc_subject_score ?? fieldScores.doc_subject ?? ""))}
                  <p class="hint muted">Leer lassen, um keinen Override zu setzen.</p>
                </div>



              </div>

              <div class="kv" style="margin-top:10px;"><span>docId</span><code>${meta.docId}</code></div>
              <div class="kv"><span>Status</span><b>${meta.state}</b></div>
            </div>
          </div>
        `;

        qs("#btn-cancel", detail)?.addEventListener("click", () => renderView());
        qs("#btn-save", detail)?.addEventListener("click", async () => {
          const next = {
            kind: val("#f-kind", detail),
            doc_id: val("#f-doc_id", detail),
            doc_date_sic: val("#f-doc_date_sic", detail),
            doc_date_parsed: val("#f-doc_date_parsed", detail),
            doc_subject: val("#f-doc_subject", detail),
          };

          
          

            const patch = {};
            const currentEff = eff; // aktueller effektiver Stand zum Vergleichen
            for (const [k, v] of Object.entries(next)) {
              if (String(v).trim() !== String((currentEff[k] ?? "")).trim()) {
                patch[k] = String(v).trim();
              }
            }

            
            // Confidence-Overrides einsammeln
            const getNumOrEmpty = (sel) => {
              const s = val(sel, detail);
              if (s === "") return "";             // "" = Override löschen
              const n = Number(s);
              if (!isFinite(n)) return "";         // ungültig => wie leer behandeln
              return Math.max(0, Math.min(1, n));  // clamp 0..1
            };
            const conf = {
              doc_id_score:      getNumOrEmpty("#f-conf_doc_id"),
              doc_date_sic_score:getNumOrEmpty("#f-conf_date_sic"),
              doc_subject_score: getNumOrEmpty("#f-conf_subject"),
            };
            // immer mitsenden (Server kann dann setzen/entfernen)
            patch.conf_overrides = conf;






          if (Object.keys(patch).length === 0) {
            return renderDetail(state, docId);
          }

          try{
            disableActionButtons(true);
            await patchCorrections(docId, patch);
            await renderDetail(state, docId);
          } catch(e){
            alert("Speichern fehlgeschlagen: " + String(e?.message || e));
          } finally {
            disableActionButtons(false);
          }
        });
      };

      function disableActionButtons(disabled){
        ["btn-edit","btn-classify-one","btn-autoroute-one","btn-to-review","btn-to-processed"]
          .forEach(id => { const el = qs(`#${id}`, detail); if (el) el.disabled = disabled; });
      }

      // initial
      renderView();

    } catch (e){
      const { detail } = ui[state];
      detail.innerHTML = `
        <div class="placeholder">
          <h2>Fehler</h2>
          <p>Details konnten nicht geladen werden (${String(e?.message || e)}).</p>
        </div>
      `;
    }
  }

  // --- small render utilities ---
  function renderInlineValueRow(label, effVal, rawVal){
    const eff = String(effVal ?? "");
    const raw = String(rawVal ?? "");
    const changed = raw && eff && eff !== raw;
    const hasEffOnly = eff && !raw;
    const hasNothing = !eff && !raw;

    let valueHtml = "";
    if (changed) {
      valueHtml = `<span class="old strike">${escapeHtml(raw)}</span><span class="sep">→</span><span class="new">${escapeHtml(eff)}</span>`;
    } else if (hasEffOnly) {
      valueHtml = `<span class="new">${escapeHtml(eff)}</span>`;
    } else if (hasNothing) {
      valueHtml = `<span class="muted">—</span>`;
    } else {
      valueHtml = `<span>${escapeHtml(eff || raw)}</span>`;
    }

    return `<div class="kv"><span>${label}</span><span>${valueHtml}</span></div>`;
  }


    function formatScore(overrideVal, baseVal){
      const show = (x) => (typeof x === "number" && isFinite(x)) ? x.toFixed(2) : "—";
      if (typeof overrideVal === "number" && isFinite(overrideVal)) {
        return `${show(overrideVal)} <span class="badge warn">(override)</span>`;
      }
      return show(baseVal);
    }




  function renderInput(key, label, value, placeholder=""){
    const id = `f-${key}`;
    const safe = escapeHtml(value ?? "");
    const ph = placeholder ? ` placeholder="${placeholder}"` : "";
    return `
      <div class="row">
        <label for="${id}">${label}</label>
        <input id="${id}" type="text"${ph} value="${safe}" />
      </div>
    `;
  }



  function renderNumber(key, label, value){
    const id = `f-${key}`;
    const v = (value ?? "") === "" ? "" : String(value ?? "");
    return `<div class="field">
      <label for="${id}">${label}</label>
      <input id="${id}" type="number" min="0" max="1" step="0.01" value="${escapeHtml(v)}" />
    </div>`;
  }



  // --- selection + controlled loading ---
  function selectItem(state, docId){
    const { list } = ui[state];
    Array.from(list.children).forEach(el => {
      el.classList.toggle("selected", el.dataset.docId === docId);
    });
    selected[state] = docId || null;
    setHash(state, docId || null);
    if (docId) renderDetail(state, docId);
    else {
      const { detail } = ui[state];
      detail.innerHTML = `<div class="placeholder"><h2>${state[0].toUpperCase()+state.slice(1)}</h2><p>Wähle links ein Dokument.</p></div>`;
    }
  }

  async function loadState(state, wantDocId=null, { force=false } = {}){
    if (force || !cache[state].loaded){
      const items = await fetchDocs(state);
      cache[state].items = items;
      cache[state].loaded = true;
    }
    renderListFromCache(state);
    const items = cache[state].items;
    const docId = wantDocId || selected[state] || (items[0]?.docId || null);
    selectItem(state, docId);
    const { search } = ui[state];
    if (search && !search._wired){
      search._wired = true;
      search.addEventListener("input", () => renderList(state, cache[state].items));
    }
  }

  function updateCachesAfterRoute(updatedMeta, fromState, toState){
    const li = {
      docId: updatedMeta.docId,
      state: updatedMeta.state,
      originalFilename: updatedMeta.originalFilename,
      filePath: updatedMeta.filePath,
      createdAt: updatedMeta.createdAt,
    };
    if (cache[fromState]?.loaded){
      cache[fromState].items = cache[fromState].items.filter(i => i.docId !== updatedMeta.docId);
    }
    if (cache[toState]?.loaded){
      cache[toState].items = [li, ...cache[toState].items.filter(i => i.docId !== updatedMeta.docId)];
    }
    selected[toState] = updatedMeta.docId;
  }

  // --- Bulk nur auf ANGEZEIGTE Items (INBOX) ---
  function getDisplayedDocIds(state){
    const { list } = ui[state];
    return Array.from(list.querySelectorAll(".item"))
      .map(el => el.dataset.docId)
      .filter(Boolean);
  }
  async function runSerial(ids, worker){
    let ok = 0, fail = 0, skipped = 0;
    for (const id of ids){
      try {
        const res = await worker(id);
        if (res && res.skipped) skipped++;
        else ok++;
      } catch (e) {
        const msg = String(e?.message || e);
        if (msg.toLowerCase().includes("not classified") || msg.toLowerCase().includes("not_classified")) skipped++;
        else fail++;
      }
    }
    return { ok, fail, skipped, total: ids.length };
  }

  // --- events ---
  tabs.forEach(t => {
    t.addEventListener('click', async () => {
      const state = t.id.replace("tab-","");
      activateTab(state);
      await loadState(state, null, { force:true }); // Tab-Wechsel: Liste frisch laden
    });
    t.addEventListener('keydown', (e) => {
      const idx = tabs.indexOf(t);
      if (e.key === 'ArrowRight') tabs[(idx + 1) % tabs.length].focus();
      if (e.key === 'ArrowLeft') tabs[(idx - 1 + tabs.length) % tabs.length].focus();
    });
  });

  for (const state of states){
    const { list, refresh } = ui[state];
    list.addEventListener("click", (e) => {
      const card = e.target.closest(".item");
      if (!card) return;
      selectItem(state, card.dataset.docId);
    });
    list.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        const card = e.target.closest(".item");
        if (card) selectItem(state, card.dataset.docId);
      }
    });
    refresh?.addEventListener("click", async () => {
      const { docId } = parseHash();
      await loadState(state, docId, { force:true }); // expliziter Refresh
    });
  }

  // Bulk-Buttons in Inbox → nur auf ANGEZEIGTE Kacheln
  ui.inbox.bulkClassify?.addEventListener("click", async () => {
    try{
      const ids = getDisplayedDocIds("inbox");
      if (ids.length === 0) return alert("Keine angezeigten Dokumente in der Inbox.");
      ui.inbox.bulkClassify.disabled = true;

      const res = await runSerial(ids, async (docId) => {
        await classifyOne(docId);
        return { ok: true };
      });

      alert(`Klassifizierung (sichtbare): ${res.ok} ok, ${res.fail} Fehler, ${res.skipped} übersprungen, gesamt ${res.total}.\n\nHinweis: Die Liste wird nur per „Aktualisieren“ neu geladen.`);
    } catch(e){
      alert("Bulk-Klassifizierung fehlgeschlagen: " + String(e?.message || e));
    } finally {
      ui.inbox.bulkClassify.disabled = false;
    }
  });

  ui.inbox.bulkAutoRoute?.addEventListener("click", async () => {
    try{
      const ids = getDisplayedDocIds("inbox");
      if (ids.length === 0) return alert("Keine angezeigten Dokumente in der Inbox.");
      ui.inbox.bulkAutoRoute.disabled = true;

      const res = await runSerial(ids, async (docId) => {
        await autoRouteOne(docId, 0.7);
        return { ok: true };
      });

      alert(`Auto-Route (sichtbare): ${res.ok} geroutet, ${res.skipped} unklassifiziert, ${res.fail} Fehler, gesamt ${res.total}.`);

      // Inbox sofort neu laden
      await loadState("inbox", null, { force: true });
    } catch(e){
      alert("Bulk-Auto-Route fehlgeschlagen: " + String(e?.message || e));
    } finally {
      ui.inbox.bulkAutoRoute.disabled = false;
    }
  });

  // --- Upload (Inbox) ---
  async function uploadFiles(files) {
    if (!files || files.length === 0) return;

    const MAX_MB = 25;
    const bad = [], tooBig = [];
    for (const f of files) {
      const isPdf = f.type === "application/pdf" || (f.name || "").toLowerCase().endsWith(".pdf");
      if (!isPdf) bad.push(f.name);
      if (f.size > MAX_MB * 1024 * 1024) tooBig.push(f.name);
    }
    if (bad.length) return alert(`Nur PDFs erlaubt:\n- ${bad.join("\n- ")}`);
    if (tooBig.length) return alert(`> ${MAX_MB} MB:\n- ${tooBig.join("\n- ")}`);

    const fd = new FormData();
    for (const f of files) fd.append("files", f);

    ui.inbox.uploadBtn.disabled = true;
    ui.inbox.uploadBtn.textContent = "Lade hoch…";
    try {
      const res = await fetch(`${API_BASE}/api/upload`, { method: "POST", body: fd });
      if (!res.ok) {
        const err = await res.json().catch(()=> ({}));
        throw new Error(err?.message || `HTTP ${res.status}`);
      }
      const data = await res.json().catch(() => ({}));
      await loadState("inbox", null, { force: true });
      if (Array.isArray(data?.created) && data.created[0]) {
        selectItem("inbox", data.created[0]);
      }
    } catch (e) {
      alert("Upload fehlgeschlagen: " + String(e?.message || e));
    } finally {
      ui.inbox.uploadBtn.disabled = false;
      ui.inbox.uploadBtn.textContent = "Hochladen";
      ui.inbox.fileInput.value = "";
    }
  }

  ui.inbox.uploadBtn?.addEventListener("click", () => ui.inbox.fileInput?.click());
  ui.inbox.fileInput?.addEventListener("change", async (e) => {
    await uploadFiles(Array.from(e.target.files || []));
  });

  // Hashchange: Tab in Hash → frisch laden, sonst nur Auswahl ändern
  window.addEventListener("hashchange", async () => {
    const { state, docId } = parseHash();
    activateTab(state);
    await loadState(state, docId, { force:true });
  });

  // utils
  function val(sel, root=document){ const el = qs(sel, root); return el ? el.value.trim() : ""; }
  function escapeHtml(s){ return String(s ?? "").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

  // init
  (async function init(){
    const { state, docId } = parseHash();
    activateTab(state);
    await loadState(state, docId, { force:true }); // initialer Load
  })();
})();
