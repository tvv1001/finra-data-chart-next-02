/**
 * finra.js  –  FINRA BrokerCheck Network Graph
 *
 * Renders the finra-graph.json as an interactive D3 v7 force-directed graph.
 *
 * Nodes:
 *   individual  – blue circles  (people discovered from seed search)
 *   firm        – amber squares (registered broker-dealer / IA firms)
 *   entity      – grey diamonds (non-individual Form BD control owners)
 *
 * Links:
 *   employed_by – grey line  (person → firm, with date range on hover)
 *   controls    – red line   (person/entity → firm, from Form BD directOwners)
 */



// API base. When VITE_API_URL is not set, use relative paths so the dev
// server proxy (`/api`) is used and we don't hardcode a backend port.
const BASE = (typeof process !== "undefined" && process.env.NEXT_PUBLIC_API_URL) || "";
const ENABLE_SERVER_PROFILE_SYNC =
  typeof process !== "undefined" &&
  process.env.NEXT_PUBLIC_ENABLE_SERVER_PROFILE_SYNC === "1";

// Safely build an absolute URL for API calls. When `BASE` is empty the
// browser `location.origin` will be used so `new URL` never throws.
function makeApiUrl(path) {
  const p = path.startsWith("/") ? path : `/${path}`;
  const base = BASE || (typeof location !== "undefined" ? location.origin : "");
  return new URL(p, base);
}

function syncProfileSelection(payload) {
  if (!ENABLE_SERVER_PROFILE_SYNC) return;
  fetch(`${BASE}/api/finra/add-to-profile`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ profile: "custom", ...payload }),
  }).catch((err) =>
    console.error("Failed to sync profile selection to server:", err),
  );
}

let d3;

// ── State ──────────────────────────────────────────────────────────────────
let graphData = null; // { nodes, links, meta } — full dataset
let simulation = null;
let selectedId = null;
let linkSel = null; // current <line> selection
let nodeSel = null; // current <g.fg-node> selection
let layoutNodes = null; // node objects with x/y positions
let layoutLinks = null; // link objects (source/target resolved to objects)
let spreadAnimId = null; // rAF handle for neighbor spread animation
let isSubsetMode = false; // true when only a random sample is rendered
let neighborMap = null; // Map<nodeId, Set<nodeId>> — rebuilt each renderGraph
let nodeGroup = null; // <g.fg-nodes> selection — for live node injection
let linkGroup = null; // <g.fg-links> selection — for live link injection
// D3 references needed for restoring zoom state
let svgSel = null; // d3 selection for #fg-svg
let zoomBehavior = null; // d3.zoom() instance
let zoomSaveTimer = null; // debounce timer for zoom-state persistence
// Baseline snapshot from the initial server response for this page load.
// Used to identify which rendered nodes/links are truly "added" extras.
let initialServerNodeIds = null; // Set<id>
let initialServerLinkKeys = null; // Set<"source|target">
// Shared appender used by both UI actions and load-time session restore.
let appendFetched = null;

const INITIAL_SEED_COUNT = 25; // random seed nodes on first load (default select)
const FILTER_MATCH_LIMIT = 1; // maximum number of direct matches to show when filtering
const LS_SESSION_KEY = "finra_session"; // storage key for persisted session nodes
const SESSION_TTL_MS = 365 * 24 * 60 * 60 * 1000; // 1 year

// ── Session persistence helpers ────────────────────────────────────────────
// We save the IDs of any nodes the user has added beyond what the server
// initially served, plus the full data for nodes that won't be in the server
// graph (e.g. stub nodes added via Fetch).  On reload we reinject them.
function saveSession() {
  if (!layoutNodes || !graphData) return;
  try {
    // Collect nodes present in the live layout but not in the initial
    // server-returned subset for this page load — those are user-added extras.
    const serverIds =
      initialServerNodeIds || new Set(graphData.nodes.map((n) => n.id));
    const extraNodes = layoutNodes.filter((n) => !serverIds.has(n.id));
    // Also record baseline server IDs that are currently rendered
    const renderedServerIds = layoutNodes
      .filter((n) => serverIds.has(n.id))
      .map((n) => n.id);
    const baseLinkKeys =
      initialServerLinkKeys ||
      new Set(
        graphData.links.map((l) => {
          const s = l.source?.id ?? l.source;
          const t = l.target?.id ?? l.target;
          return `${s}|${t}`;
        }),
      );
    const payload = {
      renderedServerIds,
      nodePositions: layoutNodes.map((n) => ({
        id: n.id,
        x: Number.isFinite(n.x) ? n.x : null,
        y: Number.isFinite(n.y) ? n.y : null,
        fx: Number.isFinite(n.fx) ? n.fx : null,
        fy: Number.isFinite(n.fy) ? n.fy : null,
      })),
      extraNodes: extraNodes.map((n) => {
        // strip D3 simulation fields before storing
        const { x, y, vx, vy, fx, fy, index, ...rest } = n;
        return rest;
      }),
      extraLinks: layoutLinks
        .filter((l) => {
          const s = l.source?.id ?? l.source;
          const t = l.target?.id ?? l.target;
          return !baseLinkKeys.has(`${s}|${t}`);
        })
        .map((l) => ({
          source: l.source?.id ?? l.source,
          target: l.target?.id ?? l.target,
          relationship: l.relationship,
          startDate: l.startDate,
          endDate: l.endDate,
          city: l.city,
          state: l.state,
        })),
      zoomTransform: (() => {
        try {
          if (svgSel && typeof svgSel.node === "function") {
            const z = d3.zoomTransform(svgSel.node());
            return { x: z.x, y: z.y, k: z.k };
          }
        } catch {
          // ignore
        }
        return null;
      })(),
    };
    const envelope = {
      expiresAt: Date.now() + SESSION_TTL_MS,
      data: payload,
    };
    localStorage.setItem(LS_SESSION_KEY, JSON.stringify(envelope));
  } catch {
    // quota exceeded or private browsing — non-critical
  }
}

function clearSession() {
  // Clear both current and legacy locations
  localStorage.removeItem(LS_SESSION_KEY);
  sessionStorage.removeItem(LS_SESSION_KEY);
}

function loadSession() {
  try {
    const raw = localStorage.getItem(LS_SESSION_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      // New format with TTL envelope
      if (parsed && typeof parsed === "object" && "data" in parsed) {
        const expiresAt = Number(parsed.expiresAt || 0);
        if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) {
          localStorage.removeItem(LS_SESSION_KEY);
          return null;
        }
        return parsed.data || null;
      }
      // Backward-compatible fallback (plain payload in localStorage)
      return parsed || null;
    }

    // Legacy fallback: old sessionStorage payload
    const legacy = sessionStorage.getItem(LS_SESSION_KEY);
    return legacy ? JSON.parse(legacy) : null;
  } catch {
    return null;
  }
}

let currentProfileName = null;
let currentProfileEnabled = true;

function isProfileEnabled(profile) {
  return profile == null || profile.enabled !== false;
}

async function loadProfile(profileName) {
  let prof = null;
  try {
    const res = await fetch(
      makeApiUrl(`/api/finra/profile/${encodeURIComponent(profileName)}`).toString(),
      { cache: "no-store" },
    );
    if (res.ok) prof = await res.json();
  } catch {
    /* ignore */
  }

  if (
    !prof ||
    (typeof prof === "object" &&
      !Array.isArray(prof) &&
      !prof.seeds &&
      !Array.isArray(prof.individuals) &&
      !Array.isArray(prof.firms))
  ) {
    try {
      const seedsRes = await fetch(makeApiUrl("/api/finra/seeds").toString(), {
        cache: "no-store",
      });
      if (seedsRes.ok) {
        const seeds = await seedsRes.json();
        if (Array.isArray(seeds)) prof = seeds;
      }
    } catch {
      /* ignore */
    }
  }

  return prof;
}

async function restoreSavedSession(session) {
  if (!session) return;
  const renderedIds = new Set(layoutNodes.map((n) => n.id));
  const missingServerIds = (session.renderedServerIds || []).filter(
    (id) => !renderedIds.has(id),
  );
  if (missingServerIds.length) {
    await injectNodesById(missingServerIds);
  }

  if (session.extraNodes?.length || session.extraLinks?.length) {
    mergeIntoGraphData(session.extraNodes || [], session.extraLinks || []);
    appendFetched(session.extraNodes || [], session.extraLinks || []);
  }

  try {
    applySavedNodePositions(session.nodePositions || []);
  } catch {
    // non-critical
  }

  try {
    const parsed = parseZoomTransformString(session.zoomTransform);
    if (
      parsed &&
      zoomBehavior &&
      svgSel &&
      typeof svgSel.call === "function"
    ) {
      svgSel
        .transition()
        .duration(0)
        .call(
          zoomBehavior.transform,
          d3.zoomIdentity.translate(parsed.x, parsed.y).scale(parsed.k),
        );
    }
  } catch {
    // non-critical
  }
}

function clearGraphData() {
  graphData = { nodes: [], links: [], meta: {} };
  initialServerNodeIds = new Set();
  initialServerLinkKeys = new Set();
  isSubsetMode = false;
  clearSubsetInfo();
  renderGraph(graphData);
  updateMeta({ totalIndividuals: 0, totalFirms: 0, totalLinks: 0 });
  showEmpty(true);
}

async function loadBaselineGraph(profileName) {
  const url = makeApiUrl("/api/finra/graph");
  if (profileName) {
    url.searchParams.set("profile", profileName);
  }
  const res = await fetch(url.toString(), { cache: "no-store" });
  if (!res.ok) {
    if (res.status === 404) {
      showEmpty(true);
      return null;
    }
    throw new Error(`HTTP ${res.status}`);
  }
  graphData = await res.json();
  initialServerNodeIds = new Set(graphData.nodes.map((n) => n.id));
  initialServerLinkKeys = new Set(
    graphData.links.map((l) => {
      const s = l.source?.id ?? l.source;
      const t = l.target?.id ?? l.target;
      return `${s}|${t}`;
    }),
  );
  showEmpty(false);
  updateMeta(graphData.meta);
  const totalNodes = graphData.meta?.totalNodes ?? graphData.nodes.length;
  if (totalNodes > graphData.nodes.length) {
    isSubsetMode = true;
    updateSubsetInfo(graphData.nodes.length, totalNodes);
    const sel = document.getElementById("fg-subset-select");
    if (sel) sel.value = String(INITIAL_SEED_COUNT);
    renderGraph(graphData);
  } else {
    isSubsetMode = false;
    clearSubsetInfo();
    const sel = document.getElementById("fg-subset-select");
    if (sel) sel.value = "all";
    renderGraph(graphData);
  }
  return graphData;
}

async function resetSessionView() {
  clearSession();
  if (currentProfileEnabled) {
    try {
      await loadBaselineGraph(currentProfileName);
    } catch (err) {
      console.error("resetSessionView:", err);
      clearGraphData();
    }
  } else {
    clearGraphData();
  }
}

// Normalize saved zoom transform from either object form or SVG transform string.
function parseZoomTransformString(t) {
  if (t && typeof t === "object") {
    const x = Number(t.x);
    const y = Number(t.y);
    const k = Number(t.k);
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(k)) {
      return { x, y, k };
    }
  }
  if (!t || typeof t !== "string") return null;
  // match translate(x,y) scale(k)
  const m =
    /translate\((-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)\)\s*scale\((-?\d+(?:\.\d+)?)\)/.exec(
      t,
    );
  if (m) return { x: Number(m[1]), y: Number(m[2]), k: Number(m[3]) };
  // fallback: matrix(a,b,c,d,e,f) — approximate scale and extract translate
  const mm = /matrix\(([-0-9eE+.,\s]+)\)/.exec(t);
  if (mm) {
    const parts = mm[1].trim().split(/[ ,]+/).map(Number);
    if (parts.length >= 6) {
      const a = parts[0],
        b = parts[1],
        c = parts[2],
        d = parts[3],
        e = parts[4],
        f = parts[5];
      // approximate uniform scale from matrix
      const kx = Math.hypot(a, b);
      const ky = Math.hypot(c, d);
      const k = (kx + ky) / 2 || 1;
      return { x: e, y: f, k };
    }
  }
  return null;
}

function applySavedNodePositions(savedPositions) {
  if (!Array.isArray(savedPositions) || !layoutNodes || !simulation) return;

  const byId = new Map(savedPositions.map((p) => [p.id, p]));
  layoutNodes.forEach((n) => {
    const p = byId.get(n.id);
    if (!p) return;
    if (Number.isFinite(p.x)) n.x = p.x;
    if (Number.isFinite(p.y)) n.y = p.y;
    // Keep nodes fixed where they were so refresh reproduces exact layout.
    n.fx = Number.isFinite(p.fx) ? p.fx : Number.isFinite(p.x) ? p.x : n.fx;
    n.fy = Number.isFinite(p.fy) ? p.fy : Number.isFinite(p.y) ? p.y : n.fy;
  });

  if (linkSel) {
    linkSel
      .attr("x1", (d) => d.source.x)
      .attr("y1", (d) => d.source.y)
      .attr("x2", (d) => d.target.x)
      .attr("y2", (d) => d.target.y);
  }
  if (nodeSel) {
    nodeSel.attr("transform", (d) => `translate(${d.x},${d.y})`);
  }

  simulation.alpha(0).restart();
}

function hasDisclosures(d) {
  const listCount = Array.isArray(d?.disclosures) ? d.disclosures.length : 0;
  const count = Number(d?.disclosureCount || d?.disclosuresCount || 0);
  return listCount > 0 || count > 0;
}

function drawDisclosureIndicator(g, d, r) {
  if (!hasDisclosures(d)) return;
  if (d.group === "individual") {
    const rv = d._vizHalf != null ? d._vizHalf : r;
    g.append("circle")
      .attr("r", rv + 4)
      .attr("fill", "none")
      .attr("stroke", "#f97316")
      .attr("stroke-width", 0)
      .attr("stroke-dasharray", "3 2");
    return;
  }
  if (d.group === "firm") {
    const s = (d._vizHalf ?? r * 0.85) * 2;
    g.append("rect")
      .attr("x", -s / 2 - 4)
      .attr("y", -s / 2 - 4)
      .attr("width", s + 8)
      .attr("height", s + 8)
      .attr("rx", 6)
      .attr("fill", "none")
      .attr("stroke", "#f97316")
      .attr("stroke-width", 0)
      .attr("stroke-dasharray", "4 3");
  }
}

// ── Bootstrap ──────────────────────────────────────────────────────────────
export function init(_d3) { d3 = _d3;
  // Top toolbar buttons removed: refresh and run-scraper
  document.getElementById("btn-log-close").addEventListener("click", closeLog);

  const clearSessionBtn = document.getElementById("fg-clear-session");
  if (clearSessionBtn) {
    clearSessionBtn.addEventListener("click", async () => {
      clearSessionBtn.disabled = true;
      clearSessionBtn.textContent = "Clearing…";
      try {
        await resetSessionView();
        clearSessionBtn.textContent = "Cleared!";
      } catch (err) {
        console.error("clearSession failed:", err);
        clearSessionBtn.textContent = "Error";
      } finally {
        setTimeout(() => {
          clearSessionBtn.textContent = "Clear session";
          clearSessionBtn.disabled = false;
        }, 1500);
      }
    });
  }

  const subsetSelect = document.getElementById("fg-subset-select");
  if (subsetSelect) {
    subsetSelect.addEventListener("change", async () => {
      const v = subsetSelect.value;
      const limit = v === "all" ? 0 : parseInt(v, 10);
      if (isNaN(limit) || limit < 0) return;
      try {
        const url = makeApiUrl("/api/finra/graph");
        if (limit > 0) url.searchParams.set("limit", String(limit));
        const r = await fetch(url.toString(), { cache: "no-store" });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        graphData = await r.json();
        // Reset baseline snapshot for this newly loaded server subset.
        initialServerNodeIds = new Set(graphData.nodes.map((n) => n.id));
        initialServerLinkKeys = new Set(
          graphData.links.map((l) => {
            const s = l.source?.id ?? l.source;
            const t = l.target?.id ?? l.target;
            return `${s}|${t}`;
          }),
        );
        const totalNodes = graphData.meta?.totalNodes ?? graphData.nodes.length;
        if (limit > 0 && totalNodes > graphData.nodes.length) {
          isSubsetMode = true;
          updateSubsetInfo(graphData.nodes.length, totalNodes);
        } else {
          isSubsetMode = limit > 0;
          if (!isSubsetMode) clearSubsetInfo();
          else updateSubsetInfo(graphData.nodes.length, totalNodes);
        }
        renderGraph(graphData);
      } catch (err) {
        console.error("subset select fetch failed", err);
      }
    });
  }

  // Inline sanction loader: delegate clicks on disclosure links and fetch full text
  const sidebarInner = document.getElementById("fg-sidebar-inner");
  if (sidebarInner) {
    sidebarInner.addEventListener("click", async (ev) => {
      const a = ev.target.closest && ev.target.closest(".fg-dis-link");
      if (!a) return;
      ev.preventDefault();
      const docket = a.getAttribute("data-docket") || a.dataset.docket;
      if (!docket) return;

      // If already loaded, toggle visibility
      const parent = a.closest(".fg-disclosure");
      if (!parent) return;
      let holder = parent.querySelector(".fg-dis-full");
      if (holder) {
        holder.classList.toggle("hidden");
        return;
      }

      // Create placeholder
      holder = document.createElement("div");
      holder.className = "fg-dis-full";
      holder.textContent = "Loading full sanction…";
      parent.appendChild(holder);

      try {
        const r = await fetch(
          `${BASE}/api/finra/fda/${encodeURIComponent(docket)}`,
        );
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();

        // Prefer node body content if available
        let bodyText = null;
        if (j?.node) {
          const n = j.node;
          // JSON:API shape often under data.attributes.field_body or body.value
          const data = n.data || n;
          const attrs = data.attributes || {};
          bodyText =
            attrs?.body?.value ||
            attrs?.field_body?.value ||
            attrs?.field_fda_body?.value ||
            attrs?.body ||
            null;
          if (!bodyText && typeof data === "string") bodyText = data;
        }
        // Fallback: include meta.filtered_query_url or the raw meta as string
        if (!bodyText) {
          bodyText =
            j?.meta?.filtered_query_url ||
            JSON.stringify(j?.meta || j, null, 2);
        }

        // Insert sanitized plain-text preformatted block
        holder.innerHTML = "";
        const pre = document.createElement("pre");
        pre.style.whiteSpace = "pre-wrap";
        pre.style.fontFamily = "inherit";
        pre.textContent = bodyText;
        holder.appendChild(pre);
      } catch (err) {
        holder.textContent = `Failed to load sanction: ${err.message}`;
      }
    });
  }
  // Note: inline "Add Person" UI removed from top — keep log close only

  window.addEventListener("resize", onResize);

  // Search input (filters nodes by label, CRD, BD/IA SEC numbers)
  const searchEl = document.getElementById("fg-search");
  if (searchEl) {
    const debounced = debounce(
      (e) => filterGraph(e.target.value).catch(() => {}),
      200,
    );
    searchEl.addEventListener("input", debounced);
    searchEl.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        searchEl.value = "";
        filterGraph("").catch(() => {});
      }
    });
  }

  // Remote fetch button – search ALL results, inject every hit, persist to server
  const fetchBtn = document.getElementById("fg-fetch-remote");
  const fetchInput = document.getElementById("fg-fetch-input");
  if (fetchBtn && fetchInput) {
    const runRemoteFetch = async () => {
      const q = String(fetchInput.value || "").trim();
      if (!q) return;
      fetchBtn.disabled = true;
      const origText = fetchBtn.textContent;
      fetchBtn.textContent = "Fetching…";
      try {
        // ── 1. Search all three external endpoints in parallel ─────────────
        // FINRA firm:   https://api.brokercheck.finra.org/search/firm?query=…
        // FINRA indiv:  https://api.brokercheck.finra.org/search/individual?query=…
        // SEC indiv:    https://api.adviserinfo.sec.gov/search/individual?firm=…
        const PAGE_SIZE = 100; // FINRA Solr supports up to 100 per page
        const fetchFinraAll = async (useFirm) => {
          const hits = [];
          let start = 0;
          let total = null;
          do {
            const su = makeApiUrl("/api/finra/search");
            su.searchParams.set("query", q);
            su.searchParams.set("rows", String(PAGE_SIZE));
            su.searchParams.set("start", String(start));
            if (useFirm) su.searchParams.set("firm", "1");
            const sr = await fetch(su.toString());
            if (!sr.ok) break;
            const sj = await sr.json();
            const page =
              sj?.hits?.hits || sj?.response?.docs || sj?.results || [];
            if (total === null)
              total = sj?.hits?.total ?? sj?.response?.numFound ?? page.length;
            hits.push(...page);
            start += page.length;
            if (page.length < PAGE_SIZE) break;
          } while (start < total);
          return hits;
        };

        const fetchSec = async () => {
          // SEC adviserinfo: https://api.adviserinfo.sec.gov/search/individual?firm=…
          // Server translates ?query= → ?firm= before forwarding.
          const su = makeApiUrl("/api/finra/sec-search");
          su.searchParams.set("query", q);
          su.searchParams.set("pageSize", "50"); // SEC pagination
          su.searchParams.set("pageNumber", "1");
          const sr = await fetch(su.toString());
          if (!sr.ok) return [];
          const sj = await sr.json();
          // SEC wraps results under hits.hits or currentPage array
          return (
            sj?.hits?.hits ||
            sj?.response?.docs ||
            sj?.currentPage ||
            sj?.results ||
            []
          );
        };

        const [indHits, firmHits, secHits] = await Promise.all([
          fetchFinraAll(false),
          fetchFinraAll(true),
          fetchSec(),
        ]);
        const allHits = [...indHits, ...firmHits, ...secHits];

        // When query is a pure number, always inject synthetic hits so the
        // direct-by-ID lookup path runs even if text search returned nothing.
        if (/^\d+$/.test(q)) {
          if (
            !allHits.some(
              (h) =>
                String(
                  (h._source || h)?.firm_id || (h._source || h)?.firmId,
                ) === q,
            )
          )
            allHits.push({ _source: { firm_id: q } });
          if (
            !allHits.some(
              (h) =>
                String(
                  (h._source || h)?.ind_source_id || (h._source || h)?.ind_crd,
                ) === q,
            )
          )
            allHits.push({ _source: { ind_source_id: q } });
        }

        if (!allHits.length) {
          updateFetchStatus(`No remote results for "${q}"`);
          return;
        }

        // ── 2. Build nodes directly from search hit _source data ──────────
        // The search results already contain ind_firstname/lastname + ind_current_employments
        // (firm_id, firm_name) — no extra per-hit fetch needed.
        // We only fetch full detail for pure-numeric queries (direct CRD/firm ID lookup).
        const batchAllNodes = [];
        const batchAllLinks = [];

        const isDirectId = /^\d+$/.test(q);

        function addIndividualFromSource(src) {
          // Handle FINRA search results where data is in content JSON string
          let parsed = src;
          if (typeof src?.content === "string") {
            try {
              parsed = JSON.parse(src.content);
            } catch {
              // fallback to src
            }
          }

          const crd = String(
            parsed?.basicInformation?.individualId ||
              parsed?.ind_source_id ||
              parsed?.ind_crd ||
              parsed?.person?.crd ||
              "",
          ).trim();
          if (!crd) return;
          const existingGraphNode = findExistingPersonNode(crd);
          const personId = existingGraphNode?.id || `person:${crd}`;
          const personLabel =
            [
              parsed?.basicInformation?.firstName,
              parsed?.basicInformation?.middleName,
              parsed?.basicInformation?.lastName,
            ]
              .filter(Boolean)
              .join(" ") ||
            [src?.ind_firstname, src?.ind_middlename, src?.ind_lastname]
              .filter(Boolean)
              .join(" ") ||
            parsed?.name ||
            src?.name ||
            `CRD ${crd}`;

          if (existingGraphNode) {
            applyIndividualDetail(existingGraphNode, parsed, crd);
          } else if (!batchAllNodes.some((n) => n.id === personId)) {
            batchAllNodes.push(
              applyIndividualDetail(
                {
                  id: personId,
                  label: personLabel,
                  group: "individual",
                  crd,
                },
                parsed,
                crd,
              ),
            );
          }
          // Build firm connections from embedded employment data
          const emps = [
            ...(parsed?.currentEmployments || []).map(e => ({...e, _isCurrent: true})),
            ...(parsed?.currentIAEmployments || []).map(e => ({...e, _isCurrent: true})),
            ...(parsed?.previousEmployments || []).map(e => ({...e, _isCurrent: false})),
            ...(parsed?.previousIAEmployments || []).map(e => ({...e, _isCurrent: false})),
            ...(src?.ind_current_employments || []).map(e => ({...e, _isCurrent: true})),
          ];
          for (const e of emps) {
            const fid = String(e?.firmId || e?.firm_id || "").trim();
            if (!fid) continue;
            const existingFirmNode = findExistingFirmNode(fid);
            const firmNodeId = existingFirmNode?.id || `firm:${fid}`;
            if (
              !existingFirmNode &&
              !batchAllNodes.some((n) => n.id === firmNodeId)
            ) {
              batchAllNodes.push({
                id: firmNodeId,
                label: e?.firm_name || e?.firmName || `Firm ${fid}`,
                group: "firm",
                firmId: fid,
                bdSecNumber: e?.firm_bd_sec_number || e?.bdSecNumber,
                iaSecNumber: e?.firm_ia_sec_number || e?.iaSecNumber,
              });
            }
            if (
              !batchAllLinks.some(
                (l) =>
                  (l.source?.id ?? l.source) === personId &&
                  (l.target?.id ?? l.target) === firmNodeId,
              )
            ) {
              batchAllLinks.push({
                source: personId,
                target: firmNodeId,
                relationship: "employed_by",
                isCurrent: e._isCurrent,
              });
            }
          }
        }

        function addFirmFromSource(src) {
          const firmId = String(
            src?.firm_id || src?.firmId || src?.firm_source_id || "",
          ).trim();
          if (!firmId) return;
          const firmNodeId = `firm:${firmId}`;
          const firmLabel =
            src?.firm_name || src?.firmName || src?.name || `Firm ${firmId}`;
          if (!batchAllNodes.some((n) => n.id === firmNodeId)) {
            batchAllNodes.push({
              id: firmNodeId,
              label: firmLabel,
              group: "firm",
              firmId,
              bdSecNumber: src?.firm_bd_sec_number || src?.bdSecNumber,
              iaSecNumber: src?.firm_ia_sec_number || src?.iaSecNumber,
            });
          }
        }

        if (isDirectId) {
          // For direct numeric CRD/firm ID — fetch full detail to get rich sidebar data
          await Promise.allSettled(
            allHits.map(async (hit) => {
              const src = hit._source || hit;
              const crd = String(
                src?.ind_source_id || src?.ind_crd || "",
              ).trim();
              if (crd && /^\d+$/.test(crd)) {
                try {
                  const r = await fetch(
                    `${BASE}/api/finra/individual/${encodeURIComponent(crd)}`,
                  );
                  if (!r.ok) throw new Error(`${r.status}`);
                  const detail = unwrapDetailPayload(await r.json());
                  if (detail?.found === false) return;
                  addIndividualFromSource(detail);
                } catch {
                  // Ignore the synthetic direct-id fallback when the lookup fails.
                }
                return;
              }
              const firmId = String(
                src?.firm_id || src?.firmId || src?.firm_source_id || "",
              ).trim();
              if (firmId && /^\d+$/.test(firmId)) {
                try {
                  const r = await fetch(
                    `${BASE}/api/finra/firm/${encodeURIComponent(firmId)}`,
                  );
                  if (!r.ok) throw new Error(`${r.status}`);
                  const detail = await r.json();
                  if (detail?.found === false) return;
                  const firmNodeId = `firm:${firmId}`;
                  const bi = detail?.basicInformation || {};
                  const firmLabel =
                    bi.firmName ||
                    detail?.firmName ||
                    detail?.name ||
                    `Firm ${firmId}`;
                  if (!batchAllNodes.some((n) => n.id === firmNodeId)) {
                    batchAllNodes.push({
                      id: firmNodeId,
                      label: firmLabel,
                      group: "firm",
                      firmId,
                      bcScope: bi.bcScope ?? detail?.bcScope,
                      firmStatus: bi.firmStatus ?? detail?.firmStatus,
                      firmStatusDate:
                        bi.firmStatusDate ?? detail?.firmStatusDate,
                      firmType: bi.firmType ?? detail?.firmType,
                      formedState: bi.formedState ?? detail?.formedState,
                      formedDate: bi.formedDate ?? detail?.formedDate,
                      regulator: bi.regulator ?? detail?.regulator,
                      bdSecNumber:
                        bi.bdSECNumber ??
                        bi.bdSecNumber ??
                        detail?.bdSECNumber ??
                        detail?.bdSecNumber,
                      iaSecNumber: bi.iaSecNumber ?? detail?.iaSecNumber,
                      isLegacy: bi.isLegacy ?? detail?.isLegacy,
                      fiscalYearEnd:
                        bi.fiscalMonthEndCode ?? detail?.fiscalMonthEndCode,
                      otherNames: bi.otherNames ?? detail?.otherNames ?? [],
                      selfRegulatoryOrgs:
                        detail?.selfRegulatoryOrgs ?? detail?.SROs ?? [],
                      activeStates:
                        detail?.activeStates ?? detail?.registeredStates ?? [],
                      directOwners: detail?.directOwners ?? [],
                      disclosures: detail?.disclosures ?? [],
                    });
                  }
                  for (const o of detail?.directOwners || []) {
                    const pid = String(
                      o?.crdNumber || o?.crd || o?.personId || "",
                    ).trim();
                    if (!pid) continue;
                    const personNodeId = `person:${pid}`;
                    if (!batchAllNodes.some((n) => n.id === personNodeId)) {
                      batchAllNodes.push({
                        id: personNodeId,
                        label: o?.legalName || o?.name || `Person ${pid}`,
                        group: "individual",
                        crd: pid,
                      });
                    }
                    if (
                      !batchAllLinks.some(
                        (l) =>
                          (l.source?.id ?? l.source) === personNodeId &&
                          (l.target?.id ?? l.target) === firmNodeId,
                      )
                    ) {
                      batchAllLinks.push({
                        source: personNodeId,
                        target: firmNodeId,
                        relationship: "controls",
                      });
                    }
                  }
                } catch {
                  // Ignore the synthetic direct-id fallback when the lookup fails.
                }
                return;
              }
            }),
          );
        } else {
          // Text search — build nodes directly from search _source (fast, no extra fetches)
          for (const hit of allHits) {
            const src = hit._source || hit;
            const crd = String(src?.ind_source_id || src?.ind_crd || "").trim();
            if (crd) {
              addIndividualFromSource(src);
              continue;
            }
            const firmId = String(
              src?.firm_id || src?.firmId || src?.firm_source_id || "",
            ).trim();
            if (firmId) {
              addFirmFromSource(src);
              continue;
            }
            // stub for hits with no ID
            const label =
              src?.name ||
              [src?.ind_firstname, src?.ind_middlename, src?.ind_lastname]
                .filter(Boolean)
                .join(" ");
            if (label)
              batchAllNodes.push({
                id: `remote:${Date.now()}:${Math.random()}`,
                label,
                group: "individual",
              });
          }
        }

        // ── 3. Append all nodes/links to the live view ─────────────────────
        if (batchAllNodes.length === 0) {
          updateFetchStatus(`No structured data found for "${q}"`);
          return;
        }
        appendFetched(batchAllNodes, batchAllLinks);

        // ── 4. Update in-memory graphData so filter/subset sees new nodes ──
        mergeIntoGraphData(batchAllNodes, batchAllLinks);

        // ── 5. Reveal connected graph neighbors for fetched nodes ─────────
        await expandFetchedNodes(batchAllNodes, 1);

        // ── 6. Persist to server so data survives page reload ──────────────
        persistToServer(batchAllNodes, batchAllLinks);

        const newCount = batchAllNodes.length;
        updateFetchStatus(
          `Added ${newCount} node${newCount !== 1 ? "s" : ""} for "${q}"`,
        );
      } catch (err) {
        console.error("remote fetch failed", err);
        updateFetchStatus(`Fetch error: ${err?.message || err}`);
      } finally {
        fetchBtn.disabled = false;
        fetchBtn.textContent = origText;
      }
    };

    fetchBtn.addEventListener("click", runRemoteFetch);
    fetchInput.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        runRemoteFetch();
      }
    });
  }

  function updateFetchStatus(msg) {
    const info = document.getElementById("fg-subset-info");
    if (info) info.textContent = msg;
    setTimeout(() => {
      // restore subset info after a short delay (if subset mode)
      if (isSubsetMode && graphData)
        updateSubsetInfo(layoutNodes.length, graphData.nodes.length);
      else if (!isSubsetMode) clearSubsetInfo();
    }, 3500);
  }

  function applyIndividualDetail(targetNode, detail, fallbackCrd = null) {
    if (!targetNode || !detail) return targetNode;

    const bi = detail?.basicInformation || {};
    targetNode.basicInformation = bi;

    if (bi.individualId || fallbackCrd) {
      targetNode.crd = String(bi.individualId || fallbackCrd);
    }
    if (bi.bcScope) targetNode.bcScope = bi.bcScope;
    if (bi.iaScope) targetNode.iaScope = bi.iaScope;

    const fullName = [bi.firstName, bi.middleName, bi.lastName]
      .filter(Boolean)
      .join(" ");
    if (fullName) targetNode.label = fullName;
    if (Array.isArray(bi.otherNames)) targetNode.otherNames = bi.otherNames;

    if (Array.isArray(detail.currentEmployments)) {
      targetNode.currentEmployments = detail.currentEmployments;
    }
    if (Array.isArray(detail.previousEmployments)) {
      targetNode.previousEmployments = detail.previousEmployments;
    }
    if (Array.isArray(detail.currentIAEmployments)) {
      targetNode.currentIAEmployments = detail.currentIAEmployments;
    }
    if (Array.isArray(detail.previousIAEmployments)) {
      targetNode.previousIAEmployments = detail.previousIAEmployments;
    }

    if (Array.isArray(detail.disclosures)) {
      targetNode.disclosures = detail.disclosures;
    }
    if (Array.isArray(detail.iaDisclosures)) {
      targetNode.iaDisclosures = detail.iaDisclosures;
    }
    if (bi.disclosureFlag) targetNode.disclosureFlag = bi.disclosureFlag;
    if (detail.disclosureFlag)
      targetNode.disclosureFlag = detail.disclosureFlag;
    if (detail.iaDisclosureFlag) {
      targetNode.iaDisclosureFlag = detail.iaDisclosureFlag;
    }

    if (detail.examsCount) targetNode.examsCount = detail.examsCount;
    if (Array.isArray(detail.stateExamCategory)) {
      targetNode.stateExamCategory = detail.stateExamCategory;
    }
    if (Array.isArray(detail.principalExamCategory)) {
      targetNode.principalExamCategory = detail.principalExamCategory;
    }
    if (Array.isArray(detail.productExamCategory)) {
      targetNode.productExamCategory = detail.productExamCategory;
    }

    if (Array.isArray(detail.registeredSROs)) {
      targetNode.registeredSROs = detail.registeredSROs;
    }
    if (Array.isArray(detail.registeredStates)) {
      targetNode.registeredStates = detail.registeredStates;
    }
    if (detail.registrationCount) {
      targetNode.registrationCount = detail.registrationCount;
    }
    if (detail.brokerDetails) targetNode.brokerDetails = detail.brokerDetails;

    try {
      const firms = new Set();
      for (const employment of [
        ...(detail.currentEmployments || []),
        ...(detail.previousEmployments || []),
        ...(detail.currentIAEmployments || []),
        ...(detail.previousIAEmployments || []),
      ]) {
        if (employment?.firmId) firms.add(employment.firmId);
        else if (employment?.bdSECNumber) firms.add(employment.bdSECNumber);
      }
      targetNode.firmCount = firms.size;
    } catch {
      /* ignore */
    }

    try {
      if (bi.daysInIndustry) {
        targetNode.daysInIndustry = Number(bi.daysInIndustry);
        targetNode.yearsExperience = Math.floor(
          targetNode.daysInIndustry / 365,
        );
      } else if (
        bi.daysInIndustryCalculatedDate ||
        bi.daysInIndustryCalculatedDateIAPD
      ) {
        const dstr =
          bi.daysInIndustryCalculatedDate ||
          bi.daysInIndustryCalculatedDateIAPD;
        const year = new Date(dstr).getFullYear();
        if (year && !Number.isNaN(year)) {
          targetNode.yearsExperience = Math.max(
            0,
            new Date().getFullYear() - year,
          );
        }
      }
    } catch {
      /* ignore */
    }

    try {
      const current =
        detail.currentEmployments?.[0] || detail.currentIAEmployments?.[0];
      if (current) {
        const office = current.branchOfficeLocations?.[0];
        const parts = office
          ? [
              office.street1,
              office.street2,
              office.city,
              office.state,
              office.zipCode,
            ].filter(Boolean)
          : [];
        targetNode.primaryOffice = {
          firmId: current.firmId,
          firmName: current.firmName,
          address: parts.join(", "),
        };
      }
    } catch {
      /* ignore */
    }

    targetNode._detailLoaded = true;
    return targetNode;
  }

  function findExistingPersonNode(crd) {
    const value = String(crd);
    return (
      layoutNodes.find(
        (n) =>
          n.group === "individual" &&
          (n.id === `person:${value}` ||
            n.id === `person_${value}` ||
            String(n.crd || "") === value),
      ) || null
    );
  }

  function findExistingFirmNode(firmId) {
    const value = String(firmId);
    return (
      layoutNodes.find(
        (n) =>
          n.group === "firm" &&
          (n.id === `firm:${value}` ||
            n.id === `firm_${value}` ||
            String(n.firmId || "") === value),
      ) || null
    );
  }

  function normalizeProfileIds(items) {
    return (Array.isArray(items) ? items : [])
      .map((item) => String(item ?? "").trim())
      .filter((value) => /^[0-9]+$/.test(value));
  }

  // Batch helper: fetch individual detail and return nodes/links without injecting.
  async function fetchIndividualBatch(crd, queryLabel) {
    if (!/^[0-9]+$/.test(String(crd))) {
      throw new Error(`invalid individual id ${crd}`);
    }
    const nodes = [];
    const links = [];
    try {
      const r = await fetch(
        `${BASE}/api/finra/individual/${encodeURIComponent(crd)}`,
      );
      if (!r.ok) throw new Error(`individual HTTP ${r.status}`);
      const detail = unwrapDetailPayload(await r.json());
      if (detail?.found === false) throw new Error(`individual ${crd} not found`);

      const personId = `person:${crd}`;
      const personLabel =
        (detail?.basicInformation &&
          [
            detail.basicInformation.firstName,
            detail.basicInformation.middleName,
            detail.basicInformation.lastName,
          ]
            .filter(Boolean)
            .join(" ")) ||
        (detail?.basicInformation && detail.basicInformation?.name) ||
        queryLabel ||
        `CRD ${crd}`;

      nodes.push(
        applyIndividualDetail(
          {
            id: personId,
            label: personLabel,
            group: "individual",
            crd,
          },
          detail,
          crd,
        ),
      );

      const emps = [
        ...(detail?.currentEmployments || []).map(e => ({...e, _isCurrent: true})),
        ...(detail?.currentIAEmployments || []).map(e => ({...e, _isCurrent: true})),
        ...(detail?.previousEmployments || []).map(e => ({...e, _isCurrent: false})),
        ...(detail?.previousIAEmployments || []).map(e => ({...e, _isCurrent: false})),
        ...(detail?.employments || []),
      ];
      for (const e of emps) {
        const fid =
          e?.firmId || e?.firm_id || e?.firmIdNumber || e?.firmId || null;
        if (!fid) continue;
        const firmNodeId = `firm:${fid}`;
        if (
          !nodes.some((n) => n.id === firmNodeId) &&
          !layoutNodes.some((n) => n.id === firmNodeId)
        ) {
          const firmLabel = e?.firmName || e?.name || `Firm ${fid}`;
          nodes.push({
            id: firmNodeId,
            label: firmLabel,
            group: "firm",
            firmId: String(fid),
          });
        }
        links.push({
          source: personId,
          target: firmNodeId,
          relationship: "employed_by",
          isCurrent: e._isCurrent,
        });
      }
    } catch (e) {
      // propagate to caller but return what we have so far
      throw e;
    }
    return { nodes, links };
  }

  // Batch helper: fetch firm detail and return nodes/links without injecting.
  async function fetchFirmBatch(firmId, queryLabel) {
    if (!/^[0-9]+$/.test(String(firmId))) {
      throw new Error(`invalid firm id ${firmId}`);
    }
    const nodes = [];
    const links = [];
    try {
      const r = await fetch(
        `${BASE}/api/finra/firm/${encodeURIComponent(firmId)}`,
      );
      if (!r.ok) throw new Error(`firm HTTP ${r.status}`);
      const detail = unwrapDetailPayload(await r.json());
      if (detail?.found === false) throw new Error(`firm ${firmId} not found`);
      const firmNodeId = `firm:${firmId}`;
      const firmLabel =
        detail?.firmName || detail?.name || queryLabel || `Firm ${firmId}`;
      nodes.push({
        id: firmNodeId,
        label: firmLabel,
        group: "firm",
        firmId: String(firmId),
      });

      const owners = detail?.directOwners || detail?.owners || [];
      for (const o of owners) {
        const pid = o?.crdNumber || o?.crd || o?.personId || null;
        if (!pid) continue;
        const personNodeId = `person:${pid}`;
        if (
          !nodes.some((n) => n.id === personNodeId) &&
          !layoutNodes.some((n) => n.id === personNodeId)
        ) {
          const pname = o?.legalName || o?.name || `Person ${pid}`;
          nodes.push({
            id: personNodeId,
            label: pname,
            group: "individual",
            crd: pid,
          });
        }
        links.push({
          source: personNodeId,
          target: firmNodeId,
          relationship: "controls",
        });
      }
    } catch (e) {
      throw e;
    }
    return { nodes, links };
  }

  // Helper: fetch individual detail and inject person + their firms
  async function fetchAndInjectIndividual(crd, queryLabel) {
    try {
      const r = await fetch(
        `${BASE}/api/finra/individual/${encodeURIComponent(crd)}`,
      );
      if (!r.ok) throw new Error(`individual HTTP ${r.status}`);
      const detail = unwrapDetailPayload(await r.json());

      const existingNode = findExistingPersonNode(crd);
      const personId = existingNode?.id || `person:${crd}`;
      const personLabel =
        (detail?.basicInformation &&
          [
            detail.basicInformation.firstName,
            detail.basicInformation.middleName,
            detail.basicInformation.lastName,
          ]
            .filter(Boolean)
            .join(" ")) ||
        (detail?.basicInformation && detail.basicInformation?.name) ||
        queryLabel ||
        `CRD ${crd}`;
      const newNodes = [];
      const newLinks = [];

      if (existingNode) {
        applyIndividualDetail(existingNode, detail, crd);
      } else {
        const personNode = applyIndividualDetail(
          {
            id: personId,
            label: personLabel,
            group: "individual",
            crd,
          },
          detail,
          crd,
        );
        newNodes.push(personNode);
      }

      const emps = [
        ...(detail?.currentEmployments || []).map(e => ({...e, _isCurrent: true})),
        ...(detail?.currentIAEmployments || []).map(e => ({...e, _isCurrent: true})),
        ...(detail?.previousEmployments || []).map(e => ({...e, _isCurrent: false})),
        ...(detail?.previousIAEmployments || []).map(e => ({...e, _isCurrent: false})),
        ...(detail?.employments || []),
      ];
      for (const e of emps) {
        const fid =
          e?.firmId || e?.firm_id || e?.firmIdNumber || e?.firmId || null;
        if (!fid) continue;
        const existingFirmNode = findExistingFirmNode(fid);
        const firmNodeId = existingFirmNode?.id || `firm:${fid}`;
        if (!existingFirmNode && !newNodes.some((n) => n.id === firmNodeId)) {
          const firmLabel = e?.firmName || e?.name || `Firm ${fid}`;
          newNodes.push({
            id: firmNodeId,
            label: firmLabel,
            group: "firm",
            firmId: String(fid),
          });
        }
        // add link
        if (
          !layoutLinks.some(
            (l) =>
              (l.source?.id || l.source) === personId &&
              (l.target?.id || l.target) === firmNodeId,
          )
        ) {
          newLinks.push({
            source: personId,
            target: firmNodeId,
            relationship: "employed_by",
            isCurrent: e._isCurrent,
          });
        }
      }

      appendFetched(newNodes, newLinks);

      // Try to enrich firm labels by fetching firm details (best-effort)
      for (const fn of newNodes.filter((n) => n.group === "firm")) {
        const fid = String(fn.id).replace(/^firm:/, "");
        try {
          const fr = await fetch(
            `${BASE}/api/finra/firm/${encodeURIComponent(fid)}`,
          );
          if (!fr.ok) continue;
          const fdet = unwrapDetailPayload(await fr.json());
          const lbl = fdet?.firmName || fdet?.companyName || fn.label;
          // update in layoutNodes
          const ln = layoutNodes.find((x) => x.id === fn.id);
          if (ln) ln.label = lbl;
        } catch (e) {
          /* ignore */
        }
      }
    } catch (e) {
      throw e;
    }
  }

  // Helper: fetch firm detail and inject firm + connected people evidence
  async function fetchAndInjectFirm(firmId, queryLabel) {
    try {
      const r = await fetch(
        `${BASE}/api/finra/firm/${encodeURIComponent(firmId)}`,
      );
      if (!r.ok) throw new Error(`firm HTTP ${r.status}`);
      const detail = unwrapDetailPayload(await r.json());
      if (detail?.found === false) throw new Error(`firm ${firmId} not found`);
      const existingFirmNode = findExistingFirmNode(firmId);
      const firmNodeId = existingFirmNode?.id || `firm:${firmId}`;
      const firmLabel =
        detail?.firmName || detail?.name || queryLabel || `Firm ${firmId}`;
      const newNodes = [];
      const newLinks = [];
      if (existingFirmNode) {
        existingFirmNode.label = firmLabel;
        existingFirmNode.firmId = String(firmId);
      } else {
        newNodes.push({
          id: firmNodeId,
          label: firmLabel,
          group: "firm",
          firmId: String(firmId),
        });
      }
      // Try to discover related individuals from Form BD owners or evidence
      const owners = detail?.directOwners || detail?.owners || [];
      for (const o of owners) {
        const pid = o?.crdNumber || o?.crd || o?.personId || null;
        if (!pid) continue;
        const personNodeId = `person:${pid}`;
        if (
          !layoutNodes.some((n) => n.id === personNodeId) &&
          !newNodes.some((n) => n.id === personNodeId)
        ) {
          const pname = o?.legalName || o?.name || `Person ${pid}`;
          newNodes.push({
            id: personNodeId,
            label: pname,
            group: "individual",
          });
        }
        if (
          !layoutLinks.some(
            (l) =>
              (l.source?.id || l.source) === personNodeId &&
              (l.target?.id || l.target) === firmNodeId,
          )
        ) {
          newLinks.push({
            source: personNodeId,
            target: firmNodeId,
            relationship: "controls",
          });
        }
      }

      appendFetched(newNodes, newLinks);
    } catch (e) {
      throw e;
    }
  }

  // Inject a single simple node
  function injectSimpleNode(n) {
    appendFetched([n], []);
  }

  // Append fetched nodes/links into live layout (reuse revealNeighbors append logic)
  appendFetched = function appendFetched(newNodes, newLinks) {
    if (!Array.isArray(newNodes)) newNodes = [];
    if (!Array.isArray(newLinks)) newLinks = [];

    // avoid duplicates
    const existIds = new Set(layoutNodes.map((n) => n.id));
    const uniqNodes = newNodes.filter((n) => !existIds.has(n.id));

    // Place newly-added nodes near the viewport center so they're visible immediately
    if (uniqNodes.length > 0) {
      const main = document.getElementById("fg-main");
      const W = main?.clientWidth || 800;
      const H = main?.clientHeight || 600;
      uniqNodes.forEach((n, i) => {
        if (n.x == null && n.y == null) {
          n.x = W / 2 + (Math.random() - 0.5) * 180 + (i % 5) * 8;
          n.y = H / 2 + (Math.random() - 0.5) * 180 + (i % 7) * 6;
        }
      });
    }
    // push
    layoutNodes.push(...uniqNodes);
    layoutLinks.push(
      ...newLinks.filter((l) => {
        const s = l.source?.id ?? l.source;
        const t = l.target?.id ?? l.target;
        // avoid duplicate link
        return !layoutLinks.some(
          (el) =>
            (el.source?.id ?? el.source) === s &&
            (el.target?.id ?? el.target) === t,
        );
      }),
    );

    // Rebuild neighbor cache and update info
    neighborMap = buildNeighborMap(layoutNodes, layoutLinks);
    if (layoutNodes.length || layoutLinks.length) showEmpty(false);
    if (graphData) updateSubsetInfo(layoutNodes.length, graphData.nodes.length);
    updateMeta();

    // Persist session so reload restores these nodes
    saveSession();

    // Append DOM nodes/links similar to revealNeighbors
    const allLinks = linkGroup.selectAll("line").data(layoutLinks, (d) => {
      const s = d.source?.id ?? d.source;
      const t = d.target?.id ?? d.target;
      return `${s}-${t}-${d.relationship}`;
    });
    const enteredLinks = allLinks
      .enter()
      .append("line")
      .attr("stroke", (d) => getLinkColor(d))
      .attr("stroke-width", 0.25)
      .attr("marker-end", (d) => getLinkMarker(d));
    enteredLinks
      .transition()
      .duration(400)
      .attr("stroke-opacity", defaultLinkOpacity);
    linkSel = linkGroup.selectAll("line");

    const allNodes = nodeGroup
      .selectAll("g.fg-node")
      .data(layoutNodes, (d) => d.id);
    const enteredNodes = allNodes
      .enter()
      .append("g")
      .attr("class", "fg-node")
      .attr("opacity", 0)
      .call(fluidDrag())
      .on("click", (event, d) => {
        event.stopPropagation();
        selectNode(d);
      });

    enteredNodes.each(function (d) {
      const g = d3.select(this);
      const r = NODE_R[d.group] || 10;
      const color = NODE_COLOR[d.group] || "#475569";
      if (d.group === "firm") {
        const s = (d._vizHalf ?? r * 0.85) * 2 || r * 2;
        g.append("rect")
          .attr("x", -s / 2)
          .attr("y", -s / 2)
          .attr("width", s)
          .attr("height", s)
          .attr("rx", 3)
          .attr("fill", color)
          .attr("stroke", "#fff")
          .attr("stroke-width", 1.5)
          .attr("opacity", d.stub ? 0.45 : 0.9);
      } else if (d.group === "entity") {
        const s = r * 1.5;
        g.append("polygon")
          .attr("points", `0,${-s} ${s},0 0,${s} ${-s},0`)
          .attr("fill", color)
          .attr("stroke", "#fff")
          .attr("stroke-width", 1.5)
          .attr("opacity", 0.8);
      } else {
        const rv = d._vizHalf != null ? d._vizHalf : r;
        g.append("circle")
          .attr("r", rv)
          .attr("fill", color)
          .attr("stroke", "#fff")
          .attr("stroke-width", 1.5)
          .attr("opacity", d.stub ? 0.5 : 1);
      }
      ["halo", "fill"].forEach((pass) => {
        g.append("text")
          .attr("class", `fg-label-${pass}`)
          .attr("dy", d._vizHalf != null ? d._vizHalf + 14 : r + 14)
          .attr("text-anchor", "middle")
          .attr("font-size", "10px")
          .attr("font-family", "var(--sans)")
          .attr("font-weight", "500")
          .attr("fill", pass === "halo" ? "none" : "#1e293b")
          .attr("stroke", pass === "halo" ? "rgba(246,248,252,0.92)" : "none")
          .attr("stroke-width", pass === "halo" ? 4 : 0)
          .attr("stroke-linejoin", "round")
          .attr("paint-order", "stroke")
          .attr("pointer-events", "none")
          .text(truncate(capitalize(d.label), 22));
      });
      g.append("title").text(() => {
        const parts = [d.label, d.group?.toUpperCase?.() || ""];
        if (d.crd) parts.push(`CRD: ${d.crd}`);
        return parts.join("\n");
      });
    });

    // Apply initial transform so new nodes appear at their placed position
    // immediately (the renderGraph tick handler only covers old nodes).
    enteredNodes.attr("transform", (d) => `translate(${d.x ?? 0},${d.y ?? 0})`);

    enteredNodes.transition().duration(400).attr("opacity", 1);
    nodeSel = nodeGroup.selectAll("g.fg-node");
    linkSel = linkGroup.selectAll("line");

    refreshGraphColors();

    // Replace tick handler so it covers the full updated selections.
    simulation.on("tick", () => {
      linkSel
        .attr("x1", (d) => d.source.x)
        .attr("y1", (d) => d.source.y)
        .attr("x2", (d) => d.target.x)
        .attr("y2", (d) => d.target.y);
      nodeSel.attr("transform", (d) => `translate(${d.x},${d.y})`);
    });

    // Restart simulation with new nodes/links
    simulation.nodes(layoutNodes);
    simulation.force("link").links(layoutLinks);
    simulation.alpha(0.45).restart();
    updateMeta();

    // Reveal any connected neighbors for nodes that were just added.
    if (uniqNodes.length && typeof revealNeighbors === "function") {
      uniqNodes.forEach((node) => {
        try {
          revealNeighbors(node, 1);
        } catch (e) {
          console.warn("Failed to reveal neighbors for loaded node:", node.id, e);
        }
      });
    }
  };

  // Add-person UI removed per user request

  // ── Location search handlers ──────────────────────────────────────────────
  const locStatus = document.getElementById("fg-loc-status");

  function setLocStatus(msg, isErr = false) {
    if (!locStatus) return;
    locStatus.textContent = msg;
    locStatus.style.color = isErr ? "var(--c-controls)" : "var(--text-m)";
    if (msg)
      setTimeout(() => {
        if (locStatus.textContent === msg) locStatus.textContent = "";
      }, 5000);
  }

  // Shared: process raw FINRA search hits from a location response
  async function processLocationHits(hits) {
    if (!hits.length) return { nodes: [], links: [] };
    const MAX_HITS = 50;
    const batchNodes = [];
    const batchLinks = [];
    await Promise.allSettled(
      hits.slice(0, MAX_HITS).map(async (hit) => {
        const src = hit._source || hit;
        const crd = String(src?.ind_source_id || src?.ind_crd || "").trim();
        if (crd && /^\d+$/.test(crd)) {
          try {
            const r = await fetch(
              `${BASE}/api/finra/individual/${encodeURIComponent(crd)}`,
            );
            if (!r.ok) return;
            const detail = unwrapDetailPayload(await r.json());
            if (detail?.found === false) return;
            const personId = `person:${crd}`;
            const personLabel =
              detail?.basicInformation?.name || src?.name || `CRD ${crd}`;
            if (!batchNodes.some((n) => n.id === personId))
              batchNodes.push({
                id: personId,
                label: personLabel,
                group: "individual",
                crd,
              });
            for (const e of [
              ...(detail?.currentEmployments || []).map(e => ({...e, _isCurrent: true})),
              ...(detail?.previousEmployments || []).map(e => ({...e, _isCurrent: false})),
            ]) {
              const fid = String(
                e?.firmId || e?.firm_id || e?.firmIdNumber || "",
              ).trim();
              if (!fid) continue;
              const firmNodeId = `firm:${fid}`;
              if (!batchNodes.some((n) => n.id === firmNodeId))
                batchNodes.push({
                  id: firmNodeId,
                  label: e?.firmName || `Firm ${fid}`,
                  group: "firm",
                });
              if (
                !batchLinks.some(
                  (l) =>
                    (l.source?.id ?? l.source) === personId &&
                    (l.target?.id ?? l.target) === firmNodeId,
                )
              )
                batchLinks.push({
                  source: personId,
                  target: firmNodeId,
                  relationship: "employed_by",
                  isCurrent: e._isCurrent,
                });
            }
          } catch {
            /* skip */
          }
          return;
        }
        // Firm hit (from zip search)
        const firmId = String(
          src?.firm_id || src?.firmId || src?.firm_source_id || "",
        ).trim();
        if (firmId && /^\d+$/.test(firmId)) {
          try {
            const r = await fetch(
              `${BASE}/api/finra/firm/${encodeURIComponent(firmId)}`,
            );
            if (!r.ok) return;
            const detail = await r.json();
            if (detail?.found === false) return;
            const firmNodeId = `firm:${firmId}`;
            if (!batchNodes.some((n) => n.id === firmNodeId))
              batchNodes.push({
                id: firmNodeId,
                label: detail?.firmName || src?.name || `Firm ${firmId}`,
                group: "firm",
              });
            for (const o of detail?.directOwners || []) {
              const pid = String(o?.crdNumber || o?.crd || "").trim();
              if (!pid) continue;
              const personNodeId = `person:${pid}`;
              if (!batchNodes.some((n) => n.id === personNodeId))
                batchNodes.push({
                  id: personNodeId,
                  label: o?.legalName || o?.name || `Person ${pid}`,
                  group: "individual",
                  crd: pid,
                });
              if (
                !batchLinks.some(
                  (l) =>
                    (l.source?.id ?? l.source) === personNodeId &&
                    (l.target?.id ?? l.target) === firmNodeId,
                )
              )
                batchLinks.push({
                  source: personNodeId,
                  target: firmNodeId,
                  relationship: "controls",
                });
            }
          } catch {
            /* skip */
          }
        }
      }),
    );
    return { nodes: batchNodes, links: batchLinks };
  }

  // City / State → individual search
  const cityBtn = document.getElementById("fg-loc-city-search");
  if (cityBtn) {
    cityBtn.addEventListener("click", async () => {
      const city = (document.getElementById("fg-loc-city")?.value || "").trim();
      if (!city) {
        setLocStatus("Enter a city to search", true);
        return;
      }
      cityBtn.disabled = true;
      cityBtn.textContent = "Searching…";
      setLocStatus(`Searching people in ${city}…`);
      try {
        const u = makeApiUrl("/api/finra/location-search");
        u.searchParams.set("city", city);
        const r = await fetch(u.toString());
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        const hits = data?.hits?.hits || data?.response?.docs || [];
        if (!hits.length) {
          setLocStatus(`No results for ${city}`);
          return;
        }
        const { nodes, links } = await processLocationHits(hits);
        if (!nodes.length) {
          setLocStatus("No structured records found");
          return;
        }
        appendFetched(nodes, links);
        mergeIntoGraphData(nodes, links);
        persistToServer(nodes, links);
        setLocStatus(
          `Added ${nodes.length} node${nodes.length !== 1 ? "s" : ""} for ${city}`,
        );
      } catch (err) {
        console.error("city search failed", err);
        setLocStatus(`Error: ${err.message}`, true);
      } finally {
        cityBtn.disabled = false;
        cityBtn.textContent = "Search People";
      }
    });
  }

  // ZIP / radius → firm search
  const zipBtn = document.getElementById("fg-loc-zip-search");
  const radiusInput = document.getElementById("fg-loc-radius");
  const radiusVal = document.getElementById("fg-loc-radius-val");
  if (radiusInput && radiusVal) {
    radiusInput.addEventListener("input", () => {
      radiusVal.textContent = `${radiusInput.value} mi`;
    });
  }
  if (zipBtn) {
    zipBtn.addEventListener("click", async () => {
      const zip = (document.getElementById("fg-loc-zip")?.value || "").trim();
      const radius = radiusInput?.value || "25";
      if (!zip) {
        setLocStatus("Enter a ZIP code", true);
        return;
      }
      zipBtn.disabled = true;
      zipBtn.textContent = "Searching…";
      setLocStatus(`Searching firms within ${radius} mi of ${zip}…`);
      try {
        const u = makeApiUrl("/api/finra/location-search");
        u.searchParams.set("zip", zip);
        u.searchParams.set("radius", radius);
        const r = await fetch(u.toString());
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        const hits = data?.hits?.hits || data?.response?.docs || [];
        if (!hits.length) {
          setLocStatus(`No firms found within ${radius} mi of ${zip}`);
          return;
        }
        const { nodes, links } = await processLocationHits(hits);
        if (!nodes.length) {
          setLocStatus("No structured firm records found");
          return;
        }
        appendFetched(nodes, links);
        mergeIntoGraphData(nodes, links);
        persistToServer(nodes, links);
        setLocStatus(
          `Added ${nodes.length} node${nodes.length !== 1 ? "s" : ""} within ${radius} mi of ${zip}`,
        );
      } catch (err) {
        console.error("zip search failed", err);
        setLocStatus(`Error: ${err.message}`, true);
      } finally {
        zipBtn.disabled = false;
        zipBtn.textContent = "Search Firms";
      }
    });
  }

  renderLegend();
  loadGraph();
  // Start background meta polling so UI updates when server-side graph file
  // is rebuilt externally (e.g. after batch crawls). A manual refresh button
  // is available in the toolbar with id `fg-refresh`.
  let _metaPollId = null;
  const META_POLL_MS = 15000;

  async function fetchMetaOnce() {
    try {
      const hasProfileParam = new URLSearchParams(window.location.search).has("profile");
      const profileName = hasProfileParam
        ? new URLSearchParams(window.location.search).get("profile")
        : "custom";
      const url = makeApiUrl("/api/finra/graph");
      url.searchParams.set("limit", "1");
      if (profileName) url.searchParams.set("profile", profileName);
      const r = await fetch(url.toString(), { cache: "no-store" });
      if (!r.ok) return;
      const j = await r.json();
      if (j && j.meta) {
        // Update visible meta label
        updateMeta(j.meta);
        // Keep in-memory graphData.meta up-to-date so other UI pieces read the latest
        if (!graphData) graphData = { nodes: [], links: [], meta: j.meta };
        else graphData.meta = { ...(graphData.meta || {}), ...j.meta };
      }
    } catch (e) {
      // non-fatal; ignore network errors
    }
  }

  function startMetaPolling() {
    if (_metaPollId) return;
    // Poll graph metadata, which reflects downloaded local data.
    fetchMetaOnce();
    _metaPollId = setInterval(() => {
      fetchMetaOnce();
    }, META_POLL_MS);
  }

  function stopMetaPolling() {
    if (_metaPollId) {
      clearInterval(_metaPollId);
      _metaPollId = null;
    }
  }

  // Kick off polling after initial load so UI shows updated counts automatically
  startMetaPolling();
}

// ── Data loading ────────────────────────────────────────────────────────────

// Merge new nodes/links into in-memory graphData so filter/subset stays current.
/**
 * Look up a text query in the LOCAL graph (no external API calls).
 * Used during profile seed auto-loading to avoid hammering upstream APIs.
 * Returns true if at least one matching node was found and injected.
 */
async function fetchAndInjectLocalQuery(q) {
  try {
    const url = makeApiUrl(
      `/api/finra/graph-search?q=${encodeURIComponent(q)}&limit=50`,
    ).toString();
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`Local query failed: ${res.status}`);
    const data = await res.json();
    const nodes = data?.nodes || [];
    const links = data?.links || [];
    if (!nodes.length) throw new Error("No local results");
    mergeIntoGraphData(nodes, links);
    appendFetched(nodes, links);
    return true;
  } catch (err) {
    console.log(
      `Local data not found for "${q}". Fetching from APIs to update local data...`,
    );
    try {
      await fetchAndInjectQuery(q);
      return true;
    } catch (remoteErr) {
      console.error(`Remote fetch also failed for "${q}":`, remoteErr);
      return false;
    }
  }
}

/**
 * Search FINRA + SEC for a text query and inject every result hit as a node.
 * This is the programmatic equivalent of pressing the "Fetch" button.
 * Called during profile seed auto-loading on page load.
 */
async function fetchAndInjectQuery(q) {
  const ROWS = "1000";
  const headers = { Accept: "application/json" };

  const [finraIndResp, finraFirmResp, secResp] = await Promise.allSettled([
    fetch(
      makeApiUrl(
        `/api/finra/search?query=${encodeURIComponent(q)}&rows=${ROWS}`,
      ).toString(),
      { headers },
    ).then((r) => (r.ok ? r.json() : null)),
    fetch(
      makeApiUrl(
        `/api/finra/search?query=${encodeURIComponent(q)}&firm=1&rows=${ROWS}`,
      ).toString(),
      { headers },
    ).then((r) => (r.ok ? r.json() : null)),
    fetch(
      makeApiUrl(
        `/api/finra/sec-search?query=${encodeURIComponent(q)}`,
      ).toString(),
      { headers },
    ).then((r) => (r.ok ? r.json() : null)),
  ]);

  const extractHits = (res) => {
    const d = res.status === "fulfilled" ? res.value : null;
    return d?.hits?.hits || d?.response?.docs || d?.results || [];
  };

  const allHits = [
    ...extractHits(finraIndResp),
    ...extractHits(finraFirmResp),
    ...extractHits(secResp),
  ];

  if (!allHits.length) return;

  const newNodes = [];
  const newLinks = [];
  const seenNodes = new Set(layoutNodes ? layoutNodes.map((n) => n.id) : []);

  for (const hit of allHits) {
    const src = hit._source || hit;

    // Parse embedded content blob if present
    let parsed = src;
    if (typeof src?.content === "string") {
      try {
        parsed = JSON.parse(src.content);
      } catch {
        parsed = src;
      }
    }

    const crd = String(
      parsed?.basicInformation?.individualId ||
        src?.ind_source_id ||
        src?.ind_crd ||
        "",
    ).trim();

    if (crd) {
      const personId = `person:${crd}`;
      if (!seenNodes.has(personId)) {
        seenNodes.add(personId);
        const label =
          [
            parsed?.basicInformation?.firstName || src?.ind_firstname,
            parsed?.basicInformation?.middleName || src?.ind_middlename,
            parsed?.basicInformation?.lastName || src?.ind_lastname,
          ]
            .filter(Boolean)
            .join(" ") || `CRD ${crd}`;

        newNodes.push({
          id: personId,
          label,
          group: "individual",
          crd,
          bcScope:
            src?.ind_bc_scope ?? parsed?.basicInformation?.bcScope ?? null,
          iaScope:
            src?.ind_ia_scope ?? parsed?.basicInformation?.iaScope ?? null,
          disclosureFlag: src?.ind_bc_disclosure_fl ?? null,
          _source: "finra",
        });

        // Link to current employments
        const emps =
          src?.ind_current_employments || src?.ind_ia_current_employments || [];
        for (const e of emps) {
          const fid = String(e?.firm_id || e?.firmId || "").trim();
          if (!fid) continue;
          const firmNodeId = `firm:${fid}`;
          if (!seenNodes.has(firmNodeId)) {
            seenNodes.add(firmNodeId);
            newNodes.push({
              id: firmNodeId,
              label: e?.firm_name || e?.firmName || `Firm ${fid}`,
              group: "firm",
              firmId: fid,
              _source: "finra",
            });
          }
          newLinks.push({
            source: personId,
            target: firmNodeId,
            relationship: "employed_by",
            isCurrent: true,
          });
        }
      }
      continue;
    }

    const firmId = String(
      src?.firm_id || src?.firmId || src?.firm_source_id || "",
    ).trim();

    if (firmId) {
      const firmNodeId = `firm:${firmId}`;
      if (!seenNodes.has(firmNodeId)) {
        seenNodes.add(firmNodeId);
        newNodes.push({
          id: firmNodeId,
          label: src?.firm_name || src?.firmName || `Firm ${firmId}`,
          group: "firm",
          firmId,
          bcScope: src?.firm_bc_scope ?? src?.bcScope ?? null,
          _source: "finra",
        });
      }
    }
  }

  if (!newNodes.length) return;

  if (typeof appendFetched === "function") appendFetched(newNodes, newLinks);
  mergeIntoGraphData(newNodes, newLinks);
  await expandFetchedNodes(newNodes, 1);
  persistToServer(newNodes, newLinks);
}

// Batch variant of local graph search that returns nodes/links without
// mutating the layout or graphData. Used to preload seeds before a single
// append to reduce layout movement.
async function fetchLocalQueryBatch(q) {
  try {
    const url = makeApiUrl(
      `/api/finra/graph-search?q=${encodeURIComponent(q)}&limit=50`,
    ).toString();
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return { nodes: [], links: [] };
    const data = await res.json();
    return { nodes: data?.nodes || [], links: data?.links || [] };
  } catch {
    return { nodes: [], links: [] };
  }
}

// Batch variant of the full text query that returns nodes/links without
// appending. Mirrors `fetchAndInjectQuery` logic but returns the results.
async function fetchQueryBatch(q) {
  const ROWS = "1000";
  const headers = { Accept: "application/json" };

  const [finraIndResp, finraFirmResp, secResp] = await Promise.allSettled([
    fetch(
      makeApiUrl(
        `/api/finra/search?query=${encodeURIComponent(q)}&rows=${ROWS}`,
      ).toString(),
      { headers },
    ).then((r) => (r.ok ? r.json() : null)),
    fetch(
      makeApiUrl(
        `/api/finra/search?query=${encodeURIComponent(q)}&firm=1&rows=${ROWS}`,
      ).toString(),
      { headers },
    ).then((r) => (r.ok ? r.json() : null)),
    fetch(
      makeApiUrl(
        `/api/finra/sec-search?query=${encodeURIComponent(q)}`,
      ).toString(),
      { headers },
    ).then((r) => (r.ok ? r.json() : null)),
  ]);

  const extractHits = (res) => {
    const d = res.status === "fulfilled" ? res.value : null;
    return d?.hits?.hits || d?.response?.docs || d?.results || [];
  };

  const allHits = [
    ...extractHits(finraIndResp),
    ...extractHits(finraFirmResp),
    ...extractHits(secResp),
  ];

  if (!allHits.length) return { nodes: [], links: [] };

  const newNodes = [];
  const newLinks = [];
  const seenNodes = new Set(layoutNodes ? layoutNodes.map((n) => n.id) : []);

  for (const hit of allHits) {
    const src = hit._source || hit;

    let parsed = src;
    if (typeof src?.content === "string") {
      try {
        parsed = JSON.parse(src.content);
      } catch {
        parsed = src;
      }
    }

    const crd = String(
      parsed?.basicInformation?.individualId || src?.ind_source_id || src?.ind_crd || "",
    ).trim();

    if (crd) {
      const personId = `person:${crd}`;
      if (!seenNodes.has(personId)) {
        seenNodes.add(personId);
        const label =
          [
            parsed?.basicInformation?.firstName || src?.ind_firstname,
            parsed?.basicInformation?.middleName || src?.ind_middlename,
            parsed?.basicInformation?.lastName || src?.ind_lastname,
          ]
            .filter(Boolean)
            .join(" ") || `CRD ${crd}`;

        newNodes.push({ id: personId, label, group: "individual", crd, _source: "finra" });

        const emps = src?.ind_current_employments || src?.ind_ia_current_employments || [];
        for (const e of emps) {
          const fid = String(e?.firm_id || e?.firmId || "").trim();
          if (!fid) continue;
          const firmNodeId = `firm:${fid}`;
          if (!seenNodes.has(firmNodeId)) {
            seenNodes.add(firmNodeId);
            newNodes.push({ id: firmNodeId, label: e?.firm_name || e?.firmName || `Firm ${fid}`, group: "firm", firmId: fid, _source: "finra" });
          }
          newLinks.push({ source: personId, target: firmNodeId, relationship: "employed_by", isCurrent: true });
        }
      }
      continue;
    }

    const firmId = String(src?.firm_id || src?.firmId || src?.firm_source_id || "").trim();
    if (firmId) {
      const firmNodeId = `firm:${firmId}`;
      if (!seenNodes.has(firmNodeId)) {
        seenNodes.add(firmNodeId);
        newNodes.push({ id: firmNodeId, label: src?.firm_name || src?.firmName || `Firm ${firmId}`, group: "firm", firmId, _source: "finra" });
      }
    }
  }

  return { nodes: newNodes, links: newLinks };
}

function updateGraphMeta() {
  if (!graphData) return;
  const totalIndividuals = graphData.nodes.filter((n) => n.group === "individual").length;
  const totalFirms = graphData.nodes.filter((n) => n.group === "firm").length;
  const totalLinks = graphData.links.length;
  graphData.meta = {
    ...(graphData.meta || {}),
    totalIndividuals,
    totalFirms,
    totalLinks,
  };
  updateMeta(graphData.meta);
}

function mergeIntoGraphData(newNodes, newLinks) {
  if (!graphData) return;
  const gIds = new Set(graphData.nodes.map((n) => n.id));
  const gLinkKeys = new Set(
    graphData.links.map((l) => {
      const s = l.source?.id ?? l.source;
      const t = l.target?.id ?? l.target;
      return `${s}|${t}`;
    }),
  );
  newNodes
    .filter((n) => !gIds.has(n.id))
    .forEach((n) => {
      graphData.nodes.push(n);
      gIds.add(n.id);
    });
  newLinks
    .filter((l) => {
      const s = l.source?.id ?? l.source;
      const t = l.target?.id ?? l.target;
      const k = `${s}|${t}`;
      if (gLinkKeys.has(k)) return false;
      gLinkKeys.add(k);
      return true;
    })
    .forEach((l) => graphData.links.push(l));

  // Persist session so any changes to graphData that affect rendered nodes
  // or available server IDs get saved for reloads.
  try {
    saveSession();
  } catch (e) {
    /* ignore */
  }

  updateGraphMeta();
}

// Fire-and-forget persist of newly fetched nodes/links to the server graph file.
function persistToServer(nodes, links) {
  const url = makeApiUrl("/api/finra/graph-append");
  fetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nodes, links }),
  }).catch(() => {
    /* non-critical */
  });
}

async function loadGraph() {
  try {
    const hasProfileParam = new URLSearchParams(window.location.search).has("profile");
    const profileName = hasProfileParam
      ? new URLSearchParams(window.location.search).get("profile")
      : "custom";
    currentProfileName = profileName;

    const profileData = await loadProfile(profileName);
    currentProfileEnabled = isProfileEnabled(profileData);
    const session = loadSession();

    if (!currentProfileEnabled) {
      if (session) {
        graphData = { nodes: [], links: [], meta: {} };
        initialServerNodeIds = new Set();
        initialServerLinkKeys = new Set();
        isSubsetMode = false;
        renderGraph(graphData);
        showEmpty(false);
        updateMeta({ totalIndividuals: 0, totalFirms: 0, totalLinks: 0 });
        await restoreSavedSession(session);
        return;
      }
      clearGraphData();
      return;
    }

    await loadBaselineGraph(profileName);
    if (!graphData) return;

    if (session) {
      await restoreSavedSession(session);
      return;
    }

    // Auto-load the profile specified in ?profile=<name>, or 'custom' by default.
    // The /api/finra/profile/:name endpoint returns either a profile object or a flat seeds array.
    // If not found, fall back to /api/finra/seeds (flat array).
    const prof = profileData;

    if (Array.isArray(prof)) {
      for (const seed of prof.map(String).filter(Boolean)) {
        try {
          await fetchAndInjectLocalQuery(seed);
        } catch {
          /* ignore — non-critical */
        }
      }
      await expandLoadedSeedNodes();
      return;
    }

    if (prof && typeof prof === "object") {
      const indCrds = normalizeProfileIds(prof.individuals);
      const firmIds = normalizeProfileIds(prof.firms);
      const seedQueries = (prof.seeds || [])
        .map(String)
        .map((s) => s.trim())
        .filter(Boolean);

      const indivPromises = indCrds.map(async (c) => {
        if (layoutNodes.some((n) => n.id === `person:${c}`))
          return { nodes: [], links: [] };
        try {
          return await fetchIndividualBatch(c);
        } catch {
          return { nodes: [], links: [] };
        }
      });
      const firmPromises = firmIds.map(async (f) => {
        if (layoutNodes.some((n) => n.id === `firm:${f}`))
          return { nodes: [], links: [] };
        try {
          return await fetchFirmBatch(f);
        } catch {
          return { nodes: [], links: [] };
        }
      });

      const indivResults = await Promise.allSettled(indivPromises);
      const firmResults = await Promise.allSettled(firmPromises);

      const batchAllNodes = [];
      const batchAllLinks = [];

      for (const r of indivResults) {
        if (r.status === "fulfilled" && r.value) {
          batchAllNodes.push(...(r.value.nodes || []));
          batchAllLinks.push(...(r.value.links || []));
        }
      }
      for (const r of firmResults) {
        if (r.status === "fulfilled" && r.value) {
          batchAllNodes.push(...(r.value.nodes || []));
          batchAllLinks.push(...(r.value.links || []));
        }
      }

      if (batchAllNodes.length) {
        appendFetched(batchAllNodes, batchAllLinks);
        mergeIntoGraphData(batchAllNodes, batchAllLinks);
        persistToServer(batchAllNodes, batchAllLinks);
      }

      if (seedQueries.length) {
        const CONCURRENCY = 6;
        const seedBatchNodes = [];
        const seedBatchLinks = [];
        for (let i = 0; i < seedQueries.length; i += CONCURRENCY) {
          const chunk = seedQueries.slice(i, i + CONCURRENCY);
          const promises = chunk.map(async (s) => {
            try {
              const local = await fetchLocalQueryBatch(s);
              if (local.nodes && local.nodes.length) return local;
              return await fetchQueryBatch(s);
            } catch {
              return { nodes: [], links: [] };
            }
          });
          const results = await Promise.all(promises);
          for (const r of results) {
            if (r.nodes?.length) seedBatchNodes.push(...r.nodes);
            if (r.links?.length) seedBatchLinks.push(...r.links);
          }
        }
        if (seedBatchNodes.length) {
          appendFetched(seedBatchNodes, seedBatchLinks);
          mergeIntoGraphData(seedBatchNodes, seedBatchLinks);
          persistToServer(seedBatchNodes, seedBatchLinks);
        }
      }
    }

    await expandLoadedSeedNodes();
  } catch (err) {
    console.error("loadGraph:", err);
    showEmpty(true);
  }
}

// Build a subgraph from `seedCount` random nodes plus all their N-hop neighbors.
function subsetGraph(data, seedCount, hops = 3) {
  const adj = new Map();
  data.links.forEach((l) => {
    const srcId = l.source?.id ?? l.source;
    const tgtId = l.target?.id ?? l.target;
    if (!adj.has(srcId)) adj.set(srcId, []);
    if (!adj.has(tgtId)) adj.set(tgtId, []);
    adj.get(srcId).push(tgtId);
    adj.get(tgtId).push(srcId);
  });

  const shuffled = data.nodes.slice().sort(() => Math.random() - 0.5);
  const seeds = shuffled.slice(0, seedCount);
  const visibleIds = new Set(seeds.map((n) => n.id));
  let frontier = new Set(visibleIds);

  for (let h = 0; h < hops; h++) {
    const next = new Set();
    frontier.forEach((id) => {
      (adj.get(id) || []).forEach((nid) => {
        if (!visibleIds.has(nid)) {
          visibleIds.add(nid);
          next.add(nid);
        }
      });
    });
    frontier = next;
    if (frontier.size === 0) break;
  }

  const nodes = data.nodes.filter((n) => visibleIds.has(n.id));
  const links = data.links.filter((l) => {
    const srcId = l.source?.id ?? l.source;
    const tgtId = l.target?.id ?? l.target;
    return visibleIds.has(srcId) && visibleIds.has(tgtId);
  });
  return { nodes, links, meta: data.meta };
}

function updateSubsetInfo(shown, total) {
  const info = document.getElementById("fg-subset-info");
  const sel = document.getElementById("fg-subset-select");
  if (info)
    info.textContent = `Showing ${shown.toLocaleString()} of ${total.toLocaleString()} nodes`;
  if (sel) sel.classList.remove("hidden");
}

function clearSubsetInfo() {
  const info = document.getElementById("fg-subset-info");
  const sel = document.getElementById("fg-subset-select");
  if (info) info.textContent = "";
  if (sel) sel.value = "all";
}

// Debounce helper
function debounce(fn, ms) {
  let t;
  return function (...args) {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), ms);
  };
}

// Filter rendered graph nodes and links by a query string.
// Supports matching node.label (name/firm), node.crd, node.bdSecNumber, node.iaSecNumber.
async function filterGraph(rawQuery) {
  const q = String(rawQuery || "").trim();
  const qlow = q.toLowerCase();
  if (!nodeSel || !linkSel || !layoutNodes || !layoutLinks) return;

  if (!q) {
    // reset
    nodeSel.style("opacity", null).classed("filtered", false);
    linkSel
      .style("stroke-opacity", null)
      .attr("stroke-opacity", defaultLinkOpacity)
      .style("opacity", null);
    // Restore the real layout count
    if (graphData) updateSubsetInfo(layoutNodes.length, graphData.nodes.length);
    return;
  }

  // Helpers to read common fields across slightly different node shapes
  function firstField(obj, keys) {
    for (const k of keys) {
      if (obj[k] != null) return obj[k];
      if (obj._source && obj._source[k] != null) return obj._source[k];
    }
    return null;
  }

  function normalizeDigits(s) {
    return String(s || "").replace(/[^0-9]/g, "");
  }

  const isExactNumeric =
    /^\d+$/.test(q) ||
    /^\d+-\d+$/.test(q) ||
    /^crd:/i.test(q) ||
    /^sec:/i.test(q);

  // determine matching node ids
  const matched = new Set();
  layoutNodes.forEach((n) => {
    // gather candidate values
    const label = String(
      firstField(n, ["label", "firm_name", "firmName"]) || "",
    );
    const labelLow = label.toLowerCase();

    const crd = String(
      firstField(n, ["crd", "ind_source_id", "ind_crd"]) || "",
    );
    const bdSec = String(
      firstField(n, ["bdSecNumber", "bd_sec_number", "firm_bd_sec_number"]) ||
        "",
    );
    const bdFull = String(firstField(n, ["firm_bd_full_sec_number"]) || "");
    const firmSrc = String(firstField(n, ["firm_source_id", "firm_id"]) || "");

    // person name pieces
    const fname = String(firstField(n, ["ind_firstname"]) || "");
    const mname = String(firstField(n, ["ind_middlename"]) || "");
    const lname = String(firstField(n, ["ind_lastname"]) || "");
    const personFull = [fname, mname, lname].filter(Boolean).join(" ");

    // firm address (may be stored as JSON string)
    let addrObj = null;
    const addrRaw = firstField(n, ["firm_address_details", "address_details"]);
    if (addrRaw) {
      try {
        addrObj = typeof addrRaw === "string" ? JSON.parse(addrRaw) : addrRaw;
      } catch (e) {
        addrObj = null;
      }
    }

    // exact numeric match for CRD/SEC/firmsource
    if (isExactNumeric) {
      const qDigits = normalizeDigits(q);
      // check CRD / source ids
      if (
        normalizeDigits(crd) === qDigits ||
        normalizeDigits(firmSrc) === qDigits
      ) {
        matched.add(n.id);
        return;
      }
      // check bd sec numbers: either numeric or full with hyphen
      if (bdFull && bdFull.toLowerCase() === q.toLowerCase()) {
        matched.add(n.id);
        return;
      }
      if (normalizeDigits(bdSec) === qDigits) {
        matched.add(n.id);
        return;
      }
      // also check node._source fields if present
      const src = n._source || {};
      if (src.ind_source_id && normalizeDigits(src.ind_source_id) === qDigits) {
        matched.add(n.id);
        return;
      }
      if (
        src.firm_bd_full_sec_number &&
        String(src.firm_bd_full_sec_number).toLowerCase() === q.toLowerCase()
      ) {
        matched.add(n.id);
        return;
      }
      // no exact match
      return;
    }

    // Non-exact: loose matching for main name/firm only (exclude alternate names)
    const ql = qlow;
    if (labelLow.includes(ql) || personFull.toLowerCase().includes(ql)) {
      matched.add(n.id);
      return;
    }

    // address match for firms: search street/city/state/postal
    if (addrObj) {
      const office = addrObj.officeAddress || addrObj.office || {};
      const mail = addrObj.mailingAddress || addrObj.mailing || {};
      const addrText = [
        office.street1,
        office.street2,
        office.city,
        office.state,
        office.postalCode,
        mail.street1,
        mail.city,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (addrText.includes(ql)) {
        matched.add(n.id);
        return;
      }
    }

    // employment branch match for individuals
    const emp = firstField(n, ["ind_current_employments", "ind_employments"]);
    if (Array.isArray(emp)) {
      for (const e of emp) {
        const city = String(e.branch_city || e.city || "").toLowerCase();
        const state = String(e.branch_state || e.state || "").toLowerCase();
        const zip = String(e.branch_zip || e.postalCode || "").toLowerCase();
        if (city.includes(ql) || state.includes(ql) || zip.includes(ql)) {
          matched.add(n.id);
          return;
        }
      }
    }
  });

  // Limit direct matches to the configured maximum to avoid overwhelming the view
  if (matched.size > FILTER_MATCH_LIMIT) {
    const arr = Array.from(matched);
    matched.clear();
    arr.slice(0, FILTER_MATCH_LIMIT).forEach((id) => matched.add(id));
  }

  // If no matches found in the currently rendered subset, try the full graph
  // so users can search for nodes that aren't yet injected into the view.
  if (matched.size === 0 && graphData && Array.isArray(graphData.nodes)) {
    for (const n of graphData.nodes) {
      const label = String(
        firstField(n, ["label", "firm_name", "firmName"]) || "",
      );
      const labelLow = label.toLowerCase();

      const crd = String(
        firstField(n, ["crd", "ind_source_id", "ind_crd"]) || "",
      );
      const bdSec = String(
        firstField(n, ["bdSecNumber", "bd_sec_number", "firm_bd_sec_number"]) ||
          "",
      );
      const bdFull = String(firstField(n, ["firm_bd_full_sec_number"]) || "");
      const firmSrc = String(
        firstField(n, ["firm_source_id", "firm_id"]) || "",
      );

      const fname = String(firstField(n, ["ind_firstname"]) || "");
      const mname = String(firstField(n, ["ind_middlename"]) || "");
      const lname = String(firstField(n, ["ind_lastname"]) || "");
      const personFull = [fname, mname, lname].filter(Boolean).join(" ");

      if (isExactNumeric) {
        const qDigits = normalizeDigits(q);
        if (
          normalizeDigits(crd) === qDigits ||
          normalizeDigits(firmSrc) === qDigits ||
          (bdFull && bdFull.toLowerCase() === q.toLowerCase()) ||
          normalizeDigits(bdSec) === qDigits
        ) {
          matched.add(n.id);
        }
      } else {
        if (
          labelLow.includes(qlow) ||
          personFull.toLowerCase().includes(qlow)
        ) {
          matched.add(n.id);
        }
      }
      if (matched.size >= FILTER_MATCH_LIMIT) break;
    }

    // If we found some ids in the full graph, inject them into the layout
    if (matched.size > 0) {
      const rendered = new Set(layoutNodes.map((n) => n.id));
      const missing = Array.from(matched).filter((id) => !rendered.has(id));
      if (missing.length) injectNodesById(missing);
    }
  }

  // Still no match in local subset — query the server's full cached graph
  if (matched.size === 0) {
    try {
      const resp = await fetch(
        `${BASE}/api/finra/graph-search?q=${encodeURIComponent(q)}&limit=10`,
      );
      if (resp.ok) {
        const data = await resp.json();
        if (data.nodes?.length) {
          mergeIntoGraphData(data.nodes, data.links || []);
          // only take up to FILTER_MATCH_LIMIT direct label matches
          let count = 0;
          for (const n of data.nodes) {
            const label = String(n.label || "").toLowerCase();
            const firmId = String(n.firmId || n.firm_id || "");
            const crd = String(n.crd || n.ind_source_id || "");
            if (label.includes(qlow) || firmId === q || crd === q) {
              matched.add(n.id);
              if (++count >= FILTER_MATCH_LIMIT) break;
            }
          }
          const rendered = new Set(layoutNodes.map((n) => n.id));
          const missing = Array.from(matched).filter((id) => !rendered.has(id));
          if (missing.length) injectNodesById(missing);
        }
      }
    } catch (_e) {
      // server graph-search failed — silently ignore
    }
  }

  // include direct neighbors of matched nodes for context
  const expanded = new Set(matched);
  matched.forEach((id) => {
    const nb = getNeighborIds(id);
    nb.forEach((x) => expanded.add(x));
  });

  // update node opacity
  nodeSel.style("opacity", (d) => (expanded.has(d.id) ? 0.45 : 0.45));

  // Update the count to reflect visible (expanded) nodes
  if (graphData) {
    updateSubsetInfo(expanded.size, graphData.nodes.length);
  }

  // update links: highlight links connected to any matched node, dim others
  linkSel
    .style("stroke-opacity", (l) => {
      const srcId = l.source?.id ?? l.source;
      const tgtId = l.target?.id ?? l.target;
      if (matched.has(srcId) || matched.has(tgtId)) return 0.45;
      if (expanded.has(srcId) || expanded.has(tgtId)) return 0.45;
      return 0.05;
    })
    .style("opacity", (l) => {
      const srcId = l.source?.id ?? l.source;
      const tgtId = l.target?.id ?? l.target;
      return matched.has(srcId) ||
        matched.has(tgtId) ||
        expanded.has(srcId) ||
        expanded.has(tgtId)
        ? 1
        : 0.45;
    });
}




function updateMeta(meta = {}) {
  if (!meta && !layoutNodes) return;
  const el = document.getElementById("fg-meta-label");
  if (!el) return;

  const visibleIndividuals = Array.isArray(layoutNodes)
    ? layoutNodes.filter((n) => n.group === "individual").length
    : meta.totalIndividuals ?? 0;
  const visibleFirms = Array.isArray(layoutNodes)
    ? layoutNodes.filter((n) => n.group === "firm").length
    : meta.totalFirms ?? 0;
  const visibleLinks = Array.isArray(layoutLinks)
    ? layoutLinks.length
    : meta.totalLinks ?? 0;

  const parts = [];
  if (typeof visibleIndividuals === "number") parts.push(`${visibleIndividuals} people`);
  if (typeof visibleFirms === "number") parts.push(`${visibleFirms} firms`);
  if (typeof visibleLinks === "number") parts.push(`${visibleLinks} links`);

  el.textContent = parts.join(" · ");

  const totalIndividuals = typeof meta.totalIndividuals === "number" ? meta.totalIndividuals : null;
  const totalFirms = typeof meta.totalFirms === "number" ? meta.totalFirms : null;
  const totalLinks = typeof meta.totalLinks === "number" ? meta.totalLinks : null;
  if (totalIndividuals !== null || totalFirms !== null || totalLinks !== null) {
    const bottomEl = document.getElementById("fg-bottom-status");
    if (bottomEl) {
      const totalParts = [];
      if (totalIndividuals !== null) totalParts.push(`${totalIndividuals} people`);
      if (totalFirms !== null) totalParts.push(`${totalFirms} firms`);
      if (totalLinks !== null) totalParts.push(`${totalLinks} links`);
      bottomEl.textContent = `Downloaded: ${totalParts.join(" · ")}`;
    }
  }
}

function showEmpty(show) {
  document.getElementById("fg-empty")?.classList.toggle("hidden", !show);
  document.getElementById("fg-svg").style.visibility = show
    ? "hidden"
    : "visible";
  document.getElementById("fg-legend").style.display = show ? "none" : "flex";
}

// ── Run scraper ─────────────────────────────────────────────────────────────
function runScraper() {
  const panel = document.getElementById("fg-log-panel");
  const logBody = document.getElementById("fg-log-body");
  panel.classList.remove("hidden");
  logBody.textContent = "";

  // Get the current profile name
  const hasProfileParam = new URLSearchParams(window.location.search).has("profile");
  const profileName = hasProfileParam
    ? new URLSearchParams(window.location.search).get("profile")
    : "custom";

  function runBatch() {
    fetch(`${BASE}/api/finra/run-scraper`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile: profileName })
    })
      .then((res) => {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let hasMore = false;

        function pump() {
          reader.read().then(({ done, value }) => {
            if (done) {
              loadGraph();
              return;
            }
            const text = decoder.decode(value, { stream: true });
            // SSE lines: data: {...}\n\n
            text.split("\n").forEach((line) => {
              if (!line.startsWith("data:")) return;
              try {
                const { type, data } = JSON.parse(line.slice(5).trim());
                if (type === "stdout" || type === "stderr") {
                  logBody.textContent += data;
                  logBody.scrollTop = logBody.scrollHeight;
                  if (
                    typeof data === "string" &&
                    /\d+ more pending after this batch/.test(data)
                  ) {
                    hasMore = true;
                  }
                }
                if (type === "done") {
                  logBody.textContent += `\n[exit code ${data.exitCode}]\n`;
                  logBody.scrollTop = logBody.scrollHeight;
                  if (data.exitCode === 0) {
                    loadGraph();
                    if (hasMore) {
                      logBody.textContent += "\nStarting next batch…\n";
                      logBody.scrollTop = logBody.scrollHeight;
                      runBatch();
                    }
                  }
                }
              } catch {
                /* malformed chunk */
              }
            });
            pump();
          });
        }
        pump();
      })
      .catch((err) => {
        logBody.textContent += `\nError: ${err.message}\n`;
      });
  }

  runBatch();
}

function closeLog() {
  document.getElementById("fg-log-panel").classList.add("hidden");
}

// Add-person functionality removed

// ── D3 Rendering ────────────────────────────────────────────────────────────
const NODE_R = { individual: 10, firm: 12, entity: 9 };
const NODE_COLOR = {
  individual: "var(--c-individual)",
  firm: "var(--c-firm)",
  entity: "var(--c-entity)",
};
const LINK_COLOR = {
  employed_by: "#5e6268",
  controls: "#5e6268",
};
const LINK_OPACITY = {
  employed_by: 0.2,
  controls: 0.2,
};
const defaultLinkOpacity = (d) => LINK_OPACITY[d.relationship] ?? 0.5;

function isCurrentRegistration(d) {
  if (d.relationship !== "employed_by") return false;
  if (d.isCurrent !== undefined) return d.isCurrent;

  const src = typeof d.source === "object" ? d.source : layoutNodes?.find(n => n.id === d.source);
  if (!src || src.group !== "individual") return false;

  const tgtId = String(typeof d.target === "object" ? d.target.id : d.target).replace(/^firm:/, "");

  const currents = [
    ...(src.currentEmployments || []),
    ...(src.currentIAEmployments || [])
  ];
  if (currents.some(e => String(e.firmId || e.firm_id) === tgtId)) return true;

  const previous = [
    ...(src.previousEmployments || []),
    ...(src.previousIAEmployments || [])
  ];
  if (previous.some(e => String(e.firmId || e.firm_id) === tgtId)) return false;

  if (d.endDate === null || d.endDate === "") return true;

  return false;
}

function getLinkColor(d) {
  if (d.relationship === "controls") return "#ff0c0c";
  if (d.relationship === "employed_by" && isCurrentRegistration(d)) return "#ff0c0c";
  return LINK_COLOR[d.relationship] || "#5e6268";
}

function getLinkMarker(d) {
  if (d.relationship === "controls") return `url(#arrow-controls)`;
  if (d.relationship === "employed_by" && isCurrentRegistration(d)) return `url(#arrow-current_employed_by)`;
  return `url(#arrow-${d.relationship})`;
}

// Refreshes colors for all nodes dynamically to ensure nodes and links correctly reflect state
function refreshGraphColors() {
  if (!nodeSel || !layoutLinks || !linkSel) return;

  nodeSel.each(function (d) {
    const isController = layoutLinks.some(
      (l) => l.relationship === "controls" && (l.source?.id ?? l.source) === d.id
    );
    const color = isController ? "#ff0c0c" : NODE_COLOR[d.group] || "#475569";
    d3.select(this)
      .selectAll("circle, rect, polygon")
      .filter(function () { return d3.select(this).attr("fill") !== "none"; })
      .attr("fill", color);
  });

  linkSel
    .attr("stroke", (d) => {
      if (selectedId != null) {
        const srcId = d.source?.id ?? d.source;
        const tgtId = d.target?.id ?? d.target;
        if (srcId === selectedId || tgtId === selectedId) {
           return d.relationship === "controls" ? "#ff2222" : (isCurrentRegistration(d) ? "#ff2222" : "#38bdf8");
        }
      }
      return getLinkColor(d);
    })
    .attr("marker-end", (d) => getLinkMarker(d));
}

// Fetch node objects for any link endpoint IDs that aren't in knownIds, then
// inject them into the live graph. Called after renderGraph to resolve dangling
// links that come from the server subset missing some referenced nodes.
async function fetchAndInjectOrphanNodes(links, knownIds) {
  const missing = new Set();
  for (const l of links) {
    const s = l.source?.id ?? l.source;
    const t = l.target?.id ?? l.target;
    if (!knownIds.has(s)) missing.add(s);
    if (!knownIds.has(t)) missing.add(t);
  }
  if (!missing.size) return;
  try {
    const url = makeApiUrl("/api/finra/nodes-by-ids");
    url.searchParams.set("ids", [...missing].join(","));
    const res = await fetch(url.toString());
    if (!res.ok) return;
    const fetched = await res.json();
    if (!fetched.length) return;
    mergeIntoGraphData(fetched, []);
    injectNodesById(fetched.map((n) => n.id));
  } catch {
    // non-critical — dangling links will simply be invisible
  }
}

function renderGraph(_data) {
  let data = _data;
  if (simulation) simulation.stop();
  if (spreadAnimId) {
    cancelAnimationFrame(spreadAnimId);
    spreadAnimId = null;
  }
  const svg = d3.select("#fg-svg");
  svg.selectAll("*").remove();

  const main = document.getElementById("fg-main");
  const W = main.clientWidth;
  const H = main.clientHeight;

  svg.attr("viewBox", `0 0 ${W} ${H}`);

  // ── Filter to the top 2 non-firm hubs and top firm hub + their direct neighbours ──
  const _rawDeg = new Map(data.nodes.map((n) => [n.id, 0]));
  data.links.forEach((l) => {
    const s = l.source?.id ?? l.source;
    const t = l.target?.id ?? l.target;
    if (_rawDeg.has(s)) _rawDeg.set(s, _rawDeg.get(s) + 1);
    if (_rawDeg.has(t)) _rawDeg.set(t, _rawDeg.get(t) + 1);
  });
  const _topNonFirms = data.nodes
    .filter((n) => n.group !== "firm")
    .sort((a, b) => (_rawDeg.get(b.id) || 0) - (_rawDeg.get(a.id) || 0))
    .slice(0, 2);
  const _topFirm = data.nodes
    .filter((n) => n.group === "firm")
    .sort((a, b) => (_rawDeg.get(b.id) || 0) - (_rawDeg.get(a.id) || 0))[0];
  const _allowedIds = new Set();
  for (const hub of [..._topNonFirms, _topFirm]) {
    if (!hub) continue;
    _allowedIds.add(hub.id);
    data.links.forEach((l) => {
      const s = l.source?.id ?? l.source;
      const t = l.target?.id ?? l.target;
      if (s === hub.id) _allowedIds.add(t);
      if (t === hub.id) _allowedIds.add(s);
    });
  }
  const _filteredData = {
    ...data,
    nodes: data.nodes.filter((n) => _allowedIds.has(n.id)),
    links: data.links.filter((l) => {
      const s = l.source?.id ?? l.source;
      const t = l.target?.id ?? l.target;
      return _allowedIds.has(s) && _allowedIds.has(t);
    }),
  };
  data = _filteredData;

  // Deep-copy so D3 mutation doesn't corrupt the original
  const nodes = data.nodes.map((n) => ({ ...n }));
  const nodeIdSet = new Set(nodes.map((n) => n.id));
  const allLinks = data.links.map((l) => ({ ...l }));
  // Strip links whose endpoints aren't in the node set — D3 force throws if
  // a link references a missing node. Missing nodes are fetched asynchronously.
  const orphanLinks = allLinks.filter((l) => {
    const s = l.source?.id ?? l.source;
    const t = l.target?.id ?? l.target;
    return !nodeIdSet.has(s) || !nodeIdSet.has(t);
  });
  const links = allLinks.filter((l) => {
    const s = l.source?.id ?? l.source;
    const t = l.target?.id ?? l.target;
    return nodeIdSet.has(s) && nodeIdSet.has(t);
  });
  layoutNodes = nodes;
  layoutLinks = links;
  // Async-resolve any orphaned link endpoints so they appear once fetched
  if (orphanLinks.length) fetchAndInjectOrphanNodes(orphanLinks, nodeIdSet);

  // ── Per-node degree stats for scaled / tinted firm nodes ─────────────────
  const _degMap = new Map();
  nodes.forEach((n) => {
    _degMap.set(n.id, { total: 0, controls: 0, employed: 0 });
  });
  links.forEach((l) => {
    const srcId = l.source?.id ?? l.source;
    const tgtId = l.target?.id ?? l.target;
    [srcId, tgtId].forEach((id) => {
      const e = _degMap.get(id);
      if (!e) return;
      e.total++;
      if (l.relationship === "controls") e.controls++;
      else e.employed++;
    });
  });
  // Assign per-node degree stats to each node
  nodes.forEach((n) => {
    n._deg = _degMap.get(n.id);
  });
  const _maxFirmDeg = Math.max(
    1,
    ...nodes.filter((n) => n.group === "firm").map((n) => n._deg.total || 0),
  );
  const _maxIndDeg = Math.max(
    1,
    ...nodes
      .filter((n) => n.group === "individual")
      .map((n) => n._deg.total || 0),
  );
  nodes.forEach((n) => {
    if (n.group === "individual") {
      const scale = 1 + (Math.sqrt(n._deg.total) / Math.sqrt(_maxIndDeg)) * 2.5;
      n._vizHalf = (NODE_R.individual * 1.7 * scale) / 2;
    }
  });

  // ── Anchor the two seed nodes on the same horizontal line ─────────────────
  // When this is the initial subset (one top individual + one top firm), pin
  // them side-by-side at mid-height so their link is horizontal from the start.
  if (data.meta?.subset) {
    const topInd = nodes
      .filter((n) => n.group === "individual")
      .sort((a, b) => (b._deg?.total || 0) - (a._deg?.total || 0))[0];
    const topFirm = nodes
      .filter((n) => n.group === "firm")
      .sort((a, b) => (b._deg?.total || 0) - (a._deg?.total || 0))[0];
    if (topInd && topFirm) {
      topInd.x = W * 0.38;
      topInd.y = H / 2;
      topFirm.x = W * 0.45;
      topFirm.y = H / 2;
    }
  }

  // Scale params based on graph size — used by both zoom LOD and simulation setup
  const nodeCount = nodes.length;
  const isLarge = nodeCount > 300;
  const isHuge = nodeCount > 1000;

  // ── Zoom ──────────────────────────────────────────────────────────────────
  // LOD threshold: hide labels when zoomed out (less DOM paint, higher props)
  const labelZoomThreshold = isHuge ? 0.8 : isLarge ? 0.55 : 0.3;

  const zoom = d3
    .zoom()
    .scaleExtent([0.1, 6])
    .on("zoom", (event) => {
      root.attr("transform", event.transform);
      root.classed("fg-labels-hidden", event.transform.k < labelZoomThreshold);
      if (zoomSaveTimer) clearTimeout(zoomSaveTimer);
      zoomSaveTimer = setTimeout(() => {
        try {
          saveSession();
        } catch {
          // non-critical
        }
      }, 150);
    });

  // expose zoom and svg to module scope so saved transforms can be replayed
  zoomBehavior = zoom;
  svgSel = svg;

  svg.call(zoom);

  // Set an initial zoom so larger graphs start more zoomed-out by default.
  // Scale choices: small=1, medium≈0.8, large≈0.6, huge≈0.45
  const initialScale = isHuge ? 0.18 : isLarge ? 0.25 : 0.25;
  try {
    // Use immediate transition to set scale centered on the viewport
    svg.transition().duration(0).call(zoom.scaleTo, initialScale);
  } catch (e) {
    /* ignore if zoom API not available */
  }

  const root = svg.append("g").attr("class", "fg-root");

  // ── Arrow markers ─────────────────────────────────────────────────────────
  const defs = svg.append("defs");

  ["employed_by", "controls", "current_employed_by"].forEach((rel) => {
    defs
      .append("marker")
      .attr("id", `arrow-${rel}`)
      .attr("viewBox", "0 -4 8 8")
      .attr("refX", 22)
      .attr("refY", 0)
      .attr("markerWidth", 6)
      .attr("markerHeight", 6)
      .attr("orient", "auto")
      .append("path")
      .attr("d", "M0,-4L8,0L0,4")
      .attr("fill", (rel === "controls" || rel === "current_employed_by") ? "#ff0c0c" : "#5e6268");
  });

  // ── Force simulation ──────────────────────────────────────────────────────
  // Scale simulation aggressiveness with graph size so large graphs converge faster
  simulation = d3
    .forceSimulation(nodes)
    .alphaDecay(isHuge ? 0.1 : isLarge ? 0.07 : 0.04)
    .velocityDecay(isLarge ? 0.5 : 0.35)
    .force(
      "link",
      d3
        .forceLink(links)
        .id((d) => d.id)
        .distance(isHuge ? 200 : isLarge ? 160 : 100),
    )
    .force(
      "charge",
      d3
        .forceManyBody()
        .strength(isHuge ? -800 : isLarge ? -600 : -400)
        .theta(isLarge ? 0.9 : 0.81),
    )
    .force("center", d3.forceCenter(W / 2, H / 2))
    // per-node radius so scaled firm squares don't overlap each other
    .force(
      "collision",
      d3
        .forceCollide()
        .radius((d) =>
          d._vizHalf != null
            ? d._vizHalf + (isLarge ? 30 : 20)
            : (NODE_R[d.group] || 10) + (isLarge ? 30 : 20),
        )
        .strength(1.0),
    );

  // Build neighbor adjacency cache after D3 has resolved link source/target objects
  neighborMap = buildNeighborMap(nodes, links);

  // ── Links ─────────────────────────────────────────────────────────────────
  const link = root
    .append("g")
    .attr("class", "fg-links")
    .selectAll("line")
    .data(links)
    .join("line")
    .attr("stroke", (d) => getLinkColor(d))
    .attr("stroke-opacity", defaultLinkOpacity)
    .attr("stroke-width", 0)
    .attr("marker-end", (d) => getLinkMarker(d));
  linkSel = link;
  linkGroup = root.select(".fg-links");

  // ── Nodes ─────────────────────────────────────────────────────────────────
  const node = root
    .append("g")
    .attr("class", "fg-nodes")
    .selectAll("g")
    .data(nodes, (d) => d.id)
    .join("g")
    .attr("class", "fg-node")
    .call(fluidDrag())
    .on("click", (event, d) => {
      event.stopPropagation();
      selectNode(d);
    });
  nodeSel = node;
  nodeGroup = root.select(".fg-nodes");

  // Shapes
  node.each(function (d) {
    const g = d3.select(this);
    const r = NODE_R[d.group] || 10;
    const color = NODE_COLOR[d.group] || "#475569";

    if (d.group === "firm") {
      const s = (d._vizHalf ?? r * 0.85) * 2;
      // Dominant-link stroke: red = controls, slate = employed_by, white = neutral
      const deg = d._deg || { total: 0, controls: 0, employed: 0 };
      const dominantStroke =
        deg.controls > deg.employed
          ? "#ef4444"
          : deg.employed > deg.controls
            ? "#64748b"
            : "#fff";
      const strokeW = deg.total > 0 ? 2.5 : 1.5;
      // Outer dashed ring shows the minority link type when both are present
      if (deg.controls > 0 && deg.employed > 0) {
        const minorityStroke =
          deg.controls > deg.employed ? "#64748b" : "#ef4444";
        g.append("rect")
          .attr("x", -s / 2 - 4)
          .attr("y", -s / 2 - 4)
          .attr("width", s + 8)
          .attr("height", s + 8)
          .attr("rx", 6)
          .attr("fill", "none")
          .attr("stroke", minorityStroke)
          .attr("stroke-width", 1.5)
          .attr("opacity", 0.5);
      }
      g.append("rect")
        .attr("x", -s / 2)
        .attr("y", -s / 2)
        .attr("width", s)
        .attr("height", s)
        .attr("rx", 3)
        .attr("fill", color)
        .attr("stroke", dominantStroke)
        .attr("stroke-width", strokeW)
        .attr("opacity", d.stub ? 0.45 : 0.9);
    } else if (d.group === "entity") {
      const s = r * 1.5;
      g.append("polygon")
        .attr("points", `0,${-s} ${s},0 0,${s} ${-s},0`)
        .attr("fill", color)
        .attr("stroke", "#fff")
        .attr("stroke-width", 1.5)
        .attr("opacity", 0.8);
    } else {
      const rv = d._vizHalf != null ? d._vizHalf : r;
      g.append("circle")
        .attr("r", rv)
        .attr("fill", color)
        .attr("stroke", "#fff")
        .attr("stroke-width", 1.5)
        .attr("opacity", d.stub ? 0.5 : 1);
    }

    // Disclosure indicator ring/outline
    drawDisclosureIndicator(g, d, r);
  });

  // Labels — rendered in two passes (stroke halo first, then fill) so text
  // stays readable even when nodes are still close after zooming out.
  // Both elements live inside the <g> so they move with every transform.
  ["halo", "fill"].forEach((pass) => {
    node
      .append("text")
      .attr("class", `fg-label-${pass}`)
      .attr("dy", (d) =>
        d._vizHalf != null ? d._vizHalf + 14 : (NODE_R[d.group] || 10) + 14,
      )
      .attr("text-anchor", "middle")
      .attr("font-size", "10px")
      .attr("font-family", "var(--sans)")
      .attr("font-weight", "500")
      .attr("fill", pass === "halo" ? "none" : "#1e293b")
      .attr("stroke", pass === "halo" ? "rgba(246,248,252,0.92)" : "none")
      .attr("stroke-width", pass === "halo" ? 4 : 0)
      .attr("stroke-linejoin", "round")
      .attr("paint-order", "stroke")
      .attr("pointer-events", "none")
      .text((d) => truncate(capitalize(d.label), 22));
  });
  // Tooltip
  node.append("title").text((d) => {
    const parts = [d.label, d.group.toUpperCase()];
    if (d.crd) parts.push(`CRD: ${d.crd}`);
    return parts.join("\n");
  });

  // ── Tick ──────────────────────────────────────────────────────────────────
  let _tickN = 0;
  simulation.on("tick", () => {
    _tickN++;
    // During high-energy early layout, skip every other DOM write to cut paint time.
    // Physics still advances every tick; only the SVG update is throttled.
    if (simulation.alpha() > 0.15 && _tickN % 2 !== 0) return;

    link
      .attr("x1", (d) => d.source.x)
      .attr("y1", (d) => d.source.y)
      .attr("x2", (d) => d.target.x)
      .attr("y2", (d) => d.target.y);

    node.attr("transform", (d) => `translate(${d.x},${d.y})`);
  });

  // Freeze all nodes once the initial layout converges — no more jiggling
  simulation.on("end", () => {
    nodes.forEach((d) => {
      d.fx = d.x;
      d.fy = d.y;
    });
  });

  // Stop simulation after 5 seconds to prevent endless movement
  setTimeout(() => simulation.stop(), 5000);

  // Deselect on blank click
  svg.on("click", () => {
    selectedId = null;
    node.classed("selected", false);
    highlightLinks(null);
    showSidebarHint();
  });

  refreshGraphColors();
}

// ── Fluid Drag (simulation-driven neighbor repulsion) ────────────────────
function fluidDrag() {
  return d3
    .drag()
    .on("start", function (event, d) {
      // Cancel any pending click-spread animation
      if (spreadAnimId) {
        cancelAnimationFrame(spreadAnimId);
        spreadAnimId = null;
      }
      // Pin the dragged node
      d.fx = d.x;
      d.fy = d.y;
      // Unfix direct neighbors so the simulation can push them aside
      const neighborIds = getNeighborIds(d.id);
      layoutNodes.forEach((n) => {
        if (neighborIds.has(n.id)) {
          n.fx = null;
          n.fy = null;
        }
      });
      // Reheat just enough for fluid neighbor movement
      simulation.alphaTarget(0.3).restart();
    })
    .on("drag", function (event, d) {
      // Calculate delta from previous position
      const prevX = d.fx ?? d.x;
      const prevY = d.fy ?? d.y;
      const dx = event.x - prevX;
      const dy = event.y - prevY;
      d.fx = event.x;
      d.fy = event.y;

      // Move loose child nodes by the same delta
      // A child is any node where this node is the source in a link
      if (Array.isArray(layoutLinks) && Array.isArray(layoutNodes)) {
        layoutLinks.forEach((l) => {
          const srcId = l.source?.id ?? l.source;
          const tgtId = l.target?.id ?? l.target;
          if (srcId === d.id) {
            const child = layoutNodes.find((n) => n.id === tgtId);
            if (child && child.fx == null && child.fy == null) {
              // Only move if not fixed
              child.x = (child.x ?? 0) + dx;
              child.y = (child.y ?? 0) + dy;
            }
          }
        });
      }
    })
    .on("end", function (event, d) {
      // Cool down – simulation will coast to rest then the "end" handler re-freezes all
      simulation.alphaTarget(0);
    });
}

// Returns the set of node ids directly connected to the given node id
function getNeighborIds(nodeId) {
  if (neighborMap) return neighborMap.get(nodeId) ?? new Set();
  // Fallback if map is not yet built
  const ids = new Set();
  if (!layoutLinks) return ids;
  layoutLinks.forEach((l) => {
    const srcId = l.source?.id ?? l.source;
    const tgtId = l.target?.id ?? l.target;
    if (srcId === nodeId) ids.add(tgtId);
    if (tgtId === nodeId) ids.add(srcId);
  });
  return ids;
}

// Build a bidirectional adjacency map for O(1) neighbor lookups
function buildNeighborMap(nodes, links) {
  const map = new Map(nodes.map((n) => [n.id, new Set()]));
  links.forEach((l) => {
    const srcId = l.source?.id ?? l.source;
    const tgtId = l.target?.id ?? l.target;
    if (map.has(srcId)) map.get(srcId).add(tgtId);
    if (map.has(tgtId)) map.get(tgtId).add(srcId);
  });
  return map;
}

// Inject nodes (by id) from the full `graphData` into the live layout and DOM.
// Safe to call when the graph is already rendered; will skip already-present ids.
function injectNodesById(ids) {
  if (!graphData || !layoutNodes || !layoutLinks || !nodeGroup || !linkGroup)
    return;
  const idSet = new Set(ids || []);
  const exist = new Set(layoutNodes.map((n) => n.id));
  const toAdd = graphData.nodes.filter(
    (n) => idSet.has(n.id) && !exist.has(n.id),
  );
  if (!toAdd.length) return;

  // place new nodes near center with small random offset
  const main = document.getElementById("fg-main");
  const W = main?.clientWidth || 800;
  const H = main?.clientHeight || 600;
  toAdd.forEach((n, i) => {
    n.x = W / 2 + (Math.random() - 0.5) * 200 + (i % 5) * 8;
    n.y = H / 2 + (Math.random() - 0.5) * 200 + (i % 7) * 6;
  });

  // find links that connect now-rendered nodes
  const nowIds = new Set([
    ...layoutNodes.map((n) => n.id),
    ...toAdd.map((n) => n.id),
  ]);
  const newLinks = graphData.links
    .filter((l) => {
      const s = l.source?.id ?? l.source;
      const t = l.target?.id ?? l.target;
      return (
        nowIds.has(s) &&
        nowIds.has(t) &&
        !layoutLinks.some(
          (el) =>
            (el.source?.id ?? el.source) === s &&
            (el.target?.id ?? el.target) === t,
        )
      );
    })
    .map((l) => ({ ...l }));

  layoutNodes.push(...toAdd);
  layoutLinks.push(...newLinks);

  neighborMap = buildNeighborMap(layoutNodes, layoutLinks);
  if (graphData) updateSubsetInfo(layoutNodes.length, graphData.nodes.length);

  // Append DOM elements for links and nodes (reuse pattern from appendFetched)
  const allLinks = linkGroup.selectAll("line").data(layoutLinks, (d) => {
    const s = d.source?.id ?? d.source;
    const t = d.target?.id ?? d.target;
    return `${s}-${t}-${d.relationship}`;
  });
  const enteredLinks = allLinks
    .enter()
    .append("line")
    .attr("stroke", (d) => getLinkColor(d))
    .attr("stroke-opacity", 0)
    .attr("stroke-width", 0)
    .attr("marker-end", (d) => getLinkMarker(d));
  enteredLinks
    .transition()
    .duration(400)
    .attr("stroke-opacity", defaultLinkOpacity);
  linkSel = linkGroup.selectAll("line");

  const allNodes = nodeGroup
    .selectAll("g.fg-node")
    .data(layoutNodes, (d) => d.id);
  const enteredNodes = allNodes
    .enter()
    .append("g")
    .attr("class", "fg-node")
    .attr("opacity", 0)
    .call(fluidDrag())
    .on("click", (event, d) => {
      event.stopPropagation();
      selectNode(d);
    });

  enteredNodes.each(function (d) {
    const g = d3.select(this);
    const r = NODE_R[d.group] || 10;
    const color = NODE_COLOR[d.group] || "#475569";
    if (d.group === "firm") {
      const s = (d._vizHalf ?? r * 0.85) * 2 || r * 2;
      g.append("rect")
        .attr("x", -s / 2)
        .attr("y", -s / 2)
        .attr("width", s)
        .attr("height", s)
        .attr("rx", 3)
        .attr("fill", color)
        .attr("stroke", "#fff")
        .attr("stroke-width", 1.5)
        .attr("opacity", d.stub ? 0.45 : 0.9);
    } else if (d.group === "entity") {
      const s = r * 1.5;
      g.append("polygon")
        .attr("points", `0,${-s} ${s},0 0,${s} ${-s},0`)
        .attr("fill", color)
        .attr("stroke", "#fff")
        .attr("stroke-width", 1.5)
        .attr("opacity", 0.8);
    } else {
      const rv = d._vizHalf != null ? d._vizHalf : r;
      g.append("circle")
        .attr("r", rv)
        .attr("fill", color)
        .attr("stroke", "#fff")
        .attr("stroke-width", 1.5)
        .attr("opacity", d.stub ? 0.5 : 1);
    }
    drawDisclosureIndicator(g, d, r);
    drawDisclosureIndicator(g, d, r);
    ["halo", "fill"].forEach((pass) => {
      g.append("text")
        .attr("class", `fg-label-${pass}`)
        .attr("dy", d._vizHalf != null ? d._vizHalf + 14 : r + 14)
        .attr("text-anchor", "middle")
        .attr("font-size", "10px")
        .attr("font-family", "var(--sans)")
        .attr("font-weight", "500")
        .attr("fill", pass === "halo" ? "none" : "#1e293b")
        .attr("stroke", pass === "halo" ? "rgba(246,248,252,0.92)" : "none")
        .attr("stroke-width", pass === "halo" ? 4 : 0)
        .attr("stroke-linejoin", "round")
        .attr("paint-order", "stroke")
        .attr("pointer-events", "none")
        .text(truncate(capitalize(d.label), 22));
    });
    g.append("title").text(() => {
      const parts = [d.label, d.group?.toUpperCase?.() || ""];
      if (d.crd) parts.push(`CRD: ${d.crd}`);
      return parts.join("\n");
    });
  });

  // Persist session so reload restores these server-rendered nodes
  try {
    saveSession();
  } catch (e) {
    /* ignore */
  }

  enteredNodes.attr("transform", (d) => `translate(${d.x ?? 0},${d.y ?? 0})`);

  enteredNodes.transition().duration(400).attr("opacity", 1);
  nodeSel = nodeGroup.selectAll("g.fg-node");
  linkSel = linkGroup.selectAll("line");

  refreshGraphColors();

  simulation.on("tick", () => {
    linkSel
      .attr("x1", (d) => d.source.x)
      .attr("y1", (d) => d.source.y)
      .attr("x2", (d) => d.target.x)
      .attr("y2", (d) => d.target.y);
    nodeSel.attr("transform", (d) => `translate(${d.x},${d.y})`);
  });

  simulation.nodes(layoutNodes);
  simulation.force("link").links(layoutLinks);
  simulation.alpha(0.45).restart();
}

// ── Selection & Sidebar ─────────────────────────────────────────────────────

// Normalize wrapped detail payloads (e.g. from Elasticsearch/Solr hits)
function unwrapDetailPayload(detail) {
  if (!detail) return detail;
  const hit = detail?.hits?.hits?.[0] || detail?.response?.docs?.[0];
  if (hit) {
    const src = hit._source || hit;
    const rawContent = src.content || src.iacontent;
    if (typeof rawContent === "string") {
      try {
        const parsed = JSON.parse(rawContent);
        if (detail.found !== undefined) parsed.found = detail.found;
        return parsed;
      } catch {
        return src;
      }
    }
    return src;
  }
  return detail;
}

async function fetchFromExternalApi(id, isFirm) {
  let url = isFirm
    ? `https://api.brokercheck.finra.org/search/firm/${encodeURIComponent(id)}?hl=true&nrows=12&query=&start=0&wt=json`
    : `https://api.brokercheck.finra.org/search/individual/${encodeURIComponent(id)}?hl=true&includePrevious=true&nrows=12&r=25&sort=bc_lastname_sort+asc,bc_firstname_sort+asc,bc_middlename_sort+asc,score+desc&wt=json`;
  try {
    let res = await fetch(url);
    if (res.ok) return unwrapDetailPayload(await res.json());
  } catch (e) { /* ignore */ }

  url = isFirm
    ? `https://api.adviserinfo.sec.gov/search/firm/${encodeURIComponent(id)}?hl=true&nrows=12&query=&r=25&sort=score+desc&wt=json`
    : `https://api.adviserinfo.sec.gov/search/individual/${encodeURIComponent(id)}?hl=true&includePrevious=true&nrows=12&r=25&sort=bc_lastname_sort+asc,bc_firstname_sort+asc,bc_middlename_sort+asc,score+desc&wt=json`;
  try {
    let res = await fetch(url);
    if (res.ok) return unwrapDetailPayload(await res.json());
  } catch (e) { /* ignore */ }

  return null;
}

// Normalize a detail payload so top-level merged fields are available
// under basicInformation and the UI can consume it consistently.
function normalizeIndividualDetailPayload(detail, fallbackCrd) {
  if (!detail || typeof detail !== "object") return detail;
  if (!detail.basicInformation) {
    const bi = {};
    if (detail.individualId || detail.ind_source_id || detail.crd || fallbackCrd) {
      bi.individualId = detail.individualId || detail.ind_source_id || detail.crd || fallbackCrd;
    }
    if (detail.firstName) bi.firstName = detail.firstName;
    if (detail.middleName) bi.middleName = detail.middleName;
    if (detail.lastName) bi.lastName = detail.lastName;
    if (detail.name) bi.name = detail.name;
    if (detail.bcScope) bi.bcScope = detail.bcScope;
    if (detail.iaScope) bi.iaScope = detail.iaScope;
    if (detail.otherNames) bi.otherNames = detail.otherNames;
    if (Object.keys(bi).length) {
      detail.basicInformation = bi;
    }
  }
  return detail;
}

function hasRichIndividualDetail(detail) {
  if (!detail || typeof detail !== "object") return false;
  const listFields = [
    "currentEmployments",
    "previousEmployments",
    "currentIAEmployments",
    "previousIAEmployments",
    "disclosures",
    "iaDisclosures",
    "registeredStates",
    "registeredSROs",
  ];
  for (const key of listFields) {
    if (Array.isArray(detail[key]) && detail[key].length) return true;
  }
  if (detail.registrationCount || detail.examsCount || detail.brokerDetails) return true;
  return false;
}

// Fetch individual detail from API and merge all data into the node.
// Called when an individual node is selected to hydrate missing data.
async function ensureIndividualDetail(personNode) {
  if (!personNode || personNode.group !== "individual") return;

  // Extract CRD from node ID.
  // Supports "person:6482604", legacy "person_6482604", and bare numeric ids.
  const match = personNode.id.match(/^(?:person[:_])?(\d+)$/);
  if (!match) return;
  const crd = match[1];

  if (personNode._detailLoaded && hasRichIndividualDetail(personNode)) {
    return;
  }

  try {
    // First try the local merged record (fast, no external call)
    let detail = null;
    let localDetail = null;
    try {
      const localRes = await fetch(`${BASE}/api/finra/merged/individual/${encodeURIComponent(crd)}`);
      if (localRes.ok) {
        const merged = await localRes.json();
        const candidate = merged?.merged;
        if (candidate) {
          const normalized = normalizeIndividualDetailPayload(candidate, crd);
          if (
            normalized?.basicInformation &&
            (normalized.basicInformation.individualId || normalized.basicInformation.firstName || normalized.basicInformation.lastName)
          ) {
            localDetail = normalized;
            if (hasRichIndividualDetail(normalized)) {
              detail = normalized;
            }
          }
        }
      }
    } catch {
      // local lookup failed — fall through to live API
    }

    // Fall back to live FINRA/SEC API if no local rich data available.
    if (!detail) {
      const url = `${BASE}/api/finra/individual/${encodeURIComponent(crd)}`;
      try {
        const response = await fetch(url);
        if (!response.ok) {
          console.warn(`Failed to fetch individual detail for ${crd}:`, response.status);
        } else {
          detail = unwrapDetailPayload(await response.json());
        }
      } catch (err) {
        console.warn(`Local API fetch failed for individual ${crd}:`, err);
      }

      if (!detail || detail.found === false || (!detail.basicInformation && !detail.hits)) {
        console.log(`Local API missing data for ${crd}, fetching from external API...`);
        const ext = await fetchFromExternalApi(crd, false);
        if (ext && (ext.basicInformation || ext.firstName)) {
          detail = ext;
        }
      }

      if (!detail || (detail.found === false && !detail.basicInformation)) {
        console.warn(`Individual ${crd} not found`);
        detail = localDetail;
      } else {
        detail = normalizeIndividualDetailPayload(detail, crd);
        if (localDetail && hasRichIndividualDetail(localDetail) && !hasRichIndividualDetail(detail)) {
          detail = localDetail;
        }
      }
    }

    if (!detail && localDetail) {
      detail = localDetail;
    }

    // Inline merge of individual detail into the person node (avoid external helper dependency)
    try {
      const bi = detail?.basicInformation || {};
      personNode.basicInformation = bi;
      personNode.crd = String(bi.individualId || crd);
      if (bi.bcScope) personNode.bcScope = bi.bcScope;
      if (bi.iaScope) personNode.iaScope = bi.iaScope;
      const fullName = [bi.firstName, bi.middleName, bi.lastName].filter(Boolean).join(" ");
      if (fullName) personNode.label = fullName;
      if (Array.isArray(bi.otherNames)) personNode.otherNames = bi.otherNames;
      if (Array.isArray(detail.currentEmployments)) personNode.currentEmployments = detail.currentEmployments;
      if (Array.isArray(detail.previousEmployments)) personNode.previousEmployments = detail.previousEmployments;
      if (Array.isArray(detail.currentIAEmployments)) personNode.currentIAEmployments = detail.currentIAEmployments;
      if (Array.isArray(detail.previousIAEmployments)) personNode.previousIAEmployments = detail.previousIAEmployments;
      if (Array.isArray(detail.disclosures)) personNode.disclosures = detail.disclosures;
      if (Array.isArray(detail.iaDisclosures)) personNode.iaDisclosures = detail.iaDisclosures;
      if (bi.disclosureFlag) personNode.disclosureFlag = bi.disclosureFlag;
      if (detail.disclosureFlag) personNode.disclosureFlag = detail.disclosureFlag;
      if (detail.iaDisclosureFlag) personNode.iaDisclosureFlag = detail.iaDisclosureFlag;
      if (detail.examsCount) personNode.examsCount = detail.examsCount;
      if (Array.isArray(detail.stateExamCategory)) personNode.stateExamCategory = detail.stateExamCategory;
      if (Array.isArray(detail.principalExamCategory)) personNode.principalExamCategory = detail.principalExamCategory;
      if (Array.isArray(detail.productExamCategory)) personNode.productExamCategory = detail.productExamCategory;
      if (Array.isArray(detail.registeredSROs)) personNode.registeredSROs = detail.registeredSROs;
      if (Array.isArray(detail.registeredStates)) personNode.registeredStates = detail.registeredStates;
      if (detail.registrationCount) personNode.registrationCount = detail.registrationCount;
      if (detail.brokerDetails) personNode.brokerDetails = detail.brokerDetails;
      // compute firm count
      try {
        const firms = new Set();
        for (const employment of [
          ...(detail.currentEmployments || []),
          ...(detail.previousEmployments || []),
          ...(detail.currentIAEmployments || []),
          ...(detail.previousIAEmployments || []),
        ]) {
          if (employment?.firmId) firms.add(employment.firmId);
          else if (employment?.bdSECNumber) firms.add(employment.bdSECNumber);
        }
        personNode.firmCount = firms.size;
      } catch {}
      try {
        if (bi.daysInIndustry) {
          personNode.daysInIndustry = Number(bi.daysInIndustry);
          personNode.yearsExperience = Math.floor(personNode.daysInIndustry / 365);
        } else if (bi.daysInIndustryCalculatedDate || bi.daysInIndustryCalculatedDateIAPD) {
          const dstr = bi.daysInIndustryCalculatedDate || bi.daysInIndustryCalculatedDateIAPD;
          const year = new Date(dstr).getFullYear();
          if (year && !Number.isNaN(year)) personNode.yearsExperience = Math.max(0, new Date().getFullYear() - year);
        }
      } catch {}
      try {
        const current = detail.currentEmployments?.[0] || detail.currentIAEmployments?.[0];
        if (current) {
          const office = current.branchOfficeLocations?.[0];
          const parts = office ? [office.street1, office.street2, office.city, office.state, office.zipCode].filter(Boolean) : [];
          personNode.primaryOffice = { firmId: current.firmId, firmName: current.firmName, address: parts.join(", ") };
        }
      } catch {}
      personNode._detailLoaded = true;
    } catch (e) {
      console.warn("Failed to merge individual detail:", e);
    }
    console.log(`Detail loaded for CRD ${crd}: ${personNode.disclosures?.length || 0} BC disclosures, ${personNode.iaDisclosures?.length || 0} IA disclosures`);
    if (typeof refreshGraphColors === "function") refreshGraphColors();
  } catch (err) {
    console.error(`Error fetching individual detail for ${crd}:`, err);
  }
}

// Fetch firm detail from the server (which checks local cache first, then FINRA API).
// Merges the response into the firm node so renderFirmDetail can display rich data.
async function ensureFirmDetail(firmNode) {
  if (!firmNode || firmNode.group !== "firm") return;

  // Support both "firm:12345", legacy "firm_12345", and bare numeric ids
  const match = firmNode.id.match(/^(?:firm[:_])?(\d+)$/);
  if (!match) return;
  const firmId = match[1];

  if (firmNode._detailLoaded) return;

  try {
    // First try the local merged record (fast, no external call)
    let detail = null;
    try {
      const localRes = await fetch(`${BASE}/api/finra/merged/firm/${encodeURIComponent(firmId)}`);
      if (localRes.ok) {
        const merged = await localRes.json();
        if (merged?.found && merged?.finraNode) {
          // finraNode is already a graph node — merge any enriched fields
          const fn = merged.finraNode;
          if (fn.firmStatus) firmNode.firmStatus = fn.firmStatus;
          if (fn.firmStatusDate) firmNode.firmStatusDate = fn.firmStatusDate;
          if (fn.firmType) firmNode.firmType = fn.firmType;
          if (fn.bcScope) firmNode.bcScope = fn.bcScope;
          if (fn.regulator) firmNode.regulator = fn.regulator;
          if (fn.formedState) firmNode.formedState = fn.formedState;
          if (fn.formedDate) firmNode.formedDate = fn.formedDate;
          if (fn.isLegacy) firmNode.isLegacy = fn.isLegacy;
          if (fn.bdSecNumber) firmNode.bdSecNumber = fn.bdSecNumber;
          if (Array.isArray(fn.otherNames)) firmNode.otherNames = fn.otherNames;
          if (Array.isArray(fn.directOwners)) firmNode.directOwners = fn.directOwners;
          if (Array.isArray(fn.disclosures)) firmNode.disclosures = fn.disclosures;
          if (Array.isArray(fn.activeStates)) firmNode.activeStates = fn.activeStates;
          if (Array.isArray(fn.selfRegulatoryOrgs)) firmNode.selfRegulatoryOrgs = fn.selfRegulatoryOrgs;
          if (fn.firmSize) firmNode.firmSize = fn.firmSize;
          if (fn.iaSecNumber) firmNode.iaSecNumber = fn.iaSecNumber;
          if (fn.fiscalYearEnd) firmNode.fiscalYearEnd = fn.fiscalYearEnd;
          // For IA-only firms the merged node is sparse (no firmStatus, bcScope, activeStates).
          // Do not assume local merged data is complete for all firms; continue to live FINRA fetch.
          // If the live API fails, we'll still keep any fields merged from the local record.
        }
      }
    } catch {
      // local lookup failed — fall through to live API
    }

    // Fall back to live FINRA API (server-side cached for 7 days)
    try {
      const res = await fetch(`${BASE}/api/finra/firm/${encodeURIComponent(firmId)}`);
      if (!res.ok) {
        console.warn(`Failed to fetch firm detail for ${firmId}:`, res.status);
      } else {
        detail = unwrapDetailPayload(await res.json());
      }
    } catch (err) {
      console.warn(`Local API fetch failed for firm ${firmId}:`, err);
    }

    if (!detail || detail.found === false || (!detail.basicInformation && !detail.firmName && !detail.name)) {
      console.log(`Local API missing data for firm ${firmId}, fetching from external API...`);
      const ext = await fetchFromExternalApi(firmId, true);
      if (ext && (ext.basicInformation || ext.firmName || ext.name)) {
        detail = ext;
      }
    }

    if (!detail || (detail.found === false && !detail.basicInformation && !detail.firmName)) {
      console.warn(`Firm ${firmId} not found`);
      return;
    }

    const bi = detail?.basicInformation || {};
    if (bi.firmName && !firmNode.label?.trim()) firmNode.label = bi.firmName;
    if (bi.bcScope || bi.iaScope) firmNode.bcScope = bi.bcScope || bi.iaScope;
    if (bi.firmStatus) firmNode.firmStatus = bi.firmStatus;
    if (bi.firmStatusDate) firmNode.firmStatusDate = bi.firmStatusDate;
    if (bi.firmType) firmNode.firmType = bi.firmType;
    if (bi.firmSize) firmNode.firmSize = bi.firmSize;
    if (bi.regulator) firmNode.regulator = bi.regulator;
    if (bi.districtName) firmNode.districtName = bi.districtName;
    if (bi.formedState) firmNode.formedState = bi.formedState;
    if (bi.formedDate) firmNode.formedDate = bi.formedDate;
    if (bi.fiscalMonthEndCode) firmNode.fiscalYearEnd = bi.fiscalMonthEndCode;
    if (bi.iaSECNumber || bi.iaSecNumber || bi.bdSECNumber) firmNode.iaSecNumber = bi.iaSECNumber || bi.iaSecNumber || bi.bdSECNumber;
    if (bi.isLegacy) firmNode.isLegacy = bi.isLegacy;
    if (Array.isArray(bi.otherNames) && bi.otherNames.length) firmNode.otherNames = bi.otherNames;

    // Address / phone
    const addr = detail.firmAddressDetails || detail.iaFirmAddressDetails;
    if (addr) {
      const off = addr.officeAddress || {};
      const parts = [off.street1, off.city, off.state, off.postalCode, off.country].filter(Boolean);
      if (parts.length) firmNode.officeAddress = parts.join(", ");
      if (addr.businessPhoneNumber) firmNode.businessPhone = addr.businessPhoneNumber;
    }

    // Remap disclosures from API shape {disclosureType, disclosureCount} → {type, count}
    if (Array.isArray(detail.disclosures) && detail.disclosures.length) {
      firmNode.disclosures = detail.disclosures.map((dis) => ({
        type: dis.disclosureType || dis.type || "",
        count: dis.disclosureCount ?? dis.count ?? 0,
      }));
    }

    // Affiliate disclosures summary
    const aff = detail.affiliateDisclosures;
    if (aff) {
      firmNode.affiliateDisclosures = aff;
    }

    if (Array.isArray(detail.directOwners) && detail.directOwners.length) {
      firmNode.directOwners = detail.directOwners;
    }

    const reg = detail.registrations || {};
    if (Array.isArray(reg.stateList) && reg.stateList.length) {
      // stateList may be [{state: "Alabama"}, ...] or ["Alabama", ...]
      firmNode.activeStates = reg.stateList.map((s) => (typeof s === "string" ? s : s.state || JSON.stringify(s)));
    }
    if (Array.isArray(reg.SROList) && reg.SROList.length) {
      firmNode.selfRegulatoryOrgs = reg.SROList.map((s) => (typeof s === "string" ? s : s.sro || s.name || JSON.stringify(s)));
    }

    // IA-only firms: pull registration status and notice-filed states from SEC fields
    if (!firmNode.firmStatus && Array.isArray(detail.registrationStatus) && detail.registrationStatus.length) {
      const reg0 = detail.registrationStatus[0];
      if (reg0.status) firmNode.firmStatus = reg0.status;
      if (reg0.effectiveDate) firmNode.firmStatusDate = reg0.effectiveDate;
      if (reg0.secJurisdiction) firmNode.regulator = reg0.secJurisdiction;
    }
    // noticeFilings gives the states where the IA is notice-filed
    if (!firmNode.activeStates?.length && Array.isArray(detail.noticeFilings) && detail.noticeFilings.length) {
      firmNode.activeStates = detail.noticeFilings
        .filter((f) => /Notice Filed|Approved/i.test(f.status || ""))
        .map((f) => f.jurisdiction)
        .filter(Boolean);
    }
    // brochures (Form ADV Part 2)
    if (detail.brochures?.brochuredetails?.length && !firmNode.brochures) {
      firmNode.brochures = detail.brochures.brochuredetails;
    }

    firmNode._detailLoaded = true;
    console.log(`Firm detail loaded for ID ${firmId}: ${firmNode.disclosures?.length || 0} disclosures, ${firmNode.directOwners?.length || 0} owners`);
  } catch (err) {
    console.error(`Error fetching firm detail for ${firmId}:`, err);
  }
}

function selectNode(d) {
  selectedId = d.id;
  nodeSel.classed("selected", (n) => n.id === d.id);
  highlightLinks(d.id);
  renderSidebar(d);

  // Add the selected node to the seed profile
  const rawId = d.id.split(':').pop();
  const parsedId = rawId && !isNaN(rawId) ? parseInt(rawId, 10) : null;
  if (parsedId) {
    const data = d.group === 'individual' ? { individuals: [parsedId] } : { firms: [parsedId] };
    syncProfileSelection(data);
  }

  // For individual nodes, fetch detail data from API and re-render if it's still selected
  if (d.group === "individual") {
    ensureIndividualDetail(d)
      .then(() => {
        // Re-render sidebar if this node is still selected
        if (selectedId === d.id) {
          renderSidebar(d);
        }
      })
      .catch((err) => {
        console.error("Failed to load individual detail:", err);
      });
  }

  // For firm nodes, fetch Form BD detail (local first, then FINRA API) and re-render
  if (d.group === "firm") {
    ensureFirmDetail(d)
      .then(() => {
        if (selectedId === d.id) {
          renderSidebar(d);
        }
      })
      .catch((err) => {
        console.error("Failed to load firm detail:", err);
      });
  }

  // Read the hops selector value (1,2,3,4 or 'all') and pass through
  const hopsEl = document.getElementById("fg-reveal-hops");
  let hops = 1;
  if (hopsEl) {
    const v = hopsEl.value;
    hops = v === "all" ? "all" : parseInt(v, 10) || 1;
  }
  // Fetch 1-hop neighbors from the full server graph, merge into graphData,
  // then reveal.  Falls back gracefully if the fetch fails.
  expandFromServer(d, hops);
  spreadNeighbors(d);
}

// Fetch the 1-hop neighbourhood of `clickedNode` from the server's full graph,
// merge any new nodes/links into the local graphData, then call revealNeighbors.
async function expandFromServer(clickedNode, hops = 1) {
  try {
    const r = await fetch(
      `${BASE}/api/finra/expand/${encodeURIComponent(clickedNode.id)}`,
    );
    if (r.ok) {
      const { nodes: newNodes, links: newLinks } = await r.json();
      const renderedIds = new Set((layoutNodes || []).map((n) => n.id));
      const hiddenNodes = (newNodes || [])
        .filter((n) => n.id !== clickedNode.id && !renderedIds.has(n.id))
        .map((n, index) => {
          const radius = 110 + (index % 6) * 24;
          const angle = (index / Math.max(1, newNodes.length - 1 || 1)) * Math.PI * 2;
          return {
            ...n,
            x:
              clickedNode.x +
              Math.cos(angle) * radius +
              (Math.random() - 0.5) * 18,
            y:
              clickedNode.y +
              Math.sin(angle) * radius +
              (Math.random() - 0.5) * 18,
          };
        });

      mergeIntoGraphData(newNodes, newLinks);

      if (hiddenNodes.length && typeof appendFetched === "function") {
        appendFetched(hiddenNodes, newLinks || []);
      }
    }
  } catch {
    // non-critical — fall back to whatever is already in graphData
  }
  revealNeighbors(clickedNode, hops);
}

async function expandLoadedSeedNodes() {
  if (!layoutNodes || !graphData) return;
  const seedIds = new Set(
    layoutNodes
      .filter((n) => n.group === "individual" || n.group === "firm")
      .map((n) => n.id),
  );
  for (const node of layoutNodes) {
    if (!seedIds.has(node.id)) continue;
    await expandFromServer(node, 1);
  }
}

async function expandFetchedNodes(nodes, hops = 1) {
  if (!Array.isArray(nodes) || !nodes.length || !layoutNodes || !graphData) {
    return;
  }

  const seen = new Set();
  const candidates = nodes.filter(
    (node) => node && (node.group === "individual" || node.group === "firm"),
  );

  for (const node of candidates) {
    if (!node?.id || seen.has(node.id)) continue;
    seen.add(node.id);
    const liveNode = layoutNodes.find((entry) => entry.id === node.id);
    if (!liveNode) continue;
    await expandFromServer(liveNode, hops);
  }
}

// Bring any hidden neighbors (present in graphData but not yet rendered) into
// the live graph without a full re-render.
function revealNeighbors(clickedNode, hops = 1) {
  if (!graphData || !layoutNodes || !layoutLinks || !nodeGroup || !linkGroup)
    return;

  const renderedIds = new Set(layoutNodes.map((n) => n.id));

  // Build adjacency from the full graph data (cached per call)
  const adj = new Map();
  graphData.nodes.forEach((n) => adj.set(n.id, new Set()));
  graphData.links.forEach((l) => {
    const srcId = l.source?.id ?? l.source;
    const tgtId = l.target?.id ?? l.target;
    if (!adj.has(srcId)) adj.set(srcId, new Set());
    if (!adj.has(tgtId)) adj.set(tgtId, new Set());
    adj.get(srcId).add(tgtId);
    adj.get(tgtId).add(srcId);
  });

  // BFS to collect ids up to `hops` away; hops === 'all' means unlimited
  const dist = new Map();
  const q = [clickedNode.id];
  dist.set(clickedNode.id, 0);
  for (let i = 0; i < q.length; i++) {
    const id = q[i];
    const d = dist.get(id);
    if (hops !== "all" && d >= hops) continue;
    (adj.get(id) || []).forEach((nid) => {
      if (!dist.has(nid)) {
        dist.set(nid, d + 1);
        q.push(nid);
      }
    });
  }

  // Remove the clicked node itself
  dist.delete(clickedNode.id);

  // Filter to only nodes not yet rendered
  const hiddenIds = Array.from(dist.keys()).filter(
    (id) => !renderedIds.has(id),
  );
  if (hiddenIds.length === 0) return;

  // Create new node objects with positions based on hop distance
  const newNodes = graphData.nodes
    .filter((n) => hiddenIds.includes(n.id))
    .map((n) => {
      const d = dist.get(n.id) || 1;
      const radius = 80 + d * 60;
      const ang = Math.random() * Math.PI * 2;
      return {
        ...n,
        x: clickedNode.x + Math.cos(ang) * radius + (Math.random() - 0.5) * 20,
        y: clickedNode.y + Math.sin(ang) * radius + (Math.random() - 0.5) * 20,
      };
    });

  // Now include any links that connect these newly-rendered nodes to the now-rendered set
  const nowRenderedIds = new Set([
    ...renderedIds,
    ...newNodes.map((n) => n.id),
  ]);
  const newLinks = graphData.links
    .filter((l) => {
      const srcId = l.source?.id ?? l.source;
      const tgtId = l.target?.id ?? l.target;
      if (!nowRenderedIds.has(srcId) || !nowRenderedIds.has(tgtId))
        return false;
      const alreadyHas = layoutLinks.some((el) => {
        const es = el.source?.id ?? el.source;
        const et = el.target?.id ?? el.target;
        return es === srcId && et === tgtId;
      });
      return !alreadyHas;
    })
    .map((l) => ({ ...l }));

  if (newNodes.length === 0 && newLinks.length === 0) return;

  // Push into live arrays
  layoutNodes.push(...newNodes);
  layoutLinks.push(...newLinks);

  // Add revealed nodes to seed profile for persistence
  const individuals = newNodes
    .filter((n) => n.group === "individual")
    .map((n) => Number(String(n.id).split(":").pop()))
    .filter(Number.isFinite);
  const firms = newNodes
    .filter((n) => n.group === "firm")
    .map((n) => Number(String(n.id).split(":").pop()))
    .filter(Number.isFinite);
  if (individuals.length || firms.length) {
    syncProfileSelection({ individuals, firms });
  }

  // Rebuild neighbor cache for the live layout
  neighborMap = buildNeighborMap(layoutNodes, layoutLinks);

  // Update the subset info to reflect newly-visible nodes
  if (graphData) updateSubsetInfo(layoutNodes.length, graphData.nodes.length);

  // Append new link <line> elements
  const allLinks = linkGroup.selectAll("line").data(layoutLinks, (d) => {
    const s = d.source?.id ?? d.source;
    const t = d.target?.id ?? d.target;
    return `${s}-${t}-${d.relationship}`;
  });
  // const enteredLinks = allLinks
  //   .enter()
  //   .append("line")
  //   .attr("stroke", (d) => LINK_COLOR[d.relationship] || "#5e6268")
  //   .attr("stroke-opacity", 0)
  //   .attr("stroke-width", 1)
  //   .attr("marker-end", (d) => `url(#arrow-${d.relationship})`);
  // enteredLinks
  //   .transition()
  //   .duration(400)
  //   .attr("stroke-opacity", defaultLinkOpacity);
  // linkSel = linkGroup.selectAll("line");

  const enteredLinks = allLinks
    .enter()
    .append("line")
    .attr("stroke", (d) => getLinkColor(d))
    .attr("stroke-opacity", 0)
    .attr("stroke-width", 0.5)
    .attr("marker-end", (d) => getLinkMarker(d));
  enteredLinks
    .transition()
    .duration(400)
    .attr("stroke-opacity", defaultLinkOpacity);
  linkSel = linkGroup.selectAll("line");

  // Append new node <g> elements
  const allNodes = nodeGroup
    .selectAll("g.fg-node")
    .data(layoutNodes, (d) => d.id);
  const enteredNodes = allNodes
    .enter()
    .append("g")
    .attr("class", "fg-node")
    .attr("opacity", 0)
    .call(fluidDrag())
    .on("click", (event, d) => {
      event.stopPropagation();
      selectNode(d);
    });

  // Draw shapes on new nodes (reuse same logic as renderGraph)
  enteredNodes.each(function (d) {
    const g = d3.select(this);
    const r = NODE_R[d.group] || 10;
    const color = NODE_COLOR[d.group] || "#475569";
    if (d.group === "firm") {
      const s = (d._vizHalf ?? r * 0.85) * 2 || r * 2;
      g.append("rect")
        .attr("x", -s / 2)
        .attr("y", -s / 2)
        .attr("width", s)
        .attr("height", s)
        .attr("rx", 3)
        .attr("fill", color)
        .attr("stroke", "#fff")
        .attr("stroke-width", 1.5)
        .attr("opacity", d.stub ? 0.45 : 0.9);
    } else if (d.group === "entity") {
      const s = r * 1.5;
      g.append("polygon")
        .attr("points", `0,${-s} ${s},0 0,${s} ${-s},0`)
        .attr("fill", color)
        .attr("stroke", "#fff")
        .attr("stroke-width", 1.5)
        .attr("opacity", 0.8);
    } else {
      const rv = d._vizHalf != null ? d._vizHalf : r;
      g.append("circle")
        .attr("r", rv)
        .attr("fill", color)
        .attr("stroke", "#fff")
        .attr("stroke-width", 1.5)
        .attr("opacity", d.stub ? 0.5 : 1);
    }
    drawDisclosureIndicator(g, d, r);
    ["halo", "fill"].forEach((pass) => {
      g.append("text")
        .attr("class", `fg-label-${pass}`)
        .attr("dy", d._vizHalf != null ? d._vizHalf + 14 : r + 14)
        .attr("text-anchor", "middle")
        .attr("font-size", "10px")
        .attr("font-family", "var(--sans)")
        .attr("font-weight", "500")
        .attr("fill", pass === "halo" ? "none" : "#1e293b")
        .attr("stroke", pass === "halo" ? "rgba(246,248,252,0.92)" : "none")
        .attr("stroke-width", pass === "halo" ? 4 : 0)
        .attr("stroke-linejoin", "round")
        .attr("paint-order", "stroke")
        .attr("pointer-events", "none")
        .text(truncate(capitalize(d.label), 22));
    });
    g.append("title").text(() => {
      const parts = [d.label, d.group.toUpperCase()];
      if (d.crd) parts.push(`CRD: ${d.crd}`);
      return parts.join("\n");
    });
  });

  enteredNodes.transition().duration(400).attr("opacity", 1);
  nodeSel = nodeGroup.selectAll("g.fg-node");

  refreshGraphColors();

  // Restart simulation with new nodes/links
  simulation.nodes(layoutNodes);
  simulation.force("link").links(layoutLinks);

  // Unfix nodes within a generous radius so the simulation can make room
  const UNFIX_RADIUS = 400;
  layoutNodes.forEach((n) => {
    const dx = n.x - clickedNode.x;
    const dy = n.y - clickedNode.y;
    if (Math.sqrt(dx * dx + dy * dy) < UNFIX_RADIUS) {
      n.fx = null;
      n.fy = null;
    }
  });

  simulation.alpha(0.45).restart();

  // Re-freeze once settled
  simulation.on("end.reveal", () => {
    layoutNodes.forEach((n) => {
      n.fx = n.x;
      n.fy = n.y;
    });
  });

  // Persist session so reload restores these nodes
  saveSession();

  // Update tick handler to cover new selections
  simulation.on("tick", () => {
    linkSel
      .attr("x1", (d) => d.source.x)
      .attr("y1", (d) => d.source.y)
      .attr("x2", (d) => d.target.x)
      .attr("y2", (d) => d.target.y);
    nodeSel.attr("transform", (d) => `translate(${d.x},${d.y})`);
  });

  // Persist session so reload restores these revealed neighbors
  try {
    saveSession();
  } catch (e) {
    /* ignore */
  }
}

function showSidebarHint() {
  const inner = document.getElementById("fg-sidebar-inner");
  if (inner)
    inner.innerHTML = `<p class="fg-hint">Click a node to inspect it.</p>`;
  const side = document.getElementById("fg-sidebar");
  if (side) side.classList.add("hidden");
  try {
    updateShortDetail(null);
  } catch (e) {
    /* ignore */
  }
}

// ── Link highlight on selection ───────────────────────────────────────────────
// activeId = null  → reset all lines to their default appearance
// activeId = id    → brighten connected lines by type; dim unconnected ones
function highlightLinks(activeId) {
  if (!linkSel) return;
  if (activeId == null) {
    // restore default appearance (both attributes and inline styles)
    linkSel
      .style("stroke-opacity", null)
      .style("opacity", null)
      .attr("stroke", (d) => getLinkColor(d))
      .attr("stroke-opacity", defaultLinkOpacity)
      .attr("stroke-width", 0.5);
    return;
  }
  linkSel.each(function (d) {
    const srcId = d.source?.id ?? d.source;
    const tgtId = d.target?.id ?? d.target;
    const connected = srcId === activeId || tgtId === activeId;
    const sel = d3.select(this);
    if (connected) {
      // controls → vivid red; employed_by → vivid cyan-blue
      sel
        .style("opacity", 1)
        .style("stroke-opacity", null)
        .attr("stroke", d.relationship === "controls" ? "#ff2222" : (isCurrentRegistration(d) ? "#ff2222" : "#38bdf8"))
        .attr("stroke-opacity", 1)
        .attr("stroke-width", d.relationship === "controls" ? 2.5 : (isCurrentRegistration(d) ? 2.5 : 2));
    } else {
      sel
        .style("opacity", null)
        .style("stroke-opacity", null)
        .attr("stroke", getLinkColor(d));
      // .attr("stroke-opacity", 0.45)
      // .attr("stroke-width", 0.5);
    }
  });
}

// ── Spread neighbors on click ────────────────────────────────────────────────
function spreadNeighbors(clickedNode) {
  if (!layoutNodes || !layoutLinks || !nodeSel || !linkSel) return;
  if (spreadAnimId) {
    cancelAnimationFrame(spreadAnimId);
    spreadAnimId = null;
  }

  const SPREAD = 80;
  const DURATION = 480;

  // Find all direct neighbor IDs using the cached adjacency map
  const neighborIds = getNeighborIds(clickedNode.id);
  if (neighborIds.size === 0) return;

  // Fast node lookup
  const nodeById = new Map(layoutNodes.map((d) => [d.id, d]));

  // Capture start and target positions for each neighbor
  const snapshots = new Map();
  neighborIds.forEach((id) => {
    const d = nodeById.get(id);
    if (!d) return;
    const dx = d.x - clickedNode.x;
    const dy = d.y - clickedNode.y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
    snapshots.set(id, {
      x0: d.x,
      y0: d.y,
      x1: d.x + (dx / dist) * SPREAD,
      y1: d.y + (dy / dist) * SPREAD,
    });
  });

  const startTime = performance.now();

  function frame(now) {
    const raw = Math.min((now - startTime) / DURATION, 1);
    const ease = d3.easeCubicOut(raw);

    // Interpolate positions directly in the data objects
    // (link .source.x / .target.y then read naturally)
    snapshots.forEach((snap, id) => {
      const d = nodeById.get(id);
      if (!d) return;
      d.x = snap.x0 + (snap.x1 - snap.x0) * ease;
      d.y = snap.y0 + (snap.y1 - snap.y0) * ease;
    });

    // Re-render affected nodes
    nodeSel
      .filter((d) => neighborIds.has(d.id))
      .attr("transform", (d) => `translate(${d.x},${d.y})`);

    // Re-render all links touching the clicked node or any neighbor
    linkSel
      .filter((l) => {
        const srcId = l.source?.id ?? l.source;
        const tgtId = l.target?.id ?? l.target;
        return (
          srcId === clickedNode.id ||
          tgtId === clickedNode.id ||
          neighborIds.has(srcId) ||
          neighborIds.has(tgtId)
        );
      })
      .attr("x1", (l) => l.source.x)
      .attr("y1", (l) => l.source.y)
      .attr("x2", (l) => l.target.x)
      .attr("y2", (l) => l.target.y);

    if (raw < 1) {
      spreadAnimId = requestAnimationFrame(frame);
    } else {
      spreadAnimId = null;
      // Freeze at final positions
      snapshots.forEach((snap, id) => {
        const d = nodeById.get(id);
        if (!d) return;
        d.x = snap.x1;
        d.y = snap.y1;
        d.fx = d.x;
        d.fy = d.y;
      });
    }
  }

  spreadAnimId = requestAnimationFrame(frame);
}

function focusNodeById(id) {
  try {
    if (!zoomBehavior || !svgSel) return;
    // layoutNodes is the current array of node objects in the visualization
    const node =
      (Array.isArray(layoutNodes) && layoutNodes.find((n) => n.id === id)) ||
      null;
    if (!node) return;
    const main = document.getElementById("fg-main");
    const W = main.clientWidth;
    const H = main.clientHeight;
    const transform = d3.zoomTransform(svgSel.node());
    const k = transform.k || 1;
    const x = node.x || 0;
    const y = node.y || 0;
    const tx = W / 2 - x * k;
    const ty = H / 2 - y * k;
    svgSel
      .transition()
      .duration(600)
      .call(zoomBehavior.transform, d3.zoomIdentity.translate(tx, ty).scale(k));

    // transient highlight: enlarge circle briefly
    try {
      nodeSel
        .filter((n) => n.id === id)
        .select("circle")
        .transition()
        .duration(250)
        .attr("r", (n) => (n._vizHalf || 6) * 1.6)
        .transition()
        .duration(300)
        .attr("r", (n) => n._vizHalf || 6);
    } catch (e) {
      /* ignore highlight errors */
    }
  } catch (e) {
    console.warn("focusNodeById error", e);
  }
}

function renderSidebar(d) {
  const el = document.getElementById("fg-sidebar-inner");
  el.innerHTML =
    d.group === "firm"
      ? renderFirmDetail(d)
      : d.group === "entity"
        ? renderEntityDetail(d)
        : renderPersonDetail(d);
  // show sidebar and update header short detail when rendering
  const side = document.getElementById("fg-sidebar");
  if (side) side.classList.remove("hidden");
  try {
    updateShortDetail(d);
  } catch (e) {
    /* no-op */
  }

  // Ensure a focus button exists in the sidebar header for centering selected node
  (function ensureFocusButton() {
    const sideEl = document.getElementById("fg-sidebar");
    const inner = document.getElementById("fg-sidebar-inner");
    if (!inner || !sideEl) return;
    // record which node is currently displayed in the sidebar
    sideEl.dataset.displayedId = d?.id || "";
    if (sideEl.querySelector("#fg-focus-btn")) return;
    const btn = document.createElement("button");
    btn.id = "fg-focus-btn";
    btn.className = "fg-btn fg-btn-small";
    btn.title = "Center selected node";
    btn.innerText = "Center Node";
    btn.addEventListener("click", () => {
      // Prefer the node currently shown in the sidebar, even if not selected
      const sid = sideEl.dataset.displayedId || selectedId;
      if (!sid) return;
      // find node object and select it (so UI state is consistent)
      const nodeObj =
        (Array.isArray(layoutNodes) && layoutNodes.find((n) => n.id === sid)) ||
        null;
      if (nodeObj && typeof selectNode === "function") {
        // selectNode expects the node data object
        selectNode(nodeObj);
      }
      focusNodeById(sid);
    });
    const header = inner.querySelector(".fg-sb-header");
    if (header) header.appendChild(btn);
    else inner.insertBefore(btn, inner.firstChild);
  })();

  openSidebarToggles();

  // manual load button removed — details are auto-fetched on node selection
}

// ── Person detail ────────────────────────────────────────────────────────────
function renderPersonDetail(d) {
  const bi = d.basicInformation || {};
  const links = (graphData?.links || []).filter(
    (l) =>
      (l.source?.id || l.source) === d.id ||
      (l.target?.id || l.target) === d.id,
  );
  const controlLinks = links.filter((l) => l.relationship === "controls");

  const stubBadge = d.stub
    ? `<span class="fg-badge stub">Form BD stub</span>`
    : "";

  // ── Scope badges ──────────────────────────────────────────────────────────
  const _rawScopes = [
    { text: d.bcScope || bi.bcScope, src: "BrokerCheck" },
    { text: d.iaScope || bi.iaScope, src: "SEC AdvisorInfo" },
  ].filter((s) => s.text);
  const _dedupMap = {};
  _rawScopes.forEach((s) => {
    const txt = capitalize(String(s.text || "").toLowerCase());
    const key = txt.toLowerCase();
    const cls =
      txt.toLowerCase().includes("active") &&
      !txt.toLowerCase().includes("inact")
        ? "active"
        : "inactive";
    if (!_dedupMap[key]) _dedupMap[key] = { text: txt, cls, sources: [s.src] };
    else _dedupMap[key].sources.push(s.src);
  });
  const scopeBadgesHtml = Object.values(_dedupMap)
    .map(
      (b) =>
        `<span class="fg-badge ${b.cls}" title="${esc(b.sources.join("; "))}">${esc(b.text)}</span>`,
    )
    .join(" ");

  // ── All disclosures (BC + IA) ─────────────────────────────────────────────
  // Deduplicate: for each (type, date) pair keep the entry with the most content.
  // A blank duplicate (same type, no date/detail/resolution) is dropped when a
  // richer entry with the same type already exists.
  const _rawDisclosures = [...(d.disclosures || []), ...(d.iaDisclosures || [])];
  const allDisclosures = (() => {
    function disHasContent(dis) {
      return !!(
        (dis.eventDate || dis.date || "").trim() ||
        (dis.disclosureResolution || dis.resolution || "").trim() ||
        (dis.disclosureDetail && Object.keys(dis.disclosureDetail).length > 0)
      );
    }

    // Two-pass: first collect all, then drop blank entries whose type already
    // has at least one entry with real content.
    const byType = new Map(); // type -> has any entry with content
    for (const dis of _rawDisclosures) {
      const dtype = (dis.disclosureType || dis.type || "").trim();
      if (!byType.has(dtype)) byType.set(dtype, false);
      if (disHasContent(dis)) byType.set(dtype, true);
    }

    // Second pass: deduplicate by (type + date), dropping blank entries when
    // a richer entry of the same type exists.
    const seen = new Map();
    for (const dis of _rawDisclosures) {
      const dtype = (dis.disclosureType || dis.type || "").trim();
      const ddate = (dis.eventDate || dis.date || "").trim();
      const key = `${dtype}||${ddate}`;
      const hasContent = disHasContent(dis);

      // Drop completely blank entries when any entry of this type has content
      if (!hasContent && byType.get(dtype)) continue;

      if (!seen.has(key)) {
        seen.set(key, dis);
      } else if (hasContent && !disHasContent(seen.get(key))) {
        seen.set(key, dis); // upgrade to richer entry
      }
    }
    return Array.from(seen.values());
  })();
  const disclosureCount = allDisclosures.length;
  const aliases = d.otherNames?.length ? d.otherNames : bi.otherNames || [];

  // ── Employment timeline from stored arrays, fallback to graph links ────────
  // Build unified list from FINRA arrays (currentEmployments, previousEmployments,
  // currentIAEmployments, previousIAEmployments) if stored on node.
  function empToEntry(emp, isCurrent) {
    const bo = emp.branchOfficeLocations?.[0];
    const city = emp.city || bo?.city || "";
    const state = emp.state || bo?.state || "";
    const street = bo?.street1 || "";
    const zip = bo?.zipCode || "";
    const loc = [city, state].filter(Boolean).join(", ");
    const addr = [street, city, state, zip].filter(Boolean).join(", ");
    return {
      firmName: emp.firmName || "",
      firmId: emp.firmId,
      bdSecNumber: emp.bdSECNumber,
      iaSECNumber: emp.iaSECNumber,
      start: emp.registrationBeginDate || "",
      end: emp.registrationEndDate || null,
      isCurrent: isCurrent || !emp.registrationEndDate,
      iaOnly: emp.iaOnly === "Y",
      firmBCScope: emp.firmBCScope,
      firmIAScope: emp.firmIAScope,
      loc,
      addr,
      expelledDate: emp.expelledDate,
    };
  }

  function regToEntry(emp, role, isCurrent) {
    const office = emp.branchOfficeLocations?.[0];
    const officeAddress = office
      ? [
          office.street1,
          office.street2,
          office.city,
          office.state,
          office.zipCode,
        ]
          .filter(Boolean)
          .join(", ")
      : "";
    const cityState = [
      emp.city || office?.city || "",
      emp.state || office?.state || "",
    ]
      .filter(Boolean)
      .join(", ");
    return {
      role,
      firmId: emp.firmId,
      firmName: emp.firmName || "",
      start: emp.registrationBeginDate || "",
      end: emp.registrationEndDate || null,
      isCurrent,
      officeAddress,
      cityState,
    };
  }

  function dedupeRegs(items) {
    const seen = new Set();
    return items.filter((item) => {
      const key = [
        item.role,
        item.firmId,
        item.start,
        item.end || "present",
        item.cityState,
      ].join("|");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  const currentRegistrations = dedupeRegs([
    ...(d.currentIAEmployments || []).map((emp) => regToEntry(emp, "IA", true)),
    ...(d.currentEmployments || []).map((emp) => regToEntry(emp, "B", true)),
  ]);
  const previousRegistrations = dedupeRegs([
    ...(d.previousIAEmployments || []).map((emp) =>
      regToEntry(emp, "IA", false),
    ),
    ...(d.previousEmployments || []).map((emp) => regToEntry(emp, "B", false)),
  ]).sort((a, b) => (b.end || "").localeCompare(a.end || ""));

  const hasStoredEmps =
    d.currentEmployments?.length ||
    d.previousEmployments?.length ||
    d.currentIAEmployments?.length ||
    d.previousIAEmployments?.length;

  let empEntries = [];
  if (hasStoredEmps) {
    empEntries = [
      ...(d.currentEmployments || []).map((e) => empToEntry(e, true)),
      ...(d.currentIAEmployments || []).map((e) => empToEntry(e, true)),
      ...(d.previousEmployments || []).map((e) => empToEntry(e, false)),
      ...(d.previousIAEmployments || []).map((e) => empToEntry(e, false)),
    ];
    // De-duplicate by firmId + start date
    const seen = new Set();
    empEntries = empEntries.filter((e) => {
      const key = `${e.firmId || e.firmName}|${e.start}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    // Sort: current first, then by start date desc
    empEntries.sort((a, b) => {
      if (a.isCurrent && !b.isCurrent) return -1;
      if (!a.isCurrent && b.isCurrent) return 1;
      return (b.start || "").localeCompare(a.start || "");
    });
  } else {
    // Fallback: derive from graph links
    const empLinks = links
      .filter((l) => l.relationship === "employed_by")
      .sort((a, b) => {
        if (!a.endDate && b.endDate) return -1;
        if (a.endDate && !b.endDate) return 1;
        return (b.startDate || "").localeCompare(a.startDate || "");
      });
    empEntries = empLinks.map((l) => {
      const firmNode = graphData.nodes.find(
        (n) => n.id === (l.target?.id || l.target),
      );
      return {
        firmName: firmNode?.label || l.firmName || "",
        firmId: l.firmId,
        start: l.startDate || "",
        end: l.endDate || null,
        isCurrent: !l.endDate,
        iaOnly: false,
        loc: [l.city, l.state].filter(Boolean).join(", "),
      };
    });
  }

  // ── Exam categories ────────────────────────────────────────────────────────
  const allExams = [
    ...(d.stateExamCategory || []),
    ...(d.principalExamCategory || []),
    ...(d.productExamCategory || []),
  ];

  // ── Registered states (raw objects with scope) ─────────────────────────────
  const regStates = Array.isArray(d.registeredStates)
    ? d.registeredStates.filter(Boolean)
    : [];
  const licenseCount =
    regStates.length ||
    (d.registrationCount?.approvedStateRegistrationCount || 0) +
      (d.registrationCount?.approvedIAStateRegistrationCount || 0);

  // ── Helper: render a single raw FINRA/SEC disclosure ──────────────────────
  function renderDisclosure(dis) {
    const dtype = dis.disclosureType || dis.type || "";
    const ddate = dis.eventDate || dis.date || "";
    const dres = dis.disclosureResolution || dis.resolution || "";
    const dd = dis.disclosureDetail || {};

    const isObj = dd && typeof dd === "object" && !Array.isArray(dd);

    const allegs = isObj ? dd["Allegations"] || dd["allegations"] || "" : "";
    const initiatedBy = isObj
      ? dd["Initiated By"] || dd["initiatedBy"] || ""
      : "";
    const resolution = isObj ? dd["Resolution"] || dd["resolution"] || "" : "";
    const sanctionText = isObj ? dd["Sanctions"] || dd["sanctions"] || "" : "";
    const sanctionDetails = isObj
      ? dd["SanctionDetails"] || dd["Sanction Details"] || []
      : [];
    const brokerComment = isObj
      ? dd["Broker Comment"] || dd["brokerComment"] || null
      : null;
    const settlementAmt = isObj
      ? dd["Settlement Amount"] || dd["settlementAmount"] || ""
      : "";
    const docketFDA = isObj ? (dd["DocketNumberFDA"] || "").trim() : "";
    const docketAAO = isObj ? (dd["DocketNumberAAO"] || "").trim() : "";
    const arbDocket = isObj ? dd["arbitrationDocketNumber"] || "" : "";
    const isIAExcl = dis.isIapdExcludedCCFlag === "Y";
    const isBCExcl = dis.isBcExcludedCCFlag === "Y";

    const comments = Array.isArray(brokerComment)
      ? brokerComment
      : brokerComment
        ? [brokerComment]
        : [];

    const sanctionBadges = [
      ...(Array.isArray(sanctionDetails)
        ? sanctionDetails.map((s) =>
            typeof s === "object"
              ? s.Sanctions || s.sanctions || ""
              : String(s),
          )
        : []),
    ]
      .map((s) => String(s).trim())
      .filter(Boolean);

    return `
      <div class="fg-disclosure">
        <div class="fg-dis-header">
          <span class="fg-dis-type">${esc(dtype)}</span>
          ${ddate ? `<span class="fg-dis-date">${esc(ddate)}</span>` : ""}
          ${dres ? `<span class="fg-dis-res ${/final|settled/i.test(dres) ? "final" : "pending"}">${esc(dres)}</span>` : ""}
          ${isIAExcl || isBCExcl ? `<span class="fg-badge inactive" title="Excluded from count">${isIAExcl ? "IA-excl" : ""}${isIAExcl && isBCExcl ? " " : ""}${isBCExcl ? "BC-excl" : ""}</span>` : ""}
        </div>
        ${initiatedBy ? `<div class="fg-dis-row"><span class="fg-dis-label">Initiated by:</span> ${esc(initiatedBy)}</div>` : ""}
        ${allegs ? `<div class="fg-dis-row"><span class="fg-dis-label">Allegations:</span><div class="fg-dis-text">${esc(allegs)}</div></div>` : ""}
        ${resolution ? `<div class="fg-dis-row"><span class="fg-dis-label">Resolution:</span> ${esc(resolution)}</div>` : ""}
        ${sanctionText ? `<div class="fg-dis-row"><span class="fg-dis-label">Sanctions:</span><div class="fg-dis-text">${esc(sanctionText)}</div></div>` : ""}
        ${settlementAmt ? `<div class="fg-dis-row"><span class="fg-dis-label">Settlement:</span> <strong>${esc(settlementAmt)}</strong></div>` : ""}
        ${sanctionBadges.length ? `<div class="fg-dis-sanctions">${sanctionBadges.map((s) => `<span class="fg-badge inactive">${esc(s)}</span>`).join(" ")}</div>` : ""}
        ${comments.length ? `<div class="fg-dis-row"><span class="fg-dis-label">Broker comment:</span><div class="fg-dis-text fg-dis-comment">${comments.map((c) => esc(String(c))).join("<br>")}</div></div>` : ""}
        ${docketFDA || docketAAO || arbDocket ? `<div class="fg-dis-row fg-dis-dockets">${[docketFDA && `FDA: ${esc(docketFDA)}`, docketAAO && `AAO: ${esc(docketAAO)}`, arbDocket && `Arb: ${esc(arbDocket)}`].filter(Boolean).join(" &nbsp;|&nbsp; ")}</div>` : ""}
      </div>`;
  }

  const crd = bi.individualId || d.crd || String(d.id).replace(/^person[:_]/, "");
  const bcRawUrl = bi.individualId
    ? `https://api.brokercheck.finra.org/search/individual/${encodeURIComponent(crd)}?hl=true&includePrevious=true&nrows=12&r=25&sort=bc_lastname_sort+asc,bc_firstname_sort+asc,bc_middlename_sort+asc,score+desc&wt=json`
    : null;
  const secRawUrl = bi.individualId
    ? `https://api.adviserinfo.sec.gov/search/individual/${encodeURIComponent(crd)}?hl=true&includePrevious=true&nrows=12&r=25&sort=bc_lastname_sort+asc,bc_firstname_sort+asc,bc_middlename_sort+asc,score+desc&wt=json`
    : null;

  return `
    <div class="fg-sb-header individual">
      <div class="fg-sb-title">${esc(d.label || [bi.firstName, bi.middleName, bi.lastName].filter(Boolean).join(" "))}</div>
      <div class="fg-sb-badges">
        ${scopeBadgesHtml}
        ${stubBadge}
        ${disclosureCount ? `<span class="fg-badge inactive">${disclosureCount} disclosure${disclosureCount !== 1 ? "s" : ""}</span>` : ""}
      </div>
    </div>
    <div class="fg-sb-body">
      <div class="fg-ext-links">
        ${bi.individualId ? `<a class="fg-ext-link bc" href="https://brokercheck.finra.org/individual/summary/${encodeURIComponent(bi.individualId)}" target="_blank" rel="noopener noreferrer">&#x2197; BrokerCheck Summary</a>` : ""}
        ${bi.individualId && d.hasSecData ? `<a class="fg-ext-link sec" href="https://adviserinfo.sec.gov/Individual/${encodeURIComponent(bi.individualId)}" target="_blank" rel="noopener noreferrer">&#x2197; SEC AdvisorInfo Summary</a>` : ""}
      </div>

      ${bi.individualId ? row("CRD", `<code>${bi.individualId}</code>`) : ""}
      ${aliases.length ? row("Also known as", esc(aliases.join("; "))) : ""}
      ${d.yearsExperience != null ? row("Years of Experience", esc(String(d.yearsExperience))) : d.daysInIndustry != null ? row("Days in Industry", d.daysInIndustry.toLocaleString()) : ""}
      ${typeof d.firmCount === "number" ? row("Firms (all time)", esc(String(d.firmCount))) : ""}
      ${licenseCount ? row("State Licenses", esc(String(licenseCount))) : ""}
      ${row("Disclosures", esc(String(disclosureCount)))}
      ${d.primaryOffice?.address ? row("Primary Office", esc(d.primaryOffice.address)) : ""}
      ${
        d.registrationCount
          ? `
        ${d.registrationCount.approvedFinraRegistrationCount != null ? row("FINRA Registrations", esc(String(d.registrationCount.approvedFinraRegistrationCount))) : ""}
        ${d.registrationCount.approvedSRORegistrationCount != null ? row("SRO Registrations", esc(String(d.registrationCount.approvedSRORegistrationCount))) : ""}
        ${d.registrationCount.approvedStateRegistrationCount != null ? row("State (BD) Lic.", esc(String(d.registrationCount.approvedStateRegistrationCount))) : ""}
        ${d.registrationCount.approvedIAStateRegistrationCount != null ? row("State (IA) Lic.", esc(String(d.registrationCount.approvedIAStateRegistrationCount))) : ""}
      `
          : ""
      }

      ${
        currentRegistrations.length
          ? `<div class="fg-section-title">Current Registrations</div>
            <div class="fg-timeline">
              ${currentRegistrations
                .map(
                  (reg) => `
                <div class="fg-tl-entry active-pos">
                  <span class="fg-tl-firm"><span class="fg-badge active">${esc(reg.role)}</span> ${esc(reg.firmName)}${reg.firmId ? ` (CRD#${esc(String(reg.firmId))})` : ""}</span>
                  ${reg.officeAddress ? `<span class="fg-tl-loc">${esc(reg.officeAddress)}</span>` : reg.cityState ? `<span class="fg-tl-loc">${esc(reg.cityState)}</span>` : ""}
                  ${reg.start ? `<span class="fg-tl-dates">Registered since ${esc(reg.start)}</span>` : ""}
                </div>`,
                )
                .join("")}
            </div>`
          : ""
      }

      ${
        previousRegistrations.length
          ? `<div class="fg-section-title">Previous Registrations</div>
            <div class="fg-timeline">
              ${previousRegistrations
                .map(
                  (reg) => `
                <div class="fg-tl-entry">
                  <span class="fg-tl-firm"><span class="fg-badge inactive">${esc(reg.role)}</span> ${esc(reg.firmName)}${reg.firmId ? ` (CRD#${esc(String(reg.firmId))})` : ""}</span>
                  ${reg.cityState ? `<span class="fg-tl-loc">${esc(reg.cityState)}</span>` : ""}
                  <span class="fg-tl-dates">${esc(reg.start || "–")} → ${esc(reg.end || "present")}</span>
                </div>`,
                )
                .join("")}
            </div>`
          : ""
      }

      ${
        d.registeredSROs?.length
          ? `<details class="fg-section-toggle">
              <summary class="fg-section-title">Registered SROs (${d.registeredSROs.length})</summary>
              ${d.registeredSROs
                .map((sro) => {
                  const name = esc(sro.sro || sro.name || "");
                  const status = sro.status
                    ? ` <span class="fg-badge ${/approved/i.test(sro.status) ? "active" : "inactive"}">${esc(sro.status)}</span>`
                    : "";
                  const cats =
                    Array.isArray(sro.CategoriesList) && sro.CategoriesList.length
                      ? `<div class="fg-dis-text" style="margin-top:4px">${esc(sro.CategoriesList.join(", "))}</div>`
                      : "";
                  return `<div class="fg-detail-row"><span class="fg-label">${name}${status}</span>${cats}</div>`;
                })
                .join("")}
            </details>`
          : ""
      }

      ${
        regStates.length
          ? `<div class="fg-section-title">Registered States</div>
            <div class="fg-states-grid">
              ${regStates
                .map((s) => {
                  const stateStr =
                    typeof s === "object" ? s.state || "" : String(s);
                  const scope = typeof s === "object" ? s.regScope || "" : "";
                  const status = typeof s === "object" ? s.status || "" : "";
                  const regDate = typeof s === "object" ? s.regDate || "" : "";
                  const cls = /approved/i.test(status) ? "active" : "inactive";
                  return `<span class="fg-state-pill ${cls}" title="${esc([scope, status, regDate ? `since ${regDate}` : ""].filter(Boolean).join(" | "))}">${esc(stateStr)}${scope ? ` <small>${esc(scope)}</small>` : ""}</span>`;
                })
                .join("")}
            </div>`
          : ""
      }

      ${
        controlLinks.length
          ? `<div class="fg-section-title">Control Positions</div>
            ${controlLinks
              .map((l) => {
                const firmNode = graphData.nodes.find(
                  (n) => n.id === (l.target?.id || l.target),
                );
                return `<div class="fg-tl-entry active-pos">
                <span class="fg-tl-firm">${esc(firmNode?.label || l.firmName || "")}</span>
                ${l.position ? `<span class="fg-tl-loc">${esc(l.position)}</span>` : ""}
              </div>`;
              })
              .join("")}`
          : ""
      }

      ${
        empEntries.length
          ? `<div class="fg-section-title">Employment History (${empEntries.length})</div>
            <div class="fg-timeline">
              ${empEntries
                .map((e) => {
                  const cls = `fg-tl-entry${e.isCurrent ? " active-pos" : ""}`;
                  const scopeTags = [
                    e.iaOnly ? "IA only" : null,
                    e.firmBCScope && e.firmBCScope !== "ACTIVE"
                      ? `Firm BC: ${e.firmBCScope}`
                      : null,
                  ].filter(Boolean);
                  return `<div class="${cls}">
                  <span class="fg-tl-firm">${esc(e.firmName)}${e.bdSecNumber ? ` <small>SEC#${esc(e.bdSecNumber)}</small>` : ""}</span>
                  <span class="fg-tl-dates">${esc(e.start || "–")} → ${esc(e.end || "present")}</span>
                  ${e.loc ? `<span class="fg-tl-loc">${esc(e.loc)}</span>` : ""}
                  ${scopeTags.length ? `<span class="fg-tl-loc" style="color:var(--text-m)">${esc(scopeTags.join(" · "))}</span>` : ""}
                  ${e.expelledDate ? `<span class="fg-badge inactive">Expelled ${esc(e.expelledDate)}</span>` : ""}
                </div>`;
                })
                .join("")}
            </div>`
          : ""
      }

      ${
        allExams.length
          ? `<div class="fg-section-title">Qualifications &amp; Exams (${allExams.length})</div>
            <div class="fg-timeline">
              ${allExams
                .map(
                  (ex) => `
                <div class="fg-tl-entry">
                  <span class="fg-tl-firm">${esc(ex.examCategory || "")} – ${esc(ex.examName || "")}</span>
                  ${ex.examTakenDate ? `<span class="fg-tl-dates">Passed: ${esc(ex.examTakenDate)}</span>` : ""}
                  ${ex.examScope ? `<span class="fg-tl-loc">${esc(ex.examScope)}</span>` : ""}
                </div>`,
                )
                .join("")}
            </div>`
          : ""
      }

      ${
        allDisclosures.length
          ? `<details class="fg-section-toggle">
              <summary class="fg-section-title">Disclosures (${allDisclosures.length})</summary>
              ${allDisclosures.map(renderDisclosure).join("")}
            </details>`
          : d.disclosureFlag === "Y" || d.iaDisclosureFlag === "Y"
            ? `<div class="fg-section-title">Disclosures</div><p class="fg-sb-note">Disclosure flag is set. Click to load full details from BrokerCheck.</p>`
            : ""
      }
    </div>
  `;
}

// ── Firm detail ──────────────────────────────────────────────────────────────
function renderFirmDetail(d) {
  const owners = d.directOwners || [];
  const disclosures = d.disclosures || [];

  const crdSec = [
    d.firmId ? `CRD#: ${d.firmId}` : null,
    d.bdSecNumber ? `SEC#: 8-${d.bdSecNumber}` : null,
  ]
    .filter(Boolean)
    .join(" / ");

  const statusDate = d.firmStatusDate || "";
  const statusText = d.firmStatus
    ? capitalize(String(d.firmStatus || "").toLowerCase())
    : "";
  const statusIsActive = d.firmStatus
    ? /\bactive\b|\bapproved\b/i.test(String(d.firmStatus))
    : false;
  const statusIsTerminated = d.firmStatus
    ? /terminated|inactive|revoked|suspended/i.test(String(d.firmStatus))
    : false;
  const statusClass = statusIsActive
    ? "active"
    : statusIsTerminated
      ? "terminated"
      : "inactive";
  const statusBadge = d.firmStatus
    ? `<span class="fg-badge ${statusClass}">${esc(statusText)}${statusDate ? ` ${statusDate}` : ""}</span>`
    : "";
  const legacyBadge =
    d.isLegacy === "Y"
      ? `<span class="fg-badge inactive">PR Previously Registered Brokerage Firm</span>`
      : "";
  const scopeBadge = d.bcScope
    ? `<span class="fg-badge ${/\b(active|approved)\b/i.test(String(d.bcScope)) ? "active" : "inactive"}>${esc(capitalize(String(d.bcScope || "").toLowerCase()))}</span>`
    : "";

  const sros =
    Array.isArray(d.selfRegulatoryOrgs) && d.selfRegulatoryOrgs.length
      ? d.selfRegulatoryOrgs.join(", ")
      : "N/A";
  const states =
    Array.isArray(d.activeStates) && d.activeStates.length
      ? d.activeStates.join(", ")
      : "N/A";

  const firmId = d.firmId || String(d.id).replace(/^firm[:_]/, "");
  const bcRawUrl = firmId
    ? `https://api.brokercheck.finra.org/search/firm/${encodeURIComponent(firmId)}?hl=true&nrows=12&query=&start=0&wt=json`
    : null;
  const secRawUrl = firmId
    ? `https://api.adviserinfo.sec.gov/search/firm/${encodeURIComponent(firmId)}?hl=true&nrows=12&query=smith&r=25&sort=score+desc&wt=json`
    : null;

  return `
    <div class="fg-sb-header firm">
      <div class="fg-sb-title">${esc(d.label)}</div>
      ${crdSec ? `<div class="fg-sb-crd">${crdSec}</div>` : ""}
      <div class="fg-sb-badges">
        ${legacyBadge}
        ${(() => {
          if (d.firmSize && d.firmStatus) {
            const combined = `${esc(firmSizeLabel(d.firmSize))} - ${esc(statusText)}`;
            return `<span class="fg-badge ${statusClass}">${combined}</span>`;
          }
          return `${statusBadge}${d.firmSize ? `<span class="fg-badge">${esc(firmSizeLabel(d.firmSize))}</span>` : ""}`;
        })()}
        ${scopeBadge}
      </div>
    </div>
    <div class="fg-sb-body">
      <div class="fg-ext-links">
        ${firmId ? `<a class="fg-ext-link bc" href="https://brokercheck.finra.org/firm/summary/${encodeURIComponent(firmId)}" target="_blank" rel="noopener noreferrer">&#x2197; BrokerCheck Summary</a>` : ""}
        ${firmId ? `<a class="fg-ext-link sec" href="https://adviserinfo.sec.gov/firm/summary/${encodeURIComponent(firmId)}" target="_blank" rel="noopener noreferrer">&#x2197; SEC AdvisorInfo Summary</a>` : ""}
      </div>
      ${d.isLegacy === "Y" ? `<p class="fg-sb-note">Not currently registered as broker. BrokerCheck contains only limited information about this firm.</p>` : ""}
      ${d.iaSecNumber ? `<a class="fg-adv-btn" href="https://reports.adviserinfo.sec.gov/reports/ADV/${encodeURIComponent(d.iaSecNumber)}/PDF/${encodeURIComponent(d.iaSecNumber)}.pdf" target="_blank" rel="noopener noreferrer">View latest Form ADV filed</a>` : ""}
      ${d.officeAddress || d.businessPhone ? `
      <div class="fg-section-title">Contact</div>
      ${d.officeAddress ? row("Address", esc(d.officeAddress)) : ""}
      ${d.businessPhone ? row("Phone", esc(d.businessPhone)) : ""}
      ` : ""}
      <div class="fg-section-title">Registration</div>
      ${row("SEC Registration Status", d.firmStatus ? esc(d.firmStatus) + (statusDate ? ` (${statusDate})` : "") : "–")}
      ${d.districtName ? row("FINRA District", esc(d.districtName)) : ""}
      ${row("Company Type", esc(d.firmType || "N/A"))}
      ${row("Self-Regulatory Orgs", esc(sros))}
      ${row("U.S. States &amp; Territories", states !== "N/A" ? esc(states) : (d.activeStates?.length ? `${d.activeStates.length} states/territories` : "N/A"))}
      ${row("Regulator", esc(d.regulator || "–"))}
      <div class="fg-section-title">General Information</div>
      ${row("Established in", d.formedState ? `${esc(d.formedState)}${d.formedDate ? " since " + d.formedDate : ""}` : "–")}
      ${row("Type", esc(d.firmType || "–"))}
      ${row("Fiscal Year End", esc(d.fiscalYearEnd || "–"))}
      ${d.otherNames?.length ? row("Other names", esc(d.otherNames.join("; "))) : ""}
      ${Array.isArray(d.brochures) && d.brochures.length ? `
        <div class="fg-section-title">Form ADV Brochures</div>
        ${d.brochures.slice(0, 5).map(b => `<div class="fg-detail-row"><span class="fg-label">${esc(b.brochureName || "")}</span><span>${esc(b.dateSubmitted || "")}</span></div>`).join("")}
      ` : ""}

      ${
        disclosures.length
          ? `
        <div class="fg-section-title">Disclosures</div>
        ${disclosures
          .map(
            (dis) => `
          <div class="fg-detail-row">
            <span class="fg-label">${esc(dis.type || dis.disclosureType || "")}</span>
            <span>${dis.count ?? dis.disclosureCount ?? ""}</span>
          </div>
        `,
          )
          .join("")}
        ${d.affiliateDisclosures ? `
          <div class="fg-detail-row">
            <span class="fg-label">Affiliate (registered)</span>
            <span>${d.affiliateDisclosures.registeredAffiliateDisclosureCount ?? 0}</span>
          </div>
          <div class="fg-detail-row">
            <span class="fg-label">Affiliate (non-registered)</span>
            <span>${d.affiliateDisclosures.nonRegisteredAffiliateDisclosureCount ?? 0}</span>
          </div>
        ` : ""}
      `
          : ""
      }

      ${
        owners.length
          ? `
        <div class="fg-section-title">Form BD — Direct Owners &amp; Executive Officers</div>
        ${owners
          .map(
            (o) => `
          <div class="fg-owner-row">
            <span class="fg-owner-name">${esc(o.legalName || "")}</span>
            <span class="fg-owner-pos">${esc(o.position || "")}</span>
            ${o.crdNumber ? `<a class="fg-owner-crd" href="https://brokercheck.finra.org/individual/summary/${encodeURIComponent(o.crdNumber)}" target="_blank" rel="noopener noreferrer">CRD ${o.crdNumber}</a>` : ""}
          </div>
        `,
          )
          .join("")}
      `
          : ""
      }
    </div>
  `;
}

// ── Entity detail ────────────────────────────────────────────────────────────
function renderEntityDetail(d) {
  return `
    <div class="fg-sb-header entity">
      <div class="fg-sb-title">${esc(d.label)}</div>
      <div class="fg-sb-badges">
        <span class="fg-badge">Entity</span>
        ${d.bcScope ? `<span class="fg-badge">${esc(d.bcScope)}</span>` : ""}
      </div>
    </div>
    <div class="fg-sb-body">
      <p style="font-size:13px;color:var(--text-m);margin-top:8px">
        Non-individual owner listed on Form BD (no CRD number).
      </p>
    </div>
  `;
}

// ── Legend ────────────────────────────────────────────────────────────────────
function renderLegend() {
  const items = [
    {
      color: "var(--c-individual)",
      shape: "circle",
      label: "Individual (seed)",
    },
    {
      color: "var(--c-individual)",
      shape: "circle-s",
      label: "Stub (Form BD only)",
      opacity: 0.45,
    },
    { color: "var(--c-firm)", shape: "rect", label: "Firm" },
    {
      color: "var(--c-entity)",
      shape: "diamond",
      label: "Entity (non-CRD owner)",
    },
    { color: "#5e6268", shape: "line", label: "Employed by (Previous)" },
    { color: "#ff0c0c", shape: "line", label: "Employed by (Current) / Controls" },
    { color: "#f97316", shape: "ring", label: "Has disclosures" },
  ];

  const legend = document.getElementById("fg-legend");
  legend.innerHTML = items
    .map(({ color, shape, label, opacity = 1 }) => {
      let svg;
      if (shape === "circle" || shape === "circle-s") {
        svg = `<svg width="16" height="16"><circle cx="8" cy="8" r="7" fill="${color}" opacity="${opacity}" stroke="#fff" stroke-width="1.5"/></svg>`;
      } else if (shape === "rect") {
        svg = `<svg width="16" height="16"><rect x="2" y="2" width="12" height="12" rx="2" fill="${color}" stroke="#fff" stroke-width="1.5" opacity="0.9"/></svg>`;
      } else if (shape === "diamond") {
        svg = `<svg width="16" height="16"><polygon points="8,1 15,8 8,15 1,8" fill="${color}" stroke="#fff" stroke-width="1.5" opacity="0.8"/></svg>`;
      } else if (shape === "ring") {
        svg = `<svg width="16" height="16"><circle cx="8" cy="8" r="6" fill="none" stroke="${color}" stroke-width="2" stroke-dasharray="3 2"/></svg>`;
      } else {
        svg = `<svg width="16" height="4"><line x1="0" y1="2" x2="16" y2="2" stroke="${color}" stroke-width="1.5"/></svg>`;
      }
      return `<div class="fg-legend-item">${svg}<span>${label}</span></div>`;
    })
    .join("");
}

// ── Resize ────────────────────────────────────────────────────────────────────
function onResize() {
  if (!graphData) return;
  // Just update the viewBox — no re-simulation, positions stay frozen
  const main = document.getElementById("fg-main");
  const W = main.clientWidth;
  const H = main.clientHeight;
  d3.select("#fg-svg").attr("viewBox", `0 0 ${W} ${H}`);
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function esc(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function capitalize(str) {
  const s = String(str || "").trim();
  return s ? s[0].toUpperCase() + s.slice(1) : "";
}

function truncate(str, n) {
  return str && str.length > n ? str.slice(0, n - 1) + "…" : str;
}

// Return a human-friendly firm size label. Accepts numeric or textual values.
function firmSizeLabel(size) {
  if (size == null) return "";
  const s = String(size).trim();
  if (/^\d+$/.test(s)) {
    const n = parseInt(s, 10);
    if (n <= 150) return `Small (${n.toLocaleString()})`;
    if (n <= 499) return `Mid (${n.toLocaleString()})`;
    return `Large (${n.toLocaleString()})`;
  }
  switch (s.toLowerCase()) {
    case "small":
      return "Small (1-150)";
    case "mid":
    case "medium":
      return "Mid (151-499)";
    case "large":
      return "Large (500+)";
    default:
      return capitalize(s);
  }
}

function openSidebarToggles() {
  const sidebar = document.getElementById("fg-sidebar-inner");
  if (!sidebar) return;
  const toggles = sidebar.querySelectorAll("details.fg-section-toggle");
  toggles.forEach((toggle) => {
    toggle.open = true;
  });
}

function row(label, value) {
  return `<div class="fg-detail-row">
    <span class="fg-label">${label}</span>
    <span>${value}</span>
  </div>`;
}
