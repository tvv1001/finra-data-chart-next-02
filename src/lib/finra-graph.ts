/**
 * finra.ts  –  FINRA BrokerCheck Network Graph
 */

import {
	flattenEmploymentRecords as flattenEmploymentRecordsImpl,
	buildSyntheticFirmNodeId as buildSyntheticFirmNodeIdImpl,
	getEmploymentRelationship as getEmploymentRelationshipImpl,
	hasRichIndividualDetail as hasRichIndividualDetailImpl,
	findExistingFirmNode as findExistingFirmNodeImpl,
	findExistingPersonNode as findExistingPersonNodeImpl,
	findFirmNodeByLabel as findFirmNodeByLabelImpl,
	applyIndividualDetail as applyIndividualDetailImpl,
	normalizeComparableName as normalizeComparableNameImpl,
	normalizeFirmLabelKey as normalizeFirmLabelKeyImpl,
	normalizeIndividualDetailPayload as normalizeIndividualDetailPayloadImpl,
} from './finra-graph/detailUtils';
import {
	capitalize as capitalizeImpl,
	esc as escImpl,
	firmSizeLabel as firmSizeLabelImpl,
	formatLocationText as formatLocationTextImpl,
	formatUiText as formatUiTextImpl,
	formatNodeLabel as formatNodeLabelImpl,
	normalizePersonLabel as normalizePersonLabelImpl,
	openSidebarToggles as openSidebarTogglesImpl,
	row as rowImpl,
	truncate as truncateImpl,
} from './finra-graph/formatters';
import { DEFAULT_EXPANSION_HOPS, DEFAULT_SELECTION_HOPS } from './finra-graph-defaults';

// API base. When VITE_API_URL is not set, use relative paths so the dev
// server proxy (`/api`) is used and we don't hardcode a backend port.
const BASE = (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_API_URL) || '';

const GRAPH_COLORS = {
	nodeIndividual: 'var(--color-highlight-individual)',
	nodeFirm: 'var(--color-highlight-firm)',
	nodeEntity: 'var(--color-highlight-entity)',
	nodeStub: 'var(--color-node-stub)',
	nodeInactive: 'var(--color-node-inactive)',
	nodeInactiveStroke: 'var(--color-node-inactive-stroke)',
	nodeInactiveLabel: 'var(--color-node-inactive-label)',
	nodeDefault: 'var(--color-default-text)',
	nodeBorder: 'var(--color-node-border)',
	nodeLabel: '#1e293b',
	nodeLabelHalo: 'rgba(246,248,252,0.92)',
	nodePulse: 'var(--color-node-pulse)',
	lineEmployedBy: 'var(--color-highlight-employed)',
	lineControls: 'var(--color-highlight-controls)',
	lineControlsHighlight: '#ff2222',
	lineDisclosure: '#f97316',
	lineInactive: 'var(--color-default-line)',
	lineNeutral: 'var(--color-default-line)',
	linePreviousEmployment: 'var(--color-default-line)',
	nodeFirmEmployedStroke: 'var(--color-node-firm-employed-stroke)',
	nodeFirmControlsStroke: 'var(--color-node-firm-controls-stroke)',
};

const NODE_STROKE_WIDTH_DEFAULT = 'var(--stroke-width-node-default)';
const NODE_OPACITY_STUB = 'var(--opacity-node-stub)';

const ENABLE_SERVER_PROFILE_SYNC = typeof process !== 'undefined' && process.env.NEXT_PUBLIC_ENABLE_SERVER_PROFILE_SYNC === '1';

// Safely build an absolute URL for API calls. When `BASE` is empty the
// browser `location.origin` will be used so `new URL` never throws.
function makeApiUrl(path) {
	const p = path.startsWith('/') ? path : `/${path}`;
	const base = BASE || (typeof location !== 'undefined' ? location.origin : '');
	return new URL(p, base);
}

function syncProfileSelection(payload) {
	if (!ENABLE_SERVER_PROFILE_SYNC) return;
	fetch(`${BASE}/api/finra/add-to-profile`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ profile: 'custom', ...payload }),
	}).catch((err) => console.error('Failed to sync profile selection to server:', err));
}

let d3;

// ── State ──────────────────────────────────────────────────────────────────
let graphData = null; // { nodes, links, meta } — full dataset
let simulation = null;
let selectedId = null;
let highlightedSelections = []; // [{ id, hops }] — persistent multi-node highlight roots
let linkSel = null; // current <line> selection
let nodeSel = null; // current <g.fg-node> selection
let arrowSel = null; // current top-line marker selection
let layoutNodes = null; // node objects with x/y positions
let layoutLinks = null; // link objects (source/target resolved to objects)
let spreadAnimId = null; // rAF handle for neighbor spread animation
let isSubsetMode = false; // true when only a random sample is rendered
let neighborMap = null; // Map<nodeId, Set<nodeId>> — rebuilt each renderGraph
let nodeGroup = null; // <g.fg-nodes> selection — for live node injection
let linkGroup = null; // <g.fg-links> selection — for live link injection
let arrowGroup = null; // <g.fg-arrowheads> selection — for top-layer arrowheads
let rootGroup = null; // <g.fg-root> selection — for zoom/state-driven graph styling
let allowFirstFetchZoom = true; // only auto-zoom on the first user fetch into an empty graph
// D3 references needed for restoring zoom state
let svgSel = null; // d3 selection for #fg-svg
let zoomBehavior = null; // d3.zoom() instance
let zoomSaveTimer = null; // debounce timer for zoom-state persistence
let refreshLayoutStopTimer = null; // timer used to stop refresh-layout sooner
let selectionRestoreTimer = null; // timer used when restoring a saved selection after reload
let traceRefreshTimer: ReturnType<typeof setTimeout> | null = null; // trailing trace refresh when async reveals land after selection
let nodePulseTimer = null; // timer used to pulse the restored node after focus animation
let nodePulseInterval = null; // interval used to keep the restored node pulsing until interaction
let nodePulseInteractionCleanup: (() => void) | null = null; // removes reload pulse interaction listeners once the user interacts
let activeLabelZoomThreshold = 0.3;
let inactiveLabelCompactZoomThreshold = 0.42;
let inactiveLabelCompactMode = false;
let sessionPersistenceMode: 'full' | 'compact' | 'reduced' | 'minimal' = 'full';

function isAnyTraceModeActive() {
	return isTraceMode || isTraceLogMode;
}

function getCurrentGraphZoomScale() {
	try {
		if (!svgSel?.node || !d3?.zoomTransform) return 1;
		return d3.zoomTransform(svgSel.node()).k || 1;
	} catch {
		return 1;
	}
}

function getSelectionLinkEmphasis(zoomScale = getCurrentGraphZoomScale()) {
	const normalizedScale = Math.max(0.18, Math.min(1, Number(zoomScale) || 1));
	const zoomWeight = Math.max(0, Math.min(1, (normalizedScale - 0.18) / 0.82));

	return {
		strokeWidthScale: 0.7 + zoomWeight * 0.3,
		strokeOpacity: 0.66 + zoomWeight * 0.22,
		showActiveFilter: normalizedScale >= 0.55,
	};
}

function syncTraceLabelPresentation(zoomScale = getCurrentGraphZoomScale()) {
	if (!rootGroup) return;
	const traceActive = isAnyTraceModeActive();
	const normalizedScale = Math.max(0.1, Number(zoomScale) || 1);
	const traceLabelScale = traceActive ? Math.max(1.45, Math.min(2.35, 1 / Math.max(0.45, Math.min(1, normalizedScale)))) : 1;

	rootGroup
		.classed('fg-trace-labels', traceActive)
		.classed('fg-labels-hidden', normalizedScale < activeLabelZoomThreshold)
		.style('--fg-trace-label-scale', String(traceLabelScale));

	updateInactiveLabelZoomState(rootGroup, normalizedScale);
}

function applyStatusPresentation(text, options: { transient?: boolean; dismissible?: boolean; pinned?: boolean } = {}) {
	const { transient = false, dismissible = false, pinned = false } = options;
	const info = document.getElementById('fg-subset-info');
	const wrap = info?.closest('.fg-toolbar-status--top') as HTMLElement | null;
	const pinBtn = document.getElementById('fg-subset-info-pin') as HTMLButtonElement | null;
	if (info) {
		info.textContent = text;
		info.dataset.transient = transient ? 'true' : 'false';
		info.dataset.dismissible = dismissible ? 'true' : 'false';
		info.dataset.pinned = pinned ? 'true' : 'false';
		info.dataset.fetchLocked = dismissible ? 'true' : 'false';
	}
	if (wrap) {
		wrap.dataset.dismissible = dismissible ? 'true' : 'false';
		wrap.dataset.pinned = pinned ? 'true' : 'false';
		wrap.dataset.fetchLocked = dismissible ? 'true' : 'false';
	}
	if (pinBtn) {
		pinBtn.classList.toggle('is-active', pinned);
		pinBtn.setAttribute('aria-pressed', pinned ? 'true' : 'false');
		pinBtn.setAttribute('title', 'Dismiss status');
		pinBtn.setAttribute('aria-label', 'Dismiss status');
	}
}

function hasLockedFetchStatus() {
	const info = document.getElementById('fg-subset-info');
	const wrap = info?.closest('.fg-toolbar-status--top') as HTMLElement | null;
	return info?.dataset.fetchLocked === 'true' || wrap?.dataset.fetchLocked === 'true';
}

function clearFetchStatus() {
	activeFetchStatusMessage = null;
	activeFetchStatusPinned = false;
	applyStatusPresentation('', { transient: false, dismissible: false, pinned: false });
	const pinBtn = document.getElementById('fg-subset-info-pin') as HTMLButtonElement | null;
	if (pinBtn) {
		pinBtn.setAttribute('aria-pressed', 'false');
		pinBtn.setAttribute('title', 'Dismiss status');
		pinBtn.setAttribute('aria-label', 'Dismiss status');
		pinBtn.classList.remove('is-active');
	}
}

function setFetchStatusPinned(pinned: boolean) {
	activeFetchStatusPinned = pinned;
	const pinBtn = document.getElementById('fg-subset-info-pin') as HTMLButtonElement | null;
	if (pinBtn) {
		pinBtn.classList.toggle('is-active', pinned);
		pinBtn.setAttribute('aria-pressed', pinned ? 'true' : 'false');
		pinBtn.setAttribute('title', 'Dismiss status');
		pinBtn.setAttribute('aria-label', 'Dismiss status');
	}
	try {
		localStorage.setItem(FETCH_STATUS_PIN_STORAGE_KEY, pinned ? '1' : '0');
	} catch {
		/* ignore storage errors */
	}
	if (!activeFetchStatusMessage) return;
	applyStatusPresentation(activeFetchStatusMessage, {
		transient: true,
		dismissible: true,
		pinned: activeFetchStatusPinned,
	});
}

type SessionPersistenceMode = 'full' | 'compact' | 'reduced' | 'minimal';
// Baseline snapshot from the initial server response for this page load.
// Used to identify which rendered nodes/links are truly "added" extras.
let initialServerNodeIds = null; // Set<id>
let initialServerLinkKeys = null; // Set<"source|target">
// Shared appender used by both UI actions and load-time session restore.
let appendFetched = null;
// The node that most recently triggered an expand/reveal action.
// Used to bias placement of newly injected nodes near their parent.
let lastExpandOriginNode = null;
let nonGrayExpandRunId = 0;
let hasUserInitiatedGraphExpansion = false;
let activeFetchStatusMessage: string | null = null;
const FETCH_STATUS_PIN_STORAGE_KEY = 'finra_fetch_status_pinned';

function getPersistedFetchStatusPinned() {
	try {
		return localStorage.getItem(FETCH_STATUS_PIN_STORAGE_KEY) === '1';
	} catch {
		return false;
	}
}

let activeFetchStatusPinned = getPersistedFetchStatusPinned();

const INITIAL_SEED_COUNT = 12; // random seed nodes on first load (default select)
const FILTER_MATCH_LIMIT = 100; // maximum number of direct matches to show when filtering
const LS_SESSION_KEY = 'finra_session'; // storage key for persisted session nodes
const SESSION_TTL_MS = 365 * 24 * 60 * 60 * 1000; // 1 year
const SESSION_STORAGE_SOFT_LIMIT_BYTES = 4 * 1024 * 1024; // stay comfortably below common browser quotas
const SESSION_FULL_LAYOUT_NODE_LIMIT = 1200; // above this, store only compact positioning data
const NON_GRAY_HOP_ANIMATION_MS = 420;
const NON_GRAY_HOP_DELAY_MS = 520;
const NON_GRAY_DETAIL_BATCH_SIZE = 6;

function getDefaultSelectionHops(): number {
	const normalized = normalizeHighlightHops(DEFAULT_SELECTION_HOPS);
	return normalized === 'all' ? 1 : normalized;
}

function getDefaultExpansionHops(): number {
	const normalized = normalizeHighlightHops(DEFAULT_EXPANSION_HOPS);
	return normalized === 'all' ? 1 : normalized;
}

function markUserInitiatedGraphExpansion() {
	hasUserInitiatedGraphExpansion = true;
}

// ── Session persistence helpers ────────────────────────────────────────────
// We save the IDs of any nodes the user has added beyond what the server
// initially served, plus the full data for nodes that won't be in the server
// graph (e.g. stub nodes added via Fetch).  On reload we reinject them.
function buildPersistedNodePosition(node) {
	return {
		id: node.id,
		x: Number.isFinite(node.x) ? node.x : null,
		y: Number.isFinite(node.y) ? node.y : null,
		fx: Number.isFinite(node.fx) ? node.fx : null,
		fy: Number.isFinite(node.fy) ? node.fy : null,
	};
}

function getPersistedNodePositions({ compact = false } = {}) {
	if (!Array.isArray(layoutNodes) || !layoutNodes.length) return [];
	if (!compact) return layoutNodes.map((node) => buildPersistedNodePosition(node));

	const focusIds = new Set([selectedId, ...highlightedSelections.map((entry) => entry?.id)].map((value) => String(value || '').trim()).filter(Boolean));
	if (!focusIds.size) return [];
	return layoutNodes.filter((node) => focusIds.has(node.id)).map((node) => buildPersistedNodePosition(node));
}

function buildSessionPayload({ compact = false, extraNodeMode = 'full' }: { compact?: boolean; extraNodeMode?: 'full' | 'ids' | 'none' } = {}) {
	const serverIds = initialServerNodeIds || new Set(graphData.nodes.map((n) => n.id));
	const extraNodes = layoutNodes.filter((n) => !serverIds.has(n.id));
	const extraNodeIds = extraNodes.map((node) => node.id).filter(Boolean);
	const renderedServerIds = layoutNodes.filter((n) => serverIds.has(n.id)).map((n) => n.id);
	const baseLinkKeys =
		initialServerLinkKeys ||
		new Set(
			graphData.links.map((l) => {
				const s = l.source?.id ?? l.source;
				const t = l.target?.id ?? l.target;
				return `${s}|${t}`;
			}),
		);
	const shouldCompactLayout = compact || layoutNodes.length > SESSION_FULL_LAYOUT_NODE_LIMIT;
	const includeExtraNodeObjects = extraNodeMode === 'full';
	const includeExtraNodeIds = extraNodeMode === 'ids';
	const includeExtraLinks = extraNodeMode !== 'none';
	const effectiveCleared =
		isSessionCleared &&
		renderedServerIds.length === 0 &&
		extraNodes.length === 0 &&
		(!Array.isArray(layoutLinks) || layoutLinks.length === 0) &&
		!selectedId &&
		highlightedSelections.length === 0;

	return {
		cleared: effectiveCleared,
		renderedServerIds,
		selectedNodeId: selectedId || null,
		sidebarViewMode: sidebarViewMode,
		highlightedNodes: highlightedSelections.map((entry) => ({
			id: entry.id,
			hops: entry.hops === 'all' ? 'all' : Number(entry.hops) || 1,
		})),
		nodePositions: getPersistedNodePositions({ compact: shouldCompactLayout }),
		extraNodes:
			includeExtraNodeObjects ?
				extraNodes.map((n) => {
					const { x, y, vx, vy, fx, fy, index, ...rest } = n;
					return sanitizePersistedNode(rest);
				})
			:	[],
		extraNodeIds: includeExtraNodeIds ? extraNodeIds : [],
		extraLinks:
			includeExtraLinks ?
				layoutLinks
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
					}))
			:	[],
		zoomTransform: (() => {
			try {
				if (svgSel && typeof svgSel.node === 'function') {
					const z = d3.zoomTransform(svgSel.node());
					return { x: z.x, y: z.y, k: z.k };
				}
			} catch {
				// ignore
			}
			return null;
		})(),
	};
}

function sanitizePersistedNode(node) {
	if (!node || typeof node !== 'object') return node;
	const clone = { ...node };
	delete clone.source;
	delete clone.target;
	delete clone.vx;
	delete clone.vy;
	delete clone.index;
	return clone;
}

function persistSessionPayload(payload) {
	const envelope = {
		expiresAt: Date.now() + SESSION_TTL_MS,
		data: payload,
	};
	const serialized = JSON.stringify(envelope);
	if (serialized.length > SESSION_STORAGE_SOFT_LIMIT_BYTES) {
		throw new Error(`Session payload too large (${serialized.length} bytes)`);
	}
	localStorage.setItem(LS_SESSION_KEY, serialized);
}

function getSessionPersistenceAttempts() {
	return [
		{ mode: 'full', options: { compact: false, extraNodeMode: 'full' as const } },
		{ mode: 'compact', options: { compact: true, extraNodeMode: 'full' as const } },
		{ mode: 'reduced', options: { compact: true, extraNodeMode: 'ids' as const } },
		{ mode: 'minimal', options: { compact: true, extraNodeMode: 'none' as const } },
	] satisfies Array<{ mode: SessionPersistenceMode; options: { compact: boolean; extraNodeMode: 'full' | 'ids' | 'none' } }>;
}

function saveSession() {
	if (!layoutNodes || !graphData) return;
	const attempts = getSessionPersistenceAttempts();
	const startIndex = Math.max(
		0,
		attempts.findIndex((entry) => entry.mode === sessionPersistenceMode),
	);
	let lastError = null;

	for (let index = startIndex; index < attempts.length; index += 1) {
		const attempt = attempts[index];
		try {
			const payload = buildSessionPayload(attempt.options);
			isSessionCleared = Boolean(payload.cleared);
			persistSessionPayload(payload);
			if (sessionPersistenceMode !== attempt.mode) {
				console.warn(`Graph session persistence downgraded to ${attempt.mode} mode after oversized payload.`, lastError);
			}
			sessionPersistenceMode = attempt.mode;
			return;
		} catch (error) {
			lastError = error;
		}
	}

	console.warn('Failed to persist graph session.', lastError);
}

function resetTransientDetailState(node) {
	if (!node || typeof node !== 'object') return;
	delete node._detailMissing;
	delete node._ownerEvidenceLoaded;
	delete node._detailLoaded;
	delete node._detailValidated;
}

function clearSession() {
	isSessionCleared = true;
	// Persist a cleared session marker so reload does not restore the baseline graph.
	// We still remove legacy session storage to avoid stale fallbacks.
	const envelope = {
		expiresAt: Date.now() + SESSION_TTL_MS,
		data: { cleared: true },
	};
	try {
		localStorage.setItem(LS_SESSION_KEY, JSON.stringify(envelope));
	} catch {
		// ignore quota/private mode failures
	}
	sessionStorage.removeItem(LS_SESSION_KEY);
}

function emitSelectedNodeRoute(nodeId: string | null, { replace = false }: { replace?: boolean } = {}) {
	if (typeof window === 'undefined') return;
	window.dispatchEvent(
		new CustomEvent(SELECTED_NODE_ROUTE_EVENT, {
			detail: {
				nodeId: nodeId || null,
				replace,
			},
		}),
	);
}

async function fetchNodesByIds(nodeIds: string[] = []) {
	const uniqueIds = Array.from(new Set(nodeIds.map((nodeId) => String(nodeId || '').trim()).filter(Boolean)));
	if (!uniqueIds.length) return [];
	const url = makeApiUrl('/api/finra/nodes-by-ids');
	url.searchParams.set('ids', uniqueIds.join(','));
	const response = await fetch(url.toString());
	if (!response.ok) throw new Error(`nodes-by-ids HTTP ${response.status}`);
	return response.json();
}

async function ensureRouteNodeAvailable(nodeId: string) {
	const normalizedNodeId = String(nodeId || '').trim();
	if (!normalizedNodeId) return null;

	let liveNode = layoutNodes?.find((node) => node.id === normalizedNodeId) || graphData?.nodes?.find((node) => node.id === normalizedNodeId) || null;
	if (liveNode && !layoutNodes?.some((node) => node.id === normalizedNodeId)) {
		injectNodesById([normalizedNodeId]);
		liveNode = layoutNodes?.find((node) => node.id === normalizedNodeId) || graphData?.nodes?.find((node) => node.id === normalizedNodeId) || liveNode;
	}
	if (liveNode) return liveNode;

	try {
		const expansion = await fetchExpansionDataForNodeIds([normalizedNodeId], getDefaultExpansionHops());
		if (expansion.nodes.length || expansion.links.length) {
			mergeIntoGraphData(expansion.nodes, expansion.links);
			appendFetched?.(expansion.nodes, expansion.links);
			liveNode = layoutNodes?.find((node) => node.id === normalizedNodeId) || graphData?.nodes?.find((node) => node.id === normalizedNodeId) || null;
		}
	} catch (error) {
		console.warn('Failed to expand route-selected node:', error);
	}

	if (liveNode) return liveNode;

	try {
		const fetchedNodes = await fetchNodesByIds([normalizedNodeId]);
		if (fetchedNodes.length) {
			mergeIntoGraphData(fetchedNodes, []);
			injectNodesById(fetchedNodes.map((node) => node.id));
			liveNode = layoutNodes?.find((node) => node.id === normalizedNodeId) || graphData?.nodes?.find((node) => node.id === normalizedNodeId) || null;
		}
	} catch (error) {
		console.warn('Failed to fetch route-selected node by id:', error);
	}

	if (liveNode) return liveNode;

	const [nodePrefix, rawNodeId] = normalizedNodeId.split(':');
	if (rawNodeId && /^[0-9]+$/.test(rawNodeId)) {
		try {
			const fetchedBatch =
				nodePrefix === 'person' ? await fetchIndividualBatch(rawNodeId)
				: nodePrefix === 'firm' ? await fetchFirmBatch(rawNodeId)
				: { nodes: [], links: [] };
			if (fetchedBatch.nodes.length || fetchedBatch.links.length) {
				mergeIntoGraphData(fetchedBatch.nodes, fetchedBatch.links);
				appendFetched?.(fetchedBatch.nodes, fetchedBatch.links);
				liveNode = layoutNodes?.find((node) => node.id === normalizedNodeId) || graphData?.nodes?.find((node) => node.id === normalizedNodeId) || null;
			}
		} catch (error) {
			console.warn('Failed to hydrate route-selected node directly from detail APIs:', error);
		}
	}

	return liveNode;
}

async function applyPendingRouteNodeSelection() {
	const targetNodeId = String(pendingRouteNodeId || '').trim();
	if (!targetNodeId) return false;
	if (!graphData || !layoutNodes) return false;

	const liveNode = await ensureRouteNodeAvailable(targetNodeId);
	if (!liveNode) return false;

	pendingRouteNodeId = null;
	selectNode(liveNode, {
		skipAutoExpand: true,
		skipProfileSync: true,
		focus: true,
		focusDuration: 520,
		syncRoute: false,
	});
	return true;
}

function loadSession() {
	try {
		const raw = localStorage.getItem(LS_SESSION_KEY);
		if (raw) {
			const parsed = JSON.parse(raw);
			// New format with TTL envelope
			if (parsed && typeof parsed === 'object' && 'data' in parsed) {
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
let isSessionCleared = false;
let selectedNodesLog: Array<{ id: string; label: string; secondaryId: string; group: string }> = [];
let sidebarSelectedNode = null;
let sidebarViewMode: 'none' | 'info' | 'log' = 'none';
let isTraceMode = false;
let isTraceLogMode = false;
let pendingRouteNodeId: string | null = null;
let routeNodeRequestListenerBound = false;
let traceShortestIds = new Set<string>(); // node and link IDs
let traceLongestIds = new Set<string>(); // node and link IDs
let traceLogIds = new Set<string>(); // node and link IDs
let traceShortestConnectorIds = new Set<string>(); // intermediate nodes only
let traceLongestConnectorIds = new Set<string>(); // intermediate nodes only
let traceLogConnectorIds = new Set<string>(); // intermediate nodes only

const LS_LOG_KEY = 'finra_selection_log';
const ROUTE_NODE_REQUEST_EVENT = 'finra:route-node-request';
const SELECTED_NODE_ROUTE_EVENT = 'finra:selected-node-route';
const TRACE_LOG_GUARD_WARNING_PREFIX = '[finra-graph] Trace with Log guard:';
let lastTraceLogGuardWarning = '';

function isDevelopmentRuntime() {
	if (typeof process !== 'undefined' && process.env.NODE_ENV) {
		return process.env.NODE_ENV !== 'production';
	}
	if (typeof location !== 'undefined') {
		return /(?:localhost|127\.0\.0\.1)$/i.test(location.hostname);
	}
	return false;
}

function warnTraceLogGuard(message: string) {
	if (!isDevelopmentRuntime()) return;
	if (lastTraceLogGuardWarning === message) return;
	lastTraceLogGuardWarning = message;
	console.warn(`${TRACE_LOG_GUARD_WARNING_PREFIX} ${message}`);
}

function getSelectionLogPanel() {
	return document.getElementById('fg-selection-log');
}

function guardTraceLogSurface(reason = 'state-sync') {
	if (!isTraceLogMode) {
		lastTraceLogGuardWarning = '';
		return;
	}

	const panel = getSelectionLogPanel();
	if (!panel) {
		warnTraceLogGuard(`standalone panel missing during ${reason}`);
		return;
	}

	const shouldUseStandalonePanel = !sidebarSelectedNode;
	if (!shouldUseStandalonePanel) return;

	const panelHidden = panel.classList.contains('hidden');
	if (panelHidden || panel.dataset.pinned !== 'true') {
		if (panelHidden) panel.classList.remove('hidden');
		panel.dataset.pinned = 'true';
		warnTraceLogGuard(`restored standalone panel visibility during ${reason}`);
	}
}

function getSelectionLogActionButtons(action: 'trace' | 'copy-all' | 'clear') {
	return Array.from(document.querySelectorAll<HTMLButtonElement>(`[data-fg-selection-log-action="${action}"]`));
}

function syncSelectionLogActionButtonStates() {
	const traceModeButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('#fg-trace-mode, [data-fg-trace-mode-button]'));
	traceModeButtons.forEach((button) => {
		button.classList.toggle('trace-active', isTraceMode);
		button.classList.toggle('active', isTraceMode);
		button.setAttribute('aria-pressed', isTraceMode ? 'true' : 'false');
		button.textContent = isTraceMode ? 'Tracing On' : 'Trace Mode';
	});

	getSelectionLogActionButtons('trace').forEach((button) => {
		button.classList.toggle('trace-log-active', isTraceLogMode);
		button.classList.toggle('active', isTraceLogMode);
		button.setAttribute('aria-pressed', isTraceLogMode ? 'true' : 'false');
		button.textContent = isTraceLogMode ? 'Log Trace On' : 'Trace with Log';
	});
}

function flashSelectionLogActionButton(button: HTMLButtonElement, text: string, duration = 1000) {
	const originalText = button.dataset.originalText || button.textContent || '';
	button.dataset.originalText = originalText;
	button.classList.add('active');
	button.setAttribute('aria-pressed', 'true');
	button.textContent = text;
	setTimeout(() => {
		button.classList.remove('active');
		button.setAttribute('aria-pressed', 'false');
		button.textContent = button.dataset.originalText || originalText;
		delete button.dataset.originalText;
	}, duration);
}

function updateSelectionLogChrome() {
	const panel = getSelectionLogPanel();
	if (panel) {
		const shouldShowStandalonePanel = isTraceLogMode && !sidebarSelectedNode;
		panel.classList.toggle('hidden', !shouldShowStandalonePanel);
		panel.dataset.pinned = shouldShowStandalonePanel ? 'true' : 'false';
	}

	syncSelectionLogActionButtonStates();
	guardTraceLogSurface('updateSelectionLogChrome');
}

function openSelectionLog() {
	if (!sidebarSelectedNode) {
		updateSelectionLogChrome();
		return;
	}
	setSidebarViewMode('log', { expandMobile: true });
}

function closeSelectionLog(options: { force?: boolean } = {}) {
	const { force: _force = false } = options;
	if (!sidebarSelectedNode) {
		updateSelectionLogChrome();
		return false;
	}
	sidebarViewMode = 'none';
	renderSidebar(sidebarSelectedNode);
	updateSelectionLogChrome();
	return true;
}

function setSidebarViewMode(
	mode: 'none' | 'info' | 'log',
	options: {
		expandMobile?: boolean;
	} = {},
) {
	const { expandMobile = false } = options;
	if (!sidebarSelectedNode) return;
	sidebarViewMode = mode;
	renderSidebar(sidebarSelectedNode);
	if (isMobileSidebarViewport()) {
		syncMobileSidebarExpandedState(expandMobile);
	}
	updateSelectionLogChrome();
	try {
		saveSession();
	} catch {
		/* ignore persistence errors */
	}
}

function getTraceModeNodeIds() {
	const visibleNodeIds = new Set((layoutNodes || []).map((node) => String(node?.id || '').trim()).filter(Boolean));
	const ids = highlightedSelections.map((entry) => String(entry?.id || '').trim()).filter((id) => Boolean(id) && visibleNodeIds.has(id));
	if (selectedId) {
		const normalizedSelectedId = String(selectedId).trim();
		if (normalizedSelectedId && visibleNodeIds.has(normalizedSelectedId) && !ids.includes(normalizedSelectedId)) {
			ids.push(normalizedSelectedId);
		}
	}
	const uniqueIds = Array.from(new Set(ids));
	if (uniqueIds.length >= 2) return uniqueIds;

	const recentLogIds = Array.from(
		new Set(
			selectedNodesLog
				.map((entry) => String(entry?.id || '').trim())
				.filter((id) => Boolean(id) && visibleNodeIds.has(id))
				.reverse(),
		),
	).reverse();

	if (uniqueIds.length === 1) {
		const selectedTraceId = uniqueIds[0];
		const previousTraceId = [...recentLogIds].reverse().find((id) => id !== selectedTraceId) || '';
		return previousTraceId ? [previousTraceId, selectedTraceId] : uniqueIds;
	}

	return recentLogIds.slice(-2);
}

function getTraceLogNodeIds() {
	const visibleNodeIds = new Set((layoutNodes || []).map((node) => String(node?.id || '').trim()).filter(Boolean));
	return Array.from(new Set(selectedNodesLog.map((entry) => String(entry?.id || '').trim()).filter((id) => Boolean(id) && visibleNodeIds.has(id))));
}

function calculateTrace() {
	const traceModeNodeIds = isTraceMode ? getTraceModeNodeIds() : [];
	const traceLogNodeIds = isTraceLogMode ? getTraceLogNodeIds() : [];
	const hasTraceTargets = traceModeNodeIds.length >= 2;
	const hasTraceLogTargets = traceLogNodeIds.length >= 2;
	// Strict trace rule: inactive endpoints (rendered as dashed gray links) are excluded
	// from pathfinding and must never be highlighted.
	const blockedTraceLinkIds = new Set<string>((layoutLinks || []).filter((link) => Boolean(getLinkDash(link)) || hasInactiveEndpoint(link)).map((link) => getLinkKey(link)));
	const isTraceEligibleNode = (nodeId: string) => {
		const node = layoutNodes.find((entry) => entry.id === nodeId);
		if (!node) return false;
		return !isNodeInactive(node);
	};

	if (!hasTraceTargets && !hasTraceLogTargets) {
		traceShortestIds.clear();
		traceLongestIds.clear();
		traceLogIds.clear();
		traceShortestConnectorIds.clear();
		traceLongestConnectorIds.clear();
		traceLogConnectorIds.clear();
		reapplySelectionState();
		return;
	}

	traceShortestIds.clear();
	traceLongestIds.clear();
	traceLogIds.clear();
	traceShortestConnectorIds.clear();
	traceLongestConnectorIds.clear();
	traceLogConnectorIds.clear();

	const adj = new Map<string, Array<{ nodeId: string; linkId: string }>>();
	layoutNodes.forEach((n) => adj.set(n.id, []));
	layoutLinks.forEach((l) => {
		const s = l.source?.id ?? l.source;
		const t = l.target?.id ?? l.target;
		const linkId = getLinkKey(l);
		if (adj.has(s) && adj.has(t)) {
			adj.get(s).push({ nodeId: t, linkId });
			adj.get(t).push({ nodeId: s, linkId });
		}
	});

	// path = [nodeId, linkId, nodeId, linkId, ..., nodeId]; even indices = nodes, odd = links
	// intermediate (connector) nodes are even indices excluding 0 and last
	const extractConnectorNodeIds = (path: string[]): string[] => {
		const out: string[] = [];
		for (let i = 2; i < path.length - 1; i += 2) out.push(path[i]);
		return out;
	};

	// 1. Log Path (Chronological sequence through all nodes in the log) - PINK
	if (hasTraceLogTargets) {
		for (let i = 0; i < traceLogNodeIds.length - 1; i++) {
			const start = traceLogNodeIds[i];
			const end = traceLogNodeIds[i + 1];
			const path = findShortestPath(start, end, adj, { blockedLinkIds: blockedTraceLinkIds });
			if (path) {
				path.forEach((id) => traceLogIds.add(id));
				extractConnectorNodeIds(path).forEach((id) => traceLogConnectorIds.add(id));
			}
		}
	}

	// 2. Trace Mode route: keep the default origin->target route purple,
	//    but when a real loop exists, make the full loop green and keep
	//    a separate purple highlight for the longest non-circle stretch.
	if (hasTraceTargets) {
		const originId = traceModeNodeIds[0];
		const targetId = traceModeNodeIds[traceModeNodeIds.length - 1];
		const traceRoute = buildTraceRoute(originId, targetId, adj, { blockedLinkIds: blockedTraceLinkIds });
		const getPathNodeCount = (path: string[] | null) => (Array.isArray(path) ? Math.ceil(path.length / 2) : 0);

		let longestNonCircleRoute: string[] = [];
		let longestNonCircleNodeCount = -1;
		let fallbackLongestRoute: string[] = [];
		let fallbackLongestNodeCount = -1;

		for (let i = 1; i < traceModeNodeIds.length; i++) {
			const candidateRoute = buildTraceRoute(originId, traceModeNodeIds[i], adj, { blockedLinkIds: blockedTraceLinkIds });
			const candidateForwardPath = candidateRoute?.forwardPath || null;
			const candidateNodeCount = getPathNodeCount(candidateForwardPath);
			if (!candidateForwardPath) continue;

			if (candidateNodeCount > fallbackLongestNodeCount) {
				fallbackLongestNodeCount = candidateNodeCount;
				fallbackLongestRoute = candidateForwardPath;
			}

			if (!candidateRoute?.hasDistinctReturn && candidateNodeCount > longestNonCircleNodeCount) {
				longestNonCircleNodeCount = candidateNodeCount;
				longestNonCircleRoute = candidateForwardPath;
			}
		}

		const purpleRoute =
			traceRoute?.hasDistinctReturn ? []
			: longestNonCircleRoute.length ? longestNonCircleRoute
			: fallbackLongestRoute;
		if (purpleRoute.length) {
			purpleRoute.forEach((id) => traceLongestIds.add(id));
			extractConnectorNodeIds(purpleRoute).forEach((id) => traceLongestConnectorIds.add(id));
		}

		if (originId && isTraceEligibleNode(originId)) traceShortestIds.add(originId);
		if (targetId && isTraceEligibleNode(targetId)) traceShortestIds.add(targetId);

		if (traceRoute?.hasDistinctReturn && traceRoute.closedLoop) {
			traceRoute.closedLoop.forEach((id) => traceShortestIds.add(id));
			extractConnectorNodeIds(traceRoute.closedLoop).forEach((id) => traceShortestConnectorIds.add(id));
		}
	}

	reapplySelectionState();
}

function refreshTraceState(options: { deferMs?: number } = {}) {
	const { deferMs = 0 } = options;
	const runRefresh = () => {
		traceRefreshTimer = null;
		if (isAnyTraceModeActive()) {
			calculateTrace();
			syncTraceLabelPresentation();
			return;
		}
		reapplySelectionState();
	};

	if (traceRefreshTimer) {
		clearTimeout(traceRefreshTimer);
		traceRefreshTimer = null;
	}

	if (deferMs > 0) {
		traceRefreshTimer = setTimeout(runRefresh, deferMs);
		return;
	}

	runRefresh();
}

function findShortestPath(
	startId: string,
	endId: string,
	adj: Map<string, Array<{ nodeId: string; linkId: string }>>,
	options: {
		blockedLinkIds?: Set<string>;
	} = {},
) {
	const { blockedLinkIds = new Set<string>() } = options;
	if (startId === endId) return [startId];
	const queue: Array<{ nodeId: string; path: string[] }> = [{ nodeId: startId, path: [startId] }];
	const visited = new Set<string>([startId]);

	while (queue.length > 0) {
		const { nodeId, path } = queue.shift()!;
		const neighbors = adj.get(nodeId) || [];
		for (const { nodeId: nextId, linkId } of neighbors) {
			if (blockedLinkIds.has(linkId)) continue;
			if (nextId === endId) {
				return [...path, linkId, nextId];
			}
			if (!visited.has(nextId)) {
				visited.add(nextId);
				queue.push({ nodeId: nextId, path: [...path, linkId, nextId] });
			}
		}
	}
	return null;
}

function getPathLinkIds(path: string[] | null) {
	const linkIds = new Set<string>();
	if (!Array.isArray(path)) return linkIds;
	for (let i = 1; i < path.length; i += 2) {
		linkIds.add(path[i]);
	}
	return linkIds;
}

function buildTraceRoute(
	startId: string,
	endId: string,
	adj: Map<string, Array<{ nodeId: string; linkId: string }>>,
	options: {
		blockedLinkIds?: Set<string>;
	} = {},
) {
	const { blockedLinkIds = new Set<string>() } = options;
	const forwardPath = findShortestPath(startId, endId, adj, { blockedLinkIds });
	if (!forwardPath) return null;

	const returnBlockedLinkIds = new Set<string>([...blockedLinkIds, ...getPathLinkIds(forwardPath)]);
	const returnPath = findShortestPath(endId, startId, adj, { blockedLinkIds: returnBlockedLinkIds });

	return {
		forwardPath,
		returnPath,
		closedLoop: returnPath ? [...forwardPath, ...returnPath.slice(1)] : null,
		hasDistinctReturn: Boolean(returnPath),
	};
}

function toggleTraceMode() {
	isTraceMode = !isTraceMode;
	syncSelectionLogActionButtonStates();
	if (isTraceMode) {
		calculateTrace();
	} else {
		traceShortestIds.clear();
		traceLongestIds.clear();
		traceShortestConnectorIds.clear();
		traceLongestConnectorIds.clear();
		reapplySelectionState();
	}
	syncTraceLabelPresentation();
	updateSelectionLogChrome();
}

function disableAllTraceModes() {
	isTraceMode = false;
	isTraceLogMode = false;
	traceShortestIds.clear();
	traceLongestIds.clear();
	traceLogIds.clear();
	traceShortestConnectorIds.clear();
	traceLongestConnectorIds.clear();
	traceLogConnectorIds.clear();

	syncSelectionLogActionButtonStates();

	syncTraceLabelPresentation();
	updateSelectionLogChrome();
}

function toggleTraceLogMode() {
	isTraceLogMode = !isTraceLogMode;
	syncSelectionLogActionButtonStates();
	if (isTraceLogMode) {
		calculateTrace();
		openSelectionLog();
	} else {
		traceLogIds.clear();
		traceLogConnectorIds.clear();
		reapplySelectionState();
	}
	syncTraceLabelPresentation();
	updateSelectionLogChrome();
}

function loadSelectionLog() {
	try {
		const raw = localStorage.getItem(LS_LOG_KEY);
		if (raw) {
			selectedNodesLog = JSON.parse(raw);
		}
	} catch (e) {
		console.warn('Failed to load selection log from localStorage', e);
	}
}

function saveSelectionLog() {
	try {
		localStorage.setItem(LS_LOG_KEY, JSON.stringify(selectedNodesLog));
	} catch (e) {
		console.warn('Failed to save selection log to localStorage', e);
	}
}

function getSecondaryId(d) {
	if (d.group === 'individual') {
		const crd = d.crd || d.id.split(':').pop() || '';
		return crd ? `CRD# ${crd}` : '';
	}
	if (d.group === 'firm') {
		const parts = [];
		const crd = d.firmId || d.id.split(':').pop();
		if (crd && /^\d+$/.test(crd)) {
			parts.push(`CRD# ${crd}`);
		}
		const sec = d.bdSecNumber || d.iaSecNumber;
		if (sec) {
			parts.push(`SEC# ${sec}`);
		}
		return parts.length > 0 ? parts.join(' / ') : '';
	}
	return '';
}

function addToSelectionLog(d) {
	const secondaryId = getSecondaryId(d);
	const entry = {
		id: d.id,
		label: d.label,
		secondaryId: secondaryId,
		group: d.group,
	};

	// Avoid duplicates by ID or combined label + secondaryId
	if (selectedNodesLog.some((e) => e.id === entry.id)) return;
	if (selectedNodesLog.some((e) => e.label === entry.label && e.secondaryId === entry.secondaryId)) return;

	selectedNodesLog.push(entry);
	saveSelectionLog();
	updateSelectionLogUI();
}

function updateSelectionLogUI() {
	const containers = Array.from(document.querySelectorAll<HTMLElement>('#fg-selection-log-list, #fg-sidebar-selection-log-list'));
	if (!containers.length) return;

	containers.forEach((container) => {
		container.innerHTML = '';
		if (selectedNodesLog.length === 0) {
			container.innerHTML = '<p class="fg-log-empty">No nodes selected yet.</p>';
			return;
		}

		selectedNodesLog
			.slice()
			.reverse()
			.forEach((entry) => {
				const div = document.createElement('div');
				div.className = `fg-log-entry ${entry.group}`;
				const text = `${entry.label} :: ${entry.secondaryId}`;
				div.innerHTML = `
			<span class="fg-log-text" title="Click to copy">${text}</span>
			<button class="fg-log-copy-btn" title="Copy to clipboard">
				<svg viewBox="0 0 16 16" fill="currentColor" width="12" height="12"><path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z"></path><path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"></path></svg>
			</button>
		`;
				div.querySelector('.fg-log-text')?.addEventListener('click', () => {
					copyToClipboard(text, div);
				});
				div.querySelector('.fg-log-copy-btn')?.addEventListener('click', () => {
					copyToClipboard(text, div);
				});
				container.appendChild(div);
			});
	});
}

function copyToClipboard(text, element) {
	navigator.clipboard.writeText(text).then(() => {
		const originalBackground = element.style.background;
		element.style.background = 'rgba(34, 197, 94, 0.2)';
		setTimeout(() => {
			element.style.background = originalBackground;
		}, 500);
	});
}

function toggleSelectionLog() {
	if (!sidebarSelectedNode) return;
	setSidebarViewMode(sidebarViewMode === 'log' ? 'none' : 'log', { expandMobile: sidebarViewMode !== 'log' });
}

function handleDelegatedButtonClicks(event: MouseEvent) {
	const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button') : null;
	if (!target) return;

	if (target.id === 'fg-subset-info-pin') {
		clearFetchStatus();
		return;
	}

	if (target.matches('#fg-trace-mode, [data-fg-trace-mode-button]')) {
		toggleTraceMode();
		return;
	}

	const action = target.dataset.fgSelectionLogAction as 'trace' | 'copy-all' | 'clear' | undefined;
	if (!action) return;

	if (action === 'trace') {
		toggleTraceLogMode();
		return;
	}

	if (action === 'copy-all') {
		const text = selectedNodesLog
			.map((entry) => `${entry.label} :: ${entry.secondaryId}`)
			.reverse()
			.join('\n');
		navigator.clipboard.writeText(text).then(() => {
			flashSelectionLogActionButton(target, 'Copied!');
		});
		return;
	}

	if (action === 'clear') {
		selectedNodesLog = [];
		saveSelectionLog();
		updateSelectionLogUI();
		refreshTraceState();
		flashSelectionLogActionButton(target, 'Cleared!');
	}
}

function isProfileEnabled(profile) {
	// `enabled` in data/seed-profiles.json is used as a profile behavior flag,
	// not as a signal to blank the whole graph. Preserve a future explicit
	// `disabled: true` escape hatch if the repo ever needs one.
	return profile == null || profile.disabled !== true;
}

function getRefreshLayoutDurationMs(nodeCount = layoutNodes?.length || 0) {
	if (nodeCount > 1000) return 1100;
	if (nodeCount > 300) return 1300;
	return 1500;
}

function stopNodePulseLoop() {
	if (nodePulseInteractionCleanup) {
		nodePulseInteractionCleanup();
		nodePulseInteractionCleanup = null;
	}
	if (nodePulseInterval) {
		clearInterval(nodePulseInterval);
		nodePulseInterval = null;
	}
	if (nodePulseTimer) {
		clearTimeout(nodePulseTimer);
		nodePulseTimer = null;
	}
}

function armNodePulseStopOnInteraction() {
	if (typeof window === 'undefined') return;
	if (nodePulseInteractionCleanup) {
		nodePulseInteractionCleanup();
		nodePulseInteractionCleanup = null;
	}

	const stopOnInteraction = () => {
		stopNodePulseLoop();
	};
	const listenerOptions = { capture: true, passive: true } as const;
	const events: Array<keyof WindowEventMap> = ['click', 'pointerdown', 'wheel', 'keydown'];
	events.forEach((eventName) => {
		window.addEventListener(eventName, stopOnInteraction, listenerOptions);
	});

	nodePulseInteractionCleanup = () => {
		events.forEach((eventName) => {
			window.removeEventListener(eventName, stopOnInteraction, listenerOptions);
		});
	};
}

function normalizeHighlightHops(hops) {
	if (hops === 'all') return 'all';
	const parsed = Number(hops);
	if (!Number.isFinite(parsed) || parsed < 1) return 1;
	return Math.floor(parsed);
}

function delay(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function upsertHighlightedSelection(id, hops = 1) {
	if (!id) return;
	const normalizedHops = normalizeHighlightHops(hops);
	highlightedSelections = highlightedSelections.filter((entry) => entry.id !== id);
	highlightedSelections.push({ id, hops: normalizedHops });
}

function getLinkKey(link) {
	const sourceId = link.source?.id ?? link.source;
	const targetId = link.target?.id ?? link.target;
	return `${sourceId}|${targetId}|${link.relationship || ''}`;
}

function isNonGrayExpansionLink(link) {
	if (!link) return false;
	if (link.relationship === 'controls') return true;
	if (link.relationship === 'previous_employed_by') return false;
	if (link.relationship === 'employed_by') {
		if (link.isCurrent === false) return false;
		return isCurrentRegistration(link);
	}
	return false;
}

function buildLinkAdjacency(links, linkFilter: ((link: any) => boolean) | null = null) {
	const adjacency = new Map<string, Array<{ nodeId: string; link: any }>>();
	(links || []).forEach((link) => {
		if (typeof linkFilter === 'function' && !linkFilter(link)) return;
		const sourceId = link.source?.id ?? link.source;
		const targetId = link.target?.id ?? link.target;
		if (!sourceId || !targetId) return;
		if (!adjacency.has(sourceId)) adjacency.set(sourceId, []);
		if (!adjacency.has(targetId)) adjacency.set(targetId, []);
		adjacency.get(sourceId).push({ nodeId: targetId, link });
		adjacency.get(targetId).push({ nodeId: sourceId, link });
	});
	return adjacency;
}

function computeHighlightState() {
	const rootIds = new Set();
	const nodeIds = new Set();
	const hopNodeIds = new Set();
	const linkKeys = new Set();

	if (!Array.isArray(highlightedSelections) || !highlightedSelections.length) {
		return { rootIds, nodeIds, hopNodeIds, linkKeys };
	}

	const adjacency = new Map<string, Array<{ nodeId: string; link: any }>>((layoutNodes || []).map((node) => [node.id, []]));
	(layoutLinks || []).forEach((link) => {
		const sourceId = link.source?.id ?? link.source;
		const targetId = link.target?.id ?? link.target;
		if (!adjacency.has(sourceId)) adjacency.set(sourceId, []);
		if (!adjacency.has(targetId)) adjacency.set(targetId, []);
		adjacency.get(sourceId).push({ nodeId: targetId, link });
		adjacency.get(targetId).push({ nodeId: sourceId, link });
	});

	highlightedSelections.forEach((entry) => {
		if (!entry?.id) return;
		rootIds.add(entry.id);
		nodeIds.add(entry.id);

		if (!adjacency.has(entry.id)) return;

		const maxHops = normalizeHighlightHops(entry.hops);
		const dist = new Map<string, number>([[entry.id, 0]]);
		const queue = [entry.id];

		for (let index = 0; index < queue.length; index += 1) {
			const currentId = queue[index];
			const currentDist = dist.get(currentId) ?? 0;
			const neighbors = adjacency.get(currentId) || [];
			neighbors.forEach(({ nodeId, link }) => {
				const nextDist = currentDist + 1;
				if (maxHops !== 'all' && nextDist > maxHops) return;
				linkKeys.add(getLinkKey(link));
				nodeIds.add(nodeId);
				if (!rootIds.has(nodeId)) hopNodeIds.add(nodeId);
				if (!dist.has(nodeId) || nextDist < dist.get(nodeId)) {
					dist.set(nodeId, nextDist);
					queue.push(nodeId);
				}
			});
		}
	});

	return { rootIds, nodeIds, hopNodeIds, linkKeys };
}

function startNodePulseLoop(id, { interval = 1400, immediate = true, startDelayMs = 0 }: { interval?: number; immediate?: boolean; startDelayMs?: number } = {}) {
	if (!id) return;
	stopNodePulseLoop();
	const beginPulseLoop = () => {
		armNodePulseStopOnInteraction();
		if (immediate) {
			pulseNodeHighlightById(id, { duration: 900 });
		}
		nodePulseInterval = setInterval(() => pulseNodeHighlightById(id, { duration: 900 }), interval);
	};
	if (startDelayMs > 0) {
		nodePulseTimer = setTimeout(() => {
			nodePulseTimer = null;
			beginPulseLoop();
		}, startDelayMs);
		return;
	}
	beginPulseLoop();
}

function resolveCssColorValue(value, fallback = '#18a0fb') {
	if (typeof value !== 'string') return fallback;
	const trimmed = value.trim();
	if (!trimmed) return fallback;
	if (typeof window === 'undefined' || !trimmed.includes('var(')) return trimmed;
	const match = /var\((--[^),\s]+)(?:,\s*([^)]+))?\)/.exec(trimmed);
	if (!match) return trimmed;
	const variableName = match[1];
	const fallbackValue = match[2]?.trim() || fallback;
	const resolved = window.getComputedStyle(document.documentElement).getPropertyValue(variableName).trim();
	return resolved || fallbackValue;
}

function pulseNodeHighlightById(id, { duration = 1200, stroke = GRAPH_COLORS.nodePulse }: { duration?: number; stroke?: string } = {}) {
	try {
		if (!nodeSel) return;
		const selectedNode = nodeSel.filter((node) => node.id === id);
		if (!selectedNode || typeof selectedNode.empty !== 'function' || selectedNode.empty()) return;
		const resolvedStroke = resolveCssColorValue(stroke);

		selectedNode.each(function (nodeDatum) {
			const nodeGroupSel = d3.select(this);
			nodeGroupSel.selectAll('circle.fg-restore-ring').remove();
			const baseRadius = Math.max((nodeDatum?._vizHalf || NODE_R[nodeDatum?.group] || 10) + 8, 14);
			nodeGroupSel
				.append('circle')
				.attr('class', 'fg-restore-ring')
				.attr('fill', 'none')
				.attr('stroke', resolvedStroke)
				.attr('stroke-width', 'var(--stroke-width-node-pulse)')
				.attr('stroke-opacity', 'var(--stroke-opacity-node-pulse)')
				.attr('pointer-events', 'none')
				.attr('r', baseRadius * 0.82)
				.transition()
				.duration(duration)
				.ease(d3.easeCubicOut)
				.attr('r', baseRadius * 2.35)
				.attr('stroke-opacity', 0)
				.remove();
		});
	} catch (e) {
		console.warn('pulseNodeHighlightById error', e);
	}
}

function restoreHighlightStateFromSession(session, { delayMs = 0 }: { delayMs?: number } = {}) {
	const restoredHighlights =
		Array.isArray(session?.highlightedNodes) ? session.highlightedNodes
		: session?.selectedNodeId ? [{ id: session.selectedNodeId, hops: 1 }]
		: [];

	if (selectionRestoreTimer) {
		clearTimeout(selectionRestoreTimer);
		selectionRestoreTimer = null;
	}

	const restoreSelection = () => {
		selectionRestoreTimer = null;

		if (!restoredHighlights.length) {
			selectedId =
				typeof session?.selectedNodeId === 'string' && Array.isArray(layoutNodes) && layoutNodes.some((node) => node.id === session.selectedNodeId) ? session.selectedNodeId : null;
			highlightedSelections = [];
			reapplySelectionState();

			const selectedNode = Array.isArray(layoutNodes) ? layoutNodes.find((entry) => entry.id === selectedId) : null;
			if (!selectedNode) return;
			resetTransientDetailState(selectedNode);
			renderSidebar(selectedNode);
			if (session?.sidebarViewMode === 'info' || session?.sidebarViewMode === 'log') {
				setSidebarViewMode(session.sidebarViewMode, { expandMobile: session.sidebarViewMode !== 'none' });
			}
			return;
		}

		highlightedSelections = restoredHighlights
			.map((entry) => ({
				id: entry?.id,
				hops: normalizeHighlightHops(entry?.hops ?? getDefaultSelectionHops()),
			}))
			.filter((entry) => entry.id && Array.isArray(layoutNodes) && layoutNodes.some((node) => node.id === entry.id));

		selectedId = highlightedSelections.find((entry) => entry.id === session?.selectedNodeId)?.id || highlightedSelections[highlightedSelections.length - 1]?.id || null;

		reapplySelectionState();

		const node = Array.isArray(layoutNodes) ? layoutNodes.find((entry) => entry.id === selectedId) : null;
		if (!node) return;
		resetTransientDetailState(node);
		renderSidebar(node);
		if (session?.sidebarViewMode === 'info' || session?.sidebarViewMode === 'log') {
			setSidebarViewMode(session.sidebarViewMode, { expandMobile: session.sidebarViewMode !== 'none' });
		}
		if (node.group === 'individual') {
			ensureIndividualDetail(node)
				.then(() => {
					if (selectedId === node.id) {
						renderSidebar(node);
					}
				})
				.catch((err) => {
					console.error('Failed to restore individual detail after reload:', err);
				});
		} else if (node.group === 'firm') {
			ensureFirmDetail(node)
				.then(() => {
					if (selectedId === node.id) {
						renderSidebar(node);
					}
				})
				.catch((err) => {
					console.error('Failed to restore firm detail after reload:', err);
				});
		}
		const restoreFocusDuration = 700;
		focusNodeById(node.id, { duration: restoreFocusDuration, pulse: false });
		startNodePulseLoop(node.id, {
			startDelayMs: restoreFocusDuration + 60,
		});
	};

	if (delayMs > 0) {
		selectionRestoreTimer = setTimeout(restoreSelection, delayMs);
	} else {
		restoreSelection();
	}
}

async function loadProfile(profileName) {
	let prof = null;
	try {
		const res = await fetch(makeApiUrl(`/api/finra/profile/${encodeURIComponent(profileName)}`).toString(), { cache: 'no-store' });
		if (res.ok) prof = await res.json();
	} catch {
		/* ignore */
	}

	if (!prof || (typeof prof === 'object' && !Array.isArray(prof) && !prof.seeds && !Array.isArray(prof.individuals) && !Array.isArray(prof.firms))) {
		try {
			const seedsRes = await fetch(makeApiUrl('/api/finra/seeds').toString(), {
				cache: 'no-store',
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

function normalizeProfileIds(items) {
	return (Array.isArray(items) ? items : []).map((item) => String(item ?? '').trim()).filter((value) => /^[0-9]+$/.test(value));
}

function getNormalizedProfileSeedQueries(profile) {
	return (Array.isArray(profile?.seeds) ? profile.seeds : []).map((seed) => String(seed ?? '').trim()).filter(Boolean);
}

function profileHasExplicitSeedTargets(profile) {
	if (Array.isArray(profile)) {
		return profile.map((seed) => String(seed ?? '').trim()).filter(Boolean).length > 0;
	}
	if (!profile || typeof profile !== 'object') return false;
	return normalizeProfileIds(profile.individuals).length > 0 || normalizeProfileIds(profile.firms).length > 0 || getNormalizedProfileSeedQueries(profile).length > 0;
}

function flattenEmploymentRecords(detail, { includeGeneric = false }: { includeGeneric?: boolean } = {}) {
	return flattenEmploymentRecordsImpl(detail, { includeGeneric });
}

function normalizeFirmLabelKey(label) {
	return normalizeFirmLabelKeyImpl(label);
}

function buildSyntheticFirmNodeId(label) {
	return buildSyntheticFirmNodeIdImpl(label);
}

function findExistingPersonNode(crd) {
	return findExistingPersonNodeImpl(crd, layoutNodes);
}

function findFirmNodeByLabel(label) {
	return findFirmNodeByLabelImpl(label, layoutNodes);
}

function findExistingFirmNode(firmId, { label = '' }: { label?: string } = {}) {
	return findExistingFirmNodeImpl(firmId, layoutNodes, { label });
}

function applyIndividualDetail(targetNode, detail, fallbackCrd = null) {
	return applyIndividualDetailImpl(targetNode, detail, fallbackCrd);
}

async function restoreSavedSession(session) {
	if (!session || session.cleared) return;
	const renderedIds = new Set(layoutNodes.map((n) => n.id));
	const missingServerIds = (session.renderedServerIds || []).filter((id) => !renderedIds.has(id));
	if (missingServerIds.length) {
		await injectNodesById(missingServerIds);
	}

	if (session.extraNodes?.length || session.extraLinks?.length) {
		const restoredExtraNodes = (session.extraNodes || []).map((node) => sanitizePersistedNode(node));
		restoredExtraNodes.forEach((node) => resetTransientDetailState(node));
		mergeIntoGraphData(restoredExtraNodes, session.extraLinks || []);
		appendFetched(restoredExtraNodes, session.extraLinks || []);
	} else if (session.extraNodeIds?.length) {
		const missingExtraNodeIds = session.extraNodeIds.filter((id) => !layoutNodes.some((node) => node.id === id));
		if (missingExtraNodeIds.length) {
			await injectNodesById(missingExtraNodeIds);
		}
	}

	try {
		applySavedNodePositions(session.nodePositions || []);
	} catch {
		// non-critical
	}

	try {
		const parsed = parseZoomTransformString(session.zoomTransform);
		if (parsed && zoomBehavior && svgSel && typeof svgSel.call === 'function') {
			svgSel.call(zoomBehavior.transform, d3.zoomIdentity.translate(parsed.x, parsed.y).scale(parsed.k));
		}
	} catch {
		// non-critical
	}

	try {
		ensureGraphViewportVisible({ duration: 0 });
	} catch {
		// non-critical
	}

	try {
		refreshNodeLayout();
	} catch {
		// non-critical
	}

	try {
		restoreHighlightStateFromSession(session, {
			delayMs: getRefreshLayoutDurationMs(),
		});
	} catch {
		// non-critical
	}
}

function clearGraphData() {
	graphData = { nodes: [], links: [], meta: {} };
	sessionPersistenceMode = 'full';
	initialServerNodeIds = new Set();
	initialServerLinkKeys = new Set();
	isSubsetMode = false;
	clearFetchStatus();
	allowFirstFetchZoom = true;
	hasUserInitiatedGraphExpansion = false;
	selectedId = null;
	highlightedSelections = [];
	sidebarSelectedNode = null;
	sidebarViewMode = 'none';
	stopNodePulseLoop();
	clearSubsetInfo();
	renderGraph(graphData);
	updateMeta({ totalIndividuals: 0, totalFirms: 0, totalLinks: 0 });
	showSidebarHint();
	showEmpty(true);
}

async function loadBaselineGraph(profileName) {
	isSessionCleared = false;
	const url = makeApiUrl('/api/finra/graph');
	if (!profileName && INITIAL_SEED_COUNT > 0) {
		url.searchParams.set('limit', String(INITIAL_SEED_COUNT));
	}
	if (profileName) {
		url.searchParams.set('profile', profileName);
	}
	const res = await fetch(url.toString(), { cache: 'no-store' });
	if (!res.ok) {
		if (res.status === 404) {
			sidebarSelectedNode = null;
			sidebarViewMode = 'none';
			showSidebarHint();
			showEmpty(true);
			return null;
		}
		throw new Error(`HTTP ${res.status}`);
	}
	graphData = await res.json();
	sessionPersistenceMode = 'full';
	normalizeNodeLabelsInPlace(graphData?.nodes || []);
	const hasGraphContent = Boolean((graphData?.nodes?.length || 0) > 0 || (graphData?.links?.length || 0) > 0);
	initialServerNodeIds = new Set(graphData.nodes.map((n) => n.id));
	initialServerLinkKeys = new Set(
		graphData.links.map((l) => {
			const s = l.source?.id ?? l.source;
			const t = l.target?.id ?? l.target;
			return `${s}|${t}`;
		}),
	);
	updateMeta(graphData.meta);
	const totalNodes = graphData.meta?.totalNodes ?? graphData.nodes.length;
	if (totalNodes > graphData.nodes.length) {
		isSubsetMode = true;
		updateSubsetInfo(graphData.nodes.length, totalNodes);
		const sel = document.getElementById('fg-subset-select') as HTMLSelectElement | null;
		if (sel) sel.value = String(INITIAL_SEED_COUNT);
		renderGraph(graphData);
	} else {
		isSubsetMode = false;
		clearSubsetInfo();
		const sel = document.getElementById('fg-subset-select') as HTMLSelectElement | null;
		if (sel) sel.value = 'all';
		renderGraph(graphData);
	}
	if (!hasGraphContent) {
		sidebarSelectedNode = null;
		sidebarViewMode = 'none';
		showSidebarHint();
	}
	showEmpty(!hasGraphContent);
	return graphData;
}

async function clearPersistedServerGraph() {
	const url = makeApiUrl('/api/finra/graph-reset');
	url.searchParams.set('_ts', String(Date.now()));
	const response = await fetch(url.toString(), {
		method: 'POST',
		cache: 'no-store',
	});
	if (!response.ok) {
		throw new Error(`HTTP ${response.status}`);
	}
}

async function resetSessionView() {
	clearSession();
	clearGraphData();
	emitSelectedNodeRoute(null, { replace: true });
	void fetchCacheStats();

	void clearPersistedServerGraph().catch((error) => {
		console.warn('Failed to clear persisted server graph; local session was cleared instead.', error);
	});
}

// Normalize saved zoom transform from either object form or SVG transform string.
function parseZoomTransformString(t) {
	if (t && typeof t === 'object') {
		const x = Number(t.x);
		const y = Number(t.y);
		const k = Number(t.k);
		if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(k)) {
			return { x, y, k };
		}
	}
	if (!t || typeof t !== 'string') return null;
	// match translate(x,y) scale(k)
	const m = /translate\((-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)\)\s*scale\((-?\d+(?:\.\d+)?)\)/.exec(t);
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
		// Preserve positions, but keep nodes free so the simulation can flow.
		n.fx = null;
		n.fy = null;
	});

	if (linkSel) {
		linkSel
			.attr('x1', (d) => d.source.x)
			.attr('y1', (d) => d.source.y)
			.attr('x2', (d) => d.target.x)
			.attr('y2', (d) => d.target.y);
	}
	if (nodeSel) {
		nodeSel.attr('transform', (d) => `translate(${d.x},${d.y})`);
	}

	simulation.alpha(0).restart();
}

function renderSavedSessionGraph(session) {
	if (!graphData || !Array.isArray(graphData.nodes) || !Array.isArray(graphData.links)) return false;

	const requestedIds = new Set(
		[
			...(Array.isArray(session?.renderedServerIds) ? session.renderedServerIds : []),
			session?.selectedNodeId,
			...(Array.isArray(session?.highlightedNodes) ? session.highlightedNodes.map((entry) => entry?.id) : []),
		]
			.map((value) => String(value || '').trim())
			.filter(Boolean),
	);

	if (!requestedIds.size) return false;

	const sessionNodes = graphData.nodes.filter((node) => requestedIds.has(node.id));
	if (!sessionNodes.length) return false;

	const sessionNodeIds = new Set(sessionNodes.map((node) => node.id));
	const sessionLinks = graphData.links.filter((link) => {
		const sourceId = link.source?.id ?? link.source;
		const targetId = link.target?.id ?? link.target;
		return sessionNodeIds.has(sourceId) && sessionNodeIds.has(targetId);
	});

	isSubsetMode = sessionNodes.length < graphData.nodes.length;
	if (isSubsetMode) {
		updateSubsetInfo(sessionNodes.length, graphData.nodes.length);
	} else {
		clearSubsetInfo();
	}

	renderGraph({
		...graphData,
		nodes: sessionNodes,
		links: sessionLinks,
	});
	showEmpty(false);
	updateMeta(graphData.meta);
	return true;
}

function getViewportSize() {
	const main = document.getElementById('fg-main');
	return {
		width: main?.clientWidth || 800,
		height: main?.clientHeight || 600,
	};
}

function getMobileSidebarChromeOcclusionTop(mainRect: DOMRect, sidebar: HTMLElement) {
	if (typeof window === 'undefined') return 0;
	if (!window.matchMedia('(max-width: 860px)').matches) return 0;
	if (!sidebar || sidebar.classList.contains('hidden')) return 0;
	if (sidebar.dataset.mobileExpanded === 'true') return 0;

	const chromeSections = Array.from(sidebar.querySelectorAll<HTMLElement>('.fg-sidebar-actions, .fg-sidebar-mobile-actions')).filter((section) => {
		const style = window.getComputedStyle(section);
		return style.display !== 'none' && style.visibility !== 'hidden';
	});
	if (!chromeSections.length) return 0;

	let chromeBottom = mainRect.top;
	chromeSections.forEach((section) => {
		const rect = section.getBoundingClientRect();
		if (rect.bottom <= mainRect.top || rect.top >= mainRect.bottom) return;
		chromeBottom = Math.max(chromeBottom, Math.min(mainRect.bottom, rect.bottom));
	});

	const overlap = Math.max(0, chromeBottom - mainRect.top);
	if (!overlap) return 0;

	const safetyPadding = 12;
	return Math.min(overlap + safetyPadding, Math.max(mainRect.height - 1, 0));
}

function getVisibleGraphViewport() {
	const main = document.getElementById('fg-main');
	const { width, height } = getViewportSize();
	const fallback = {
		width,
		height,
		centerX: width / 2,
		centerY: height / 2,
		visibleLeft: 0,
		visibleRight: width,
		visibleTop: 0,
		visibleBottom: height,
		visibleWidth: width,
		visibleHeight: height,
	};
	if (!main) return fallback;

	const sidebar = document.getElementById('fg-sidebar');
	if (!sidebar || sidebar.classList.contains('hidden')) return fallback;

	const mainRect = main.getBoundingClientRect();
	const sidebarRect = sidebar.getBoundingClientRect();
	const horizontalOverlap = Math.max(0, Math.min(mainRect.right, sidebarRect.right) - Math.max(mainRect.left, sidebarRect.left));
	const verticalOverlap = Math.max(0, Math.min(mainRect.bottom, sidebarRect.bottom) - Math.max(mainRect.top, sidebarRect.top));
	if (horizontalOverlap <= 0 || verticalOverlap <= 0) return fallback;

	const occludedLeft = sidebarRect.left <= mainRect.left + 8 ? horizontalOverlap : 0;
	const occludedRight = occludedLeft ? 0 : horizontalOverlap;
	const occludedTop = getMobileSidebarChromeOcclusionTop(mainRect, sidebar);
	const visibleLeft = occludedLeft;
	const visibleRight = Math.max(visibleLeft + 1, width - occludedRight);
	const visibleTop = Math.min(Math.max(0, occludedTop), Math.max(height - 1, 0));
	const visibleBottom = height;
	const visibleWidth = Math.max(visibleRight - visibleLeft, 1);
	const visibleHeight = Math.max(visibleBottom - visibleTop, 1);

	return {
		width,
		height,
		centerX: visibleLeft + visibleWidth / 2,
		centerY: visibleTop + visibleHeight / 2,
		visibleLeft,
		visibleRight,
		visibleTop,
		visibleBottom,
		visibleWidth,
		visibleHeight,
	};
}

function getLayoutBounds(nodes = layoutNodes) {
	if (!Array.isArray(nodes) || !nodes.length) return null;

	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	let hasFinitePoint = false;

	nodes.forEach((node) => {
		if (!Number.isFinite(node?.x) || !Number.isFinite(node?.y)) return;
		hasFinitePoint = true;
		const radius = (node._vizHalf ?? NODE_R[node.group] ?? 10) + 24;
		minX = Math.min(minX, node.x - radius);
		minY = Math.min(minY, node.y - radius);
		maxX = Math.max(maxX, node.x + radius);
		maxY = Math.max(maxY, node.y + radius);
	});

	if (!hasFinitePoint) return null;

	return {
		minX,
		minY,
		maxX,
		maxY,
		width: Math.max(maxX - minX, 1),
		height: Math.max(maxY - minY, 1),
		centerX: (minX + maxX) / 2,
		centerY: (minY + maxY) / 2,
	};
}

function getGraphViewportMetrics() {
	if (!svgSel || typeof svgSel.node !== 'function' || !layoutNodes?.length) {
		return null;
	}

	const bounds = getLayoutBounds(layoutNodes);
	if (!bounds) return null;

	const { width, height } = getViewportSize();
	const transform = d3.zoomTransform(svgSel.node());
	const k = Number.isFinite(transform?.k) && transform.k > 0 ? transform.k : 1;
	const x = Number.isFinite(transform?.x) ? transform.x : 0;
	const y = Number.isFinite(transform?.y) ? transform.y : 0;

	const screenBounds = {
		left: bounds.minX * k + x,
		right: bounds.maxX * k + x,
		top: bounds.minY * k + y,
		bottom: bounds.maxY * k + y,
	};

	let visibleNodeCount = 0;
	layoutNodes.forEach((node) => {
		if (!Number.isFinite(node?.x) || !Number.isFinite(node?.y)) return;
		const radius = (node._vizHalf ?? NODE_R[node.group] ?? 10) * k;
		const sx = node.x * k + x;
		const sy = node.y * k + y;
		if (sx + radius >= 0 && sx - radius <= width && sy + radius >= 0 && sy - radius <= height) {
			visibleNodeCount += 1;
		}
	});

	return {
		bounds,
		width,
		height,
		transform: { x, y, k },
		screenBounds,
		visibleNodeCount,
		centerScreenX: bounds.centerX * k + x,
		centerScreenY: bounds.centerY * k + y,
	};
}

function recenterGraphViewport({ duration = 0, scale = null }: { duration?: number; scale?: number | null } = {}) {
	if (!zoomBehavior || !svgSel || typeof svgSel.call !== 'function') return false;

	const bounds = getLayoutBounds(layoutNodes);
	if (!bounds) return false;

	const { width, height } = getViewportSize();
	const currentTransform = svgSel && typeof svgSel.node === 'function' ? d3.zoomTransform(svgSel.node()) : d3.zoomIdentity;
	const k =
		Number.isFinite(scale) && scale > 0 ? scale
		: Number.isFinite(currentTransform?.k) && currentTransform.k > 0 ? currentTransform.k
		: 1;

	const target = d3.zoomIdentity.translate(width / 2 - bounds.centerX * k, height / 2 - bounds.centerY * k).scale(k);

	if (duration > 0) {
		svgSel.transition().duration(duration).call(zoomBehavior.transform, target);
	} else {
		svgSel.call(zoomBehavior.transform, target);
		try {
			saveSession();
		} catch {
			// non-critical
		}
	}

	return true;
}

function ensureGraphViewportVisible({ duration = 0 }: { duration?: number } = {}) {
	const metrics = getGraphViewportMetrics();
	if (!metrics) return false;

	const padding = Math.max(32, Math.min(metrics.width, metrics.height) * 0.08);
	const graphOutsideViewport =
		metrics.screenBounds.right < padding ||
		metrics.screenBounds.left > metrics.width - padding ||
		metrics.screenBounds.bottom < padding ||
		metrics.screenBounds.top > metrics.height - padding;
	const graphCenterOutOfView =
		metrics.centerScreenX < padding || metrics.centerScreenX > metrics.width - padding || metrics.centerScreenY < padding || metrics.centerScreenY > metrics.height - padding;
	const minimumVisibleNodes = Math.min(3, Math.max(1, Math.ceil(layoutNodes.length * 0.05)));
	const tooFewVisibleNodes = metrics.visibleNodeCount < minimumVisibleNodes;

	if (!graphOutsideViewport && !(graphCenterOutOfView && tooFewVisibleNodes)) {
		return false;
	}

	return recenterGraphViewport({
		duration,
		scale: metrics.transform.k,
	});
}

function refreshNodeLayout() {
	if (!simulation || !Array.isArray(layoutNodes) || !layoutNodes.length) return;

	const main = document.getElementById('fg-main');
	const width = main?.clientWidth || 800;
	const height = main?.clientHeight || 600;
	const centerX = width / 2;
	const centerY = height / 2;
	const nodeCount = layoutNodes.length;
	const isLarge = nodeCount > 300;
	const isHuge = nodeCount > 1000;
	const jitterBase =
		isHuge ? 26
		: isLarge ? 22
		: 18;
	const refreshDurationMs = getRefreshLayoutDurationMs(nodeCount);

	layoutNodes.forEach((node, index) => {
		node.fx = null;
		node.fy = null;

		if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) {
			node.x = centerX + (Math.random() - 0.5) * 140;
			node.y = centerY + (Math.random() - 0.5) * 140;
		} else {
			const angle = (index / Math.max(1, layoutNodes.length)) * Math.PI * 2;
			const jitter = jitterBase + (index % 5) * 2;
			node.x += Math.cos(angle) * jitter + (Math.random() - 0.5) * 16;
			node.y += Math.sin(angle) * jitter + (Math.random() - 0.5) * 16;
		}
	});

	if (refreshLayoutStopTimer) {
		clearTimeout(refreshLayoutStopTimer);
		refreshLayoutStopTimer = null;
	}

	const finalizeRefreshLayout = () => {
		simulation.alphaTarget(0);
		simulation.stop();
		refreshLayoutStopTimer = null;
		try {
			saveSession();
		} catch {
			// non-critical
		}
	};

	simulation.alphaTarget(0);
	simulation
		.alpha(
			isHuge ? 0.72
			: isLarge ? 0.78
			: 0.84,
		)
		.restart();

	simulation.on('end.refresh-layout', finalizeRefreshLayout);
	refreshLayoutStopTimer = setTimeout(finalizeRefreshLayout, refreshDurationMs);
}

function hasAffirmativeDisclosureFlag(value) {
	if (value == null) return false;
	if (typeof value === 'boolean') return value;
	if (typeof value === 'number') return value > 0;
	const normalized = String(value).trim().toLowerCase();
	return normalized === 'y' || normalized === 'yes' || normalized === 'true' || normalized === '1';
}

function hasDisclosures(d) {
	const listCount = (Array.isArray(d?.disclosures) ? d.disclosures.length : 0) + (Array.isArray(d?.iaDisclosures) ? d.iaDisclosures.length : 0);
	const count = Number(d?.disclosureCount || d?.disclosuresCount || d?.iaDisclosureCount || 0);
	const flag = hasAffirmativeDisclosureFlag(d?.disclosureFlag) || hasAffirmativeDisclosureFlag(d?.iaDisclosureFlag);
	return listCount > 0 || count > 0 || flag;
}

function drawDisclosureIndicator(g, d, r) {
	if (!hasDisclosures(d)) return;
	// Thinner, more integrated ring: closer to node, thinner stroke, tighter dash
	if (d.group === 'individual') {
		const rv = d._vizHalf != null ? d._vizHalf : r;
		g.append('circle')
			.attr('class', 'fg-node-disclosure-ring fg-node-disclosure-ring--circle')
			.attr('r', rv + 2.2) // closer to node
			.attr('fill', null)
			.attr('stroke', null)
			.attr('stroke-width', null)
			.attr('stroke-dasharray', null);
		return;
	}
	if (d.group === 'firm') {
		const s = (d._vizHalf ?? r * 0.85) * 2;
		// For hexagons, draw a slightly larger hexagon overlay
		function hexPoints(radius) {
			const points = [];
			for (let i = 0; i < 6; i++) {
				const angle = (Math.PI / 3) * i - Math.PI / 6;
				points.push([(radius * Math.cos(angle)).toFixed(2), (radius * Math.sin(angle)).toFixed(2)].join(','));
			}
			return points.join(' ');
		}
		g.append('polygon')
			.attr('class', 'fg-node-disclosure-ring fg-node-disclosure-ring--firm')
			.attr('points', hexPoints(s / 2 + 2.2)) // just outside node
			.attr('fill', null)
			.attr('stroke', null)
			.attr('stroke-width', null)
			.attr('stroke-dasharray', null);
	}
}

// ── Bootstrap ──────────────────────────────────────────────────────────────
export function init(_d3, options: { initialRouteNodeId?: string | null } = {}) {
	d3 = _d3;
	pendingRouteNodeId = String(options?.initialRouteNodeId || '').trim() || pendingRouteNodeId;

	if (!routeNodeRequestListenerBound && typeof window !== 'undefined') {
		window.addEventListener(ROUTE_NODE_REQUEST_EVENT, ((event: Event) => {
			const detail = (event as CustomEvent<{ nodeId?: string | null }>).detail || {};
			pendingRouteNodeId = String(detail.nodeId || '').trim() || null;
			if (pendingRouteNodeId) {
				void applyPendingRouteNodeSelection();
			}
		}) as EventListener);
		routeNodeRequestListenerBound = true;
	}

	if (isSidebarPersistentlyPinned()) {
		showSidebarHint({ keepOpen: true });
	}
	loadSelectionLog();
	try {
		localStorage.removeItem('finra_selection_log_pinned');
	} catch {
		// ignore storage errors
	}
	updateSelectionLogUI();
	updateSelectionLogChrome();
	(document.getElementById('btn-log-close') as HTMLButtonElement | null)?.addEventListener('click', closeLog);
	document.addEventListener('click', handleDelegatedButtonClicks);
	syncSelectionLogActionButtonStates();

	const refreshLayoutButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-fg-action="refresh-layout"]'));
	refreshLayoutButtons.forEach((button) => bindTouchDragClickSuppression(button));
	refreshLayoutButtons.forEach((refreshLayoutBtn) => {
		refreshLayoutBtn.addEventListener('click', () => {
			const buttons = refreshLayoutButtons;
			buttons.forEach((button) => {
				button.disabled = true;
				button.dataset.originalText = button.textContent || '';
				button.textContent = 'Refreshing…';
			});
			try {
				refreshNodeLayout();
				void fetchCacheStats();
			} catch (err) {
				console.error('refreshNodeLayout failed:', err);
			} finally {
				setTimeout(() => {
					buttons.forEach((button) => {
						button.textContent = button.dataset.originalText || 'Refresh node layout';
						button.disabled = false;
						delete button.dataset.originalText;
					});
				}, 900);
			}
		});
	});

	const clearSessionButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-fg-action="clear-session"]'));
	clearSessionButtons.forEach((button) => bindTouchDragClickSuppression(button));
	clearSessionButtons.forEach((clearSessionBtn) => {
		clearSessionBtn.addEventListener('click', async () => {
			const buttons = clearSessionButtons;
			buttons.forEach((button) => {
				button.disabled = true;
				button.dataset.originalText = button.textContent || '';
				button.textContent = 'Clearing…';
			});
			try {
				await resetSessionView();
				void fetchCacheStats();
				buttons.forEach((button) => {
					button.textContent = 'Cleared!';
				});
			} catch (err) {
				console.error('clearSession failed:', err);
				buttons.forEach((button) => {
					button.textContent = 'Error';
				});
			} finally {
				setTimeout(() => {
					buttons.forEach((button) => {
						button.textContent = button.dataset.originalText || 'Clear session';
						button.disabled = false;
						delete button.dataset.originalText;
					});
				}, 1500);
			}
		});
	});

	const clearHighlightsButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-fg-action="clear-highlights"]'));
	clearHighlightsButtons.forEach((button) => bindTouchDragClickSuppression(button));
	clearHighlightsButtons.forEach((clearHighlightsBtn) => {
		clearHighlightsBtn.addEventListener('click', () => {
			clearHighlights();
		});
	});

	const focusSidebarBtn = document.getElementById('fg-focus-btn') as HTMLButtonElement | null;
	if (focusSidebarBtn) {
		bindTouchDragClickSuppression(focusSidebarBtn);
		focusSidebarBtn.addEventListener('click', () => {
			markUserInitiatedGraphExpansion();
			const sideEl = document.getElementById('fg-sidebar');
			const sid = sideEl?.dataset?.displayedId || selectedId;
			if (!sid) return;
			const focusDuration = 600;
			const nodeObj = (Array.isArray(layoutNodes) && layoutNodes.find((n) => n.id === sid)) || null;
			if (nodeObj && typeof selectNode === 'function') {
				selectNode(nodeObj);
			}
			focusNodeById(sid, { duration: focusDuration, pulse: false });
			startNodePulseLoop(sid, {
				startDelayMs: Math.max(180, Math.min(focusDuration, 320)),
			});
			void fetchCacheStats();
		});
	}

	const subsetSelect = document.getElementById('fg-subset-select') as HTMLSelectElement | null;
	if (subsetSelect) {
		subsetSelect.addEventListener('change', async () => {
			const v = subsetSelect.value;
			const limit = v === 'all' ? 0 : parseInt(v, 10);
			if (isNaN(limit) || limit < 0) return;
			try {
				const url = makeApiUrl('/api/finra/graph');
				if (limit > 0) url.searchParams.set('limit', String(limit));
				const r = await fetch(url.toString(), { cache: 'no-store' });
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
				void fetchCacheStats();
			} catch (err) {
				console.error('subset select fetch failed', err);
			}
		});
	}

	// Inline sanction loader: delegate clicks on disclosure links and fetch full text
	const sidebarInner = document.getElementById('fg-sidebar-inner');
	if (sidebarInner) {
		sidebarInner.addEventListener('click', async (ev) => {
			const target = ev.target as HTMLElement | null;
			const a = (target?.closest ? target.closest('.fg-dis-link') : null) as HTMLElement | null;
			if (!a) return;
			ev.preventDefault();
			const docket = a.getAttribute('data-docket') || a.dataset.docket;
			if (!docket) return;

			// If already loaded, toggle visibility
			const parent = a.closest('.fg-disclosure');
			if (!parent) return;
			let holder = parent.querySelector('.fg-dis-full');
			if (holder) {
				holder.classList.toggle('hidden');
				return;
			}

			// Create placeholder
			holder = document.createElement('div');
			holder.className = 'fg-dis-full';
			holder.textContent = 'Loading full sanction…';
			parent.appendChild(holder);

			try {
				const r = await fetch(`${BASE}/api/finra/fda/${encodeURIComponent(docket)}`);
				if (!r.ok) throw new Error(`HTTP ${r.status}`);
				const j = await r.json();

				// Prefer node body content if available
				let bodyText = null;
				if (j?.node) {
					const n = j.node;
					// JSON:API shape often under data.attributes.field_body or body.value
					const data = n.data || n;
					const attrs = data.attributes || {};
					bodyText = attrs?.body?.value || attrs?.field_body?.value || attrs?.field_fda_body?.value || attrs?.body || null;
					if (!bodyText && typeof data === 'string') bodyText = data;
				}
				// Fallback: include meta.filtered_query_url or the raw meta as string
				if (!bodyText) {
					bodyText = j?.meta?.filtered_query_url || JSON.stringify(j?.meta || j, null, 2);
				}

				// Insert sanitized plain-text preformatted block
				holder.innerHTML = '';
				const pre = document.createElement('pre');
				pre.style.whiteSpace = 'pre-wrap';
				pre.style.fontFamily = 'inherit';
				pre.textContent = bodyText;
				holder.appendChild(pre);
			} catch (err) {
				holder.textContent = `Failed to load sanction: ${err.message}`;
			}
		});
	}
	window.addEventListener('resize', onResize);

	// Remote fetch button – search ALL results, inject every hit, persist to server
	const fetchBtn = document.getElementById('fg-fetch-remote') as HTMLButtonElement | null;
	const fetchInput = document.getElementById('fg-fetch-input') as HTMLInputElement | null;
	if (fetchBtn && fetchInput) {
		const normalizeSecComparable = (value) => {
			const raw = String(value || '')
				.trim()
				.toLowerCase();
			if (!raw) return '';
			if (/^8-\d+$/.test(raw)) return raw;
			if (/^\d+$/.test(raw)) return `8-${raw}`;
			return raw;
		};

		const collectSearchableNodeKeys = (node) => {
			if (!node || typeof node !== 'object') return [];
			const basic = node.basicInformation || {};
			const idSuffix = String(node.id || '')
				.split(':')
				.pop();
			const preferredLabel = getPreferredNodeLabel(node);
			const keys = [
				node.id,
				idSuffix,
				node.crd,
				basic.individualId,
				node.firmId,
				basic.firmId,
				node.bdSecNumber,
				node.iaSecNumber,
				basic.bdSECNumber,
				basic.iaSECNumber,
				preferredLabel,
				node.label,
				node.name,
				basic.name,
				[basic.firstName, basic.middleName, basic.lastName].filter(Boolean).join(' '),
				...(Array.isArray(node.otherNames) ? node.otherNames : []),
				...(Array.isArray(basic.otherNames) ? basic.otherNames : []),
			];
			return keys.map((entry) => String(entry || '').trim()).filter(Boolean);
		};

		const findExistingNodeMatches = (rawQuery, explicitNodePool = null) => {
			const query = String(rawQuery || '').trim();
			if (!query) return [];
			const comparableQuery = normalizeComparableName(query);
			const numericQuery = /^\d+$/.test(query) ? query : '';
			const normalizedSecQuery = normalizeSecComparable(query);
			const nodePool =
				Array.isArray(explicitNodePool) ? explicitNodePool : [...(Array.isArray(layoutNodes) ? layoutNodes : []), ...(Array.isArray(graphData?.nodes) ? graphData.nodes : [])];
			const byId = new Map((nodePool || []).filter(Boolean).map((node) => [node.id, node]));
			const connectionCounts = new Map();
			for (const link of Array.isArray(layoutLinks) ? layoutLinks : []) {
				const sourceId = link?.source?.id ?? link?.source;
				const targetId = link?.target?.id ?? link?.target;
				if (sourceId) connectionCounts.set(sourceId, (connectionCounts.get(sourceId) || 0) + 1);
				if (targetId) connectionCounts.set(targetId, (connectionCounts.get(targetId) || 0) + 1);
			}

			const scored = [];
			for (const node of byId.values()) {
				const keys = collectSearchableNodeKeys(node);
				if (!keys.length) continue;

				let bestScore = -1;
				let hasExactMatch = false;
				if (numericQuery) {
					const nodeId = String(node?.id || '').trim();
					if (nodeId.endsWith(`:${numericQuery}`) || nodeId.endsWith(`_${numericQuery}`) || nodeId === numericQuery) {
						bestScore = Math.max(bestScore, 240);
						hasExactMatch = true;
					}
				}
				for (const rawKey of keys) {
					const key = String(rawKey || '').trim();
					if (!key) continue;
					const keyComparable = normalizeComparableName(key);
					const keySecComparable = normalizeSecComparable(key);

					if (key === query) {
						bestScore = Math.max(bestScore, 220);
						hasExactMatch = true;
					}
					if (numericQuery && key === numericQuery) {
						bestScore = Math.max(bestScore, 220);
						hasExactMatch = true;
					}
					if (normalizedSecQuery && keySecComparable === normalizedSecQuery) {
						bestScore = Math.max(bestScore, 210);
						hasExactMatch = true;
					}
					if (comparableQuery && keyComparable === comparableQuery) {
						bestScore = Math.max(bestScore, 185);
						hasExactMatch = true;
					}
					if (comparableQuery && keyComparable.startsWith(comparableQuery)) bestScore = Math.max(bestScore, 150);
					if (comparableQuery && keyComparable.includes(comparableQuery)) bestScore = Math.max(bestScore, 120);
				}

				if (bestScore > 0) {
					scored.push({
						node,
						score: bestScore,
						hasExactMatch,
						connections: connectionCounts.get(node.id) || 0,
					});
				}
			}

			return scored.sort(
				(a, b) => b.connections - a.connections || b.score - a.score || String(getPreferredNodeLabel(a.node)).localeCompare(String(getPreferredNodeLabel(b.node))),
			);
		};

		const focusExistingNodeMatch = (rawQuery, options: { statusPrefix?: string } = {}) => {
			const { statusPrefix = 'Already loaded' } = options;
			const renderedNodes = (nodeSel && typeof nodeSel.data === 'function' ? nodeSel.data() : []).filter(Boolean);
			const renderedMatches = findExistingNodeMatches(rawQuery, renderedNodes).filter((match) => match.hasExactMatch);
			const matches = renderedMatches.length ? renderedMatches : findExistingNodeMatches(rawQuery).filter((match) => match.hasExactMatch);
			if (!matches.length) return false;
			const bestScore = matches[0]?.score ?? -1;
			const topMatches = matches.filter((match) => match.score === bestScore);
			if (topMatches.length !== 1) return false;
			const bestNodeId = matches[0]?.node?.id;
			if (!bestNodeId) return false;

			if (!layoutNodes.some((node) => node.id === bestNodeId)) {
				injectNodesById([bestNodeId]);
			}

			const liveNode = layoutNodes.find((node) => node.id === bestNodeId) || matches[0].node;
			if (!liveNode) return false;

			selectNode(liveNode, {
				skipAutoExpand: true,
				focus: true,
				pulse: true,
				focusDuration: 520,
			});

			const preferredLabel = getPreferredNodeLabel(liveNode) || liveNode.label || liveNode.id;
			clearFetchStatus();
			updateFetchStatus(matches.length > 1 ? `${statusPrefix}: focused ${preferredLabel} (${matches.length} matches)` : `${statusPrefix}: focused ${preferredLabel}`);
			return true;
		};

		const ensureFetchRuntimeReady = async () => {
			for (let attempt = 0; attempt < 20; attempt += 1) {
				if (graphData && Array.isArray(layoutNodes) && Array.isArray(layoutLinks) && typeof appendFetched === 'function') {
					return true;
				}
				await new Promise<void>((resolve) => {
					window.requestAnimationFrame(() => resolve());
				});
			}
			return Boolean(graphData && Array.isArray(layoutNodes) && Array.isArray(layoutLinks) && typeof appendFetched === 'function');
		};

		const runRemoteFetch = async () => {
			const q = String(fetchInput.value || '').trim();
			if (!q) return;
			if (!(await ensureFetchRuntimeReady())) {
				updateFetchStatus('Graph is still loading. Please try again.');
				return;
			}
			fetchBtn.disabled = true;
			const origText = fetchBtn.textContent;
			fetchBtn.textContent = 'Fetching…';
			try {
				const localResult = await fetchLocalQueryBatch(q);
				const localNodes = Array.isArray(localResult?.nodes) ? localResult.nodes : [];
				const localLinks = Array.isArray(localResult?.links) ? localResult.links : [];
				const localMatchedIds = Array.isArray(localResult?.matchedIds) ? localResult.matchedIds.map((id) => String(id || '').trim()).filter(Boolean) : [];
				const isDirectIdQuery = /^\d+$/.test(q);
				const localHasGraphContext = localLinks.length > 0 || localNodes.length > 1;
				const shouldUseLocalResults = (localNodes.length > 0 || localMatchedIds.length > 0) && (!isDirectIdQuery || localHasGraphContext);

				if (shouldUseLocalResults) {
					scheduleFirstFetchFocusIfAvailable(
						localNodes.map((node) => node.id),
						{
							duration: 700,
							maxScale: 1.05,
						},
					);
					appendFetched(localNodes, localLinks);
					mergeIntoGraphData(localNodes, localLinks);
					void fetchCacheStats();

					if (!focusExistingNodeMatch(q, { statusPrefix: 'Loaded from local API' })) {
						const localMatchCount = localMatchedIds.length || localNodes.length;
						updateFetchStatus(`Loaded ${localMatchCount} local match${localMatchCount !== 1 ? 'es' : ''} for "${q}"`);
					}
					return;
				}

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
						const su = makeApiUrl('/api/finra/search');
						su.searchParams.set('query', q);
						su.searchParams.set('rows', String(PAGE_SIZE));
						su.searchParams.set('start', String(start));
						if (useFirm) su.searchParams.set('firm', '1');
						const sr = await fetch(su.toString());
						if (!sr.ok) break;
						const sj = await sr.json();
						const page = sj?.hits?.hits || sj?.response?.docs || sj?.results || [];
						if (total === null) total = sj?.hits?.total ?? sj?.response?.numFound ?? page.length;
						hits.push(...page);
						start += page.length;
						if (page.length < PAGE_SIZE) break;
					} while (start < total);
					return hits;
				};

				const fetchSec = async () => {
					// SEC adviserinfo: https://api.adviserinfo.sec.gov/search/individual?firm=…
					// Server translates ?query= → ?firm= before forwarding.
					const su = makeApiUrl('/api/finra/sec-search');
					su.searchParams.set('query', q);
					su.searchParams.set('pageSize', '50'); // SEC pagination
					su.searchParams.set('pageNumber', '1');
					const sr = await fetch(su.toString());
					if (!sr.ok) return [];
					const sj = await sr.json();
					// SEC wraps results under hits.hits or currentPage array
					return sj?.hits?.hits || sj?.response?.docs || sj?.currentPage || sj?.results || [];
				};

				const [indHits, firmHits, secHits] = await Promise.all([fetchFinraAll(false), fetchFinraAll(true), fetchSec()]);
				const allHits = [...indHits, ...firmHits, ...secHits];

				const hitHasIndividualId = (hit) => {
					const src = hit?._source || hit || {};
					if (src?.ind_source_id || src?.ind_crd) return true;
					if (typeof src?.content === 'string') {
						try {
							const parsed = JSON.parse(src.content);
							return Boolean(parsed?.basicInformation?.individualId);
						} catch {
							return false;
						}
					}
					return false;
				};

				const hitHasFirmId = (hit) => {
					const src = hit?._source || hit || {};
					if (src?.firm_id || src?.firmId || src?.firm_source_id) return true;
					if (typeof src?.content === 'string') {
						try {
							const parsed = JSON.parse(src.content);
							return Boolean(parsed?.basicInformation?.firmId);
						} catch {
							return false;
						}
					}
					return false;
				};

				// When query is a pure number, always inject synthetic hits so the
				// direct-by-ID lookup path runs when search could not already identify
				// the query as an individual or firm. Avoid synthesizing the opposite
				// kind when a real hit already exists, because that can stall the UI
				// on an unnecessary detail request for the wrong record type.
				if (/^\d+$/.test(q)) {
					const hasIndividualHit = allHits.some((hit) => hitHasIndividualId(hit));
					const hasFirmHit = allHits.some((hit) => hitHasFirmId(hit));
					if (!hasIndividualHit && !hasFirmHit) {
						allHits.push({ _source: { ind_source_id: q } }, { _source: { firm_id: q } });
					}
				}

				if (!allHits.length) {
					if (focusExistingNodeMatch(q)) {
						return;
					}
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
					if (typeof src?.content === 'string') {
						try {
							parsed = JSON.parse(src.content);
						} catch {
							// fallback to src
						}
					}

					const crd = String(parsed?.basicInformation?.individualId || parsed?.ind_source_id || parsed?.ind_crd || '').trim();
					if (!crd) return;
					const existingGraphNode = findExistingPersonNode(crd);
					const personId = existingGraphNode?.id || `person:${crd}`;
					const personLabel = normalizePersonLabel(
						[parsed?.basicInformation?.firstName, parsed?.basicInformation?.middleName, parsed?.basicInformation?.lastName].filter(Boolean).join(' ') ||
							[src?.ind_firstname, src?.ind_middlename, src?.ind_lastname].filter(Boolean).join(' ') ||
							parsed?.name ||
							src?.name ||
							`CRD ${crd}`,
					);

					if (existingGraphNode) {
						applyIndividualDetail(existingGraphNode, parsed, crd);
					} else if (!batchAllNodes.some((n) => n.id === personId)) {
						// Propagate disclosure flags if present
						const disclosureFlag = parsed?.disclosureFlag ?? parsed?.basicInformation?.disclosureFlag ?? parsed?.ind_bc_disclosure_fl;
						const iaDisclosureFlag = parsed?.iaDisclosureFlag ?? parsed?.basicInformation?.iaDisclosureFlag ?? parsed?.ind_bc_disclosure_fl;
						batchAllNodes.push(
							applyIndividualDetail(
								{
									id: personId,
									label: personLabel,
									group: 'individual',
									crd,
									disclosureFlag,
									iaDisclosureFlag,
								},
								parsed,
								crd,
							),
						);
					}
					// Build firm connections from embedded employment data
					const emps = [
						...(parsed?.currentEmployments || []).map((e) => ({ ...e, _isCurrent: true })),
						...(parsed?.currentIAEmployments || []).map((e) => ({ ...e, _isCurrent: true })),
						...(parsed?.previousEmployments || []).map((e) => ({ ...e, _isCurrent: false })),
						...(parsed?.previousIAEmployments || []).map((e) => ({ ...e, _isCurrent: false })),
						...(src?.ind_current_employments || []).map((e) => ({ ...e, _isCurrent: true })),
					];
					for (const e of emps) {
						const fid = String(e?.firmId || e?.firm_id || e?.firmIdNumber || e?.firmId || '').trim();
						if (!fid) continue;
						const existingFirmNode = findExistingFirmNode(fid);
						const firmNodeId = existingFirmNode?.id || `firm:${fid}`;
						if (!existingFirmNode && !batchAllNodes.some((n) => n.id === firmNodeId)) {
							batchAllNodes.push({
								id: firmNodeId,
								label: e?.firm_name || e?.firmName || `Firm ${fid}`,
								group: 'firm',
								firmId: fid,
								bdSecNumber: e?.firm_bd_sec_number || e?.bdSecNumber,
								iaSecNumber: e?.firm_ia_sec_number || e?.iaSecNumber,
							});
						}
						if (!batchAllLinks.some((l) => (l.source?.id ?? l.source) === personId && (l.target?.id ?? l.target) === firmNodeId)) {
							batchAllLinks.push({
								source: personId,
								target: firmNodeId,
								relationship: getEmploymentRelationship(e),
								isCurrent: e._isCurrent,
							});
						}
					}
				}

				function addFirmFromSource(src) {
					const firmId = String(src?.firm_id || src?.firmId || src?.firm_source_id || '').trim();
					if (!firmId) return;
					const firmNodeId = `firm:${firmId}`;
					const firmLabel = src?.firm_name || src?.firmName || src?.name || `Firm ${firmId}`;
					if (!batchAllNodes.some((n) => n.id === firmNodeId)) {
						// Propagate disclosure flags if present
						const disclosureFlag = src?.disclosureFlag ?? src?.firm_disclosure_flag;
						const iaDisclosureFlag = src?.iaDisclosureFlag;
						batchAllNodes.push({
							id: firmNodeId,
							label: firmLabel,
							group: 'firm',
							firmId,
							bdSecNumber: src?.firm_bd_sec_number || src?.bdSecNumber,
							iaSecNumber: src?.firm_ia_sec_number || src?.iaSecNumber,
							disclosureFlag,
							iaDisclosureFlag,
						});
					}
				}

				if (isDirectId) {
					// For direct numeric CRD/firm ID — fetch full detail to get rich sidebar data
					await Promise.allSettled(
						allHits.map(async (hit) => {
							const src = hit._source || hit;
							const crd = String(src?.ind_source_id || src?.ind_crd || '').trim();
							if (crd && /^\d+$/.test(crd)) {
								try {
									const r = await fetch(`${BASE}/api/finra/individual/${encodeURIComponent(crd)}`);
									if (!r.ok) throw new Error(`${r.status}`);
									const detail = unwrapDetailPayload(await r.json());
									if (detail?.found === false) return;
									addIndividualFromSource(detail);
								} catch {
									// Ignore the synthetic direct-id fallback when the lookup fails.
								}
								return;
							}
							const firmId = String(src?.firm_id || src?.firmId || src?.firm_source_id || '').trim();
							if (firmId && /^\d+$/.test(firmId)) {
								try {
									const r = await fetch(`${BASE}/api/finra/firm/${encodeURIComponent(firmId)}`);
									if (!r.ok) throw new Error(`${r.status}`);
									const detail = await r.json();
									if (detail?.found === false) return;
									const firmNodeId = `firm:${firmId}`;
									const bi = detail?.basicInformation || {};
									const firmLabel = bi.firmName || detail?.firmName || detail?.name || `Firm ${firmId}`;
									if (!batchAllNodes.some((n) => n.id === firmNodeId)) {
										batchAllNodes.push({
											id: firmNodeId,
											label: firmLabel,
											group: 'firm',
											firmId,
											bcScope: bi.bcScope ?? detail?.bcScope ?? null,
											firmStatus: bi.firmStatus ?? detail?.firmStatus,
											firmStatusDate: bi.firmStatusDate ?? detail?.firmStatusDate,
											firmType: bi.firmType ?? detail?.firmType,
											formedState: bi.formedState ?? detail?.formedState,
											formedDate: bi.formedDate ?? detail?.formedDate,
											regulator: bi.regulator ?? detail?.regulator,
											bdSecNumber: bi.bdSECNumber ?? bi.bdSecNumber ?? detail?.bdSECNumber ?? detail?.bdSecNumber,
											iaSecNumber: bi.iaSecNumber ?? detail?.iaSecNumber,
											isLegacy: bi.isLegacy ?? detail?.isLegacy,
											fiscalYearEnd: bi.fiscalMonthEndCode ?? detail?.fiscalMonthEndCode,
											otherNames: bi.otherNames ?? detail?.otherNames ?? [],
											selfRegulatoryOrgs: detail?.selfRegulatoryOrgs ?? detail?.SROs ?? [],
											activeStates: detail?.activeStates ?? detail?.registeredStates ?? [],
											directOwners: detail?.directOwners ?? [],
											disclosures: detail?.disclosures ?? [],
										});
									}
									for (const o of detail?.directOwners || []) {
										const pid = String(o?.crdNumber || o?.crd || o?.personId || '').trim();
										if (!pid) continue;
										const personNodeId = `person:${pid}`;
										if (!batchAllNodes.some((n) => n.id === personNodeId)) {
											batchAllNodes.push({
												id: personNodeId,
												label: normalizePersonLabel(o?.legalName || o?.name || `Person ${pid}`),
												group: 'individual',
												crd: pid,
												bcScope: o?.bcScope || null,
												stub: true,
											});
										}
										if (!batchAllLinks.some((l) => (l.source?.id ?? l.source) === personNodeId && (l.target?.id ?? l.target) === firmNodeId)) {
											batchAllLinks.push({
												source: personNodeId,
												target: firmNodeId,
												relationship: 'controls',
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
						const crd = String(src?.ind_source_id || src?.ind_crd || '').trim();
						if (crd) {
							addIndividualFromSource(src);
							continue;
						}
						const firmId = String(src?.firm_id || src?.firmId || src?.firm_source_id || '').trim();
						if (firmId) {
							addFirmFromSource(src);
							continue;
						}
						// stub for hits with no ID
						const label = normalizePersonLabel(src?.name || [src?.ind_firstname, src?.ind_middlename, src?.ind_lastname].filter(Boolean).join(' ') || '');
						if (label)
							batchAllNodes.push({
								id: `remote:${Date.now()}:${Math.random()}`,
								label,
								group: 'individual',
							});
					}
				}

				// ── 3. Append all nodes/links to the live view ─────────────────────
				if (batchAllNodes.length === 0) {
					if (focusExistingNodeMatch(q)) {
						return;
					}
					updateFetchStatus(`No structured data found for "${q}"`);
					return;
				}
				scheduleFirstFetchFocusIfAvailable(
					batchAllNodes.map((n) => n.id),
					{
						duration: 700,
						maxScale: 1.05,
					},
				);
				appendFetched(batchAllNodes, batchAllLinks);

				// ── 4. Update in-memory graphData so filter/subset sees new nodes ──
				mergeIntoGraphData(batchAllNodes, batchAllLinks);

				// ── 6. Persist to server so data survives page reload ──────────────
				persistToServer(batchAllNodes, batchAllLinks);
				void fetchCacheStats();

				const newCount = batchAllNodes.length;
				updateFetchStatus(`Added ${newCount} node${newCount !== 1 ? 's' : ''} for "${q}"`);
			} catch (err) {
				console.error('remote fetch failed', err);
				updateFetchStatus(`Fetch error: ${err?.message || err}`);
			} finally {
				fetchBtn.disabled = false;
				fetchBtn.textContent = origText;
			}
		};

		fetchBtn.addEventListener('click', runRemoteFetch);
		fetchInput.addEventListener('keydown', (ev) => {
			if (ev.key === 'Enter') {
				ev.preventDefault();
				runRemoteFetch();
			}
		});
	}

	const subsetInfoPinBtn = document.getElementById('fg-subset-info-pin') as HTMLButtonElement | null;
	if (subsetInfoPinBtn) {
		subsetInfoPinBtn.addEventListener('click', () => {
			clearFetchStatus();
		});
	}

	function updateFetchStatus(msg) {
		activeFetchStatusMessage = msg;
		applyStatusPresentation(msg, { transient: true, dismissible: true, pinned: activeFetchStatusPinned });
	}

	// Append fetched nodes/links into live layout (reuse revealNeighbors append logic)
	appendFetched = function appendFetched(newNodes, newLinks) {
		if (!Array.isArray(newNodes)) newNodes = [];
		if (!Array.isArray(newLinks)) newLinks = [];
		normalizeNodeLabelsInPlace(newNodes);

		// avoid duplicates
		const existIds = new Set(layoutNodes.map((n) => n.id));
		const uniqNodes = newNodes.filter((n) => !existIds.has(n.id));

		// Place newly-added nodes near the expand origin (parent node) if known,
		// otherwise fall back to the viewport center so they're visible immediately.
		if (uniqNodes.length > 0) {
			const main = document.getElementById('fg-main');
			const W = main?.clientWidth || 800;
			const H = main?.clientHeight || 600;
			const originX = lastExpandOriginNode && Number.isFinite(lastExpandOriginNode.x) ? lastExpandOriginNode.x : W / 2;
			const originY = lastExpandOriginNode && Number.isFinite(lastExpandOriginNode.y) ? lastExpandOriginNode.y : H / 2;
			uniqNodes.forEach((n) => {
				if (n.x == null && n.y == null) {
					// Spawn tightly on the parent so nodes appear right at the click site
					n.x = originX + (Math.random() - 0.5) * 20;
					n.y = originY + (Math.random() - 0.5) * 20;
				}
			});
		}
		// push
		layoutNodes.push(...uniqNodes);

		const currentLayoutNodeIds = new Set(layoutNodes.map((n) => n.id));
		layoutLinks.push(
			...newLinks.filter((l) => {
				const s = l.source?.id ?? l.source;
				const t = l.target?.id ?? l.target;
				// only include link if both nodes are currently rendered
				if (!currentLayoutNodeIds.has(s) || !currentLayoutNodeIds.has(t)) return false;
				// avoid duplicate link
				return !layoutLinks.some((el) => (el.source?.id ?? el.source) === s && (el.target?.id ?? el.target) === t);
			}),
		);
		applyGraphDerivedNodeMetrics(layoutNodes, layoutLinks);

		// Rebuild neighbor cache and update info
		neighborMap = buildNeighborMap(layoutNodes, layoutLinks);
		if (layoutNodes.length || layoutLinks.length) showEmpty(false);
		if (graphData) updateSubsetInfo(layoutNodes.length, graphData.nodes.length);
		updateMeta();

		// Persist session so reload restores these nodes
		saveSession();

		// Append DOM nodes/links similar to revealNeighbors
		const allLinks = linkGroup.selectAll('line').data(layoutLinks, (d) => {
			const s = d.source?.id ?? d.source;
			const t = d.target?.id ?? d.target;
			return `${s}-${t}-${d.relationship}`;
		});
		const enteredLinks = allLinks
			.enter()
			.append('line')
			.attr('class', 'fg-link')
			.attr('stroke', (d) => getLinkColor(d))
			.attr('stroke-opacity', 0)
			.attr('stroke-width', (d) => getLinkWidth(d))
			.attr('stroke-dasharray', (d) => getLinkDash(d))
			.attr('marker-end', (d) => getLinkMarker(d));
		enteredLinks.transition().duration(400).attr('stroke-opacity', defaultLinkOpacity);
		linkSel = linkGroup.selectAll('line');

		if (arrowGroup) {
			const allArrows = arrowGroup.selectAll('line').data(layoutLinks, (d) => {
				const s = d.source?.id ?? d.source;
				const t = d.target?.id ?? d.target;
				return `${s}-${t}-${d.relationship}`;
			});
			allArrows
				.enter()
				.append('line')
				.attr('stroke', 'none')
				.attr('fill', 'none')
				.attr('marker-end', (d) => getLinkMarker(d));
			arrowSel = arrowGroup.selectAll('line');
		}

		const allNodes = nodeGroup.selectAll('g.fg-node').data(layoutNodes, (d) => d.id);
		const enteredNodes = allNodes.enter().append('g').attr('class', 'fg-node').attr('opacity', 0).call(fluidDrag()).on('click', handleNodeOpen);

		// Apply initial transform so new nodes appear at their placed position
		// immediately (the renderGraph tick handler only covers old nodes).
		enteredNodes.attr('transform', (d) => `translate(${d.x ?? 0},${d.y ?? 0})`);

		enteredNodes.transition().duration(400).attr('opacity', 1);
		nodeSel = nodeGroup.selectAll('g.fg-node');
		linkSel = linkGroup.selectAll('line');
		rerenderGraphNodesByIds(getImpactedNodeIds(uniqNodes, newLinks));

		refreshGraphColors();
		refreshTraceState();

		// Replace tick handler so it covers the full updated selections.
		simulation.on('tick', () => {
			linkSel
				.attr('x1', (d) => d.source.x)
				.attr('y1', (d) => d.source.y)
				.attr('x2', (d) => d.target.x)
				.attr('y2', (d) => d.target.y);
			if (arrowSel) {
				arrowSel
					.attr('x1', (d) => d.source.x)
					.attr('y1', (d) => d.source.y)
					.attr('x2', (d) => d.target.x)
					.attr('y2', (d) => d.target.y);
			}
			nodeSel.attr('transform', (d) => `translate(${d.x},${d.y})`);
		});

		// Restart simulation with new nodes/links
		simulation.nodes(layoutNodes);
		simulation.force('link').links(layoutLinks);
		simulation.force('collision').radius((d) => getNodeCollisionRadius(d, layoutNodes.length));
		simulation.alpha(getIncrementalRestartAlpha(layoutNodes.length, uniqNodes.length)).restart();
	};

	// ── Location search handlers ──────────────────────────────────────────────
	const locStatus = document.getElementById('fg-loc-status');

	function setLocStatus(msg, isErr = false) {
		if (!locStatus) return;
		locStatus.textContent = msg;
		locStatus.style.color = isErr ? 'var(--c-controls)' : 'var(--text-m)';
		if (msg)
			setTimeout(() => {
				if (locStatus.textContent === msg) locStatus.textContent = '';
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
				const crd = String(src?.ind_source_id || src?.ind_crd || '').trim();
				if (crd && /^\d+$/.test(crd)) {
					try {
						const r = await fetch(`${BASE}/api/finra/individual/${encodeURIComponent(crd)}`);
						if (!r.ok) return;
						const detail = unwrapDetailPayload(await r.json());
						if (detail?.found === false) return;
						const personId = `person:${crd}`;
						const personLabel = normalizePersonLabel(
							(detail?.basicInformation?.firstName || src?.ind_firstname) +
								(detail?.basicInformation?.middleName || src?.ind_middlename) +
								(detail?.basicInformation?.lastName || src?.ind_lastname),
						);

						if (!batchNodes.some((n) => n.id === personId)) {
							batchNodes.push({
								id: personId,
								label: personLabel,
								group: 'individual',
								crd,
							});
						}
						for (const e of [
							...(detail?.currentEmployments || []).map((e) => ({ ...e, _isCurrent: true })),
							...(detail?.previousEmployments || []).map((e) => ({ ...e, _isCurrent: false })),
						]) {
							const fid = String(e?.firmId || e?.firm_id || e?.firmIdNumber || e?.firmId || '').trim();
							if (!fid) continue;
							const firmNodeId = `firm:${fid}`;
							if (!batchNodes.some((n) => n.id === firmNodeId)) {
								batchNodes.push({
									id: firmNodeId,
									label: e?.firm_name || e?.firmName || `Firm ${fid}`,
									group: 'firm',
									firmId: fid,
									bdSecNumber: e?.firm_bd_sec_number || e?.bdSecNumber,
									iaSecNumber: e?.firm_ia_sec_number || e?.iaSecNumber,
								});
							}
							batchLinks.push({
								source: personId,
								target: firmNodeId,
								relationship: getEmploymentRelationship(e),
								isCurrent: e._isCurrent,
							});
						}
					} catch {
						/* skip */
					}
					return;
				}
				// Firm hit (from zip search)
				const firmId = String(src?.firm_id || src?.firmId || src?.firm_source_id || '').trim();
				if (firmId && /^\d+$/.test(firmId)) {
					try {
						const r = await fetch(`${BASE}/api/finra/firm/${encodeURIComponent(firmId)}`);
						if (!r.ok) return;
						const detail = await r.json();
						if (detail?.found === false) return;
						const firmNodeId = `firm:${firmId}`;
						if (!batchNodes.some((n) => n.id === firmNodeId)) {
							batchNodes.push({
								id: firmNodeId,
								label: detail?.firmName || src?.name || `Firm ${firmId}`,
								group: 'firm',
								firmId,
								bcScope: detail?.firm_bc_scope ?? detail?.bcScope ?? null,
								disclosureFlag: detail?.disclosureFlag ?? detail?.basicInformation?.disclosureFlag ?? detail?.ind_bc_disclosure_fl,
								iaDisclosureFlag: detail?.iaDisclosureFlag ?? detail?.basicInformation?.iaDisclosureFlag ?? detail?.ind_bc_disclosure_fl,
							});
						}
						for (const o of detail?.directOwners || []) {
							const pid = String(o?.crdNumber || o?.crd || o?.personId || '').trim();
							if (!pid) continue;
							const personNodeId = `person:${pid}`;
							if (!batchNodes.some((n) => n.id === personNodeId)) {
								batchNodes.push({
									id: personNodeId,
									label: normalizePersonLabel(o?.legalName || o?.name || `Person ${pid}`),
									group: 'individual',
									crd: pid,
									bcScope: o?.bcScope || null,
									stub: true,
								});
							}
							batchLinks.push({
								source: personNodeId,
								target: firmNodeId,
								relationship: 'controls',
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
	const cityBtn = document.getElementById('fg-loc-city-search') as HTMLButtonElement | null;
	if (cityBtn) {
		cityBtn.addEventListener('click', async () => {
			const city = ((document.getElementById('fg-loc-city') as HTMLInputElement | null)?.value || '').trim();
			if (!city) {
				setLocStatus('Enter a city to search', true);
				return;
			}
			cityBtn.disabled = true;
			cityBtn.textContent = 'Searching…';
			setLocStatus(`Searching people in ${city}…`);
			try {
				const u = makeApiUrl('/api/finra/location-search');
				u.searchParams.set('city', city);
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
					setLocStatus('No structured records found');
					return;
				}
				scheduleFirstFetchFocusIfAvailable(
					nodes.map((node) => node.id),
					{
						duration: 700,
						maxScale: 1.05,
					},
				);
				appendFetched(nodes, links);
				mergeIntoGraphData(nodes, links);
				persistToServer(nodes, links);
				void fetchCacheStats();
				setLocStatus(`Added ${nodes.length} node${nodes.length !== 1 ? 's' : ''} for ${city}`);
			} catch (err) {
				console.error('city search failed', err);
				setLocStatus(`Error: ${err.message}`, true);
			} finally {
				cityBtn.disabled = false;
				cityBtn.textContent = 'Search People';
			}
		});
	}

	// ZIP / radius → firm search
	const zipBtn = document.getElementById('fg-loc-zip-search') as HTMLButtonElement | null;
	const radiusInput = document.getElementById('fg-loc-radius') as HTMLInputElement | null;
	const radiusVal = document.getElementById('fg-loc-radius-val') as HTMLElement | null;
	if (radiusInput && radiusVal) {
		radiusInput.addEventListener('input', () => {
			radiusVal.textContent = `${radiusInput.value} mi`;
		});
	}
	if (zipBtn) {
		zipBtn.addEventListener('click', async () => {
			const zip = ((document.getElementById('fg-loc-zip') as HTMLInputElement | null)?.value || '').trim();
			const radius = Number.parseInt((radiusInput?.value || '25').trim(), 10) || 25;
			if (!zip) {
				setLocStatus('Enter a ZIP code', true);
				return;
			}
			zipBtn.disabled = true;
			zipBtn.textContent = 'Searching…';
			setLocStatus(`Searching firms within ${radius} mi of ${zip}…`);
			try {
				const u = makeApiUrl('/api/finra/location-search');
				u.searchParams.set('zip', zip);
				u.searchParams.set('radius', String(radius));
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
					setLocStatus('No structured firm records found');
					return;
				}
				scheduleFirstFetchFocusIfAvailable(
					nodes.map((node) => node.id),
					{
						duration: 700,
						maxScale: 1.05,
					},
				);
				appendFetched(nodes, links);
				mergeIntoGraphData(nodes, links);
				persistToServer(nodes, links);
				void fetchCacheStats();
				setLocStatus(`Added ${nodes.length} node${nodes.length !== 1 ? 's' : ''} within ${radius} mi of ${zip}`);
			} catch (err) {
				console.error('zip search failed', err);
				setLocStatus(`Error: ${err.message}`, true);
			} finally {
				zipBtn.disabled = false;
				zipBtn.textContent = 'Search Firms';
			}
		});
	}

	renderLegend();
	void fetchCacheStats();
	void loadGraph().finally(() => {
		void fetchCacheStats();
	});
	// Poll lightweight meta/cache endpoints so externally updated Redis totals
	// appear in the UI without a hard refresh.
	let _metaPollId = null;
	const META_POLL_MS = 15000;

	async function fetchMetaOnce() {
		try {
			const hasProfileParam = new URLSearchParams(window.location.search).has('profile');
			const profileName = hasProfileParam ? new URLSearchParams(window.location.search).get('profile') : 'custom';
			const url = makeApiUrl('/api/finra/graph');
			url.searchParams.set('limit', '1');
			if (profileName) url.searchParams.set('profile', profileName);
			const r = await fetch(url.toString(), { cache: 'no-store' });
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
		void fetchMetaOnce();
		void fetchCacheStats();
		_metaPollId = setInterval(() => {
			void fetchMetaOnce();
			void fetchCacheStats();
		}, META_POLL_MS);
	}

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
		const url = makeApiUrl(`/api/finra/graph-search?q=${encodeURIComponent(q)}&limit=50`).toString();
		const res = await fetch(url, { headers: { Accept: 'application/json' } });
		if (!res.ok) throw new Error(`Local query failed: ${res.status}`);
		const data = await res.json();
		const nodes = Array.isArray(data) ? data : data?.nodes || [];
		const links = Array.isArray(data) ? [] : data?.links || [];
		if (!nodes.length) throw new Error('No local results');
		mergeIntoGraphData(nodes, links);
		return true;
	} catch (err) {
		console.log(`Local data not found for "${q}". Fetching from APIs to update local data...`);
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
	const ROWS = '1000';
	const headers = { Accept: 'application/json' };

	const [finraIndResp, finraFirmResp, secResp] = await Promise.allSettled([
		fetch(makeApiUrl(`/api/finra/search?query=${encodeURIComponent(q)}&rows=${ROWS}`).toString(), { headers }).then((r) => (r.ok ? r.json() : null)),
		fetch(makeApiUrl(`/api/finra/search?query=${encodeURIComponent(q)}&firm=1&rows=${ROWS}`).toString(), { headers }).then((r) => (r.ok ? r.json() : null)),
		fetch(makeApiUrl(`/api/finra/sec-search?query=${encodeURIComponent(q)}`).toString(), { headers }).then((r) => (r.ok ? r.json() : null)),
	]);

	const extractHits = (res) => {
		const d = res.status === 'fulfilled' ? res.value : null;
		return d?.hits?.hits || d?.response?.docs || d?.results || [];
	};

	const allHits = [...extractHits(finraIndResp), ...extractHits(finraFirmResp), ...extractHits(secResp)];

	if (!allHits.length) return;

	const newNodes = [];
	const newLinks = [];
	const seenNodes = new Set(layoutNodes ? layoutNodes.map((n) => n.id) : []);

	for (const hit of allHits) {
		const src = hit._source || hit;

		// Parse embedded content blob if present
		let parsed = src;
		if (typeof src?.content === 'string') {
			try {
				parsed = JSON.parse(src.content);
			} catch {
				parsed = src;
			}
		}

		const crd = String(parsed?.basicInformation?.individualId || src?.ind_source_id || src?.ind_crd || '').trim();

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
						.join(' ') || `CRD ${crd}`;

				// Propagate disclosure flags if present
				const disclosureFlag = src?.disclosureFlag ?? src?.ind_bc_disclosure_fl ?? parsed?.disclosureFlag ?? parsed?.basicInformation?.disclosureFlag ?? null;
				const iaDisclosureFlag = src?.iaDisclosureFlag ?? parsed?.iaDisclosureFlag ?? parsed?.basicInformation?.iaDisclosureFlag ?? null;
				newNodes.push({
					id: personId,
					label,
					group: 'individual',
					crd,
					bcScope: src?.ind_bc_scope ?? parsed?.basicInformation?.bcScope ?? null,
					iaScope: src?.ind_ia_scope ?? parsed?.basicInformation?.iaScope ?? null,
					disclosureFlag,
					iaDisclosureFlag,
					_source: 'finra',
				});

				// Link to current employments
				const emps = src?.ind_current_employments || src?.ind_ia_current_employments || [];
				for (const e of emps) {
					const fid = String(e?.firm_id || e?.firmId || '').trim();
					if (!fid) continue;
					const firmNodeId = `firm:${fid}`;
					if (!seenNodes.has(firmNodeId)) {
						seenNodes.add(firmNodeId);
						newNodes.push({
							id: firmNodeId,
							label: e?.firm_name || e?.firmName || `Firm ${fid}`,
							group: 'firm',
							firmId: fid,
							_source: 'finra',
						});
					}
					newLinks.push({
						source: personId,
						target: firmNodeId,
						relationship: 'employed_by',
						isCurrent: true,
					});
				}
			}
			continue;
		}

		const firmId = String(src?.firm_id || src?.firmId || src?.firm_source_id || '').trim();

		if (firmId) {
			const firmNodeId = `firm:${firmId}`;
			if (!seenNodes.has(firmNodeId)) {
				seenNodes.add(firmNodeId);
				// Propagate disclosure flags if present
				const disclosureFlag = src?.disclosureFlag ?? src?.firm_disclosure_flag ?? null;
				const iaDisclosureFlag = src?.iaDisclosureFlag ?? null;
				newNodes.push({
					id: firmNodeId,
					label: src?.firm_name || src?.firmName || `Firm ${firmId}`,
					group: 'firm',
					firmId,
					bcScope: src?.firm_bc_scope ?? src?.bcScope ?? null,
					disclosureFlag,
					iaDisclosureFlag,
					_source: 'finra',
				});
			}
		}
	}

	if (!newNodes.length) return;

	if (typeof appendFetched === 'function') appendFetched(newNodes, newLinks);
	mergeIntoGraphData(newNodes, newLinks);
	persistToServer(newNodes, newLinks);
}

// Batch variant of local graph search that returns nodes/links without
// mutating the layout or graphData. Used to preload seeds before a single
// append to reduce layout movement.
async function fetchLocalQueryBatch(q) {
	try {
		const url = makeApiUrl(`/api/finra/graph-search?q=${encodeURIComponent(q)}&limit=50`).toString();
		const res = await fetch(url, { headers: { Accept: 'application/json' } });
		if (!res.ok) return { nodes: [], links: [], matchedIds: [] };
		const data = await res.json();
		if (Array.isArray(data)) {
			return { nodes: data, links: [], matchedIds: data.map((node) => node?.id).filter(Boolean) };
		}
		return { nodes: data?.nodes || [], links: data?.links || [], matchedIds: data?.matchedIds || [] };
	} catch {
		return { nodes: [], links: [], matchedIds: [] };
	}
}

// Batch variant of the full text query that returns nodes/links without
// appending. Mirrors `fetchAndInjectQuery` logic but returns the results.
async function fetchQueryBatch(q) {
	const ROWS = '1000';
	const headers = { Accept: 'application/json' };

	const [finraIndResp, finraFirmResp, secResp] = await Promise.allSettled([
		fetch(makeApiUrl(`/api/finra/search?query=${encodeURIComponent(q)}&rows=${ROWS}`).toString(), { headers }).then((r) => (r.ok ? r.json() : null)),
		fetch(makeApiUrl(`/api/finra/search?query=${encodeURIComponent(q)}&firm=1&rows=${ROWS}`).toString(), { headers }).then((r) => (r.ok ? r.json() : null)),
		fetch(makeApiUrl(`/api/finra/sec-search?query=${encodeURIComponent(q)}`).toString(), { headers }).then((r) => (r.ok ? r.json() : null)),
	]);

	const extractHits = (res) => {
		const d = res.status === 'fulfilled' ? res.value : null;
		return d?.hits?.hits || d?.response?.docs || d?.results || [];
	};

	const allHits = [...extractHits(finraIndResp), ...extractHits(finraFirmResp), ...extractHits(secResp)];

	if (!allHits.length) return { nodes: [], links: [] };

	const newNodes = [];
	const newLinks = [];
	const seenNodes = new Set(layoutNodes ? layoutNodes.map((n) => n.id) : []);

	for (const hit of allHits) {
		const src = hit._source || hit;

		let parsed = src;
		if (typeof src?.content === 'string') {
			try {
				parsed = JSON.parse(src.content);
			} catch {
				parsed = src;
			}
		}

		const crd = String(parsed?.basicInformation?.individualId || src?.ind_source_id || src?.ind_crd || '').trim();

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
						.join(' ') || `CRD ${crd}`;

				// Propagate disclosure flags if present
				const disclosureFlag = src?.disclosureFlag ?? src?.ind_bc_disclosure_fl ?? parsed?.disclosureFlag ?? parsed?.basicInformation?.disclosureFlag ?? null;
				const iaDisclosureFlag = src?.iaDisclosureFlag ?? parsed?.iaDisclosureFlag ?? parsed?.basicInformation?.iaDisclosureFlag ?? null;
				newNodes.push({
					id: personId,
					label,
					group: 'individual',
					crd,
					bcScope: src?.ind_bc_scope ?? parsed?.basicInformation?.bcScope ?? null,
					iaScope: src?.ind_ia_scope ?? parsed?.basicInformation?.iaScope ?? null,
					disclosureFlag,
					iaDisclosureFlag,
					_source: 'finra',
				});

				const emps = src?.ind_current_employments || src?.ind_ia_current_employments || [];
				for (const e of emps) {
					const fid = String(e?.firmId || e?.firm_id || e?.firmIdNumber || e?.firmId || '').trim();
					if (!fid) continue;
					const firmNodeId = `firm:${fid}`;
					if (!seenNodes.has(firmNodeId)) {
						seenNodes.add(firmNodeId);
						newNodes.push({
							id: firmNodeId,
							label: e?.firm_name || e?.firmName || `Firm ${fid}`,
							group: 'firm',
							firmId: fid,
							_source: 'finra',
						});
					}
					newLinks.push({
						source: personId,
						target: firmNodeId,
						relationship: 'employed_by',
						isCurrent: true,
					});
				}
			}
			continue;
		}

		const firmId = String(src?.firm_id || src?.firmId || src?.firm_source_id || '').trim();
		if (firmId) {
			const firmNodeId = `firm:${firmId}`;
			if (!seenNodes.has(firmNodeId)) {
				seenNodes.add(firmNodeId);
				// Propagate disclosure flags if present
				const disclosureFlag = src?.disclosureFlag ?? src?.firm_disclosure_flag ?? null;
				const iaDisclosureFlag = src?.iaDisclosureFlag ?? null;
				newNodes.push({
					id: firmNodeId,
					label: src?.firm_name || src?.firmName || `Firm ${firmId}`,
					group: 'firm',
					firmId,
					bcScope: src?.firm_bc_scope ?? src?.bcScope ?? null,
					disclosureFlag,
					iaDisclosureFlag,
					_source: 'finra',
				});
			}
		}
	}

	return { nodes: newNodes, links: newLinks };
}

function updateGraphMeta() {
	if (!graphData) return;
	const totalIndividuals = graphData.nodes.filter((n) => n.group === 'individual').length;
	const totalFirms = graphData.nodes.filter((n) => n.group === 'firm').length;
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
	normalizeNodeLabelsInPlace(newNodes);
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
	newNodes
		.filter((n) => gIds.has(n.id))
		.forEach((n) => {
			const existingNode = graphData.nodes.find((entry) => entry.id === n.id);
			if (!existingNode) return;
			if (n.basicInformation && !existingNode.basicInformation) existingNode.basicInformation = n.basicInformation;
			if (n.name && !existingNode.name) existingNode.name = n.name;
			if (n.firmName && !existingNode.firmName) existingNode.firmName = n.firmName;
			normalizeNodeLabelInPlace(existingNode);
		});
	normalizeNodeLabelsInPlace(graphData.nodes);
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
	const url = makeApiUrl('/api/finra/graph-append');

	// Fire-and-forget but split payloads into chunks below the 10MB request limit.
	void (async () => {
		const maxBytes = 5 * 1024 * 1024; // 5MB per chunk to stay safely under limits
		let nodeIdx = 0;
		let linkIdx = 0;
		const totalNodes = Array.isArray(nodes) ? nodes.length : 0;
		const totalLinks = Array.isArray(links) ? links.length : 0;

		while (nodeIdx < totalNodes || linkIdx < totalLinks) {
			const batchNodes = [];
			const batchLinks = [];

			// Add nodes until size limit reached
			while (nodeIdx < totalNodes) {
				batchNodes.push(nodes[nodeIdx]);
				const size = new TextEncoder().encode(JSON.stringify({ nodes: batchNodes, links: batchLinks })).length;
				if (size > maxBytes) {
					batchNodes.pop();
					break;
				}
				nodeIdx++;
			}

			// Add links until size limit reached
			while (linkIdx < totalLinks) {
				batchLinks.push(links[linkIdx]);
				const size = new TextEncoder().encode(JSON.stringify({ nodes: batchNodes, links: batchLinks })).length;
				if (size > maxBytes) {
					batchLinks.pop();
					break;
				}
				linkIdx++;
			}

			// Ensure at least one item is sent to avoid infinite loop on very large single elements
			if (batchNodes.length === 0 && nodeIdx < totalNodes) {
				batchNodes.push(nodes[nodeIdx]);
				nodeIdx++;
			}
			if (batchLinks.length === 0 && linkIdx < totalLinks) {
				batchLinks.push(links[linkIdx]);
				linkIdx++;
			}

			try {
				await fetch(url.toString(), {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ nodes: batchNodes, links: batchLinks }),
				});
			} catch (e) {
				// Non-critical; stop further attempts if server rejects large bodies
				break;
			}
		}
	})();
}

async function fetchIndividualBatch(crd, queryLabel = null) {
	if (!/^[0-9]+$/.test(String(crd))) {
		throw new Error(`invalid individual id ${crd}`);
	}

	const nodes = [];
	const links = [];
	const r = await fetch(`${BASE}/api/finra/individual/${encodeURIComponent(crd)}`);
	if (!r.ok) throw new Error(`individual HTTP ${r.status}`);
	const detail = unwrapDetailPayload(await r.json());
	if (detail?.found === false) throw new Error(`individual ${crd} not found`);

	const personId = `person:${crd}`;
	const personLabel = normalizePersonLabel(
		(detail?.basicInformation && [detail.basicInformation.firstName, detail.basicInformation.middleName, detail.basicInformation.lastName].filter(Boolean).join(' ')) ||
			detail?.basicInformation?.name ||
			queryLabel ||
			`CRD ${crd}`,
	);

	nodes.push(
		applyIndividualDetail(
			{
				id: personId,
				label: personLabel,
				group: 'individual',
				crd,
			},
			detail,
			crd,
		),
	);

	const emps = flattenEmploymentRecords(detail, { includeGeneric: true });

	for (const e of emps) {
		const fid = e?.firmId || e?.firm_id || e?.firmIdNumber || e?.firmId || null;
		if (!fid) continue;
		const existingFirmNode = findExistingFirmNode(fid, { label: e?.firmName || e?.name || '' });
		const firmNodeId = existingFirmNode?.id || `firm:${fid}`;
		if (!existingFirmNode && !nodes.some((n) => n.id === firmNodeId)) {
			nodes.push({
				id: firmNodeId,
				label: e?.firmName || e?.name || `Firm ${fid}`,
				group: 'firm',
				firmId: String(fid),
			});
		}
		links.push({
			source: personId,
			target: firmNodeId,
			relationship: getEmploymentRelationship(e),
			isCurrent: e._isCurrent,
		});
	}

	return { nodes, links };
}

async function fetchFirmBatch(firmId, queryLabel = null) {
	if (!/^[0-9]+$/.test(String(firmId))) {
		throw new Error(`invalid firm id ${firmId}`);
	}

	const nodes = [];
	const links = [];
	const r = await fetch(`${BASE}/api/finra/firm/${encodeURIComponent(firmId)}`);
	if (!r.ok) throw new Error(`firm HTTP ${r.status}`);
	const detail = unwrapDetailPayload(await r.json());
	if (detail?.found === false) throw new Error(`firm ${firmId} not found`);

	const firmNodeId = `firm:${firmId}`;
	nodes.push({
		id: firmNodeId,
		label: detail?.firmName || detail?.name || queryLabel || `Firm ${firmId}`,
		group: 'firm',
		firmId: String(firmId),
	});

	for (const owner of detail?.directOwners || detail?.owners || []) {
		const pid = owner?.crdNumber || owner?.crd || owner?.personId || null;
		if (!pid) continue;
		const personNodeId = `person:${pid}`;
		const existingPersonNode = findExistingPersonNode(pid);
		if (!existingPersonNode && !nodes.some((n) => n.id === personNodeId)) {
			nodes.push({
				id: personNodeId,
				label: normalizePersonLabel(owner?.legalName || owner?.name || `Person ${pid}`),
				group: 'individual',
				crd: pid,
				bcScope: owner?.bcScope || null,
				stub: true,
			});
		}
		links.push({
			source: personNodeId,
			target: firmNodeId,
			relationship: 'controls',
		});
	}

	return { nodes, links };
}

async function loadGraph() {
	try {
		const hasProfileParam = new URLSearchParams(window.location.search).has('profile');
		const profileName = hasProfileParam ? new URLSearchParams(window.location.search).get('profile') : 'custom';
		currentProfileName = profileName;

		const profileData = await loadProfile(profileName);
		currentProfileEnabled = isProfileEnabled(profileData);
		const session = loadSession();
		const clearedSession = Boolean(session?.cleared);
		isSessionCleared = clearedSession;
		const hasSavedSessionData = Boolean(
			session &&
			!clearedSession &&
			(session.extraNodes?.length || session.extraNodeIds?.length || session.renderedServerIds?.length || session.selectedNodeId || session.highlightedNodes?.length),
		);
		const shouldStartEmptyForCustomProfile = profileName === 'custom' && !pendingRouteNodeId && !profileHasExplicitSeedTargets(profileData) && !hasSavedSessionData;

		if (!currentProfileEnabled) {
			if (session && !clearedSession) {
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

		if (clearedSession) {
			clearGraphData();
			if (session && (session.extraNodes?.length || session.extraNodeIds?.length || session.renderedServerIds?.length)) {
				await restoreSavedSession(session);
			}
			return;
		} else if (shouldStartEmptyForCustomProfile) {
			clearGraphData();
			return;
		} else {
			await loadBaselineGraph(profileName);
			if (!graphData) return;

			if (session) {
				renderSavedSessionGraph(session);
				await restoreSavedSession(session);
				return;
			}
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
			return;
		}

		if (prof && typeof prof === 'object') {
			const indCrds = normalizeProfileIds(prof.individuals);
			const firmIds = normalizeProfileIds(prof.firms);
			const seedQueries = getNormalizedProfileSeedQueries(prof);

			const indivPromises = indCrds.map(async (c) => {
				if (layoutNodes.some((n) => n.id === `person:${c}`)) return { nodes: [], links: [] };
				try {
					return await fetchIndividualBatch(c);
				} catch {
					return { nodes: [], links: [] };
				}
			});
			const firmPromises = firmIds.map(async (f) => {
				if (layoutNodes.some((n) => n.id === `firm:${f}`)) return { nodes: [], links: [] };
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
				if (r.status === 'fulfilled' && r.value) {
					batchAllNodes.push(...(r.value.nodes || []));
					batchAllLinks.push(...(r.value.links || []));
				}
			}
			for (const r of firmResults) {
				if (r.status === 'fulfilled' && r.value) {
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
	} catch (err) {
		console.error('loadGraph:', err);
		showEmpty(true);
	} finally {
		if (pendingRouteNodeId) {
			if (!graphData || !layoutNodes) {
				clearGraphData();
			}
			void applyPendingRouteNodeSelection();
		}
	}
}

// Build a subgraph from `seedCount` random nodes plus all their N-hop neighbors.
function subsetGraph(data, seedCount, hops = DEFAULT_EXPANSION_HOPS) {
	const adj = new Map<string, string[]>();
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
	const visibleIds = new Set<string>(seeds.map((n) => n.id));
	let frontier = new Set<string>(visibleIds);

	for (let h = 0; h < hops; h++) {
		const next = new Set<string>();
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
	const sel = document.getElementById('fg-subset-select') as HTMLSelectElement | null;
	if (activeFetchStatusMessage || hasLockedFetchStatus()) {
		applyStatusPresentation(activeFetchStatusMessage || '', {
			transient: Boolean(activeFetchStatusMessage),
			dismissible: Boolean(activeFetchStatusMessage),
			pinned: activeFetchStatusPinned,
		});
	}

	if (sel) sel.classList.remove('hidden');
}

function clearSubsetInfo() {
	const info = document.getElementById('fg-subset-info');
	const sel = document.getElementById('fg-subset-select') as HTMLSelectElement | null;
	if (!activeFetchStatusMessage && !hasLockedFetchStatus() && info) {
		applyStatusPresentation('', { transient: false, dismissible: false, pinned: false });
	}
	if (sel) sel.value = 'all';
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
	const q = String(rawQuery || '').trim();
	const qlow = q.toLowerCase();
	if (!nodeSel || !linkSel || !layoutNodes || !layoutLinks) return;

	if (!q) {
		// reset
		nodeSel.style('opacity', null).classed('filtered', false);
		linkSel.style('stroke-opacity', null).attr('stroke-opacity', defaultLinkOpacity).style('opacity', null);
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
		return String(s || '').replace(/[^0-9]/g, '');
	}

	const isExactNumeric = /^\d+$/.test(q) || /^\d+-\d+$/.test(q) || /^crd:/i.test(q) || /^sec:/i.test(q);

	// determine matching node ids
	const matched = new Set();
	layoutNodes.forEach((n) => {
		// gather candidate values
		const label = String(firstField(n, ['label', 'firm_name', 'firmName']) || '');
		const labelLow = label.toLowerCase();

		const crd = String(firstField(n, ['crd', 'ind_source_id', 'ind_crd']) || '');
		const bdSec = String(firstField(n, ['bdSecNumber', 'bd_sec_number', 'firm_bd_sec_number']) || '');
		const bdFull = String(firstField(n, ['firm_bd_full_sec_number']) || '');
		const firmSrc = String(firstField(n, ['firm_source_id', 'firm_id']) || '');

		// person name pieces
		const fname = String(firstField(n, ['ind_firstname']) || '');
		const mname = String(firstField(n, ['ind_middlename']) || '');
		const lname = String(firstField(n, ['ind_lastname']) || '');
		const personFull = [fname, mname, lname].filter(Boolean).join(' ');

		// firm address (may be stored as JSON string)
		let addrObj = null;
		const addrRaw = firstField(n, ['firm_address_details', 'address_details']);
		if (addrRaw) {
			try {
				addrObj = typeof addrRaw === 'string' ? JSON.parse(addrRaw) : addrRaw;
			} catch (e) {
				addrObj = null;
			}
		}

		// exact numeric match for CRD/SEC/firmsource
		if (isExactNumeric) {
			const qDigits = normalizeDigits(q);
			// check CRD / source ids
			if (normalizeDigits(crd) === qDigits || normalizeDigits(firmSrc) === qDigits) {
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
			if (src.firm_bd_full_sec_number && String(src.firm_bd_full_sec_number).toLowerCase() === q.toLowerCase()) {
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
			const addrText = [office.street1, office.street2, office.city, office.state, office.postalCode, mail.street1, mail.city].filter(Boolean).join(' ').toLowerCase();
			if (addrText.includes(ql)) {
				matched.add(n.id);
				return;
			}
		}

		// employment branch match for individuals
		const emp = firstField(n, ['ind_current_employments', 'ind_employments']);
		if (Array.isArray(emp)) {
			for (const e of emp) {
				const city = String(e.branch_city || e.city || '').toLowerCase();
				const state = String(e.branch_state || e.state || '').toLowerCase();
				const zip = String(e.branch_zip || e.postalCode || '').toLowerCase();
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
			const label = String(firstField(n, ['label', 'firm_name', 'firmName']) || '');
			const labelLow = label.toLowerCase();

			const crd = String(firstField(n, ['crd', 'ind_source_id', 'ind_crd']) || '');
			const bdSec = String(firstField(n, ['bdSecNumber', 'bd_sec_number', 'firm_bd_sec_number']) || '');
			const bdFull = String(firstField(n, ['firm_bd_full_sec_number']) || '');
			const firmSrc = String(firstField(n, ['firm_source_id', 'firm_id']) || '');

			const fname = String(firstField(n, ['ind_firstname']) || '');
			const mname = String(firstField(n, ['ind_middlename']) || '');
			const lname = String(firstField(n, ['ind_lastname']) || '');
			const personFull = [fname, mname, lname].filter(Boolean).join(' ');

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
				if (labelLow.includes(qlow) || personFull.toLowerCase().includes(qlow)) {
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
			const resp = await fetch(`${BASE}/api/finra/graph-search?q=${encodeURIComponent(q)}&limit=10`);
			if (resp.ok) {
				const data = await resp.json();
				if (data.nodes?.length) {
					mergeIntoGraphData(data.nodes, data.links || []);
					// only take up to FILTER_MATCH_LIMIT direct label matches
					let count = 0;
					for (const n of data.nodes) {
						const label = String(n.label || '').toLowerCase();
						const firmId = String(n.firmId || n.firm_id || '');
						const crd = String(n.crd || n.ind_source_id || '');
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
	nodeSel.style('opacity', (d) => {
		const inactive = isNodeInactive(d);
		if (matched.has(d.id)) return inactive ? 0.6 : 0.9;
		if (expanded.has(d.id)) return inactive ? 0.38 : 0.58;
		return inactive ? 0.1 : 0.18;
	});

	// Update the count to reflect visible (expanded) nodes
	if (graphData) {
		updateSubsetInfo(expanded.size, graphData.nodes.length);
	}

	// update links: highlight links connected to any matched node, dim others
	linkSel
		.style('stroke-opacity', (l) => {
			const srcId = l.source?.id ?? l.source;
			const tgtId = l.target?.id ?? l.target;
			if (matched.has(srcId) || matched.has(tgtId)) return 0.45;
			if (expanded.has(srcId) || expanded.has(tgtId)) return 0.45;
			return 0.05;
		})
		.style('opacity', (l) => {
			const srcId = l.source?.id ?? l.source;
			const tgtId = l.target?.id ?? l.target;
			return matched.has(srcId) || matched.has(tgtId) || expanded.has(srcId) || expanded.has(tgtId) ? 1 : 0.45;
		});
}

// Cache stats are polled and reused for the header and bottom status bar.
let _cacheStats = null;
function fetchCacheStats() {
	return fetch('/api/finra/cache-stats', { cache: 'no-store' })
		.then((r) => r.json())
		.then((data) => {
			if (data?.counts) {
				_cacheStats = data.counts;
				updateMeta();
				try {
					// Ensure subset info updates to reflect Redis totals as soon as we
					// receive them (so the header can show People+Firms sum instead
					// of the possibly-stale server subset total).
					const shown = Array.isArray(layoutNodes) ? layoutNodes.length : 0;
					const totalFromGraph = graphData?.meta?.totalNodes ?? (Array.isArray(graphData?.nodes) ? graphData.nodes.length : 0);
					updateSubsetInfo(shown, totalFromGraph);
				} catch (e) {
					// swallow — non-critical UI sync
				}
			}
		})
		.catch(() => {});
}

function updateMeta(meta: { totalIndividuals?: number; totalFirms?: number; totalLinks?: number } = {}) {
	if (!meta && !layoutNodes) return;

	const dispSeeds = Array.isArray(layoutNodes) ? layoutNodes.filter((n) => n.group === 'individual').length : (meta.totalIndividuals ?? 0);
	const dispFirms = Array.isArray(layoutNodes) ? layoutNodes.filter((n) => n.group === 'firm').length : (meta.totalFirms ?? 0);
	const dispLinks = Array.isArray(layoutLinks) ? layoutLinks.length : (meta.totalLinks ?? 0);
	const globalPeople = typeof _cacheStats?.people === 'number' ? Math.max(_cacheStats.people, meta.totalIndividuals ?? 0) : (meta.totalIndividuals ?? dispSeeds);
	const globalFirms = typeof _cacheStats?.firms === 'number' ? Math.max(_cacheStats.firms, meta.totalFirms ?? 0) : (meta.totalFirms ?? dispFirms);
	const globalLinks = typeof _cacheStats?.links === 'number' ? Math.max(_cacheStats.links, meta.totalLinks ?? 0) : (meta.totalLinks ?? dispLinks);
	const fmt = (n) => (typeof n === 'number' ? n.toLocaleString() : n);

	// Top global stats removed — we no longer render the big numeric banner at the top.

	const bottomEl = document.getElementById('fg-bottom-status');
	if (bottomEl) {
		const parts = [`Displayed: ${fmt(dispSeeds)} People  ${fmt(dispFirms)} Firms  ${fmt(dispLinks)} Links`];
		if (_cacheStats && (typeof _cacheStats.people === 'number' || typeof _cacheStats.firms === 'number' || typeof _cacheStats.links === 'number')) {
			const cacheSeeds = typeof _cacheStats.people === 'number' ? Math.max(_cacheStats.people, dispSeeds) : '–';
			const cacheFirms = typeof _cacheStats.firms === 'number' ? Math.max(_cacheStats.firms, dispFirms) : '–';
			const cacheLinks = typeof _cacheStats.links === 'number' ? Math.max(_cacheStats.links, dispLinks) : '–';
			// parts.push(`redis cache: ${fmt(cacheSeeds)} People ${fmt(cacheFirms)} Firms ${fmt(cacheLinks)} Links`);
		}

		bottomEl.textContent = parts.join('  / ');
	}
}

function showEmpty(show) {
	document.getElementById('fg-empty')?.classList.toggle('hidden', !show);
	document.getElementById('fg-svg').style.visibility = show ? 'hidden' : 'visible';
	document.getElementById('fg-legend').style.display = show ? 'none' : 'flex';
}

function closeLog() {
	document.getElementById('fg-log-panel').classList.add('hidden');
}

function isSidebarPersistentlyPinned() {
	return document.getElementById('fg-sidebar')?.dataset.persistentPinned === 'true';
}

// ── D3 Rendering ────────────────────────────────────────────────────────────
const NODE_R = { individual: 5, firm: 6, entity: 9 };
const NODE_COLOR = {
	individual: GRAPH_COLORS.nodeIndividual,
	firm: GRAPH_COLORS.nodeFirm,
	entity: GRAPH_COLORS.nodeEntity,
};
const DEFAULT_LINK_COLOR = GRAPH_COLORS.lineEmployedBy;
const LINK_COLOR = {
	employed_by: GRAPH_COLORS.lineEmployedBy,
	previous_employed_by: GRAPH_COLORS.linePreviousEmployment,
	controls: GRAPH_COLORS.lineControls,
};
const LINK_OPACITY = {
	employed_by: 0.65,
	previous_employed_by: 0.5,
	controls: 0.65,
};
const DEFAULT_LINK_WIDTH = 0.75;
const INACTIVE_LINK_OPACITY = 0.34;
const defaultLinkOpacity = (d) => {
	if (hasInactiveEndpoint(d)) return INACTIVE_LINK_OPACITY;
	if (usesCurrentEmploymentStyling(d)) return LINK_OPACITY.employed_by;
	return LINK_OPACITY[d.relationship] ?? 0.5;
};

function getEmploymentRelationship(entry) {
	return getEmploymentRelationshipImpl(entry);
}

function applyGraphDerivedNodeMetrics(nodes, links) {
	const nodeList = Array.isArray(nodes) ? nodes : [];
	const linkList = Array.isArray(links) ? links : [];
	const degMap = new Map<string, { total: number; controls: number; employed: number }>();

	nodeList.forEach((node) => {
		degMap.set(node.id, { total: 0, controls: 0, employed: 0 });
	});

	linkList.forEach((link) => {
		const sourceId = link.source?.id ?? link.source;
		const targetId = link.target?.id ?? link.target;
		[sourceId, targetId].forEach((id) => {
			const entry = degMap.get(id);
			if (!entry) return;
			entry.total += 1;
			if (link.relationship === 'controls') entry.controls += 1;
			else entry.employed += 1;
		});
	});

	const maxFirmDeg = Math.max(1, ...nodeList.filter((node) => node.group === 'firm').map((node) => degMap.get(node.id)?.total || 0));
	const maxIndDeg = Math.max(1, ...nodeList.filter((node) => node.group === 'individual').map((node) => degMap.get(node.id)?.total || 0));

	const MIN_INDIV = 6; // minimum radius for individuals
	const MIN_FIRM = 7; // minimum half-size for firms
	nodeList.forEach((node) => {
		const deg = degMap.get(node.id) || { total: 0, controls: 0, employed: 0 };
		node._deg = deg;
		if (node.group === 'individual') {
			const scale = 1 + (Math.sqrt(deg.total) / Math.sqrt(maxIndDeg)) * 2.5;
			let half = (NODE_R.individual * 1.7 * scale) / 2;
			if (!deg.total || !isFinite(half) || half < MIN_INDIV) half = MIN_INDIV;
			node._vizHalf = half;
			return;
		}
		if (node.group === 'firm') {
			const scale = 1 + (Math.sqrt(deg.total) / Math.sqrt(maxFirmDeg)) * 1.9;
			let half = (NODE_R.firm * 1.7 * scale) / 2;
			if (!deg.total || !isFinite(half) || half < MIN_FIRM) half = MIN_FIRM;
			node._vizHalf = half;
			return;
		}
		delete node._vizHalf;
	});
}

function getNodeDegreeValue(node) {
	return Math.max(0, Number(node?._deg?.total || 0));
}

function getNodeScatterBoost(node, nodeCount = layoutNodes?.length || 0) {
	const degree = getNodeDegreeValue(node);
	if (!degree) return 0;
	const multiplier =
		nodeCount > 1000 ? 7.5
		: nodeCount > 600 ? 6.4
		: nodeCount > 300 ? 5.5
		: 4.5;
	const cap =
		nodeCount > 1000 ? 180
		: nodeCount > 600 ? 155
		: nodeCount > 300 ? 130
		: 100;
	return Math.min(cap, Math.sqrt(degree) * multiplier);
}

function getForceLinkDistance(link, nodeCount = layoutNodes?.length || 0) {
	const baseDistance =
		nodeCount > 1000 ? 220
		: nodeCount > 300 ? 175
		: 110;
	const sourceNode = typeof link?.source === 'object' ? link.source : layoutNodes?.find((node) => node.id === link?.source);
	const targetNode = typeof link?.target === 'object' ? link.target : layoutNodes?.find((node) => node.id === link?.target);
	const scatterBoost = Math.max(getNodeScatterBoost(sourceNode, nodeCount), getNodeScatterBoost(targetNode, nodeCount));
	const relationshipBoost =
		link?.relationship === 'controls' ? 22
		: link?.relationship === 'previous_employed_by' ? 10
		: 0;
	return baseDistance + scatterBoost + relationshipBoost;
}

function getNodeCollisionRadius(node, nodeCount = layoutNodes?.length || 0) {
	const padding =
		nodeCount > 1000 ? 12
		: nodeCount > 600 ? 14
		: nodeCount > 300 ? 16
		: nodeCount > 120 ? 18
		: 20;
	const labelPadding =
		nodeCount > 1000 ? 18
		: nodeCount > 600 ? 15
		: nodeCount > 300 ? 12
		: 9;
	const scatterPadding = Math.min(nodeCount > 1000 ? 42 : 34, getNodeScatterBoost(node, nodeCount) * 0.24);
	const labelLengthPadding = Math.min(10, Math.max(0, formatNodeLabel(node?.label || '').length - 10) * 0.24);
	return (node?._vizHalf != null ? node._vizHalf : NODE_R[node?.group] || 10) + padding + labelPadding + scatterPadding + labelLengthPadding;
}

function getIncrementalRestartAlpha(nodeCount = layoutNodes?.length || 0, changedNodeCount = 0) {
	if (nodeCount <= 0) return 0.18;
	const changeRatio = changedNodeCount > 0 ? changedNodeCount / nodeCount : 0;
	if (nodeCount > 1000) {
		return changeRatio > 0.18 ? 0.14 : 0.08;
	}
	if (nodeCount > 300) {
		return changeRatio > 0.2 ? 0.18 : 0.1;
	}
	return changeRatio > 0.25 ? 0.24 : 0.14;
}

function getImpactedNodeIds(nodes = [], links = []) {
	const ids = new Set();
	(nodes || []).forEach((node) => {
		if (node?.id) ids.add(node.id);
	});
	(links || []).forEach((link) => {
		const sourceId = link.source?.id ?? link.source;
		const targetId = link.target?.id ?? link.target;
		if (sourceId) ids.add(sourceId);
		if (targetId) ids.add(targetId);
	});
	return Array.from(ids);
}

function classifyActivityText(value) {
	const normalized = String(value || '')
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '');
	if (!normalized) return null;
	if (/(inactive|terminated|revoked|suspended|notinscope|withdrawn|barred|expelled|denied|ceased|closed|previouslyregistered|nolongerregistered|notregistered)/.test(normalized)) {
		return 'inactive';
	}
	if (/(active|approved|current)/.test(normalized)) {
		return 'active';
	}
	return null;
}

function collectNodeActivityFlags(values = []) {
	let hasActive = false;
	let hasInactive = false;
	values.forEach((value) => {
		const activity = classifyActivityText(value);
		if (activity === 'active') hasActive = true;
		if (activity === 'inactive') hasInactive = true;
	});
	return { hasActive, hasInactive };
}

function hasApprovedRegistrationCounts(registrationCount) {
	const counts = registrationCount || {};
	return [counts.approvedFinraRegistrationCount, counts.approvedSRORegistrationCount, counts.approvedStateRegistrationCount, counts.approvedIAStateRegistrationCount].some(
		(value) => Number(value || 0) > 0,
	);
}

function hasActiveRegisteredStates(registeredStates = [], allowedScopes: string[] | null = null) {
	if (!Array.isArray(registeredStates) || !registeredStates.length) return false;
	const normalizedAllowedScopes =
		Array.isArray(allowedScopes) ?
			new Set(
				allowedScopes
					.map((scope) =>
						String(scope || '')
							.trim()
							.toLowerCase(),
					)
					.filter(Boolean),
			)
		:	null;
	return registeredStates.some((entry) => {
		if (!entry || typeof entry !== 'object') return false;
		if (normalizedAllowedScopes) {
			const scope = String(entry.regScope || entry.scope || '')
				.trim()
				.toLowerCase();
			if (scope && !normalizedAllowedScopes.has(scope)) return false;
		}
		const status = classifyActivityText(entry.status || entry.registrationStatus || entry.scopeStatus);
		return status === 'active';
	});
}

function hasApprovedSro(registeredSROs = []) {
	if (!Array.isArray(registeredSROs) || !registeredSROs.length) return false;
	return registeredSROs.some((entry) => classifyActivityText(entry?.status) === 'active');
}

function hasHistoricalIndividualRegistrations(node) {
	return Boolean(
		node?.previousEmployments?.length ||
		node?.previousIAEmployments?.length ||
		(Array.isArray(node?.registeredStates) && node.registeredStates.length) ||
		hasApprovedSro(node?.registeredSROs),
	);
}
type NodeSourceCoverage = 'both' | 'sec_only' | 'finra_only' | 'none';

type NodeSourceTruth = {
	finra: boolean;
	sec: boolean;
	both: boolean;
	secOnly: boolean;
	finraOnly: boolean;
	none: boolean;
	coverage: NodeSourceCoverage;
};

function toNodeSourceCoverage(finra: boolean, sec: boolean): NodeSourceCoverage {
	if (finra && sec) return 'both';
	if (sec) return 'sec_only';
	if (finra) return 'finra_only';
	return 'none';
}

function isNotInScopeValue(value) {
	return (
		String(value || '')
			.trim()
			.toLowerCase()
			.replace(/\s+/g, '') === 'notinscope'
	);
}

function hasIndividualFinraPresence(node) {
	if (!node || typeof node !== 'object') return false;
	if (node.hasFinraData === true) return true;
	if (hasPublicFinraIndividualPage(node, node.basicInformation || {})) return true;
	if (hasAnyItems(node?.currentEmployments)) return true;
	if (hasAnyItems(node?.previousEmployments)) return true;
	if (hasApprovedSro(node?.registeredSROs)) return true;
	if (hasActiveRegisteredStates(node?.registeredStates, ['bc', 'b', 'broker'])) return true;
	if (isNotInScopeValue(node?.bcScope) || isNotInScopeValue(node?.basicInformation?.bcScope)) return false;
	const bcScopeFlags = collectNodeActivityFlags([node?.bcScope, node?.basicInformation?.bcScope]);
	if (bcScopeFlags.hasActive || bcScopeFlags.hasInactive) return true;
	return false;
}

function hasIndividualSecPresence(node) {
	if (!node || typeof node !== 'object') return false;
	if (node.hasSecData === true) return true;
	if (hasPublicSecIndividualPage(node, node.basicInformation || {})) return true;
	if (hasSecActivityEvidence(node)) return true;
	if (Number(node?.registrationCount?.approvedIAStateRegistrationCount || 0) > 0) return true;
	if (hasAnyItems(node?.previousIAEmployments)) return true;
	if (hasAnyItems(node?.iaDisclosures)) return true;
	if (hasActiveRegisteredStates(node?.registeredStates, ['ia'])) return true;
	if (isNotInScopeValue(node?.iaScope) || isNotInScopeValue(node?.basicInformation?.iaScope)) return false;
	const iaScopeFlags = collectNodeActivityFlags([node?.iaScope, node?.basicInformation?.iaScope]);
	if (iaScopeFlags.hasActive || iaScopeFlags.hasInactive) return true;
	return false;
}

function hasFirmFinraPresence(node) {
	if (!node || typeof node !== 'object') return false;
	if (node.hasFinraData === true) return true;
	if (node.isLegacy === 'Y') return true;
	if (hasAnyItems(node?.selfRegulatoryOrgs)) return true;
	if (Boolean(String(node?.districtName || '').trim())) return true;
	if (isNotInScopeValue(node?.bcScope) || isNotInScopeValue(node?.basicInformation?.bcScope)) return false;
	const bcScopeFlags = collectNodeActivityFlags([node?.bcScope, node?.basicInformation?.bcScope]);
	if (bcScopeFlags.hasActive || bcScopeFlags.hasInactive) return true;
	return false;
}

function hasFirmSecPresence(node) {
	if (!node || typeof node !== 'object') return false;
	if (node.hasSecData === true) return true;
	if (Boolean(String(node?.iaSecNumber || node?.basicInformation?.iaSECNumber || node?.basicInformation?.iaSecNumber || '').trim())) return true;
	if (hasAnyItems(node?.secDocumentLinks)) return true;
	if (Boolean(String(node?.secSummaryDescription || '').trim())) return true;
	if (isNotInScopeValue(node?.iaScope) || isNotInScopeValue(node?.basicInformation?.iaScope)) return false;
	const secStatusFlags = collectNodeActivityFlags([node?.firmStatus, node?.basicInformation?.firmStatus, node?.iaScope, node?.basicInformation?.iaScope]);
	if (secStatusFlags.hasActive || secStatusFlags.hasInactive) return true;
	return false;
}

function getNodeSourceTruth(node): NodeSourceTruth {
	const finra =
		node?.group === 'individual' ? hasIndividualFinraPresence(node)
		: node?.group === 'firm' ? hasFirmFinraPresence(node)
		: Boolean(node?.hasFinraData);
	const sec =
		node?.group === 'individual' ? hasIndividualSecPresence(node)
		: node?.group === 'firm' ? hasFirmSecPresence(node)
		: Boolean(node?.hasSecData);
	const coverage = toNodeSourceCoverage(finra, sec);
	return {
		finra,
		sec,
		both: coverage === 'both',
		secOnly: coverage === 'sec_only',
		finraOnly: coverage === 'finra_only',
		none: coverage === 'none',
		coverage,
	};
}

function formatNodeSourceTruthSummary(node) {
	const sourceTruth = getNodeSourceTruth(node);
	const coverageLabel =
		sourceTruth.coverage === 'both' ? 'both SEC+FINRA'
		: sourceTruth.coverage === 'sec_only' ? 'SEC only'
		: sourceTruth.coverage === 'finra_only' ? 'FINRA only'
		: 'none';
	return `FINRA=${sourceTruth.finra ? 'true' : 'false'} · SEC=${sourceTruth.sec ? 'true' : 'false'} (${coverageLabel})`;
}

function hasSecActivityEvidence(node) {
	if (!node || typeof node !== 'object') return false;
	const iaActivityFlags = collectNodeActivityFlags([node.iaScope, node.basicInformation?.iaScope]);
	if (iaActivityFlags.hasActive) return true;
	if (Number(node?.registrationCount?.approvedIAStateRegistrationCount || 0) > 0) return true;
	if (Array.isArray(node?.currentIAEmployments) && node.currentIAEmployments.length > 0) return true;
	if (hasActiveRegisteredStates(node?.registeredStates, ['ia'])) return true;
	return false;
}

function isNodeInactive(node) {
	if (!node || typeof node !== 'object') return false;
	const sourceTruth = getNodeSourceTruth(node);

	if (node.group === 'firm') {
		const finraFlags = sourceTruth.finra ? collectNodeActivityFlags([node.bcScope, node.basicInformation?.bcScope]) : { hasActive: false, hasInactive: false };
		const secFlags =
			sourceTruth.sec ?
				collectNodeActivityFlags([node.firmStatus, node.basicInformation?.firmStatus, node.iaScope, node.basicInformation?.iaScope])
			:	{ hasActive: false, hasInactive: false };
		if (finraFlags.hasActive || secFlags.hasActive) return false;
		if ((sourceTruth.finra || sourceTruth.sec) && Array.isArray(node.activeStates) && node.activeStates.length) return false;
		if (node.isLegacy === 'Y' && !sourceTruth.sec) return true;
		if (finraFlags.hasInactive || secFlags.hasInactive) return true;
		return false;
	}

	if (node.group === 'individual') {
		const finraSignalsEnabled = sourceTruth.finra;
		const secSignalsEnabled = sourceTruth.sec || hasSecActivityEvidence(node);
		const activityFlags = collectNodeActivityFlags([
			...(finraSignalsEnabled ? [node.bcScope, node.basicInformation?.bcScope] : []),
			...(secSignalsEnabled ? [node.iaScope, node.basicInformation?.iaScope] : []),
		]);
		const counts = node.registrationCount || {};
		const hasFinraApprovedCounts =
			finraSignalsEnabled &&
			(Number(counts.approvedFinraRegistrationCount || 0) > 0 || Number(counts.approvedSRORegistrationCount || 0) > 0 || Number(counts.approvedStateRegistrationCount || 0) > 0);
		const hasSecApprovedCounts = secSignalsEnabled && Number(counts.approvedIAStateRegistrationCount || 0) > 0;
		const hasFinraActiveStates = finraSignalsEnabled && hasActiveRegisteredStates(node.registeredStates, ['bc', 'b', 'broker']);
		const hasSecActiveStates = secSignalsEnabled && hasActiveRegisteredStates(node.registeredStates, ['ia']);
		if (activityFlags.hasActive) return false;
		if (node.stub) return false;
		if (hasFinraApprovedCounts || hasSecApprovedCounts) return false;
		if ((finraSignalsEnabled && node.currentEmployments?.length) || (secSignalsEnabled && node.currentIAEmployments?.length)) return false;
		if (hasFinraActiveStates || hasSecActiveStates) return false;
		if (finraSignalsEnabled && hasApprovedSro(node.registeredSROs)) return false;
		if (activityFlags.hasInactive) return true;
		return hasHistoricalIndividualRegistrations(node) && !node.stub;
	}

	return false;
}

function resolveLinkEndpointNode(endpoint) {
	if (endpoint && typeof endpoint === 'object') return endpoint;
	const endpointId = String(endpoint || '').trim();
	if (!endpointId) return null;
	return layoutNodes?.find((node) => node.id === endpointId) || null;
}

function hasInactiveEndpoint(link) {
	if (!link) return false;
	const sourceNode = resolveLinkEndpointNode(link.source);
	const targetNode = resolveLinkEndpointNode(link.target);
	return isNodeInactive(sourceNode) || isNodeInactive(targetNode);
}

function isPreviousEmploymentLink(link) {
	if (!link) return false;
	return link.relationship === 'previous_employed_by' || (link.relationship === 'employed_by' && link.isCurrent === false);
}

function usesCurrentEmploymentStyling(link) {
	if (!link || hasInactiveEndpoint(link)) return false;
	return isCurrentRegistration(link) || isPreviousEmploymentLink(link);
}

function getLinkHighlightColor(link) {
	if (hasInactiveEndpoint(link)) return getLinkColor(link);
	if (link?.relationship === 'controls') return GRAPH_COLORS.lineControlsHighlight;
	return getLinkColor(link);
}

function getCompactInactiveNodeLabel(node) {
	const preferredLabel = getPreferredNodeLabel(node);
	if (!preferredLabel) return '';
	if (node?.group === 'firm') {
		const clippedLabel = clipFirmLabelAtWord(preferredLabel, 26);
		return isPlaceholderExpansionLabel(clippedLabel, node?.group) ? '' : clippedLabel;
	}
	const formattedLabel = formatNodeLabel(preferredLabel);
	const compactLabel = truncate(formattedLabel, 18);
	return isPlaceholderExpansionLabel(compactLabel, node?.group) ? '' : compactLabel;
}

function updateInactiveLabelZoomState(rootSelection, zoomScale, forceExpandedLabels = false) {
	if (!rootSelection) return;
	const compactInactive = !forceExpandedLabels && zoomScale < inactiveLabelCompactZoomThreshold;
	rootSelection.classed('fg-inactive-labels-compact', compactInactive);
	if (inactiveLabelCompactMode === compactInactive) return;
	inactiveLabelCompactMode = compactInactive;
	rootSelection.selectAll('.fg-label--inactive').text((node) => (inactiveLabelCompactMode ? getCompactInactiveNodeLabel(node) : getRenderedNodeLabel(node)));
}

function rerenderGraphNodesByIds(nodeIds) {
	if (!nodeSel) return;
	const ids = Array.isArray(nodeIds) ? nodeIds.filter(Boolean) : Array.from(nodeIds || []).filter(Boolean);
	if (!ids.length) return;
	const idSet = new Set(ids);
	renderNodeContents(nodeSel.filter((node) => idSet.has(node.id)));
}

function renderNodeContents(selection) {
	if (!selection) return;
	selection.each(function (d) {
		const g = d3.select(this);
		g.selectAll('*').remove();

		const r = NODE_R[d.group] || 10;
		const inactive = isNodeInactive(d);
		g.classed('fg-node--inactive', inactive)
			.classed('fg-node--individual', d.group === 'individual')
			.classed('fg-node--firm', d.group === 'firm')
			.classed('fg-node--entity', d.group === 'entity')
			.classed('fg-node--stub', d.group === 'individual' && Boolean(d.stub));
		// Use lighter blue for stub individuals to match the legend
		let color = inactive ? GRAPH_COLORS.nodeInactive : NODE_COLOR[d.group] || GRAPH_COLORS.nodeDefault;
		let nodeOpacity: number | string = inactive ? 0.82 : 1;
		if (d.group === 'individual' && d.stub) {
			color = inactive ? GRAPH_COLORS.nodeInactive : GRAPH_COLORS.nodeStub;
			nodeOpacity = inactive ? 0.72 : NODE_OPACITY_STUB;
		}
		const nodeStroke = inactive ? GRAPH_COLORS.nodeInactiveStroke : GRAPH_COLORS.nodeBorder;
		const nodeLabelColor = inactive ? GRAPH_COLORS.nodeInactiveLabel : GRAPH_COLORS.nodeLabel;
		const nodeLabelHalo = inactive ? 'rgba(248,250,252,0.95)' : GRAPH_COLORS.nodeLabelHalo;

		if (d.group === 'firm') {
			const s = (d._vizHalf ?? r * 0.85) * 2;
			const deg = d._deg || { total: 0, controls: 0, employed: 0 };
			const dominantClass =
				deg.controls > deg.employed ? 'fg-node-shape--firm-controls'
				: deg.employed > deg.controls ? 'fg-node-shape--firm-employed'
				: '';
			const dominantStroke =
				inactive ? GRAPH_COLORS.nodeInactiveStroke
				: deg.controls > deg.employed ? GRAPH_COLORS.nodeFirmControlsStroke
				: deg.employed > deg.controls ? GRAPH_COLORS.nodeFirmEmployedStroke
				: GRAPH_COLORS.nodeBorder;
			const hasConnections = deg.total > 0;
			const strokeW = hasConnections ? 0.5 : 1.5;

			// Helper to generate hexagon points centered at (0,0)
			function hexPoints(radius) {
				const points = [];
				for (let i = 0; i < 6; i++) {
					const angle = (Math.PI / 3) * i - Math.PI / 6; // start flat-top
					points.push([(radius * Math.cos(angle)).toFixed(2), (radius * Math.sin(angle)).toFixed(2)].join(','));
				}
				return points.join(' ');
			}

			// Draw minority stroke as a larger hexagon if needed
			if (!inactive && deg.controls > 0 && deg.employed > 0) {
				const minorityStroke = deg.controls > deg.employed ? GRAPH_COLORS.nodeFirmEmployedStroke : GRAPH_COLORS.nodeFirmControlsStroke;
				g.append('polygon')
					.attr('points', hexPoints((s + 8) / 2))
					.attr('fill', 'none')
					.attr('stroke', minorityStroke)
					.attr('stroke-width', 0.5)
					.attr('opacity', 0.5);
			}

			// Main firm hexagon
			g.append('polygon')
				.attr('class', `fg-node-shape fg-node-shape--firm ${hasConnections ? 'fg-node-shape--firm-connected' : ''} ${dominantClass}`.trim())
				.attr('points', hexPoints(s / 2))
				.attr('fill', color)
				.attr(
					'stroke',
					inactive ? GRAPH_COLORS.nodeInactiveStroke
					: hasConnections ? dominantStroke
					: GRAPH_COLORS.nodeBorder,
				)
				.attr('stroke-width', null)
				.attr('opacity', nodeOpacity === 1 ? 0.9 : nodeOpacity);

			g.append('polygon')
				.attr('class', 'fg-node-overlay')
				.attr('points', hexPoints(s / 2));
		} else if (d.group === 'entity') {
			const s = r * 1.5;
			g.append('polygon')
				.attr('class', 'fg-node-shape fg-node-shape--entity')
				.attr('points', `0,${-s} ${s},0 0,${s} ${-s},0`)
				.attr('fill', null)
				.attr('stroke', null)
				.attr('stroke-width', null)
				.attr('opacity', null);
			g.append('polygon').attr('class', 'fg-node-overlay').attr('points', `0,${-s} ${s},0 0,${s} ${-s},0`);
		} else {
			const rv = d._vizHalf != null ? d._vizHalf : r;
			g.append('circle')
				.attr('class', 'fg-node-shape fg-node-shape--circle')
				.attr('r', rv)
				.attr('fill', null)
				.attr('stroke', null)
				.attr('stroke-width', null)
				.attr('opacity', null);
			g.append('circle').attr('class', 'fg-node-overlay').attr('r', rv);
		}

		drawDisclosureIndicator(g, d, r);

		['halo', 'fill'].forEach((pass) => {
			const labelClass = [`fg-label-${pass}`];
			if (inactive) {
				labelClass.push('fg-label--inactive', `fg-label-${pass}--inactive`);
			}
			const labelText = inactive && inactiveLabelCompactMode ? getCompactInactiveNodeLabel(d) : getRenderedNodeLabel(d);
			g.append('text')
				.attr('class', labelClass.join(' '))
				.attr('dy', d._vizHalf != null ? d._vizHalf + 14 : r + 14)
				.attr('text-anchor', 'middle')
				.attr('font-size', '10px')
				.attr('font-family', 'var(--sans)')
				.attr('font-weight', '500')
				.attr('fill', pass === 'halo' ? 'none' : nodeLabelColor)
				.attr('stroke', pass === 'halo' ? nodeLabelHalo : 'none')
				.attr('stroke-width', pass === 'halo' ? 4 : 0)
				.attr('stroke-linejoin', 'round')
				.attr('paint-order', 'stroke')
				.attr('pointer-events', 'all')
				.style('cursor', 'pointer')
				.text(labelText);
		});

		g.append('title').text(() => {
			const parts = [getPreferredNodeLabel(d), d.group?.toUpperCase?.() || ''];
			if (d.crd) parts.push(`CRD: ${d.crd}`);
			return parts.join('\n');
		});
	});
}

function isCurrentRegistration(d) {
	if (d.relationship !== 'employed_by') return false;
	if (d.isCurrent !== undefined) return d.isCurrent;

	const src = typeof d.source === 'object' ? d.source : layoutNodes?.find((n) => n.id === d.source);
	if (!src || src.group !== 'individual') return false;

	const tgtId = String(typeof d.target === 'object' ? d.target.id : d.target).replace(/^firm:/, '');

	const currents = [...(src.currentEmployments || []), ...(src.currentIAEmployments || [])];
	if (currents.some((e) => String(e.firmId || e.firm_id) === tgtId)) return true;

	const previous = [...(src.previousEmployments || []), ...(src.previousIAEmployments || [])];
	if (previous.some((e) => String(e.firmId || e.firm_id) === tgtId)) return false;

	if (d.endDate === null || d.endDate === '') return true;

	return false;
}

function getLinkColor(d) {
	if (hasInactiveEndpoint(d)) return GRAPH_COLORS.linePreviousEmployment;
	if (d.relationship === 'controls') return GRAPH_COLORS.lineControls;
	if (usesCurrentEmploymentStyling(d)) return GRAPH_COLORS.lineEmployedBy;
	return LINK_COLOR[d.relationship] || DEFAULT_LINK_COLOR;
}

function getLinkMarker(d) {
	if (hasInactiveEndpoint(d)) return 'url(#arrow-previous_employed_by)';
	if (d.relationship === 'controls') return `url(#arrow-controls)`;
	if (usesCurrentEmploymentStyling(d)) return `url(#arrow-current_employed_by)`;
	return `url(#arrow-${d.relationship})`;
}

function getLinkDash(d) {
	if (hasInactiveEndpoint(d)) return '5 3';
	if (usesCurrentEmploymentStyling(d)) return null;
	return null;
}

function getLinkWidth(d) {
	if (hasInactiveEndpoint(d)) return 0.5;
	if (usesCurrentEmploymentStyling(d)) return DEFAULT_LINK_WIDTH;
	return DEFAULT_LINK_WIDTH;
}

function isNodeOnAnyTrace(nodeId: string) {
	return (
		(isTraceMode && (traceShortestIds.has(nodeId) || traceShortestConnectorIds.has(nodeId) || traceLongestIds.has(nodeId) || traceLongestConnectorIds.has(nodeId))) ||
		(isTraceLogMode && (traceLogIds.has(nodeId) || traceLogConnectorIds.has(nodeId)))
	);
}

function isLinkOnAnyTrace(linkKey: string) {
	return (isTraceMode && (traceShortestIds.has(linkKey) || traceLongestIds.has(linkKey))) || (isTraceLogMode && traceLogIds.has(linkKey));
}

function getNodeRenderPriority(node, highlightState) {
	if (!node) return 1;
	if (isNodeOnAnyTrace(node.id)) return 3;
	if (highlightState?.rootIds?.has(node.id) || highlightState?.hopNodeIds?.has(node.id)) return 2;
	if (isNodeInactive(node)) return 0;
	return 1;
}

function getLinkRenderPriority(link, highlightState) {
	if (!link) return 1;
	const linkKey = getLinkKey(link);
	if (isLinkOnAnyTrace(linkKey)) return 3;
	if (highlightState?.linkKeys?.has(linkKey)) return 2;
	if (hasInactiveEndpoint(link)) return 0;
	return 1;
}

function comparePriorityWithTieBreak(aPriority, bPriority, aTieBreak, bTieBreak) {
	if (aPriority !== bPriority) return aPriority - bPriority;
	return String(aTieBreak || '').localeCompare(String(bTieBreak || ''));
}

function orderGraphVisualLayers(highlightState = computeHighlightState()) {
	if (linkSel && typeof linkSel.sort === 'function') {
		linkSel.sort((a, b) => comparePriorityWithTieBreak(getLinkRenderPriority(a, highlightState), getLinkRenderPriority(b, highlightState), getLinkKey(a), getLinkKey(b)));
	}

	if (arrowSel && typeof arrowSel.sort === 'function') {
		arrowSel.sort((a, b) => comparePriorityWithTieBreak(getLinkRenderPriority(a, highlightState), getLinkRenderPriority(b, highlightState), getLinkKey(a), getLinkKey(b)));
	}

	if (nodeSel && typeof nodeSel.sort === 'function') {
		nodeSel.sort((a, b) => comparePriorityWithTieBreak(getNodeRenderPriority(a, highlightState), getNodeRenderPriority(b, highlightState), a?.id, b?.id));
	}
}

function reapplySelectionState() {
	if (!nodeSel) return;
	const highlightState = computeHighlightState();
	nodeSel
		.classed('selected', (node) => node.id === selectedId || highlightState.rootIds.has(node.id))
		.classed('highlighted-hop', (node) => node.id !== selectedId && !highlightState.rootIds.has(node.id) && highlightState.hopNodeIds.has(node.id));

	// Trace Mode node highlights — endpoints get trace-* class, connectors get trace-*-connector class
	const isOnShortestTrace = (id: string) => traceShortestIds.has(id) || traceShortestConnectorIds.has(id);
	const isOnLongestTrace = (id: string) => traceLongestIds.has(id) || traceLongestConnectorIds.has(id);
	const isOnLogTrace = (id: string) => traceLogIds.has(id) || traceLogConnectorIds.has(id);

	nodeSel
		.classed('trace-shortest', (d) => isTraceMode && traceShortestIds.has(d.id) && !traceShortestConnectorIds.has(d.id))
		.classed('trace-shortest-connector', (d) => isTraceMode && traceShortestConnectorIds.has(d.id))
		.classed('trace-longest', (d) => isTraceMode && traceLongestIds.has(d.id) && !traceLongestConnectorIds.has(d.id))
		.classed('trace-longest-connector', (d) => isTraceMode && traceLongestConnectorIds.has(d.id))
		.classed('trace-log', (d) => isTraceLogMode && traceLogIds.has(d.id) && !traceLogConnectorIds.has(d.id))
		.classed('trace-log-connector', (d) => isTraceLogMode && traceLogConnectorIds.has(d.id))
		.classed('trace-combined', (d) => isTraceMode && isOnShortestTrace(d.id) && isOnLongestTrace(d.id))
		.classed(
			'fg-node--trace-muted',
			(d) => isAnyTraceModeActive() && !(isTraceMode && (isOnShortestTrace(d.id) || isOnLongestTrace(d.id))) && !(isTraceLogMode && isOnLogTrace(d.id)),
		);

	highlightLinks(highlightState);
	orderGraphVisualLayers(highlightState);
}

function markNodeSelected(node, options: { persist?: boolean } = {}) {
	if (!node?.id) return;
	const { persist = true } = options;
	upsertHighlightedSelection(node.id, getDefaultSelectionHops());
	selectedId = node.id;
	refreshTraceState();
	if (!persist) return;
	try {
		saveSession();
	} catch (e) {
		/* ignore */
	}
}

// Refreshes colors for all nodes dynamically to ensure nodes and links correctly reflect state
function refreshGraphColors() {
	if (!nodeSel || !layoutLinks || !linkSel) return;

	renderNodeContents(nodeSel);

	linkSel
		.attr('stroke', (d) => getLinkColor(d))
		.attr('stroke-dasharray', (d) => getLinkDash(d))
		.attr('marker-end', (d) => getLinkMarker(d));

	highlightLinks(computeHighlightState());
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
		const url = makeApiUrl('/api/finra/nodes-by-ids');
		url.searchParams.set('ids', [...missing].join(','));
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
	const svg = d3.select('#fg-svg');
	svg.selectAll('*').remove();

	const main = document.getElementById('fg-main');
	const W = main.clientWidth;
	const H = main.clientHeight;

	svg.attr('viewBox', `0 0 ${W} ${H}`);

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

	// ── Per-node degree stats for scaled / tinted nodes ──────────────────────
	applyGraphDerivedNodeMetrics(nodes, links);

	// ── Anchor the two seed nodes on the same horizontal line ─────────────────
	// When this is the initial subset (one top individual + one top firm), pin
	// them side-by-side at mid-height so their link is horizontal from the start.
	if (data.meta?.subset) {
		const topInd = nodes.filter((n) => n.group === 'individual').sort((a, b) => (b._deg?.total || 0) - (a._deg?.total || 0))[0];
		const topFirm = nodes.filter((n) => n.group === 'firm').sort((a, b) => (b._deg?.total || 0) - (a._deg?.total || 0))[0];
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
	const labelZoomThreshold =
		isHuge ? 0.8
		: isLarge ? 0.55
		: 0.3;
	activeLabelZoomThreshold = labelZoomThreshold;
	inactiveLabelCompactZoomThreshold = labelZoomThreshold * 1.35;
	inactiveLabelCompactMode = initialScaleForCompactState(nodeCount) < inactiveLabelCompactZoomThreshold;

	function initialScaleForCompactState(count) {
		return count > 1000 ? 0.18 : 0.25;
	}

	function updateTraceStrokeScale(scale: number) {
		const normalized = Math.max(0, Math.min(1, Number(scale) || 1));
		const gentleScale = 0.78 + normalized * 0.22;
		svg.style('--fg-trace-stroke-scale', String(gentleScale));
	}

	const zoom = d3
		.zoom()
		.scaleExtent([0.1, 6])
		.on('zoom', (event) => {
			root.attr('transform', event.transform);
			updateTraceStrokeScale(event.transform.k);
			syncTraceLabelPresentation(event.transform.k);
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
	const initialScale =
		isHuge ? 0.18
		: isLarge ? 0.25
		: 0.25;
	updateTraceStrokeScale(initialScale);
	try {
		// Use immediate transition to set scale centered on the viewport
		svg.transition().duration(0).call(zoom.scaleTo, initialScale);
	} catch (e) {
		/* ignore if zoom API not available */
	}

	const root = svg.append('g').attr('class', 'fg-root');
	rootGroup = root;
	syncTraceLabelPresentation(initialScale);

	// ── Arrow markers ─────────────────────────────────────────────────────────
	const defs = svg.append('defs');

	['employed_by', 'previous_employed_by', 'controls', 'current_employed_by', 'inactive'].forEach((rel) => {
		defs
			.append('marker')
			.attr('id', `arrow-${rel}`)
			.attr('viewBox', '0 -4 8 8')
			.attr('refX', 30)
			.attr('refY', 0)
			.attr('markerWidth', 8)
			.attr('markerHeight', 8)
			.attr('markerUnits', 'userSpaceOnUse')
			.attr('orient', 'auto')
			.append('path')
			.attr('d', 'M0,-4L8,0L0,4')
			.attr(
				'fill',
				rel === 'controls' ? GRAPH_COLORS.lineControls
				: rel === 'inactive' ? GRAPH_COLORS.lineInactive
				: rel === 'previous_employed_by' ? GRAPH_COLORS.linePreviousEmployment
				: GRAPH_COLORS.lineEmployedBy,
			);
	});

	// ── Force simulation ──────────────────────────────────────────────────────
	// Scale simulation aggressiveness with graph size so large graphs converge faster
	const centeringStrength =
		isHuge ? 0.006
		: isLarge ? 0.009
		: 0.015;
	simulation = d3
		.forceSimulation(nodes)
		.alphaDecay(
			isHuge ? 0.1
			: isLarge ? 0.07
			: 0.04,
		)
		.velocityDecay(isLarge ? 0.65 : 0.55)
		.force(
			'link',
			d3
				.forceLink(links)
				.id((d) => d.id)
				.distance((link) => getForceLinkDistance(link, nodeCount)),
		)
		.force(
			'charge',
			d3
				.forceManyBody()
				.strength(
					isHuge ? -600
					: isLarge ? -450
					: -300,
				)
				.theta(isLarge ? 0.9 : 0.81),
		)
		// Use gentle forceX/Y instead of forceCenter — prevents the entire graph
		// from sliding when the center of mass shifts after adding nodes.
		.force('x', d3.forceX(W / 2).strength(centeringStrength))
		.force('y', d3.forceY(H / 2).strength(centeringStrength))
		// per-node radius so scaled firm squares don't overlap each other
		.force(
			'collision',
			d3
				.forceCollide()
				.radius((d) => getNodeCollisionRadius(d, nodeCount))
				.strength(1.0),
		);

	// Build neighbor adjacency cache after D3 has resolved link source/target objects
	neighborMap = buildNeighborMap(nodes, links);

	// ── Links ─────────────────────────────────────────────────────────────────
	const link = root
		.append('g')
		.attr('class', 'fg-links')
		.selectAll('line')
		.data(links)
		.join('line')
		.attr('class', 'fg-link')
		.attr('stroke', (d) => getLinkColor(d))
		.attr('stroke-opacity', defaultLinkOpacity)
		.attr('stroke-width', (d) => getLinkWidth(d))
		.attr('stroke-dasharray', (d) => getLinkDash(d))
		.attr('marker-end', (d) => getLinkMarker(d));
	linkSel = link;
	linkGroup = root.select('.fg-links');

	// ── Nodes ─────────────────────────────────────────────────────────────────
	const node = root
		.append('g')
		.attr('class', 'fg-nodes')
		.selectAll('g')
		.data(nodes, (d) => d.id)
		.join('g')
		.attr('class', 'fg-node')
		.call(fluidDrag())
		.on('click', handleNodeOpen);
	nodeSel = node;
	nodeGroup = root.select('.fg-nodes');

	// ── Arrowheads ───────────────────────────────────────────────────────────
	const arrow = root
		.append('g')
		.attr('class', 'fg-arrowheads')
		.selectAll('line')
		.data(links)
		.join('line')
		.attr('stroke', 'none')
		.attr('fill', 'none')
		.attr('marker-end', (d) => getLinkMarker(d));
	arrowSel = arrow;
	arrowGroup = root.select('.fg-arrowheads');

	renderNodeContents(node);

	// ── Tick ──────────────────────────────────────────────────────────────────
	let _tickN = 0;
	simulation.on('tick', () => {
		_tickN++;
		// During high-energy early layout, skip every other DOM write to cut paint time.
		// Physics still advances every tick; only the SVG update is throttled.
		if (simulation.alpha() > 0.15 && _tickN % 2 !== 0) return;

		link
			.attr('x1', (d) => d.source.x)
			.attr('y1', (d) => d.source.y)
			.attr('x2', (d) => d.target.x)
			.attr('y2', (d) => d.target.y);

		node.attr('transform', (d) => `translate(${d.x},${d.y})`);
	});

	// Stop simulation after 5 seconds to prevent endless movement
	setTimeout(() => simulation.stop(), 5000);

	// Preserve the current selection on blank click; highlights must be cleared explicitly.
	svg.on('click', () => {
		if (selectionRestoreTimer) {
			clearTimeout(selectionRestoreTimer);
			selectionRestoreTimer = null;
		}
		stopNodePulseLoop();
		if (!isSidebarPersistentlyPinned()) {
			document.getElementById('fg-sidebar')?.classList.add('hidden');
			document.getElementById('fg-sidebar-backdrop')?.classList.add('hidden');
		}
		// Keep the existing selection when clicking whitespace; only close the sidebar.
	});

	refreshGraphColors();
	reapplySelectionState();
}

// ── Fluid Drag (simulation-driven neighbor repulsion) ────────────────────
function fluidDrag() {
	return d3
		.drag()
		.on('start', function (event, d) {
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
		.on('drag', function (event, d) {
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
		.on('end', function (event, d) {
			// Release the dragged node so the simulation can continue moving fluidly
			d.fx = null;
			d.fy = null;
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
	const map = new Map<string, Set<string>>(nodes.map((n) => [n.id, new Set<string>()]));
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
	if (!graphData || !layoutNodes || !layoutLinks || !nodeGroup || !linkGroup) return;
	const idSet = new Set(ids || []);
	const exist = new Set(layoutNodes.map((n) => n.id));
	const toAdd = graphData.nodes.filter((n) => idSet.has(n.id) && !exist.has(n.id));
	if (!toAdd.length) return;

	// place new nodes near parent (if known) or near center with small random offset
	const main = document.getElementById('fg-main');
	const W = main?.clientWidth || 800;
	const H = main?.clientHeight || 600;
	const originX = lastExpandOriginNode && Number.isFinite(lastExpandOriginNode.x) ? lastExpandOriginNode.x : W / 2;
	const originY = lastExpandOriginNode && Number.isFinite(lastExpandOriginNode.y) ? lastExpandOriginNode.y : H / 2;
	toAdd.forEach((n, i) => {
		n.x = originX + (Math.random() - 0.5) * 120 + (i % 5) * 8;
		n.y = originY + (Math.random() - 0.5) * 120 + (i % 7) * 6;
	});

	// find links that connect now-rendered nodes
	const nowIds = new Set([...layoutNodes.map((n) => n.id), ...toAdd.map((n) => n.id)]);
	const newLinks = graphData.links
		.filter((l) => {
			const s = l.source?.id ?? l.source;
			const t = l.target?.id ?? l.target;
			return nowIds.has(s) && nowIds.has(t) && !layoutLinks.some((el) => (el.source?.id ?? el.source) === s && (el.target?.id ?? el.target) === t);
		})
		.map((l) => ({ ...l }));

	layoutNodes.push(...toAdd);
	layoutLinks.push(...newLinks);
	applyGraphDerivedNodeMetrics(layoutNodes, layoutLinks);

	neighborMap = buildNeighborMap(layoutNodes, layoutLinks);
	if (graphData) updateSubsetInfo(layoutNodes.length, graphData.nodes.length);

	// Append DOM elements for links and nodes (reuse pattern from appendFetched)
	const allLinks = linkGroup.selectAll('line').data(layoutLinks, (d) => {
		const s = d.source?.id ?? d.source;
		const t = d.target?.id ?? d.target;
		return `${s}-${t}-${d.relationship}`;
	});
	const enteredLinks = allLinks
		.enter()
		.append('line')
		.attr('class', 'fg-link')
		.attr('stroke', (d) => getLinkColor(d))
		.attr('stroke-opacity', 0)
		.attr('stroke-width', (d) => getLinkWidth(d))
		.attr('stroke-dasharray', (d) => getLinkDash(d))
		.attr('marker-end', (d) => getLinkMarker(d));
	enteredLinks.transition().duration(400).attr('stroke-opacity', defaultLinkOpacity);
	linkSel = linkGroup.selectAll('line');

	if (arrowGroup) {
		const allArrows = arrowGroup.selectAll('line').data(layoutLinks, (d) => {
			const s = d.source?.id ?? d.source;
			const t = d.target?.id ?? d.target;
			return `${s}-${t}-${d.relationship}`;
		});
		allArrows
			.enter()
			.append('line')
			.attr('stroke', 'none')
			.attr('fill', 'none')
			.attr('marker-end', (d) => getLinkMarker(d));
		arrowSel = arrowGroup.selectAll('line');
	}

	const allNodes = nodeGroup.selectAll('g.fg-node').data(layoutNodes, (d) => d.id);
	const enteredNodes = allNodes.enter().append('g').attr('class', 'fg-node').attr('opacity', 0).call(fluidDrag()).on('click', handleNodeOpen);

	// Persist session so reload restores these server-rendered nodes
	try {
		saveSession();
	} catch (e) {
		/* ignore */
	}

	enteredNodes.attr('transform', (d) => `translate(${d.x ?? 0},${d.y ?? 0})`);

	enteredNodes.transition().duration(400).attr('opacity', 1);
	nodeSel = nodeGroup.selectAll('g.fg-node');
	linkSel = linkGroup.selectAll('line');
	rerenderGraphNodesByIds(getImpactedNodeIds(toAdd, newLinks));

	refreshGraphColors();
	refreshTraceState();

	simulation.on('tick', () => {
		linkSel
			.attr('x1', (d) => d.source.x)
			.attr('y1', (d) => d.source.y)
			.attr('x2', (d) => d.target.x)
			.attr('y2', (d) => d.target.y);
		if (arrowSel) {
			arrowSel
				.attr('x1', (d) => d.source.x)
				.attr('y1', (d) => d.source.y)
				.attr('x2', (d) => d.target.x)
				.attr('y2', (d) => d.target.y);
		}
		nodeSel.attr('transform', (d) => `translate(${d.x},${d.y})`);
	});

	simulation.nodes(layoutNodes);
	simulation.force('link').links(layoutLinks);
	simulation.force('collision').radius((d) => getNodeCollisionRadius(d, layoutNodes.length));
	simulation.alpha(getIncrementalRestartAlpha(layoutNodes.length, toAdd.length)).restart();

	// Persist session so reload restores these nodes
	saveSession();

	// Update tick handler to cover new selections
	simulation.on('tick', () => {
		linkSel
			.attr('x1', (d) => d.source.x)
			.attr('y1', (d) => d.source.y)
			.attr('x2', (d) => d.target.x)
			.attr('y2', (d) => d.target.y);
		if (arrowSel) {
			arrowSel
				.attr('x1', (d) => d.source.x)
				.attr('y1', (d) => d.source.y)
				.attr('x2', (d) => d.target.x)
				.attr('y2', (d) => d.target.y);
		}
		nodeSel.attr('transform', (d) => `translate(${d.x},${d.y})`);
	});

	// Persist session so reload restores these revealed neighbors
	try {
		saveSession();
	} catch (e) {
		/* ignore */
	}
}

// ── Selection & Sidebar ─────────────────────────────────────────────────────

// Normalize wrapped detail payloads (e.g. from Elasticsearch/Solr hits)
function unwrapDetailPayload(detail) {
	if (!detail) return detail;
	const hit = detail?.hits?.hits?.[0] || detail?.response?.docs?.[0];
	if (hit) {
		const src = hit._source || hit;
		const rawContent = src.content || src.iacontent;
		if (typeof rawContent === 'string') {
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

// Normalize a detail payload so top-level merged fields are available
// under basicInformation and the UI can consume it consistently.
function normalizeIndividualDetailPayload(detail, fallbackCrd) {
	return normalizeIndividualDetailPayloadImpl(detail, fallbackCrd);
}

function hasRichIndividualDetail(detail) {
	return hasRichIndividualDetailImpl(detail);
}

function personHasRelationship(personNode, relationships) {
	if (!personNode?.id) return false;
	const relSet = new Set((Array.isArray(relationships) ? relationships : [relationships]).filter(Boolean));
	if (!relSet.size) return false;

	const allLinks = [...(Array.isArray(layoutLinks) ? layoutLinks : [])].concat(
		...Array.from(graphData?.links || []).map((l: any) => {
			const sourceId = l.source?.id ?? l.source;
			const targetId = l.target?.id ?? l.target;
			return { sourceId, targetId };
		}),
	);

	return allLinks.some((link) => {
		if (!relSet.has(link?.relationship)) return false;
		const sourceId = link.source?.id ?? link.source;
		const targetId = link.target?.id ?? link.target;
		return sourceId === personNode.id || targetId === personNode.id;
	});
}

function isLikelyOwnerOnlyIndividual(personNode) {
	if (!personNode) return false;
	const scope = String(personNode.bcScope || personNode.basicInformation?.bcScope || '')
		.toLowerCase()
		.replace(/\s+/g, '');
	const hasControlLink = personHasRelationship(personNode, 'controls');
	const hasEmploymentLink = personHasRelationship(personNode, ['employed_by', 'current_employed_by', 'previous_employed_by']);

	return hasControlLink && !hasEmploymentLink && scope === 'notinscope';
}

function normalizeComparableName(name) {
	return normalizeComparableNameImpl(name);
}

async function mergeIndividualOwnerEvidence(personNode) {
	if (!personNode || !graphData) return false;

	const personId = personNode.id;
	const personCrd = String(personNode.crd || '').trim();
	const personName = normalizeComparableName(personNode.label);
	const connectedFirmIds = new Set();

	for (const link of layoutLinks || []) {
		if (link.relationship !== 'controls') continue;
		const sourceId = link.source?.id ?? link.source;
		const targetId = link.target?.id ?? link.target;
		if (sourceId === personId) connectedFirmIds.add(targetId);
		if (targetId === personId) connectedFirmIds.add(sourceId);
	}

	let merged = false;
	for (const firmNodeId of connectedFirmIds) {
		const firmNode = layoutNodes?.find((node) => node.id === firmNodeId) || graphData.nodes?.find((node) => node.id === firmNodeId);
		if (!firmNode || firmNode.group !== 'firm') continue;

		if (!Array.isArray(firmNode.directOwners) || !firmNode.directOwners.length) {
			try {
				await ensureFirmDetail(firmNode);
			} catch {
				// Ignore firm detail failures and keep scanning other connected firms.
			}
		}

		const owner = (firmNode.directOwners || []).find((entry) => {
			const ownerCrd = String(entry?.crdNumber || entry?.crd || entry?.personId || '').trim();
			const ownerName = normalizeComparableName(entry?.legalName || entry?.name);
			return (personCrd && ownerCrd === personCrd) || (personName && ownerName === personName);
		});
		if (!owner) continue;

		personNode.crd ||= String(owner?.crdNumber || owner?.crd || owner?.personId || '').trim();
		personNode.bcScope ||= owner?.bcScope || null;
		if (!personNode.basicInformation) personNode.basicInformation = {};
		if (!personNode.basicInformation.individualId && personNode.crd) {
			personNode.basicInformation.individualId = personNode.crd;
		}
		if ((isPlaceholderExpansionLabel(personNode.label, 'individual') || !personNode.label) && (owner?.legalName || owner?.name)) {
			personNode.label = normalizePersonLabel(owner.legalName || owner.name);
		}
		merged = true;
	}

	return merged;
}

// Fetch individual detail from API and merge all data into the node.
// Called when an individual node is selected to hydrate missing data.
async function ensureIndividualDetail(personNode) {
	if (!personNode || personNode.group !== 'individual') return;

	// Extract CRD from node ID.
	// Supports "person:6482604", legacy "person_6482604", and bare numeric ids.
	const match = personNode.id.match(/^(?:person[:_])?(\d+)$/);
	const crd = String(personNode.crd || match?.[1] || '').trim();
	if (!crd) {
		personNode._ownerEvidenceLoaded = await mergeIndividualOwnerEvidence(personNode);
		personNode._detailMissing = !personNode._ownerEvidenceLoaded;
		return;
	}

	if (personNode._detailMissing || personNode._ownerEvidenceLoaded) {
		return;
	}

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
					if (normalized?.basicInformation && (normalized.basicInformation.individualId || normalized.basicInformation.firstName || normalized.basicInformation.lastName)) {
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

		const ownerEvidenceAvailable = !detail && !localDetail && !hasRichIndividualDetail(personNode) ? await mergeIndividualOwnerEvidence(personNode) : false;
		if (ownerEvidenceAvailable && isLikelyOwnerOnlyIndividual(personNode)) {
			personNode.stub = true;
			personNode._ownerEvidenceLoaded = true;
			personNode._detailMissing = false;
			return;
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
				personNode.stub = false;
				console.info(`Local API missing data for ${crd}; skipping direct browser fallback to external APIs to avoid CORS/rate-limit failures.`);
			}

			if (!detail || (detail.found === false && !detail.basicInformation && !detail.firmName)) {
				console.debug(`Individual ${crd} not found`);
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

		if (!detail || detail.found === false) {
			personNode._ownerEvidenceLoaded = await mergeIndividualOwnerEvidence(personNode);
			if (!detail || detail.found === false) {
				personNode._detailMissing = !personNode._ownerEvidenceLoaded;
				return;
			}
		}

		try {
			applyIndividualDetail(personNode, detail, crd);
			syncIndividualConnectionsFromDetail(personNode, detail);
			personNode._detailLoaded = true;
			personNode._detailMissing = false;
		} catch (e) {
			console.warn('Failed to merge individual detail:', e);
		}
		console.log(`Detail loaded for CRD ${crd}: ${personNode.disclosures?.length || 0} BC disclosures, ${personNode.iaDisclosures?.length || 0} IA disclosures`);
		if (typeof refreshGraphColors === 'function') refreshGraphColors();
	} catch (err) {
		console.error(`Error fetching individual detail for ${crd}:`, err);
	}
}

function syncIndividualConnectionsFromDetail(personNode, detail) {
	if (!personNode || !detail) return;

	const personId = personNode.id;
	const newNodes = [];
	const newLinks = [];

	const employments = flattenEmploymentRecords(detail);

	for (const employment of employments) {
		const firmId = String(employment?.firmId || employment?.firm_id || employment?.firmIdNumber || employment?.organizationId || employment?.orgId || '').trim();
		const firmName = String(
			employment?.firmName || employment?.firm_name || employment?.organizationName || employment?.firm || employment?.name || employment?.legalName || '',
		).trim();
		const existingFirmNode = findExistingFirmNode(firmId, { label: firmName });
		const syntheticFirmNodeId = !firmId && !existingFirmNode ? buildSyntheticFirmNodeId(firmName) : null;
		const firmNodeId = existingFirmNode?.id || (firmId ? `firm:${firmId}` : syntheticFirmNodeId);
		if (!firmNodeId) continue;

		const office = employment?.branchOfficeLocations?.[0];
		if (!existingFirmNode && !newNodes.some((node) => node.id === firmNodeId)) {
			newNodes.push({
				id: firmNodeId,
				label: firmName || `Firm ${firmId}`,
				group: 'firm',
				firmId: firmId || undefined,
				bdSecNumber: employment?.bdSECNumber || employment?.firm_bd_sec_number,
				iaSecNumber: employment?.iaSECNumber || employment?.firm_ia_sec_number,
				bcScope: employment?.firmBCScope || null,
			});
		}

		const hasLayoutLink = layoutLinks.some((link) => {
			const sourceId = link.source?.id ?? link.source;
			const targetId = link.target?.id ?? link.target;
			return sourceId === personId && targetId === firmNodeId && ['employed_by', 'previous_employed_by'].includes(link.relationship);
		});
		const hasPendingLink = newLinks.some((link) => {
			const sourceId = link.source?.id ?? link.source;
			const targetId = link.target?.id ?? link.target;
			return sourceId === personId && targetId === firmNodeId && ['employed_by', 'previous_employed_by'].includes(link.relationship);
		});
		if (!hasLayoutLink && !hasPendingLink) {
			newLinks.push({
				source: personId,
				target: firmNodeId,
				relationship: getEmploymentRelationship(employment),
				isCurrent: employment._isCurrent,
				startDate: employment?.registrationBeginDate || employment?.startDate || employment?.fromDate || null,
				endDate: employment._isCurrent ? null : employment?.registrationEndDate || employment?.endDate || employment?.toDate || null,
				city: employment?.city || office?.city || null,
				state: employment?.state || office?.state || null,
			});
		}
	}

	const controlRecords = [
		...(detail.controlPositions || []),
		...(detail.controlPositionList || []),
		...(detail.controlRelationships || []),
		...(detail.brokerDetails?.controlPositions || []),
	];
	let updatedExistingControlData = false;

	for (const controlRecord of controlRecords) {
		const firmId = String(controlRecord?.firmId || controlRecord?.firm_id || controlRecord?.organizationId || controlRecord?.orgId || '').trim();
		const firmName = String(controlRecord?.firmName || controlRecord?.organizationName || controlRecord?.firm || controlRecord?.name || controlRecord?.legalName || '').trim();
		const existingFirmNode = findExistingFirmNode(firmId, { label: firmName });
		const syntheticFirmNodeId = !firmId && !existingFirmNode ? buildSyntheticFirmNodeId(firmName) : null;
		const firmNodeId = existingFirmNode?.id || (firmId ? `firm:${firmId}` : syntheticFirmNodeId);
		if (!firmNodeId) continue;

		if (existingFirmNode) {
			if (firmName && (!existingFirmNode.label || /^Firm\s+\d+$/i.test(existingFirmNode.label) || existingFirmNode.label.length < firmName.length)) {
				existingFirmNode.label = firmName;
				updatedExistingControlData = true;
			}
			if (!existingFirmNode.firmId && firmId) {
				existingFirmNode.firmId = firmId;
				updatedExistingControlData = true;
			}
			if (!existingFirmNode.officeAddress) {
				existingFirmNode.officeAddress =
					controlRecord?.officeAddress ||
					controlRecord?.address ||
					[
						controlRecord?.street1 || controlRecord?.address1 || controlRecord?.street,
						controlRecord?.street2 || controlRecord?.address2 || controlRecord?.suite || controlRecord?.unit,
						controlRecord?.city || controlRecord?.officeCity,
						controlRecord?.state || controlRecord?.officeState,
						controlRecord?.postalCode || controlRecord?.zipCode || controlRecord?.zip,
						controlRecord?.country,
					]
						.filter(Boolean)
						.join(', ') ||
					null;
				updatedExistingControlData = true;
			}
			if (!existingFirmNode.firmStatus) {
				existingFirmNode.firmStatus = controlRecord?.firmStatus || controlRecord?.status || controlRecord?.registrationStatus || null;
				updatedExistingControlData = true;
			}
			if (!existingFirmNode.bdSecNumber) {
				existingFirmNode.bdSecNumber = controlRecord?.bdSECNumber || controlRecord?.bdSecNumber || controlRecord?.firm_bd_sec_number || null;
				updatedExistingControlData = true;
			}
			if (!existingFirmNode.iaSecNumber) {
				existingFirmNode.iaSecNumber = controlRecord?.iaSECNumber || controlRecord?.iaSecNumber || null;
				updatedExistingControlData = true;
			}
		}

		if (!existingFirmNode && !newNodes.some((node) => node.id === firmNodeId)) {
			newNodes.push({
				id: firmNodeId,
				label: firmName || `Firm ${firmId}`,
				group: 'firm',
				firmId: firmId || undefined,
			});
		}

		const controlMeta = {
			firmName: firmName || existingFirmNode?.label || null,
			position: controlRecord?.position || controlRecord?.title || controlRecord?.role || null,
			officeAddress:
				controlRecord?.officeAddress ||
				controlRecord?.address ||
				[
					controlRecord?.street1 || controlRecord?.address1 || controlRecord?.street,
					controlRecord?.street2 || controlRecord?.address2 || controlRecord?.suite || controlRecord?.unit,
					controlRecord?.city || controlRecord?.officeCity,
					controlRecord?.state || controlRecord?.officeState,
					controlRecord?.postalCode || controlRecord?.zipCode || controlRecord?.zip,
					controlRecord?.country,
				]
					.filter(Boolean)
					.join(', ') ||
				existingFirmNode?.officeAddress ||
				null,
			street1: controlRecord?.street1 || controlRecord?.address1 || controlRecord?.street || null,
			street2: controlRecord?.street2 || controlRecord?.address2 || controlRecord?.suite || controlRecord?.unit || null,
			city: controlRecord?.city || controlRecord?.officeCity || null,
			state: controlRecord?.state || controlRecord?.officeState || null,
			postalCode: controlRecord?.postalCode || controlRecord?.zipCode || controlRecord?.zip || null,
			country: controlRecord?.country || null,
			firmStatus: controlRecord?.firmStatus || controlRecord?.status || controlRecord?.registrationStatus || existingFirmNode?.firmStatus || null,
			startDate: controlRecord?.registrationBeginDate || controlRecord?.startDate || controlRecord?.fromDate || controlRecord?.effectiveDate || controlRecord?.date || null,
			endDate: controlRecord?.registrationEndDate || controlRecord?.endDate || controlRecord?.toDate || null,
			location: controlRecord?.location || controlRecord?.city || controlRecord?.officeCity || controlRecord?.state || controlRecord?.officeState || null,
			bdSecNumber: controlRecord?.bdSECNumber || controlRecord?.bdSecNumber || controlRecord?.firm_bd_sec_number || existingFirmNode?.bdSecNumber || null,
			iaSecNumber: controlRecord?.iaSECNumber || controlRecord?.iaSecNumber || existingFirmNode?.iaSecNumber || null,
		};

		const applyControlMeta = (link) => {
			if (!link) return false;
			let changed = false;
			for (const [key, value] of Object.entries(controlMeta)) {
				if (value == null || value === '') continue;
				if (key === 'firmName') {
					if (!link[key] || String(link[key]).length < String(value).length) {
						link[key] = value;
						changed = true;
					}
					continue;
				}
				if (link[key] == null || link[key] === '') {
					link[key] = value;
					changed = true;
				}
			}
			return changed;
		};

		const layoutControlLink = layoutLinks.find((link) => {
			const sourceId = link.source?.id ?? link.source;
			const targetId = link.target?.id ?? link.target;
			return sourceId === personId && targetId === firmNodeId && link.relationship === 'controls';
		});
		const pendingControlLink = newLinks.find((link) => {
			const sourceId = link.source?.id ?? link.source;
			const targetId = link.target?.id ?? link.target;
			return sourceId === personId && targetId === firmNodeId && link.relationship === 'controls';
		});
		const graphControlLink = graphData?.links?.find((link) => {
			const sourceId = link.source?.id ?? link.source;
			const targetId = link.target?.id ?? link.target;
			return sourceId === personId && targetId === firmNodeId && link.relationship === 'controls';
		});

		const updatedExistingControlLink = applyControlMeta(layoutControlLink) || applyControlMeta(pendingControlLink) || applyControlMeta(graphControlLink);
		updatedExistingControlData = updatedExistingControlData || updatedExistingControlLink;

		if (layoutControlLink || pendingControlLink) {
			if (updatedExistingControlData) {
				try {
					saveSession();
				} catch (e) {
					/* ignore */
				}
			}
			continue;
		}

		newLinks.push({
			source: personId,
			target: firmNodeId,
			relationship: 'controls',
			...controlMeta,
		});
	}

	if (!newNodes.length && !newLinks.length) {
		if (updatedExistingControlData) {
			try {
				saveSession();
			} catch (e) {
				/* ignore */
			}
		}
		return;
	}
	appendFetched(newNodes, newLinks);
	mergeIntoGraphData(newNodes, newLinks);
}

function syncFirmConnectionsFromDetail(firmNode, detail) {
	if (!firmNode || !detail) return;

	const firmNodeId = firmNode.id;
	const newNodes = [];
	const newLinks = [];
	const owners = detail.directOwners || detail.owners || [];

	for (const owner of owners) {
		const personId = String(owner?.crdNumber || owner?.crd || owner?.personId || '').trim();
		if (!personId) continue;

		const personNodeId = `person:${personId}`;
		if (!layoutNodes.some((node) => node.id === personNodeId) && !newNodes.some((node) => node.id === personNodeId)) {
			newNodes.push({
				id: personNodeId,
				label: normalizePersonLabel(owner?.legalName || owner?.name || `Person ${personId}`),
				group: 'individual',
				crd: personId,
				bcScope: owner?.bcScope || null,
				stub: true,
			});
		}

		const hasLayoutLink = layoutLinks.some((link) => {
			const sourceId = link.source?.id ?? link.source;
			const targetId = link.target?.id ?? link.target;
			return sourceId === personNodeId && targetId === firmNodeId && link.relationship === 'controls';
		});
		const hasPendingLink = newLinks.some((link) => {
			const sourceId = link.source?.id ?? link.source;
			const targetId = link.target?.id ?? link.target;
			return sourceId === personNodeId && targetId === firmNodeId && link.relationship === 'controls';
		});
		if (hasLayoutLink || hasPendingLink) continue;

		newLinks.push({
			source: personNodeId,
			target: firmNodeId,
			relationship: 'controls',
			position: owner?.position || null,
		});
	}

	if (!newNodes.length && !newLinks.length) return;
	appendFetched(newNodes, newLinks);
	mergeIntoGraphData(newNodes, newLinks);
}

// Fetch firm detail from the server (which checks local cache first, then FINRA API).
// Merges the response into the firm node so renderFirmDetail can display rich data.
async function ensureFirmDetail(firmNode) {
	if (!firmNode || firmNode.group !== 'firm') return;

	// Support both "firm:12345", legacy "firm_12345", and bare numeric ids
	const match = firmNode.id.match(/^(?:firm[:_])?(\d+)$/);
	if (!match) return;
	const firmId = match[1];

	if (firmNode._detailLoaded && firmNode._detailValidated === true) return;

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
			console.info(`Local API missing data for firm ${firmId}; skipping direct browser fallback to external APIs to avoid CORS/rate-limit failures.`);
		}

		if (!detail || (detail.found === false && !detail.basicInformation && !detail.firmName)) {
			console.debug(`Firm ${firmId} not found`);
			return;
		}

		const bi = detail?.basicInformation || {};
		const preferredFirmName = String(bi.firmName || detail?.firmName || detail?.name || '').trim();
		if (preferredFirmName && (isPlaceholderExpansionLabel(firmNode.label, 'firm') || preferredFirmName.length > String(firmNode.label || '').length)) {
			firmNode.label = preferredFirmName;
		}
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
		if (detail.hasFinraData != null) firmNode.hasFinraData = detail.hasFinraData;
		if (detail.hasSecData != null) firmNode.hasSecData = detail.hasSecData;
		if (typeof detail.secSummaryDescription === 'string') {
			firmNode.secSummaryDescription = detail.secSummaryDescription;
		}
		if (Array.isArray(detail.secDocumentLinks)) {
			firmNode.secDocumentLinks = detail.secDocumentLinks;
		}
		if (detail.hasSecData === false) {
			firmNode.secSummaryDescription = '';
			firmNode.secDocumentLinks = [];
		}

		// Address / phone
		const addr = detail.firmAddressDetails || detail.iaFirmAddressDetails;
		if (addr) {
			const off = addr.officeAddress || {};
			const parts = [off.street1, off.city, off.state, off.postalCode, off.country].filter(Boolean);
			if (parts.length) firmNode.officeAddress = parts.join(', ');
			if (addr.businessPhoneNumber) firmNode.businessPhone = addr.businessPhoneNumber;
		}

		// Remap disclosures from API shape {disclosureType, disclosureCount} → {type, count}
		if (Array.isArray(detail.disclosures) && detail.disclosures.length) {
			firmNode.disclosures = detail.disclosures.map((dis) => ({
				type: dis.disclosureType || dis.type || '',
				count: dis.disclosureCount ?? dis.count ?? 0,
			}));
		}
		if (Number.isFinite(detail.disclosureCount) || Number.isFinite(detail.disclosuresCount)) {
			firmNode.disclosureCount = Number(detail.disclosureCount ?? detail.disclosuresCount);
		}
		if (detail.disclosureFlag != null) {
			firmNode.disclosureFlag = detail.disclosureFlag;
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
			firmNode.activeStates = reg.stateList.map((s) => (typeof s === 'string' ? s : s.state || JSON.stringify(s)));
		}
		if (Array.isArray(reg.SROList) && reg.SROList.length) {
			firmNode.selfRegulatoryOrgs = reg.SROList.map((s) => (typeof s === 'string' ? s : s.sro || s.name || JSON.stringify(s)));
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
				.filter((f) => /Notice Filed|Approved/i.test(f.status || ''))
				.map((f) => f.jurisdiction)
				.filter(Boolean);
		}
		// brochures (Form ADV Part 2)
		if (detail.brochures?.brochuredetails?.length && !firmNode.brochures) {
			firmNode.brochures = detail.brochures.brochuredetails;
		}

		syncFirmConnectionsFromDetail(firmNode, detail);
		firmNode._detailLoaded = true;
		firmNode._detailValidated = true;
		console.log(`Firm detail loaded for ID ${firmId}: ${firmNode.disclosures?.length || 0} disclosures, ${firmNode.directOwners?.length || 0} owners`);
	} catch (err) {
		console.error(`Error fetching firm detail for ${firmId}:`, err);
	}
}

function anchorNode(node) {
	if (!node || !Number.isFinite(node.x) || !Number.isFinite(node.y)) return;
	node.fx = node.x;
	node.fy = node.y;
	if (simulation) {
		simulation.alphaTarget(0.05).restart();
	}
}

async function fetchExpansionDataForNodeIds(nodeIds: string[] = [], hops: number | 'all' = getDefaultExpansionHops()) {
	const uniqueIds = Array.from(new Set<string>(nodeIds.filter(Boolean)));
	if (!uniqueIds.length) return { nodes: [], links: [] };
	const normalizedHops = normalizeHighlightHops(hops);

	const results = await Promise.allSettled(
		uniqueIds.map(async (nodeId) => {
			const url = makeApiUrl(`/api/finra/expand/${encodeURIComponent(nodeId)}`);
			url.searchParams.set('hops', String(normalizedHops));
			const response = await fetch(url.toString());
			if (!response.ok) throw new Error(`expand ${nodeId} HTTP ${response.status}`);
			return response.json();
		}),
	);

	const mergedNodes = [];
	const mergedLinks = [];
	results.forEach((result) => {
		if (result.status !== 'fulfilled' || !result.value) return;
		mergedNodes.push(...(result.value.nodes || []));
		mergedLinks.push(...(result.value.links || []));
	});

	return { nodes: mergedNodes, links: mergedLinks };
}

async function hydrateExpansionFrontierNodes(nodeIds: string[] = []) {
	const uniqueIds = Array.from(new Set(nodeIds.filter(Boolean)));
	if (!uniqueIds.length) return [];

	const hydratedIds = new Set<string>();
	for (let index = 0; index < uniqueIds.length; index += NON_GRAY_DETAIL_BATCH_SIZE) {
		const chunk = uniqueIds.slice(index, index + NON_GRAY_DETAIL_BATCH_SIZE);
		const results = await Promise.allSettled(
			chunk.map(async (nodeId) => {
				const liveNode = layoutNodes?.find((node) => node.id === nodeId) || graphData?.nodes?.find((node) => node.id === nodeId);
				if (!liveNode) return null;
				if (liveNode.group === 'individual') {
					await ensureIndividualDetail(liveNode);
				} else if (liveNode.group === 'firm') {
					await ensureFirmDetail(liveNode);
				} else {
					return null;
				}
				normalizeNodeLabelInPlace(liveNode);
				return liveNode.id;
			}),
		);

		results.forEach((result) => {
			if (result.status !== 'fulfilled' || !result.value) return;
			hydratedIds.add(result.value);
		});
	}

	const impactedIds = Array.from(hydratedIds);
	if (impactedIds.length) {
		rerenderGraphNodesByIds(impactedIds);
		refreshGraphColors();
		refreshTraceState();
		if (selectedId && impactedIds.includes(selectedId)) {
			const selectedNode = layoutNodes?.find((node) => node.id === selectedId) || graphData?.nodes?.find((node) => node.id === selectedId);
			if (selectedNode) {
				renderSidebar(selectedNode);
			}
		}
	}

	return impactedIds;
}

async function expandNodeThroughNonGrayHops(clickedNode, hops: number | 'all' = getDefaultExpansionHops()) {
	if (!clickedNode?.id || !graphData) return;

	const runId = ++nonGrayExpandRunId;
	lastExpandOriginNode = clickedNode;
	const normalizedHops = normalizeHighlightHops(hops);
	const maxWaves = normalizedHops === 'all' ? 100 : Math.max(1, Number(normalizedHops) || 1);
	const visitedIds = new Set([clickedNode.id]);
	let frontierIds = [clickedNode.id];
	let waveCount = 0;

	while (frontierIds.length && waveCount < maxWaves) {
		waveCount += 1;
		await hydrateExpansionFrontierNodes(frontierIds);
		if (runId !== nonGrayExpandRunId) return;
		await fetchExpansionDataForNodeIds(frontierIds, 1);
		if (runId !== nonGrayExpandRunId) return;

		const adjacency = buildLinkAdjacency(graphData?.links || [], isNonGrayExpansionLink);
		const nextIds = [];
		frontierIds.forEach((frontierId) => {
			(adjacency.get(frontierId) || []).forEach(({ nodeId }) => {
				if (visitedIds.has(nodeId)) return;
				visitedIds.add(nodeId);
				nextIds.push(nodeId);
			});
		});

		const uniqueNextIds = Array.from(new Set(nextIds));
		if (!uniqueNextIds.length) break;

		const renderedIds = new Set((layoutNodes || []).map((node) => node.id));
		const hiddenIds = uniqueNextIds.filter((nodeId) => !renderedIds.has(nodeId));
		if (hiddenIds.length) {
			revealNeighbors(clickedNode, 'all', {
				linkFilter: isNonGrayExpansionLink,
				restrictToIds: new Set(hiddenIds),
				markSelected: true,
			});
			if (runId !== nonGrayExpandRunId) return;

			spreadNeighbors(clickedNode, new Set(hiddenIds), { duration: NON_GRAY_HOP_ANIMATION_MS });
			await delay(NON_GRAY_HOP_DELAY_MS);
			if (runId !== nonGrayExpandRunId) return;
		}

		frontierIds = uniqueNextIds;
	}

	refreshTraceState({ deferMs: 120 });
	try {
		saveSession();
	} catch (e) {
		/* ignore */
	}
}

function getExpansionNodeMatchLabel(node) {
	if (!node) return '';
	const basic = node.basicInformation || {};
	return String(node.label || basic.name || [basic.firstName, basic.middleName, basic.lastName].filter(Boolean).join(' ') || '').trim();
}

function isPlaceholderExpansionLabel(label, group) {
	const text = String(label || '').trim();
	if (!text) return true;
	if (/^\d+$/.test(text)) return true;
	if (/^\d+-\d+$/.test(text)) return true;
	if (/^(?:crd|sec)#?\s*\d+$/i.test(text)) return true;
	if (/^(?:crd|sec)\s*#?:?\s*\d+-?\d*$/i.test(text)) return true;
	if (/^8-\d+$/i.test(text)) return true;
	if (group === 'individual') {
		return /^CRD\s+#?:?\s*\d+$/i.test(text) || /^Person\s+\d+$/i.test(text);
	}
	if (group === 'firm') {
		return /^Firm\s+\d+$/i.test(text) || /^SEC\s+#?:?\s*8?-?\d+$/i.test(text);
	}
	return false;
}

function firstMeaningfulText(...values) {
	for (const value of values) {
		const text = String(value || '').trim();
		if (text) return text;
	}
	return '';
}

function getSourceBackedIndividualName(node) {
	const source = node?._source || {};
	return normalizePersonLabel(
		[source.firstName, source.middleName, source.lastName, source.ind_firstname, source.ind_middlename, source.ind_lastname].filter(Boolean).join(' ') ||
			firstMeaningfulText(source.name, source.legalName, source.personName, source.individualName),
	);
}

function getSourceBackedFirmName(node) {
	const source = node?._source || {};
	return firstMeaningfulText(
		source.firm_name,
		source.firmName,
		source.organizationName,
		source.organization_name,
		source.legalName,
		source.name,
		source.companyName,
		source.displayName,
	);
}

function getPreferredNodeLabel(node) {
	if (!node) return '';
	const basic = node.basicInformation || {};
	if (node.group === 'individual') {
		const personName = normalizePersonLabel(
			[basic.firstName, basic.middleName, basic.lastName].filter(Boolean).join(' ') ||
				firstMeaningfulText(basic.name, node.name, node.legalName, node.personName, node.displayName, getSourceBackedIndividualName(node)),
		);
		if (personName && (isPlaceholderExpansionLabel(node.label, 'individual') || personName.length >= String(node.label || '').length)) {
			return personName;
		}
	}
	if (node.group === 'firm') {
		const firmName = firstMeaningfulText(
			basic.firmName,
			basic.name,
			node.firmName,
			node.name,
			node.organizationName,
			node.organization_name,
			node.legalName,
			node.companyName,
			node.displayName,
			getSourceBackedFirmName(node),
		);
		if (firmName && (isPlaceholderExpansionLabel(node.label, 'firm') || firmName.length >= String(node.label || '').length)) {
			return firmName;
		}
	}
	return firstMeaningfulText(node.label, basic.name, node.name, node.legalName, node.organizationName, node.displayName);
}

function clipFirmLabelAtWord(label, maxChars = 44) {
	const text = formatNodeLabel(label);
	if (!text || text.length <= maxChars) return text;
	const clipped = text.slice(0, maxChars + 1);
	const lastBoundary = Math.max(clipped.lastIndexOf(' '), clipped.lastIndexOf('/'), clipped.lastIndexOf('-'));
	if (lastBoundary > Math.floor(maxChars * 0.6)) {
		return clipped.slice(0, lastBoundary).trim();
	}
	return text.slice(0, maxChars).trim();
}

function getRenderedNodeLabel(node) {
	const preferredLabel = getPreferredNodeLabel(node);
	if (!preferredLabel) return '';
	if (isPlaceholderExpansionLabel(preferredLabel, node?.group)) return '';
	if (node?.group === 'firm') {
		const clippedLabel = clipFirmLabelAtWord(preferredLabel);
		return isPlaceholderExpansionLabel(clippedLabel, node?.group) ? '' : clippedLabel;
	}
	const formattedLabel = formatNodeLabel(preferredLabel);
	return isPlaceholderExpansionLabel(formattedLabel, node?.group) ? '' : formattedLabel;
}

function normalizeNodeLabelInPlace(node) {
	if (!node || typeof node !== 'object') return node;
	const preferredLabel = getPreferredNodeLabel(node);
	if (preferredLabel && preferredLabel !== node.label) {
		node.label = preferredLabel;
	}
	return node;
}

function normalizeNodeLabelsInPlace(nodes = []) {
	(nodes || []).forEach((node) => {
		normalizeNodeLabelInPlace(node);
	});
	return nodes;
}

function mergeExpansionNodeIntoExistingNode(targetNodeId, incomingNode) {
	if (!targetNodeId || !incomingNode) return;
	const targets = [layoutNodes?.find((node) => node.id === targetNodeId), graphData?.nodes?.find((node) => node.id === targetNodeId)].filter(Boolean);
	const incomingLabel = getExpansionNodeMatchLabel(incomingNode);

	targets.forEach((targetNode) => {
		Object.entries(incomingNode).forEach(([key, value]) => {
			if (key === 'id' || key.startsWith('_') || value == null) return;
			if (key === 'label') {
				if (incomingLabel && (isPlaceholderExpansionLabel(targetNode.label, targetNode.group) || String(incomingLabel).length > String(targetNode.label || '').length)) {
					targetNode.label = incomingLabel;
				}
				return;
			}
			if (Array.isArray(value)) {
				if (!Array.isArray(targetNode[key]) || targetNode[key].length === 0) {
					targetNode[key] = value.slice();
				}
				return;
			}
			if (typeof value === 'object') {
				if (!targetNode[key]) {
					targetNode[key] = { ...value };
				}
				return;
			}
			if (!targetNode[key]) {
				targetNode[key] = value;
			}
		});
	});
}

function findRenderedExpansionMatch(node, renderedNodeById = new Map<string, any>()) {
	if (!node || !Array.isArray(layoutNodes) || !layoutNodes.length) return null;
	const exactMatch = renderedNodeById.get(node.id);
	if (exactMatch) return exactMatch;

	if (node.group === 'individual') {
		const crd = String(node.crd || node.basicInformation?.individualId || '').trim();
		if (crd) {
			const existingPerson = findExistingPersonNode(crd);
			if (existingPerson) return existingPerson;
		}
		const comparableName = normalizeComparableName(getExpansionNodeMatchLabel(node));
		if (comparableName) {
			return layoutNodes.find((entry) => entry.group === 'individual' && normalizeComparableName(getExpansionNodeMatchLabel(entry)) === comparableName) || null;
		}
		return null;
	}

	if (node.group === 'firm') {
		const firmId = String(node.firmId || node.basicInformation?.firmId || '').trim();
		const firmLabel = getExpansionNodeMatchLabel(node);
		const existingFirm = findExistingFirmNode(firmId, { label: firmLabel });
		if (existingFirm) return existingFirm;
		if (firmLabel) {
			return findFirmNodeByLabel(firmLabel);
		}
		return null;
	}

	const comparableName = normalizeComparableName(getExpansionNodeMatchLabel(node));
	if (!comparableName) return null;
	return layoutNodes.find((entry) => entry.group === node.group && normalizeComparableName(getExpansionNodeMatchLabel(entry)) === comparableName) || null;
}

function normalizeExpansionPayloadToRenderedMatches(clickedNodeId, nodes = [], links = []) {
	const renderedNodeById = new Map<string, any>((layoutNodes || []).map((node) => [node.id, node]));
	const renderedIds = new Set(renderedNodeById.keys());
	const nodeById = new Map<string, any>((nodes || []).map((node) => [node.id, node]));
	const remappedIds = new Map<string, string>();

	(nodes || []).forEach((node) => {
		const match = findRenderedExpansionMatch(node, renderedNodeById);
		if (!match?.id) return;
		remappedIds.set(node.id, match.id);
		mergeExpansionNodeIntoExistingNode(match.id, node);
	});

	const adjacency = new Map<string, Set<string>>();
	(links || []).forEach((link) => {
		const sourceId = link.source?.id ?? link.source;
		const targetId = link.target?.id ?? link.target;
		if (!sourceId || !targetId) return;
		if (!adjacency.has(sourceId)) adjacency.set(sourceId, new Set());
		if (!adjacency.has(targetId)) adjacency.set(targetId, new Set());
		adjacency.get(sourceId).add(targetId);
		adjacency.get(targetId).add(sourceId);
	});

	const rootId = String(clickedNodeId || '').trim();
	const dist = new Map<string, number>();
	const parentById = new Map<string, string | null>();
	if (rootId) {
		dist.set(rootId, 0);
		parentById.set(rootId, null);
		const queue = [rootId];
		for (let index = 0; index < queue.length; index += 1) {
			const currentId = queue[index];
			(adjacency.get(currentId) || []).forEach((neighborId) => {
				if (dist.has(neighborId)) return;
				dist.set(neighborId, (dist.get(currentId) || 0) + 1);
				parentById.set(neighborId, currentId);
				queue.push(neighborId);
			});
		}
	}

	const targetIds = new Set<string>();
	(remappedIds.size ? Array.from(remappedIds.entries()) : []).forEach(([originalId, renderedId]) => {
		if (!originalId || !renderedId || renderedId === rootId) return;
		if (dist.has(originalId)) targetIds.add(originalId);
	});
	(links || []).forEach((link) => {
		const sourceId = link.source?.id ?? link.source;
		const targetId = link.target?.id ?? link.target;
		if (sourceId && renderedIds.has(sourceId) && sourceId !== rootId && dist.has(sourceId)) targetIds.add(sourceId);
		if (targetId && renderedIds.has(targetId) && targetId !== rootId && dist.has(targetId)) targetIds.add(targetId);
	});

	const includedOriginalIds = new Set<string>();
	targetIds.forEach((targetId) => {
		let cursor = targetId;
		while (cursor && cursor !== rootId) {
			const remappedTargetId = remappedIds.get(cursor);
			if (!renderedIds.has(cursor) && !remappedTargetId) {
				includedOriginalIds.add(cursor);
			}
			cursor = parentById.get(cursor) || null;
		}
	});

	const allowedOriginalIds = new Set<string>([rootId, ...includedOriginalIds, ...targetIds].filter(Boolean));
	const normalizedNodes = Array.from(includedOriginalIds)
		.map((id) => nodeById.get(id))
		.filter(Boolean)
		.filter((node) => !renderedIds.has(node.id));

	const normalizedLinks = [];
	const seenLinkKeys = new Set<string>();
	(links || []).forEach((link) => {
		const sourceId = link.source?.id ?? link.source;
		const targetId = link.target?.id ?? link.target;
		if (!allowedOriginalIds.has(sourceId) || !allowedOriginalIds.has(targetId)) return;
		const remappedSourceId = remappedIds.get(sourceId) || (renderedIds.has(sourceId) ? sourceId : null);
		const remappedTargetId = remappedIds.get(targetId) || (renderedIds.has(targetId) ? targetId : null);
		const finalSourceId = remappedSourceId || (includedOriginalIds.has(sourceId) ? sourceId : null);
		const finalTargetId = remappedTargetId || (includedOriginalIds.has(targetId) ? targetId : null);
		if (!finalSourceId || !finalTargetId || finalSourceId === finalTargetId) return;
		const normalizedLink = {
			...link,
			source: finalSourceId,
			target: finalTargetId,
		};
		const linkKey = getLinkKey(normalizedLink);
		if (seenLinkKeys.has(linkKey)) return;
		seenLinkKeys.add(linkKey);
		normalizedLinks.push(normalizedLink);
	});

	return { nodes: normalizedNodes, links: normalizedLinks };
}

async function ensureExpansionDataForNode(
	clickedNodeId,
	hops: number | 'all' = getDefaultExpansionHops(),
	options: {
		matchExistingOnly?: boolean;
	} = {},
) {
	if (!clickedNodeId) return { nodes: [], links: [] };
	const { matchExistingOnly = false } = options;
	const fetched = await fetchExpansionDataForNodeIds([clickedNodeId], hops);
	const normalized = matchExistingOnly ? normalizeExpansionPayloadToRenderedMatches(clickedNodeId, fetched.nodes, fetched.links) : fetched;
	if (normalized.nodes.length || normalized.links.length) {
		mergeIntoGraphData(normalized.nodes, normalized.links);
	}
	return normalized;
}

async function handleNodeOpen(event, d) {
	event.stopPropagation();
	markUserInitiatedGraphExpansion();
	anchorNode(d);
	selectNode(d, { skipAutoExpand: true });
	void expandNodeThroughNonGrayHops(d).catch((err) => {
		console.error('Progressive non-gray hop expansion failed:', err);
		refreshTraceState({ deferMs: 120 });
	});
	void fetchCacheStats();
}

function selectNode(
	d,
	options: {
		persist?: boolean;
		skipProfileSync?: boolean;
		skipAutoExpand?: boolean;
		focus?: boolean;
		pulse?: boolean;
		focusDuration?: number;
		syncRoute?: boolean;
	} = {},
) {
	const { persist = true, skipProfileSync = false, skipAutoExpand = false, focus = false, pulse = false, focusDuration = 600, syncRoute = true } = options;
	if (selectionRestoreTimer) {
		clearTimeout(selectionRestoreTimer);
		selectionRestoreTimer = null;
	}

	const hops = getDefaultSelectionHops();
	upsertHighlightedSelection(d.id, hops);
	selectedId = d.id;
	if (syncRoute) {
		emitSelectedNodeRoute(d.id);
	}
	addToSelectionLog(d);
	refreshTraceState();
	renderSidebar(d);
	if (persist) {
		try {
			saveSession();
		} catch (e) {
			/* ignore */
		}
	}

	// Add the selected node to the seed profile
	const rawId = d.id.split(':').pop();
	const parsedId = rawId && !isNaN(rawId) ? parseInt(rawId, 10) : null;
	if (parsedId && !skipProfileSync) {
		const data = d.group === 'individual' ? { individuals: [parsedId] } : { firms: [parsedId] };
		syncProfileSelection(data);
	}

	if (focus) {
		focusNodeById(d.id, { duration: focusDuration, pulse });
	} else if (pulse) {
		pulseNodeHighlightById(d.id);
	}

	// For individual nodes, fetch detail data from API and re-render if it's still selected
	if (d.group === 'individual') {
		ensureIndividualDetail(d)
			.then(() => {
				// Re-render sidebar if this node is still selected
				if (selectedId === d.id) {
					renderSidebar(d);
				}
			})
			.catch((err) => {
				console.error('Failed to load individual detail:', err);
			});
	}

	// For firm nodes, fetch Form BD detail (local first, then FINRA API) and re-render
	if (d.group === 'firm') {
		ensureFirmDetail(d)
			.then(() => {
				if (selectedId === d.id) {
					renderSidebar(d);
				}
			})
			.catch((err) => {
				console.error('Failed to load firm detail:', err);
			});
	}

	if (!skipAutoExpand) {
		lastExpandOriginNode = d;
		expandNodeThroughNonGrayHops(d, getDefaultExpansionHops()).finally(() => {
			refreshTraceState({ deferMs: 120 });
			try {
				saveSession();
			} catch (e) {
				/* ignore */
			}
		});
	}
}

function getAlternatingSlotOffset(slotIndex) {
	if (!slotIndex) return 0;
	const step = Math.ceil(slotIndex / 2);
	return slotIndex % 2 === 0 ? -step : step;
}

function hashAngleSeed(value) {
	let hash = 0;
	const text = String(value || '');
	for (let i = 0; i < text.length; i += 1) {
		hash = (hash * 31 + text.charCodeAt(i)) % 360;
	}
	return (hash * Math.PI) / 180;
}

function getRevealPlacementRadius(node) {
	const isLargeLayout = (layoutNodes?.length || 0) > 300;
	const baseRadius = node?._vizHalf != null ? node._vizHalf : NODE_R[node?.group] || 10;
	return baseRadius + (isLargeLayout ? 34 : 26);
}

function getAnchorDistanceLimit(hopDistance) {
	const hop = Math.max(1, Number(hopDistance) || 1);
	return Math.min(210, 138 + (hop - 1) * 26);
}

function projectWithinAnchorRadius(candidate, anchorNode, maxDistanceFromAnchor) {
	if (!anchorNode || !Number.isFinite(anchorNode.x) || !Number.isFinite(anchorNode.y)) {
		return candidate;
	}
	const dx = candidate.x - anchorNode.x;
	const dy = candidate.y - anchorNode.y;
	const dist = Math.hypot(dx, dy) || 1;
	if (dist <= maxDistanceFromAnchor) return candidate;
	return {
		x: anchorNode.x + (dx / dist) * maxDistanceFromAnchor,
		y: anchorNode.y + (dy / dist) * maxDistanceFromAnchor,
	};
}

function measureRevealOverlap(candidate, candidateRadius, occupiedNodes) {
	let overlapScore = 0;
	for (const occupied of occupiedNodes) {
		if (!Number.isFinite(occupied?.x) || !Number.isFinite(occupied?.y)) continue;
		const otherRadius = occupied._placementRadius || getRevealPlacementRadius(occupied);
		const minSeparation = candidateRadius + otherRadius;
		const dist = Math.hypot(candidate.x - occupied.x, candidate.y - occupied.y);
		if (dist < minSeparation) {
			overlapScore += minSeparation - dist;
		}
	}
	return overlapScore;
}

function placeNodesNearConnections(anchorNode, nodesToPlace, candidateLinks, hopDistances) {
	if (!anchorNode || !Array.isArray(nodesToPlace) || !nodesToPlace.length) {
		return Array.isArray(nodesToPlace) ? nodesToPlace : [];
	}

	const liveNodeById = new Map<string, any>((layoutNodes || []).map((node) => [node.id, node]));
	const linksByNode = new Map<string, Set<string>>();
	(Array.isArray(candidateLinks) ? candidateLinks : []).forEach((link) => {
		const sourceId = link.source?.id ?? link.source;
		const targetId = link.target?.id ?? link.target;
		if (!sourceId || !targetId) return;
		if (!linksByNode.has(sourceId)) linksByNode.set(sourceId, new Set());
		if (!linksByNode.has(targetId)) linksByNode.set(targetId, new Set());
		linksByNode.get(sourceId).add(targetId);
		linksByNode.get(targetId).add(sourceId);
	});

	const placedNodeById = new Map<string, any>();
	const slotCounts = new Map<string, number>();
	const occupiedNodes = (layoutNodes || [])
		.filter((node) => Number.isFinite(node?.x) && Number.isFinite(node?.y))
		.map((node) => ({
			...node,
			_placementRadius: getRevealPlacementRadius(node),
		}));
	const orderedNodes = nodesToPlace
		.map((node) => ({
			...node,
			_hopDistance: Number(hopDistances?.get(node.id) || 1),
		}))
		.sort((a, b) => a._hopDistance - b._hopDistance || String(a.id).localeCompare(String(b.id)));

	return orderedNodes
		.map((node) => {
			const neighborIds = Array.from(linksByNode.get(node.id) || []);
			const liveAnchorCandidates = neighborIds.map((id) => liveNodeById.get(id)).filter((entry): entry is any => Boolean(entry));
			const anchorCandidates = neighborIds.map((id) => placedNodeById.get(id) || liveNodeById.get(id)).filter((entry): entry is any => Boolean(entry));
			const anchors = anchorCandidates.length ? anchorCandidates : [anchorNode];

			const centerX = anchors.reduce((sum, entry) => sum + (Number.isFinite(entry.x) ? entry.x : anchorNode.x || 0), 0) / Math.max(1, anchors.length);
			const centerY = anchors.reduce((sum, entry) => sum + (Number.isFinite(entry.y) ? entry.y : anchorNode.y || 0), 0) / Math.max(1, anchors.length);

			const sharedAnchorCount = Math.max(0, anchors.length - 1);
			const hopDistance = Math.max(1, node._hopDistance || 1);
			const anchorSpreadBoost = Math.min(95, getNodeScatterBoost(anchorNode, layoutNodes?.length || 0) * 0.6);
			const preferredDistance = 45 + (hopDistance - 1) * 20 + sharedAnchorCount * 10 + anchorSpreadBoost;
			const maxDistanceFromAnchor = Math.min(240, getAnchorDistanceLimit(hopDistance) + anchorSpreadBoost);
			const candidateRadius = getRevealPlacementRadius(node);

			let baseAngle = hashAngleSeed(node.id);
			if (anchors.length > 1) {
				const dx = centerX - (anchorNode.x || centerX);
				const dy = centerY - (anchorNode.y || centerY);
				if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
					baseAngle = Math.atan2(dy, dx);
				}
			} else if (anchors[0] && anchors[0].id !== anchorNode.id) {
				const dx = (anchors[0].x || centerX) - (anchorNode.x || centerX);
				const dy = (anchors[0].y || centerY) - (anchorNode.y || centerY);
				if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
					baseAngle = Math.atan2(dy, dx);
				}
			}

			const signature = [hopDistance, ...anchors.map((entry) => entry.id).sort()].join('|');
			const slotIndex = slotCounts.get(signature) || 0;
			slotCounts.set(signature, slotIndex + 1);

			let bestCandidate = null;
			let bestScore = Infinity;
			let foundPerfectCandidate = false;
			for (let ring = 0; ring < 4; ring += 1) {
				const ringDistance = Math.min(maxDistanceFromAnchor, preferredDistance + ring * 16);
				for (let offsetIndex = 0; offsetIndex < 14; offsetIndex += 1) {
					const angle = baseAngle + (getAlternatingSlotOffset(slotIndex + offsetIndex) * Math.PI) / 10;
					const projected = projectWithinAnchorRadius(
						{
							x: centerX + Math.cos(angle) * ringDistance,
							y: centerY + Math.sin(angle) * ringDistance,
						},
						anchorNode,
						maxDistanceFromAnchor,
					);
					const overlapScore = measureRevealOverlap(projected, candidateRadius, occupiedNodes);
					const anchorDistance = Math.hypot(projected.x - (anchorNode.x || projected.x), projected.y - (anchorNode.y || projected.y));
					const score = overlapScore * 1000 + Math.abs(anchorDistance - preferredDistance);
					if (score < bestScore) {
						bestCandidate = projected;
						bestScore = score;
					}
					if (overlapScore === 0) {
						foundPerfectCandidate = true;
						break;
					}
				}
				if (foundPerfectCandidate) {
					break;
				}
			}

			let expandedFromId = null;
			if (liveAnchorCandidates.some((entry) => entry.id === anchorNode.id)) {
				expandedFromId = anchorNode.id;
			} else if (liveAnchorCandidates.length === 1) {
				expandedFromId = liveAnchorCandidates[0].id;
			} else if (liveAnchorCandidates.length > 1) {
				const closestLiveAnchor = liveAnchorCandidates
					.map((entry) => ({
						id: entry.id,
						distance: Math.hypot((Number.isFinite(entry.x) ? entry.x : centerX) - centerX, (Number.isFinite(entry.y) ? entry.y : centerY) - centerY),
					}))
					.sort((a, b) => a.distance - b.distance)[0];
				expandedFromId = closestLiveAnchor?.id || null;
			}

			const { _hopDistance, ...rest } = node;
			const placedNode = {
				...rest,
				x: bestCandidate?.x ?? centerX,
				y: bestCandidate?.y ?? centerY,
				...(expandedFromId ? { _expandedFromId: expandedFromId } : {}),
				_placementRadius: candidateRadius,
			};

			placedNodeById.set(placedNode.id, placedNode);
			occupiedNodes.push(placedNode);
			return placedNode;
		})
		.map(({ _placementRadius, ...node }) => node);
}

function getRevealParentNodeId(clickedNode, renderedIds) {
	if (!clickedNode || !renderedIds) return null;

	const explicitParentId = clickedNode._expandedFromId;
	if (explicitParentId && renderedIds.has(explicitParentId)) {
		return explicitParentId;
	}

	const renderedNeighbors = (graphData?.links || [])
		.map((link) => {
			const sourceId = link.source?.id ?? link.source;
			const targetId = link.target?.id ?? link.target;
			if (sourceId === clickedNode.id && renderedIds.has(targetId)) {
				return layoutNodes.find((node) => node.id === targetId) || null;
			}
			if (targetId === clickedNode.id && renderedIds.has(sourceId)) {
				return layoutNodes.find((node) => node.id === sourceId) || null;
			}
			return null;
		})
		.filter(Boolean);

	if (renderedNeighbors.length === 1) {
		return renderedNeighbors[0].id;
	}

	if (!renderedNeighbors.length) {
		return null;
	}

	const clickedX = Number.isFinite(clickedNode.x) ? clickedNode.x : 0;
	const clickedY = Number.isFinite(clickedNode.y) ? clickedNode.y : 0;
	return (
		renderedNeighbors
			.map((node) => ({
				id: node.id,
				distance: Math.hypot((Number.isFinite(node.x) ? node.x : clickedX) - clickedX, (Number.isFinite(node.y) ? node.y : clickedY) - clickedY),
			}))
			.sort((a, b) => a.distance - b.distance)[0]?.id || null
	);
}

// Fetch the configured neighbourhood of `clickedNode` from the server's full graph,
// merge any new nodes/links into the local graphData, then call revealNeighbors.
async function expandFromServer(
	clickedNode,
	hops: number | 'all' = getDefaultExpansionHops(),
	options: {
		matchExistingOnly?: boolean;
		markSelected?: boolean;
	} = {},
) {
	const normalizedHops = normalizeHighlightHops(hops);
	if (!hasUserInitiatedGraphExpansion && normalizedHops !== 1) {
		return;
	}
	const { matchExistingOnly = false, markSelected = false } = options;
	let expansionPayload = { nodes: [], links: [] };
	try {
		expansionPayload = await ensureExpansionDataForNode(clickedNode?.id, normalizedHops, { matchExistingOnly });
	} catch {
		// non-critical — fall back to whatever is already in graphData
	}
	const expansionLinkKeys = new Set((expansionPayload.links || []).map((link) => getLinkKey(link)));
	const expansionNodeIds = new Set((expansionPayload.nodes || []).map((node) => node.id).filter(Boolean));
	revealNeighbors(clickedNode, normalizedHops, {
		restrictToIds: matchExistingOnly ? expansionNodeIds : null,
		linkFilter: expansionLinkKeys.size > 0 ? (link) => expansionLinkKeys.has(getLinkKey(link)) : null,
		markSelected,
	});
}

async function expandLoadedSeedNodes() {
	if (!layoutNodes || !graphData) return;
	const seedIds = new Set(layoutNodes.filter((n) => n.group === 'individual' || n.group === 'firm').map((n) => n.id));
	for (const node of layoutNodes) {
		if (!seedIds.has(node.id)) continue;
		await expandFromServer(node, getDefaultExpansionHops(), { markSelected: true });
	}
}

// Bring any hidden neighbors (present in graphData but not yet rendered) into
// the live graph without a full re-render.
function revealNeighbors(
	clickedNode,
	hops: number | 'all' = 1,
	options: {
		linkFilter?: ((link: any) => boolean) | null;
		restrictToIds?: Set<string> | null;
		markSelected?: boolean;
	} = {},
) {
	if (!graphData || !layoutNodes || !layoutLinks || !nodeGroup || !linkGroup) return;
	const { linkFilter = null, restrictToIds = null, markSelected = false } = options;

	const renderedIds = new Set(layoutNodes.map((n) => n.id));
	const parentNodeId = getRevealParentNodeId(clickedNode, renderedIds);

	// Build adjacency from the full graph data (cached per call)
	const adj = new Map<string, Set<string>>();
	graphData.nodes.forEach((n) => adj.set(n.id, new Set<string>()));
	const candidateLinks = (graphData.links || []).filter((link) => (typeof linkFilter === 'function' ? linkFilter(link) : true));
	candidateLinks.forEach((l) => {
		const srcId = l.source?.id ?? l.source;
		const tgtId = l.target?.id ?? l.target;
		if (!adj.has(srcId)) adj.set(srcId, new Set());
		if (!adj.has(tgtId)) adj.set(tgtId, new Set());
		adj.get(srcId).add(tgtId);
		adj.get(tgtId).add(srcId);
	});

	// BFS to collect ids up to `hops` away; hops === 'all' means unlimited
	const dist = new Map<string, number>();
	const q: string[] = [clickedNode.id];
	dist.set(clickedNode.id, 0);
	for (let i = 0; i < q.length; i++) {
		const id = q[i];
		const d = dist.get(id);
		if (hops !== 'all' && d >= hops) continue;
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
	const hiddenIds = Array.from(dist.keys()).filter((id) => !renderedIds.has(id) && (!restrictToIds || restrictToIds.has(id)));

	// Create new node objects with positions based on hop distance
	const newNodes =
		hiddenIds.length > 0 ?
			placeNodesNearConnections(
				clickedNode,
				graphData.nodes.filter((n) => hiddenIds.includes(n.id)),
				candidateLinks,
				dist,
			)
		:	[];

	// Now include any links that connect these newly-rendered nodes to the now-rendered set
	const nowRenderedIds = new Set([...renderedIds, ...newNodes.map((n) => n.id)]);
	const newLinks = candidateLinks
		.filter((l) => {
			const srcId = l.source?.id ?? l.source;
			const tgtId = l.target?.id ?? l.target;
			if (!nowRenderedIds.has(srcId) || !nowRenderedIds.has(tgtId)) return false;
			const alreadyHas = layoutLinks.some((el) => {
				const es = el.source?.id ?? el.source;
				const et = el.target?.id ?? el.target;
				return es === srcId && et === tgtId;
			});
			return !alreadyHas;
		})
		.map((l) => ({ ...l }));

	const liveClickedNode = markSelected && clickedNode?.id ? layoutNodes.find((node) => node.id === clickedNode.id) || clickedNode : null;
	if (markSelected && liveClickedNode) {
		markNodeSelected(liveClickedNode, { persist: false });
	}

	if (newNodes.length === 0 && newLinks.length === 0) {
		if (markSelected && liveClickedNode) {
			try {
				saveSession();
			} catch (e) {
				/* ignore */
			}
		}
		return;
	}

	// Push into live arrays
	layoutNodes.push(...newNodes);
	layoutLinks.push(...newLinks);
	applyGraphDerivedNodeMetrics(layoutNodes, layoutLinks);

	// Add revealed nodes to seed profile for persistence
	const individuals = newNodes
		.filter((n) => n.group === 'individual')
		.map((n) => Number(String(n.id).split(':').pop()))
		.filter(Number.isFinite);
	const firms = newNodes
		.filter((n) => n.group === 'firm')
		.map((n) => Number(String(n.id).split(':').pop()))
		.filter(Number.isFinite);
	if (individuals.length || firms.length) {
		syncProfileSelection({ individuals, firms });
	}

	// Rebuild neighbor cache for the live layout
	neighborMap = buildNeighborMap(layoutNodes, layoutLinks);

	// Update the subset info to reflect newly-visible nodes
	if (graphData) updateSubsetInfo(layoutNodes.length, graphData.nodes.length);

	// Append new link <line> elements
	const allLinks = linkGroup.selectAll('line').data(layoutLinks, (d) => {
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
		.append('line')
		.attr('class', 'fg-link')
		.attr('stroke', (d) => getLinkColor(d))
		.attr('stroke-opacity', 0)
		.attr('stroke-width', (d) => getLinkWidth(d))
		.attr('stroke-dasharray', (d) => getLinkDash(d))
		.attr('marker-end', (d) => getLinkMarker(d));
	enteredLinks.transition().duration(800).attr('stroke-opacity', defaultLinkOpacity);
	linkSel = linkGroup.selectAll('line');

	const allNodes = nodeGroup.selectAll('g.fg-node').data(layoutNodes, (d) => d.id);
	const enteredNodes = allNodes.enter().append('g').attr('class', 'fg-node').attr('opacity', 0).call(fluidDrag()).on('click', handleNodeOpen);

	enteredNodes.transition().duration(800).attr('opacity', 1);
	nodeSel = nodeGroup.selectAll('g.fg-node');
	rerenderGraphNodesByIds(getImpactedNodeIds(newNodes, newLinks));

	refreshGraphColors();
	refreshTraceState();

	simulation.on('tick', () => {
		linkSel
			.attr('x1', (d) => d.source.x)
			.attr('y1', (d) => d.source.y)
			.attr('x2', (d) => d.target.x)
			.attr('y2', (d) => d.target.y);
		nodeSel.attr('transform', (d) => `translate(${d.x},${d.y})`);
	});

	simulation.nodes(layoutNodes);
	simulation.force('link').links(layoutLinks);
	simulation.force('collision').radius((d) => getNodeCollisionRadius(d, layoutNodes.length));

	// Low-energy restart — prevents nodes from exploding outward while preserving fluid motion
	simulation.alpha(getIncrementalRestartAlpha(layoutNodes.length, newNodes.length)).restart();

	// Persist session so reload restores these nodes
	saveSession();

	// Update tick handler to cover new selections
	simulation.on('tick', () => {
		linkSel
			.attr('x1', (d) => d.source.x)
			.attr('y1', (d) => d.source.y)
			.attr('x2', (d) => d.target.x)
			.attr('y2', (d) => d.target.y);
		nodeSel.attr('transform', (d) => `translate(${d.x},${d.y})`);
	});

	// Persist session so reload restores these revealed neighbors
	try {
		saveSession();
	} catch (e) {
		/* ignore */
	}
}

function showSidebarHint(options: { keepOpen?: boolean } = {}) {
	const persistentPin = isSidebarPersistentlyPinned();
	const { keepOpen = persistentPin } = options;
	const inner = document.getElementById('fg-sidebar-inner');
	if (inner) inner.innerHTML = ` `;
	const side = document.getElementById('fg-sidebar');
	if (side) {
		side.dataset.displayedId = '';
		side.dataset.viewMode = 'none';
		side.dataset.mobileExpanded = 'false';
		side.dataset.temporarilyPinned = 'false';
		side.dataset.persistentPinned = persistentPin ? 'true' : 'false';
		if (keepOpen) {
			side.classList.remove('hidden');
		} else {
			side.classList.add('hidden');
		}
	}
	const backdrop = document.getElementById('fg-sidebar-backdrop');
	if (backdrop) {
		backdrop.dataset.temporarilyPinned = 'false';
		backdrop.dataset.persistentPinned = persistentPin ? 'true' : 'false';
		if (keepOpen) {
			backdrop.classList.remove('hidden');
		} else {
			backdrop.classList.add('hidden');
		}
	}
	const focusBtn = document.getElementById('fg-focus-btn') as HTMLButtonElement | null;
	if (focusBtn) focusBtn.disabled = true;
	try {
		updateShortDetail(null);
	} catch (e) {
		/* ignore */
	}
}

function updateShortDetail(d) {
	const el = document.getElementById('fg-short-detail');
	if (!el) return;
	if (!d) {
		el.textContent = '';
		return;
	}
	const id = d?.crd || d?.firmId || d?.id || '';
	const type = d?.group ? String(d.group).toUpperCase() : 'NODE';
	const label = getPreferredNodeLabel(d) || 'Selected node';
	const suffix = id ? ` • ${id}` : '';
	el.textContent = `${type}: ${label}${suffix}`;
}

function clearHighlights() {
	disableAllTraceModes();
	if (!nodeSel) return;
	clearFetchStatus();
	if (selectionRestoreTimer) {
		clearTimeout(selectionRestoreTimer);
		selectionRestoreTimer = null;
	}
	stopNodePulseLoop();
	highlightedSelections = [];
	reapplySelectionState();
	showSidebarHint({ keepOpen: true });
	try {
		saveSession();
	} catch (e) {
		/* ignore */
	}
}

// ── Link highlight on selection ───────────────────────────────────────────────
// activeId = null  → reset all lines to their default appearance
// activeId = id    → brighten connected lines by type; dim unconnected ones
function highlightLinks(highlightState = null) {
	if (!linkSel) return;
	const state = highlightState && typeof highlightState === 'object' ? highlightState : computeHighlightState();

	const hasNormalHighlights = state.rootIds.size > 0;

	if (!hasNormalHighlights && !isTraceMode && !isTraceLogMode) {
		// restore default appearance (both attributes and inline styles)
		linkSel
			.style('filter', null)
			.style('stroke-opacity', null)
			.style('opacity', null)
			.attr('stroke', (d) => getLinkColor(d))
			.attr('stroke-opacity', defaultLinkOpacity)
			.attr('stroke-width', (d) => getLinkWidth(d))
			.classed('fg-link--depth-active', false)
			.classed('fg-link--depth-recessed', false)
			.classed('trace-shortest', false)
			.classed('trace-longest', false)
			.classed('trace-log', false);
		orderGraphVisualLayers(state);
		return;
	}

	linkSel.each(function (d) {
		const srcId = d.source?.id ?? d.source;
		const tgtId = d.target?.id ?? d.target;
		const linkKey = getLinkKey(d);
		const connected = state.linkKeys.has(linkKey);
		const connectedToRoot = state.rootIds.has(srcId) || state.rootIds.has(tgtId);
		const isTraceShortest = isTraceMode && traceShortestIds.has(linkKey);
		const isTraceLongest = isTraceMode && traceLongestIds.has(linkKey);
		const isTraceLog = isTraceLogMode && traceLogIds.has(linkKey);
		const selectionLinkEmphasis = getSelectionLinkEmphasis();

		const sel = d3.select(this);

		sel
			.classed('fg-link--depth-active', false)
			.classed('fg-link--depth-recessed', false)
			.classed('trace-shortest', isTraceShortest)
			.classed('trace-longest', isTraceLongest)
			.classed('trace-combined', isTraceShortest && isTraceLongest)
			.classed('trace-log', isTraceLog);

		if (isTraceShortest || isTraceLongest || isTraceLog) {
			sel.style('filter', null).style('opacity', null).style('stroke-opacity', null).attr('stroke-opacity', 1);
			// CSS classes handle the stroke and width
			return;
		}

		if (hasNormalHighlights) {
			if (connected) {
				sel.classed('fg-link--depth-active', true);
				const highlightedStrokeWidth =
					hasInactiveEndpoint(d) ?
						connectedToRoot ? 0.95
						:	0.78
					: d.relationship === 'controls' ?
						connectedToRoot ? 1.9
						:	1.55
					: usesCurrentEmploymentStyling(d) ?
						connectedToRoot ? 1.85
						:	1.5
					: connectedToRoot ? 1.4
					: 1.15;
				sel
					.style('filter', selectionLinkEmphasis.showActiveFilter ? null : 'none')
					.style('opacity', null)
					.style('stroke-opacity', null)
					.attr('stroke', getLinkHighlightColor(d))
					.attr('stroke-opacity', selectionLinkEmphasis.strokeOpacity)
					.attr('stroke-width', highlightedStrokeWidth * selectionLinkEmphasis.strokeWidthScale);
			} else {
				sel.classed('fg-link--depth-recessed', true);
				const recessedLinkOpacity = hasInactiveEndpoint(d) ? 0.42 : 0.56;
				const recessedStrokeOpacity = hasInactiveEndpoint(d) ? 0.32 : 0.46;
				const recessedStrokeWidth = hasInactiveEndpoint(d) ? 0.68 : 0.82;
				sel
					.style('filter', null)
					.style('opacity', recessedLinkOpacity)
					.style('stroke-opacity', null)
					.attr('stroke', getLinkColor(d))
					.attr('stroke-opacity', recessedStrokeOpacity)
					.attr('stroke-width', recessedStrokeWidth);
			}
		} else if (isTraceMode || isTraceLogMode) {
			// Keep non-trace links visible during trace mode, just dimmed by ~20%
			const baseStrokeOpacity = Number(defaultLinkOpacity) || 1;
			sel.classed('fg-link--depth-recessed', true);
			sel
				.style('filter', null)
				.style('opacity', 0.8)
				.style('stroke-opacity', null)
				.attr('stroke', getLinkColor(d))
				.attr('stroke-opacity', Math.max(0.18, baseStrokeOpacity * 0.8))
				.attr('stroke-width', getLinkWidth(d));
		}
	});

	orderGraphVisualLayers(state);
}

// ── Spread neighbors on click ────────────────────────────────────────────────
function spreadNeighbors(
	clickedNode,
	neighborIds = null,
	options: {
		duration?: number;
	} = {},
) {
	if (!layoutNodes || !layoutLinks || !nodeSel || !linkSel) return;
	if (spreadAnimId) {
		cancelAnimationFrame(spreadAnimId);
		spreadAnimId = null;
	}

	const { duration = 480 } = options;

	// Find all direct neighbor IDs using the cached adjacency map
	const neighborIdSet =
		neighborIds instanceof Set ? new Set(neighborIds)
		: Array.isArray(neighborIds) ? new Set(neighborIds)
		: getNeighborIds(clickedNode.id);
	if (neighborIdSet.size === 0) return;

	// Fast node lookup
	const nodeById = new Map<string, any>(layoutNodes.map((d) => [d.id, d]));

	// Capture start and target positions for each neighbor
	const snapshots = new Map<string, { x0: number; y0: number; x1: number; y1: number }>();
	neighborIdSet.forEach((id) => {
		const d = nodeById.get(id);
		if (!d) return;
		const additionalConnections = Array.from(getNeighborIds(id)).filter((neighborId) => neighborId !== clickedNode.id).length;
		if (additionalConnections === 0) return;
		const dx = d.x - clickedNode.x;
		const dy = d.y - clickedNode.y;
		const dist = Math.sqrt(dx * dx + dy * dy) || 1;
		const extraSpread = Math.min(110, additionalConnections * 30);
		const targetDist = Math.max(dist, 72) + extraSpread;
		snapshots.set(id, {
			x0: d.x,
			y0: d.y,
			x1: clickedNode.x + (dx / dist) * targetDist,
			y1: clickedNode.y + (dy / dist) * targetDist,
		});
	});

	if (snapshots.size === 0) return;

	const startTime = performance.now();

	function frame(now) {
		const raw = Math.min((now - startTime) / duration, 1);
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
		nodeSel.filter((d) => neighborIdSet.has(d.id)).attr('transform', (d) => `translate(${d.x},${d.y})`);

		// Re-render all links touching the clicked node or any neighbor
		linkSel
			.filter((l) => {
				const srcId = l.source?.id ?? l.source;
				const tgtId = l.target?.id ?? l.target;
				return srcId === clickedNode.id || tgtId === clickedNode.id || neighborIdSet.has(srcId) || neighborIdSet.has(tgtId);
			})
			.attr('x1', (l) => l.source.x)
			.attr('y1', (l) => l.source.y)
			.attr('x2', (l) => l.target.x)
			.attr('y2', (l) => l.target.y);

		if (raw < 1) {
			spreadAnimId = requestAnimationFrame(frame);
		} else {
			spreadAnimId = null;
			snapshots.forEach((snap, id) => {
				const d = nodeById.get(id);
				if (!d) return;
				d.x = snap.x1;
				d.y = snap.y1;
				d.fx = null;
				d.fy = null;
			});
		}
	}

	spreadAnimId = requestAnimationFrame(frame);
}

function focusNodeById(
	id,
	options: {
		duration?: number;
		pulse?: boolean;
	} = {},
) {
	try {
		const { duration = 600, pulse = false } = options;
		if (!zoomBehavior || !svgSel) return;
		// layoutNodes is the current array of node objects in the visualization
		const node = (Array.isArray(layoutNodes) && layoutNodes.find((n) => n.id === id)) || null;
		if (!node) return;
		const viewport = getVisibleGraphViewport();
		const transform = d3.zoomTransform(svgSel.node());
		const k = transform.k || 1;
		const x = node.x || 0;
		const y = node.y || 0;
		const tx = viewport.centerX - x * k;
		const ty = viewport.centerY - y * k;
		svgSel.transition().duration(duration).call(zoomBehavior.transform, d3.zoomIdentity.translate(tx, ty).scale(k));

		// transient highlight: enlarge circle briefly
		try {
			nodeSel
				.filter((n) => n.id === id)
				.select('circle')
				.transition()
				.duration(250)
				.attr('r', (n) => (n._vizHalf || 6) * 1.6)
				.transition()
				.duration(300)
				.attr('r', (n) => n._vizHalf || 6);
		} catch (e) {
			/* ignore highlight errors */
		}

		if (pulse) {
			if (nodePulseTimer) {
				clearTimeout(nodePulseTimer);
				nodePulseTimer = null;
			}
			nodePulseTimer = setTimeout(
				() => {
					nodePulseTimer = null;
					pulseNodeHighlightById(id);
				},
				Math.max(180, Math.min(duration, 320)),
			);
		}
	} catch (e) {
		console.warn('focusNodeById error', e);
	}
}

function focusNodesInMainArea(nodeIds, { duration = 650, maxScale = 1.1 }: { duration?: number; maxScale?: number } = {}) {
	try {
		if (!zoomBehavior || !svgSel || !Array.isArray(layoutNodes) || !layoutNodes.length) {
			return false;
		}

		const ids = Array.isArray(nodeIds) ? nodeIds.filter(Boolean) : [nodeIds].filter(Boolean);
		const idSet = new Set(ids);
		const targetNodes = (idSet.size ? layoutNodes.filter((node) => idSet.has(node.id)) : layoutNodes).filter((node) => Number.isFinite(node?.x) && Number.isFinite(node?.y));
		if (!targetNodes.length) return false;

		const bounds = getLayoutBounds(targetNodes);
		if (!bounds) return false;

		const viewport = getVisibleGraphViewport();
		const padding = Math.max(72, Math.min(viewport.visibleWidth, viewport.visibleHeight) * 0.16);
		const usableWidth = Math.max(viewport.visibleWidth - padding * 2, 1);
		const usableHeight = Math.max(viewport.visibleHeight - padding * 2, 1);
		const fitScale = Math.min(usableWidth / bounds.width, usableHeight / bounds.height);
		const targetScale = Math.max(0.22, Math.min(maxScale, Number.isFinite(fitScale) ? fitScale : 1));

		const target = d3.zoomIdentity.translate(viewport.centerX - bounds.centerX * targetScale, viewport.centerY - bounds.centerY * targetScale).scale(targetScale);

		if (duration > 0) {
			svgSel.transition().duration(duration).call(zoomBehavior.transform, target);
		} else {
			svgSel.call(zoomBehavior.transform, target);
		}
		return true;
	} catch (err) {
		console.warn('focusNodesInMainArea error', err);
		return false;
	}
}

function scheduleFocusNodesInMainArea(
	nodeIds,
	options: {
		duration?: number;
		maxScale?: number;
	} = {},
) {
	const ids = Array.isArray(nodeIds) ? nodeIds.filter(Boolean) : [nodeIds].filter(Boolean);
	if (!ids.length) return;
	requestAnimationFrame(() => {
		focusNodesInMainArea(ids, options);
	});
}

function scheduleFirstFetchFocusIfAvailable(
	nodeIds,
	options: {
		duration?: number;
		maxScale?: number;
	} = {},
) {
	if (!allowFirstFetchZoom) return;
	if (!Array.isArray(layoutNodes) || layoutNodes.length > 0) return;
	allowFirstFetchZoom = false;

	scheduleFocusNodesInMainArea(nodeIds, options);
}

function isMobileSidebarViewport() {
	return true;
}

const MOBILE_SIDEBAR_TOGGLE_TOUCH_SLOP_PX = 12;
const MOBILE_SIDEBAR_TOGGLE_TOUCH_SUPPRESSION_MS = 250;

function bindTouchDragClickSuppression(button: HTMLElement | null) {
	if (!button || button.dataset.touchGuardBound === 'true') return;
	button.dataset.touchGuardBound = 'true';

	let activePointerId: number | null = null;
	let startX = 0;
	let startY = 0;
	let suppressClickUntil = 0;

	const movedBeyondTouchSlop = (clientX: number, clientY: number) => Math.hypot(clientX - startX, clientY - startY) > MOBILE_SIDEBAR_TOGGLE_TOUCH_SLOP_PX;
	const suppressNextClick = () => {
		suppressClickUntil = Date.now() + MOBILE_SIDEBAR_TOGGLE_TOUCH_SUPPRESSION_MS;
	};

	button.addEventListener(
		'pointerdown',
		(event) => {
			if (event.pointerType !== 'touch') return;
			activePointerId = event.pointerId;
			startX = event.clientX;
			startY = event.clientY;
		},
		{ passive: true },
	);

	button.addEventListener(
		'pointermove',
		(event) => {
			if (event.pointerType !== 'touch' || activePointerId !== event.pointerId) return;
			if (!movedBeyondTouchSlop(event.clientX, event.clientY)) return;
			suppressNextClick();
			activePointerId = null;
		},
		{ passive: true },
	);

	const finalizePointer = (event: PointerEvent) => {
		if (event.pointerType !== 'touch' || activePointerId !== event.pointerId) return;
		if (movedBeyondTouchSlop(event.clientX, event.clientY)) {
			suppressNextClick();
		}
		activePointerId = null;
	};

	button.addEventListener('pointerup', finalizePointer, { passive: true });
	button.addEventListener('pointercancel', finalizePointer, { passive: true });
	button.addEventListener(
		'click',
		(event) => {
			if (Date.now() >= suppressClickUntil) return;
			event.preventDefault();
			event.stopPropagation();
		},
		true,
	);
}

function bindSidebarToggleInteraction(button: HTMLButtonElement | null, resolveNextMode: () => 'none' | 'info' | 'log') {
	if (!button || button.dataset.touchGuardBound === 'true') return;
	button.dataset.touchGuardBound = 'true';

	let activePointerId: number | null = null;
	let startX = 0;
	let startY = 0;
	let suppressClickUntil = 0;

	const suppressNextClick = () => {
		suppressClickUntil = Date.now() + MOBILE_SIDEBAR_TOGGLE_TOUCH_SUPPRESSION_MS;
	};

	const movedBeyondTouchSlop = (clientX: number, clientY: number) => Math.hypot(clientX - startX, clientY - startY) > MOBILE_SIDEBAR_TOGGLE_TOUCH_SLOP_PX;

	const onPointerDown = (event: PointerEvent) => {
		if (event.pointerType !== 'touch') return;
		activePointerId = event.pointerId;
		startX = event.clientX;
		startY = event.clientY;
	};

	const onPointerMove = (event: PointerEvent) => {
		if (event.pointerType !== 'touch' || activePointerId !== event.pointerId) return;
		if (!movedBeyondTouchSlop(event.clientX, event.clientY)) return;
		suppressNextClick();
		activePointerId = null;
	};

	const onPointerEnd = (event: PointerEvent) => {
		if (event.pointerType !== 'touch' || activePointerId !== event.pointerId) return;
		if (movedBeyondTouchSlop(event.clientX, event.clientY)) {
			suppressNextClick();
		}
		activePointerId = null;
	};

	button.addEventListener('pointerdown', onPointerDown, { passive: true });
	button.addEventListener('pointermove', onPointerMove, { passive: true });
	button.addEventListener('pointerup', onPointerEnd, { passive: true });
	button.addEventListener('pointercancel', onPointerEnd, { passive: true });
	button.addEventListener('click', (event) => {
		if (Date.now() < suppressClickUntil) {
			event.preventDefault();
			event.stopPropagation();
			return;
		}
		event.stopPropagation();
		const nextMode = resolveNextMode();
		setSidebarViewMode(nextMode, { expandMobile: nextMode !== 'none' });
	});
}

function setSidebarToggleState(button: HTMLButtonElement | null, active: boolean, titles: { active: string; inactive: string }) {
	if (!button) return;
	button.classList.toggle('is-active', active);
	button.setAttribute('aria-expanded', active ? 'true' : 'false');
	button.setAttribute('aria-pressed', active ? 'true' : 'false');
	button.title = active ? titles.active : titles.inactive;
}

function syncMobileSidebarExpandedState(expanded: boolean) {
	const side = document.getElementById('fg-sidebar');
	if (!side) return;
	side.dataset.mobileExpanded = expanded ? 'true' : 'false';
	const isTemporarilyPinned = expanded && (side.dataset.viewMode === 'info' || side.dataset.viewMode === 'log');
	side.dataset.temporarilyPinned = isTemporarilyPinned ? 'true' : 'false';
	const backdrop = document.getElementById('fg-sidebar-backdrop');
	if (backdrop) {
		backdrop.dataset.temporarilyPinned = isTemporarilyPinned ? 'true' : 'false';
	}
	setSidebarToggleState(side.querySelector('.fg-sidebar-mobile-summary-toggle') as HTMLButtonElement | null, side.dataset.viewMode === 'info' && expanded, {
		active: 'Collapse details',
		inactive: 'Expand details',
	});
	setSidebarToggleState(side.querySelector('.fg-sb-log-toggle') as HTMLButtonElement | null, side.dataset.viewMode === 'log' && expanded, {
		active: 'Hide selection log',
		inactive: 'Show selection log',
	});
}

function renderSidebarToggleButton(className: string, label: string, isActive: boolean, titles: { active: string; inactive: string }, ariaLabel?: string) {
	return `
		<button class="fg-sb-toggle-btn ${className}${isActive ? ' is-active' : ''}" type="button" aria-expanded="${isActive ? 'true' : 'false'}" aria-pressed="${isActive ? 'true' : 'false'}" title="${isActive ? titles.active : titles.inactive}"${ariaLabel ? ` aria-label="${ariaLabel}"` : ''}>
			<span class="fg-sb-toggle-btn__label">${label}</span>
			<span class="fg-sb-toggle-btn__chevron" aria-hidden="true">▾</span>
		</button>
	`;
}

function renderMobileSidebarToggle() {
	return renderSidebarToggleButton(
		'fg-sidebar-mobile-summary-toggle fg-sb-info-toggle',
		'Info',
		sidebarViewMode === 'info',
		{ active: 'Collapse details', inactive: 'Expand details' },
		'Show info',
	);
}

function renderSidebarSelectionLogToggle() {
	return renderSidebarToggleButton('fg-sb-log-toggle', 'Log', sidebarViewMode === 'log', { active: 'Hide selection log', inactive: 'Show selection log' }, 'Show selection log');
}

function renderSidebarSelectionLogBody() {
	return `
		<div class="fg-sb-body fg-sb-body--log">
			<div class="fg-section-title">Selection Log</div>
			<div class="fg-log-drawer-actions fg-log-drawer-actions--sidebar">
				<div class="fg-log-drawer-actions-row fg-log-drawer-actions-row--primary">
					<button
						data-fg-trace-mode-button="sidebar-log"
						class="fg-ghost-btn fg-btn-sm"
						type="button"
						title="Toggle path tracing mode">
						Trace Mode
					</button>
					<button
						data-fg-selection-log-action="trace"
						class="fg-ghost-btn fg-btn-sm"
						type="button"
						title="Trace path between all logged nodes">
						Trace with Log
					</button>
				</div>
				<div class="fg-log-drawer-actions-row fg-log-drawer-actions-row--secondary">
					<button
						data-fg-selection-log-action="copy-all"
						class="fg-ghost-btn fg-btn-sm"
						type="button"
						title="Copy all entries">
						Copy All
					</button>
					<button
						data-fg-selection-log-action="clear"
						class="fg-ghost-btn fg-btn-sm"
						type="button"
						title="Clear log">
						Clear
					</button>
				</div>
			</div>
			<div id="fg-sidebar-selection-log-list" class="fg-selection-log-list fg-selection-log-list--sidebar">
				<p class="fg-log-empty">No nodes selected yet.</p>
			</div>
		</div>
	`;
}

function renderSidebar(d) {
	const el = document.getElementById('fg-sidebar-inner');
	const side = document.getElementById('fg-sidebar');
	const previousDisplayedId = side?.dataset.displayedId || '';
	sidebarSelectedNode = d;
	const preserveExpandedState = sidebarViewMode !== 'none';
	el.innerHTML =
		d.group === 'firm' ? renderFirmDetail(d)
		: d.group === 'entity' ? renderEntityDetail(d)
		: renderPersonDetail(d);
	if (sidebarViewMode === 'log') {
		const body = el.querySelector('.fg-sb-body');
		if (body) {
			body.outerHTML = renderSidebarSelectionLogBody();
		}
	}
	if (sidebarViewMode === 'none') {
		el.querySelector('.fg-sb-body')?.classList.add('hidden');
	}
	// show sidebar and update header short detail when rendering
	if (side) side.classList.remove('hidden');
	document.getElementById('fg-sidebar-backdrop')?.classList.remove('hidden');
	if (side) side.dataset.displayedId = d?.id || '';
	if (side) side.dataset.viewMode = sidebarViewMode;
	syncMobileSidebarExpandedState(!isMobileSidebarViewport() || preserveExpandedState);
	const mobileToggle = el.querySelector('.fg-sidebar-mobile-summary-toggle') as HTMLButtonElement | null;
	if (mobileToggle) {
		bindSidebarToggleInteraction(mobileToggle, () => (sidebarViewMode === 'info' ? 'none' : 'info'));
	}
	const logToggleButtons = Array.from(el.querySelectorAll<HTMLButtonElement>('.fg-sb-log-toggle'));
	logToggleButtons.forEach((button) => {
		bindSidebarToggleInteraction(button, () => (sidebarViewMode === 'log' ? 'none' : 'log'));
	});
	const touchGuardButtons = Array.from(
		document.querySelectorAll<HTMLElement>('#fg-sidebar button, #fg-selection-log button, #fg-sidebar details.fg-mobile-legend-tooltip > summary, [data-fg-trace-mode-button]'),
	);
	touchGuardButtons.forEach((button) => bindTouchDragClickSuppression(button));
	updateSelectionLogUI();
	updateSelectionLogChrome();
	const focusBtn = document.getElementById('fg-focus-btn') as HTMLButtonElement | null;
	if (focusBtn) focusBtn.disabled = false;
	try {
		updateShortDetail(d);
	} catch (e) {
		/* no-op */
	}

	openSidebarToggles();
}

function hasAnyItems(list) {
	return Array.isArray(list) && list.length > 0;
}

function hasPublicFinraIndividualPage(detail, basicInformation: Record<string, any> = {}) {
	const bcScope = String(detail?.bcScope || basicInformation?.bcScope || '')
		.trim()
		.toLowerCase()
		.replace(/\s+/g, '');
	if (bcScope === 'notinscope') return false;
	if (bcScope && bcScope !== 'notinscope') return true;

	const registrationCount = detail?.registrationCount || {};
	if (Number(registrationCount.approvedFinraRegistrationCount || 0) > 0) {
		return true;
	}
	if (Number(registrationCount.approvedSRORegistrationCount || 0) > 0) {
		return true;
	}
	if (hasAnyItems(detail?.registeredSROs)) return true;

	return false;
}

function hasPublicSecIndividualPage(detail, basicInformation: Record<string, any> = {}) {
	const iaScope = String(detail?.iaScope || basicInformation?.iaScope || '')
		.trim()
		.toLowerCase()
		.replace(/\s+/g, '');
	if (iaScope && iaScope !== 'notinscope') return true;

	const registrationCount = detail?.registrationCount || {};
	if (Number(registrationCount.approvedIAStateRegistrationCount || 0) > 0) {
		return true;
	}
	if (hasAnyItems(detail?.currentIAEmployments)) return true;
	if (hasAnyItems(detail?.iaDisclosures)) return true;
	if (
		Array.isArray(detail?.registeredStates) &&
		detail.registeredStates.some(
			(entry) =>
				String(entry?.regScope || '')
					.trim()
					.toLowerCase() === 'ia',
		)
	) {
		return true;
	}

	return false;
}

// ── Person detail ────────────────────────────────────────────────────────────
function renderPersonDetail(d) {
	const bi = d.basicInformation || {};
	const hasFinraPage = d.hasFinraData === false ? false : hasPublicFinraIndividualPage(d, bi);
	const hasSecPage = hasPublicSecIndividualPage(d, bi);
	const showSecReferences = hasSecPage;
	const links = (graphData?.links || []).filter((l) => (l.source?.id || l.source) === d.id || (l.target?.id || l.target) === d.id);
	const controlLinks = links.filter((l) => l.relationship === 'controls');

	const stubBadge = d.stub ? `<span class="fg-badge stub">Form BD stub</span>` : '';

	// ── Scope badges ──────────────────────────────────────────────────────────
	function formatDomainScopeBadge(text, domain, sourceTitle) {
		const raw = String(text || '').trim();
		if (!raw) return '';
		const normalized = raw.toLowerCase().replace(/\s+/g, '');
		const isActive = /active|approved/.test(normalized) && !/inactive|notinscope|terminated|revoked|suspended/.test(normalized);
		if (!isActive && d.stub) return '';
		const label = `${isActive ? 'Active' : 'Inactive'} ${domain}`;
		return `<span class="fg-badge ${isActive ? 'active' : 'inactive'}" title="${esc(sourceTitle)}">${esc(label)}</span>`;
	}

	const finraScopeText = d.bcScope || bi.bcScope || (hasFinraPage ? 'Active' : '');
	const secScopeText = hasSecPage ? d.iaScope || bi.iaScope || 'Active' : '';
	const scopeBadgesHtml = [formatDomainScopeBadge(finraScopeText, 'finra', 'FINRA'), formatDomainScopeBadge(secScopeText, 'sec', 'SEC AdvisorInfo')].filter(Boolean).join(' ');

	// ── All disclosures (BC + IA) ─────────────────────────────────────────────
	// Deduplicate: for each (type, date) pair keep the entry with the most content.
	// A blank duplicate (same type, no date/detail/resolution) is dropped when a
	// richer entry with the same type already exists.
	const _rawDisclosures = [
		...(d.disclosures || []).map((dis) => ({
			...dis,
			_sourceLabel: dis?._sourceLabel || 'FINRA',
		})),
		...(d.iaDisclosures || []).map((dis) => ({
			...dis,
			_sourceLabel: dis?._sourceLabel || 'SEC AdvisorInfo',
		})),
	];
	const allDisclosures = (() => {
		function disHasContent(dis) {
			return !!(
				(dis.eventDate || dis.date || '').trim() ||
				(dis.disclosureResolution || dis.resolution || '').trim() ||
				(dis.disclosureDetail && Object.keys(dis.disclosureDetail).length > 0)
			);
		}

		// Two-pass: first collect all, then drop blank entries whose type already
		// has at least one entry with real content.
		const byType = new Map(); // type -> has any entry with content
		for (const dis of _rawDisclosures) {
			const dtype = (dis.disclosureType || dis.type || '').trim();
			if (!byType.has(dtype)) byType.set(dtype, false);
			if (disHasContent(dis)) byType.set(dtype, true);
		}

		// Second pass: deduplicate by (type + date), dropping blank entries when
		// a richer entry of the same type exists.
		const seen = new Map();
		for (const dis of _rawDisclosures) {
			const dtype = (dis.disclosureType || dis.type || '').trim();
			const ddate = (dis.eventDate || dis.date || '').trim();
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
		return Array.from(seen.values()).sort((a, b) => compareCurrentFirstByDates(a, b, { currentKey: '__never', dateKeys: ['eventDate', 'date'] }));
	})();
	const disclosureCount = allDisclosures.length;
	const aliases = (d.otherNames?.length ? d.otherNames : bi.otherNames || []).map((alias) => normalizePersonLabel(alias)).filter(Boolean);

	// ── Employment timeline from stored arrays, fallback to graph links ────────
	// Build unified list from FINRA arrays (currentEmployments, previousEmployments,
	// currentIAEmployments, previousIAEmployments) if stored on node.
	function empToEntry(emp, isCurrent) {
		const bo = emp.branchOfficeLocations?.[0];
		const city = emp.city || bo?.city || '';
		const state = emp.state || bo?.state || '';
		const street1 = bo?.street1 || '';
		const street2 = bo?.street2 || '';
		const zip = emp.zipCode || bo?.zipCode || '';
		const loc = formatLocationText([city, state].filter(Boolean).join(', '));
		const addr = formatLocationText([street1, street2, city, state, zip].filter(Boolean).join(', '));
		return {
			firmName: emp.firmName || '',
			firmId: emp.firmId,
			bdSecNumber: emp.bdSECNumber,
			iaSECNumber: emp.iaSECNumber,
			start: emp.registrationBeginDate || '',
			end: emp.registrationEndDate || null,
			isCurrent: isCurrent || !emp.registrationEndDate,
			employmentStatus: emp.employmentStatus || emp.status || emp.currentStatus || '',
			iaOnly: emp.iaOnly === 'Y',
			firmBCScope: emp.firmBCScope,
			firmIAScope: emp.firmIAScope,
			loc,
			addr,
			expelledDate: emp.expelledDate,
		};
	}

	function getEmploymentDetailLine(entry) {
		return entry.addr || entry.loc || '';
	}

	function getEmploymentScopeTags(entry) {
		return [
			entry.employmentStatus ? formatUiText(entry.employmentStatus) : null,
			showSecReferences && entry.iaOnly ? 'IA only' : null,
			entry.firmBCScope && entry.firmBCScope !== 'ACTIVE' ? `Firm FINRA: ${formatUiText(entry.firmBCScope)}` : null,
		].filter(Boolean);
	}

	function regToEntry(emp, role, isCurrent) {
		const office = emp.branchOfficeLocations?.[0];
		const officeAddress = office ? formatLocationText([office.street1, office.street2, office.city, office.state, office.zipCode].filter(Boolean).join(', ')) : '';
		const cityState = formatLocationText([emp.city || office?.city || '', emp.state || office?.state || ''].filter(Boolean).join(', '));
		return {
			role,
			firmId: emp.firmId,
			firmName: emp.firmName || '',
			start: emp.registrationBeginDate || '',
			end: emp.registrationEndDate || null,
			isCurrent,
			officeAddress,
			cityState,
		};
	}

	function dedupeRegs(items) {
		const seen = new Set();
		return items.filter((item) => {
			const key = [item.role, item.firmId, item.start, item.end || 'present', item.cityState].join('|');
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});
	}

	function parseSortDateValue(value) {
		const raw = String(value || '').trim();
		if (!raw) return Number.NEGATIVE_INFINITY;
		const shortDateMatch = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
		if (shortDateMatch) {
			const [, month, day, year] = shortDateMatch;
			return Date.UTC(Number(year), Number(month) - 1, Number(day));
		}
		const parsed = Date.parse(raw);
		return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
	}

	function compareCurrentFirstByDates(a, b, options: { currentKey?: string; dateKeys?: string[] } = {}) {
		const currentKey = options.currentKey || 'isCurrent';
		const dateKeys = Array.isArray(options.dateKeys) ? options.dateKeys : [];
		const aCurrent = Boolean(a?.[currentKey]);
		const bCurrent = Boolean(b?.[currentKey]);
		if (aCurrent !== bCurrent) return aCurrent ? -1 : 1;

		for (const key of dateKeys) {
			const diff = parseSortDateValue(b?.[key]) - parseSortDateValue(a?.[key]);
			if (diff !== 0) return diff;
		}

		return String(a?.firmName || a?.label || a?.brochureName || a?.examName || a?.type || '').localeCompare(
			String(b?.firmName || b?.label || b?.brochureName || b?.examName || b?.type || ''),
		);
	}

	function renderRegistrationRole(role, { inactive = false, showIcon = true }: { inactive?: boolean; showIcon?: boolean } = {}) {
		const normalizedRole = String(role || '')
			.trim()
			.toUpperCase();
		const label =
			normalizedRole === 'B' ? 'Broker'
			: normalizedRole === 'IA' ? 'Investment Adviser'
			: normalizedRole || 'Registration';
		const roleClass =
			normalizedRole === 'B' ? 'fg-reg-role--broker'
			: normalizedRole === 'IA' ? 'fg-reg-role--ia'
			: 'fg-reg-role--default';
		return `<span class="fg-reg-role ${roleClass}${inactive ? ' is-inactive' : ''}${showIcon ? '' : ' fg-reg-role--text-only'}" title="${esc(label)}">${showIcon ? `<span class="fg-reg-role__icon">${esc(normalizedRole || label.charAt(0))}</span>` : ''}<span class="fg-reg-role__label">${esc(label)}</span></span>`;
	}

	const currentRegistrations = dedupeRegs([
		...(d.currentIAEmployments || []).map((emp) => regToEntry(emp, 'IA', true)),
		...(d.currentEmployments || []).map((emp) => regToEntry(emp, 'B', true)),
	]).sort((a, b) => compareCurrentFirstByDates(a, b, { dateKeys: ['start', 'end'] }));
	const topCurrentRegistrationRoles = Array.from(new Set(currentRegistrations.map((reg) => reg.role)))
		.filter(Boolean)
		.sort((a, b) => {
			const order = (role) =>
				role === 'B' ? 0
				: role === 'IA' ? 1
				: 2;
			return order(a) - order(b);
		});
	const sourceTruth = getNodeSourceTruth(d);
	const finraActivityFlags = collectNodeActivityFlags([d.bcScope, bi.bcScope]);
	const hasActiveFinraIndicator =
		finraActivityFlags.hasActive ||
		Number(d?.registrationCount?.approvedFinraRegistrationCount || 0) > 0 ||
		Number(d?.registrationCount?.approvedSRORegistrationCount || 0) > 0 ||
		Number(d?.registrationCount?.approvedStateRegistrationCount || 0) > 0 ||
		(Boolean(d?.currentEmployments?.length) && !d?.stub) ||
		hasActiveRegisteredStates(d?.registeredStates, ['bc', 'b', 'broker']) ||
		hasApprovedSro(d?.registeredSROs);
	const hasBrokerIndicatorSource = hasActiveFinraIndicator;
	const hasIaIndicatorSource = hasSecPage || sourceTruth.sec;
	const fallbackRoles = [hasBrokerIndicatorSource ? 'B' : null, hasIaIndicatorSource ? 'IA' : null].filter(Boolean);
	const topRoleIndicators = (topCurrentRegistrationRoles.length ? topCurrentRegistrationRoles : fallbackRoles)
		.filter((role) => role !== 'B' || hasActiveFinraIndicator)
		.sort((a, b) => {
			const order = (role) =>
				role === 'B' ? 0
				: role === 'IA' ? 1
				: 2;
			return order(a) - order(b);
		});
	const topCurrentRegistrationHtml =
		topRoleIndicators.length ?
			`
			<div class="fg-sb-role-summary">
				<div class="fg-firm-summary__roles">
					${topRoleIndicators
						.map(
							(role) => `
								<div class="fg-firm-summary__role">
									<span class="fg-firm-summary__role-icon ${String(role).toUpperCase() === 'IA' ? 'fg-firm-summary__role-icon--ia' : 'fg-firm-summary__role-icon--broker'}" aria-hidden="true">${esc(String(role).toUpperCase())}</span>
									<div class="fg-firm-summary__role-copy">
										<div class="fg-firm-summary__role-title">${esc(String(role).toUpperCase() === 'IA' ? 'Investment Adviser' : 'Broker Regulated by FINRA')}</div>
									</div>
								</div>`,
						)
						.join('')}
				</div>
			</div>`
		:	'';
	const previousRegistrations = dedupeRegs([
		...(d.previousIAEmployments || []).map((emp) => regToEntry(emp, 'IA', false)),
		...(d.previousEmployments || []).map((emp) => regToEntry(emp, 'B', false)),
	]).sort((a, b) => compareCurrentFirstByDates(a, b, { dateKeys: ['end', 'start'] }));

	const hasStoredEmps = d.currentEmployments?.length || d.previousEmployments?.length || d.currentIAEmployments?.length || d.previousIAEmployments?.length;

	let empEntries = [];
	if (hasStoredEmps) {
		empEntries = [
			...(d.currentEmployments || []).map((e) => empToEntry(e, true)),
			...(d.currentIAEmployments || []).map((e) => empToEntry(e, true)),
			...(d.previousEmployments || []).map((e) => empToEntry(e, false)),
			...(d.previousIAEmployments || []).map((e) => empToEntry(e, false)),
		];
		const seen = new Set();
		empEntries = empEntries.filter((e) => {
			const key = `${e.firmId || e.firmName}|${e.start}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});
		empEntries.sort((a, b) => compareCurrentFirstByDates(a, b, { dateKeys: ['end', 'start'] }));
	} else {
		const empLinks = links.filter((l) => l.relationship === 'employed_by');
		empEntries = empLinks.map((l) => {
			const firmNode = graphData.nodes.find((n) => n.id === (l.target?.id || l.target));
			return {
				firmName: firmNode?.label || l.firmName || '',
				firmId: l.firmId,
				start: l.startDate || '',
				end: l.endDate || null,
				isCurrent: !l.endDate,
				iaOnly: false,
				loc: formatLocationText([l.city, l.state].filter(Boolean).join(', ')),
			};
		});
		empEntries.sort((a, b) => compareCurrentFirstByDates(a, b, { dateKeys: ['end', 'start'] }));
	}

	const currentEmploymentEntries = empEntries.filter((e) => e.isCurrent);
	const previousEmploymentEntries = empEntries.filter((e) => !e.isCurrent);
	const allEmploymentEntries = [...currentEmploymentEntries, ...previousEmploymentEntries];

	function normalizeFirmKey(value) {
		return String(value || '')
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, ' ')
			.trim();
	}

	function findEmploymentMatchForControl(link, firmNode) {
		const controlFirmId = String(firmNode?.firmId || link?.firmId || link?.firm_id || link?.organizationId || link?.orgId || '').trim();
		const controlFirmName = normalizeFirmKey(firmNode?.label || link?.firmName || link?.name || link?.organizationName || link?.legalName || '');

		const byFirmId = controlFirmId ? allEmploymentEntries.find((entry) => String(entry?.firmId || '').trim() === controlFirmId) : null;
		if (byFirmId) return byFirmId;

		if (!controlFirmName) return null;
		return allEmploymentEntries.find((entry) => normalizeFirmKey(entry?.firmName) === controlFirmName) || null;
	}

	// ── Exam categories ────────────────────────────────────────────────────────
	const allExams = [...(d.stateExamCategory || []), ...(d.principalExamCategory || []), ...(d.productExamCategory || [])].sort((a, b) =>
		compareCurrentFirstByDates(a, b, { currentKey: '__never', dateKeys: ['examTakenDate'] }),
	);

	// ── Registered states (raw objects with scope) ─────────────────────────────
	const regStates = Array.isArray(d.registeredStates) ? d.registeredStates.filter(Boolean) : [];
	const licenseCount = regStates.length || (d.registrationCount?.approvedStateRegistrationCount || 0) + (d.registrationCount?.approvedIAStateRegistrationCount || 0);

	function disclosureValueToText(value) {
		if (value == null) return '';
		if (Array.isArray(value)) {
			return value
				.map((item) => disclosureValueToText(item))
				.filter(Boolean)
				.join('; ');
		}
		if (typeof value === 'object') {
			return Object.entries(value)
				.map(([key, nestedValue]) => {
					const nestedText = disclosureValueToText(nestedValue);
					return nestedText ? `${key}: ${nestedText}` : '';
				})
				.filter(Boolean)
				.join(' | ');
		}
		return String(value).trim();
	}

	function disclosureLabelText(key) {
		return String(key || '')
			.replace(/([a-z])([A-Z])/g, '$1 $2')
			.replace(/[_-]+/g, ' ')
			.trim();
	}

	function disclosureKeyId(key) {
		return String(key || '')
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '');
	}

	// ── Helper: render a single raw FINRA/SEC disclosure ──────────────────────
	function renderDisclosure(dis) {
		const dtype = dis.disclosureType || dis.type || '';
		const ddate = dis.eventDate || dis.date || '';
		const dres = dis.disclosureResolution || dis.resolution || '';
		const dd = dis.disclosureDetail || {};
		const dsource = dis._sourceLabel || '';

		const isObj = dd && typeof dd === 'object' && !Array.isArray(dd);

		const allegs = isObj ? dd['Allegations'] || dd['allegations'] || '' : '';
		const initiatedBy = isObj ? dd['Initiated By'] || dd['initiatedBy'] || '' : '';
		const resolution = isObj ? dd['Resolution'] || dd['resolution'] || '' : '';
		const sanctionText = isObj ? dd['Sanctions'] || dd['sanctions'] || '' : '';
		const sanctionDetails = isObj ? dd['SanctionDetails'] || dd['Sanction Details'] || [] : [];
		const brokerComment = isObj ? dd['Broker Comment'] || dd['brokerComment'] || null : null;
		const settlementAmt = isObj ? dd['Settlement Amount'] || dd['settlementAmount'] || '' : '';
		const docketFDA = isObj ? (dd['DocketNumberFDA'] || '').trim() : '';
		const docketAAO = isObj ? (dd['DocketNumberAAO'] || '').trim() : '';
		const arbDocket = isObj ? dd['arbitrationDocketNumber'] || '' : '';
		const isIAExcl = dis.isIapdExcludedCCFlag === 'Y';
		const isBCExcl = dis.isBcExcludedCCFlag === 'Y';

		const comments =
			Array.isArray(brokerComment) ? brokerComment
			: brokerComment ? [brokerComment]
			: [];

		const sanctionBadges = [...(Array.isArray(sanctionDetails) ? sanctionDetails.map((s) => (typeof s === 'object' ? s.Sanctions || s.sanctions || '' : String(s))) : [])]
			.map((s) => String(s).trim())
			.filter(Boolean);

		const handledDetailKeys = new Set(
			[
				'Allegations',
				'allegations',
				'Initiated By',
				'initiatedBy',
				'Resolution',
				'resolution',
				'Sanctions',
				'sanctions',
				'SanctionDetails',
				'Sanction Details',
				'Broker Comment',
				'brokerComment',
				'Settlement Amount',
				'settlementAmount',
				'DocketNumberFDA',
				'DocketNumberAAO',
				'arbitrationDocketNumber',
			].map((key) => disclosureKeyId(key)),
		);

		const extraDetailRows =
			isObj ?
				Object.entries(dd)
					.map(([key, value]) => ({
						key,
						keyId: disclosureKeyId(key),
						valueText: disclosureValueToText(value),
					}))
					.filter(({ keyId, valueText }) => valueText && !handledDetailKeys.has(keyId))
			:	[];

		return `
      <div class="fg-disclosure">
        <div class="fg-dis-header">
          <span class="fg-dis-type">${esc(dtype)}</span>
          ${dsource ? `<span class="fg-badge inactive">${esc(dsource)}</span>` : ''}
          ${ddate ? `<span class="fg-dis-date">${esc(ddate)}</span>` : ''}
          ${dres ? `<span class="fg-dis-res ${/final|settled/i.test(dres) ? 'final' : 'pending'}">${esc(dres)}</span>` : ''}
								${isIAExcl || isBCExcl ? `<span class="fg-badge inactive" title="Excluded from count">${isIAExcl ? 'IA-excl' : ''}${isIAExcl && isBCExcl ? ' ' : ''}${isBCExcl ? 'FINRA-excl' : ''}</span>` : ''}
        </div>
        ${initiatedBy ? `<div class="fg-dis-row"><span class="fg-dis-label">Initiated by:</span> ${esc(initiatedBy)}</div>` : ''}
        ${allegs ? `<div class="fg-dis-row"><span class="fg-dis-label">Allegations:</span><div class="fg-dis-text">${esc(allegs)}</div></div>` : ''}
        ${resolution ? `<div class="fg-dis-row"><span class="fg-dis-label">Resolution:</span> ${esc(resolution)}</div>` : ''}
        ${sanctionText ? `<div class="fg-dis-row"><span class="fg-dis-label">Sanctions:</span><div class="fg-dis-text">${esc(sanctionText)}</div></div>` : ''}
        ${settlementAmt ? `<div class="fg-dis-row"><span class="fg-dis-label">Settlement:</span> <strong>${esc(settlementAmt)}</strong></div>` : ''}
        ${sanctionBadges.length ? `<div class="fg-dis-sanctions">${sanctionBadges.map((s) => `<span class="fg-badge inactive">${esc(s)}</span>`).join(' ')}</div>` : ''}
        ${comments.length ? `<div class="fg-dis-row"><span class="fg-dis-label">Broker comment:</span><div class="fg-dis-text fg-dis-comment">${comments.map((c) => esc(String(c))).join('<br>')}</div></div>` : ''}
        ${docketFDA || docketAAO || arbDocket ? `<div class="fg-dis-row fg-dis-dockets">${[docketFDA && `FDA: ${esc(docketFDA)}`, docketAAO && `AAO: ${esc(docketAAO)}`, arbDocket && `Arb: ${esc(arbDocket)}`].filter(Boolean).join(' &nbsp;|&nbsp; ')}</div>` : ''}
        ${extraDetailRows.length ? extraDetailRows.map(({ key, valueText }) => `<div class="fg-dis-row"><span class="fg-dis-label">${esc(disclosureLabelText(key))}:</span><div class="fg-dis-text">${esc(valueText)}</div></div>`).join('') : ''}
      </div>`;
	}

	const crd = bi.individualId || d.crd || String(d.id).replace(/^person[:_]/, '');
	const brokerCheckSummaryUrl = crd && hasFinraPage ? `https://brokercheck.finra.org/individual/summary/${encodeURIComponent(crd)}` : null;
	const brokerCheckReportUrl = crd && hasFinraPage ? `https://files.brokercheck.finra.org/individual/individual_${encodeURIComponent(crd)}.pdf` : null;
	const secSummaryUrl = crd && hasSecPage ? `https://adviserinfo.sec.gov/individual/summary/${encodeURIComponent(crd)}` : null;
	const bcRawUrl = bi.individualId ? `https://api.brokercheck.finra.org/search/individual/${encodeURIComponent(crd)}`.trim() : null;
	const secRawUrl = bi.individualId ? `https://api.adviserinfo.sec.gov/search/individual/${encodeURIComponent(crd)}`.trim() : null;
	const personSummaryLine = crd ? `CRD#: ${esc(String(crd))}` : '';

	return `
    <div class="fg-sb-header individual">
		<div class="fg-sb-title-row">
	<div class="fg-sb-title">${esc(getPreferredNodeLabel(d) || [bi.firstName, bi.middleName, bi.lastName].filter(Boolean).join(' '))}</div>
		</div>
		${personSummaryLine ? `<div class="fg-sb-crd">${personSummaryLine}</div>` : ''}
      <div class="fg-sb-badges">
        ${scopeBadgesHtml}
        ${stubBadge}
        ${disclosureCount ? `<span class="fg-badge inactive">${disclosureCount} disclosure${disclosureCount !== 1 ? 's' : ''}</span>` : ''}
      </div>
			${topCurrentRegistrationHtml}
		<div class="fg-sb-title-actions fg-sb-title-actions--below-tags">
			${renderMobileSidebarToggle()}
			${renderSidebarSelectionLogToggle()}
		</div>
    </div>
    <div class="fg-sb-body fg-sb-body--person">
      <div class="fg-ext-links">
        ${brokerCheckSummaryUrl ? `<a class="fg-ext-link bc" href="${brokerCheckSummaryUrl}" target="_blank" rel="noopener noreferrer">&#x2197; FINRA Summary</a>` : ''}
	        ${brokerCheckReportUrl ? `<a class="fg-ext-link bc" href="${brokerCheckReportUrl}" target="_blank" rel="noopener noreferrer">&#x2197; FINRA Detailed Report (PDF)</a>` : ''}
        ${secSummaryUrl ? `<a class="fg-ext-link sec" href="${secSummaryUrl}" target="_blank" rel="noopener noreferrer">&#x2197; SEC AdvisorInfo Summary</a>` : ''}
      </div>
		<div class="fg-sb-copy-below-links">

      ${bi.individualId ? row('CRD', `<code>${bi.individualId}</code>`) : ''}
		${row('ID source check', esc(formatNodeSourceTruthSummary(d)))}
      ${aliases.length ? row('Also known as', esc(aliases.join('; '))) : ''}
      ${
				d.yearsExperience != null ? row('Years of Experience', esc(String(d.yearsExperience)))
				: d.daysInIndustry != null ? row('Days in Industry', d.daysInIndustry.toLocaleString())
				: ''
			}
      ${typeof d.firmCount === 'number' ? row('Firms (all time)', esc(String(d.firmCount))) : ''}
      ${licenseCount ? row('State Licenses', esc(String(licenseCount))) : ''}
      ${row('Disclosures', esc(String(disclosureCount)))}
	      ${d.primaryOffice?.address ? row('Primary Office', esc(formatLocationText(d.primaryOffice.address)), 'fg-detail-row--stacked') : ''}
      ${
				d.registrationCount ?
					`
        ${d.registrationCount.approvedFinraRegistrationCount != null ? row('FINRA Registrations', esc(String(d.registrationCount.approvedFinraRegistrationCount))) : ''}
        ${d.registrationCount.approvedSRORegistrationCount != null ? row('SRO Registrations', esc(String(d.registrationCount.approvedSRORegistrationCount))) : ''}
		${d.registrationCount.approvedStateRegistrationCount != null ? row('State Broker Lic.', esc(String(d.registrationCount.approvedStateRegistrationCount))) : ''}
        ${d.registrationCount.approvedIAStateRegistrationCount != null ? row('State (IA) Lic.', esc(String(d.registrationCount.approvedIAStateRegistrationCount))) : ''}
      `
				:	''
			}

      ${
				currentEmploymentEntries.length ?
					`<div class="fg-section-title fg-section-title--sticky">Current Employment (${currentEmploymentEntries.length})</div>
            <div class="fg-timeline">
              ${currentEmploymentEntries
								.map((e) => {
									const detailLine = getEmploymentDetailLine(e);
									const scopeTags = getEmploymentScopeTags(e);
									return `<div class="fg-tl-entry active-pos">
	                  <span class="fg-tl-firm">${esc(e.firmName)}${showSecReferences && e.bdSecNumber ? ` <small>SEC#${esc(String(e.bdSecNumber))}</small>` : ''}</span>
                  <span class="fg-tl-dates">${esc(e.start || '–')} → ${esc(e.end || 'present')}</span>
								  ${detailLine ? `<span class="fg-tl-loc">${esc(detailLine)}</span>` : ''}
                  ${scopeTags.length ? `<span class="fg-tl-loc" style="color:var(--text-m)">${esc(scopeTags.join(' · '))}</span>` : ''}
                </div>`;
								})
								.join('')}
            </div>`
				:	''
			}

      ${
				previousEmploymentEntries.length ?
					`<div class="fg-section-title fg-section-title--sticky">Previous Employment (${previousEmploymentEntries.length})</div>
            <div class="fg-timeline">
              ${previousEmploymentEntries
								.map((e) => {
									const cls = `fg-tl-entry${e.isCurrent ? ' active-pos' : ''}`;
									const detailLine = getEmploymentDetailLine(e);
									const scopeTags = getEmploymentScopeTags(e);
									return `<div class="${cls}">
                  <span class="fg-tl-firm">${esc(e.firmName)}${showSecReferences && e.bdSecNumber ? ` <small>SEC#${esc(e.bdSecNumber)}</small>` : ''}</span>
                  <span class="fg-tl-dates">${esc(e.start || '–')} → ${esc(e.end || 'present')}</span>
								  ${detailLine ? `<span class="fg-tl-loc">${esc(detailLine)}</span>` : ''}
								  ${scopeTags.length ? `<span class="fg-tl-loc" style="color:var(--text-m)">${esc(scopeTags.join(' · '))}</span>` : ''}
								  ${e.expelledDate ? `<span class="fg-badge inactive">Expelled ${esc(e.expelledDate)}</span>` : ''}
                </div>`;
								})
								.join('')}
            </div>`
				:	`<div class="fg-section-title fg-section-title--sticky">Previous Employment</div>
            <div class="fg-empty-state" style="margin-top:8px">No previous employment records found for this profile.</div>`
			}

      ${
				currentRegistrations.length ?
					`<div class="fg-section-title fg-section-title--sticky">Current Registrations</div>
            <div class="fg-timeline">
              ${currentRegistrations
								.map(
									(reg) => `
                <div class="fg-tl-entry active-pos">
									  <span class="fg-tl-firm">${renderRegistrationRole(reg.role)} ${esc(reg.firmName)}${reg.firmId ? ` (CRD#${esc(String(reg.firmId))})` : ''}</span>
                  ${
										reg.officeAddress ? `<span class="fg-tl-loc">${esc(reg.officeAddress)}</span>`
										: reg.cityState ? `<span class="fg-tl-loc">${esc(reg.cityState)}</span>`
										: ''
									}
                  ${reg.start ? `<span class="fg-tl-dates">Registered since ${esc(reg.start)}</span>` : ''}
                </div>`,
								)
								.join('')}
            </div>`
				:	''
			}

      ${
				previousRegistrations.length ?
					`<div class="fg-section-title fg-section-title--sticky">Previous Registrations</div>
            <div class="fg-timeline">
              ${previousRegistrations
								.map(
									(reg) => `
                <div class="fg-tl-entry">
								  <span class="fg-tl-firm">${esc(reg.firmName)}${reg.firmId ? ` (CRD#${esc(String(reg.firmId))})` : ''}</span>
                  ${reg.cityState ? `<span class="fg-tl-loc">${esc(reg.cityState)}</span>` : ''}
                  <span class="fg-tl-dates">${esc(reg.start || '–')} → ${esc(reg.end || 'present')}</span>
                </div>`,
								)
								.join('')}
            </div>`
				:	''
			}

      ${
				d.registeredSROs?.length ?
					`<details class="fg-section-toggle">
			      <summary class="fg-section-title fg-section-title--sticky">Registered SROs (${d.registeredSROs.length})</summary>
              ${d.registeredSROs
								.map((sro) => {
									const name = esc(sro.sro || sro.name || '');
									const status = sro.status ? ` <span class="fg-badge ${/approved/i.test(sro.status) ? 'active' : 'inactive'}">${esc(sro.status)}</span>` : '';
									const categories =
										Array.isArray(sro.CategoriesList) ? sro.CategoriesList
										: typeof sro.CategoriesList === 'string' ? [sro.CategoriesList]
										: [];
									const categoryItems = categories
										.flatMap((item) => String(item).split(/\s*[;,]\s*/))
										.map((item) => item.trim())
										.filter(Boolean);
									const cats = categoryItems.length ? `<ul class="fg-sro-cat-list">${categoryItems.map((cat) => `<li>${esc(cat)}</li>`).join('')}</ul>` : '';
									return `<div class="fg-detail-row"><span class="fg-label">${name}${status}</span>${cats}</div>`;
								})
								.join('')}
            </details>`
				:	''
			}

      ${
				regStates.length ?
					`<div class="fg-section-title fg-section-title--sticky">Registered States</div>
            <div class="fg-states-grid">
              ${regStates
								.map((s) => {
									const stateStr = typeof s === 'object' ? s.state || '' : String(s);
									const scope = typeof s === 'object' ? s.regScope || '' : '';
									const scopeDisplay = /^bc$/i.test(String(scope).trim()) ? '' : String(scope).trim();
									const status = typeof s === 'object' ? s.status || '' : '';
									const regDate = typeof s === 'object' ? s.regDate || '' : '';
									const cls = /approved/i.test(status) ? 'active' : 'inactive';
									return `<span class="fg-state-pill ${cls}" title="${esc([scopeDisplay, status, regDate ? `since ${regDate}` : ''].filter(Boolean).join(' | '))}">${esc(stateStr)}${scopeDisplay ? ` <small>${esc(scopeDisplay)}</small>` : ''}</span>`;
								})
								.join('')}
            </div>`
				:	''
			}

      ${
				controlLinks.length ?
					`<div class="fg-section-title fg-section-title--sticky">Control Positions</div>
						<div class="fg-control-card">
						${controlLinks
							.slice()
							.sort((a, b) =>
								compareCurrentFirstByDates(
									{
										isCurrent: !a.endDate && !a.registrationEndDate && !a.toDate,
										end: a.endDate || a.registrationEndDate || a.toDate,
										start: a.startDate || a.registrationBeginDate || a.fromDate || a.effectiveDate || a.date,
									},
									{
										isCurrent: !b.endDate && !b.registrationEndDate && !b.toDate,
										end: b.endDate || b.registrationEndDate || b.toDate,
										start: b.startDate || b.registrationBeginDate || b.fromDate || b.effectiveDate || b.date,
									},
									{ dateKeys: ['end', 'start'] },
								),
							)
							.map((l) => {
								const firmNode = graphData.nodes.find((n) => n.id === (l.target?.id || l.target));
								const employmentMatch = findEmploymentMatchForControl(l, firmNode);
								const firmId = firmNode?.firmId || String(l.firmId || l.firm_id || l.organizationId || l.orgId || '').trim() || null;
								const firmAddress =
									firmNode?.officeAddress ||
									l.officeAddress ||
									l.address ||
									employmentMatch?.addr ||
									[l.street1, l.street2, l.city, l.state, l.postalCode, l.zipCode, l.zip, l.country].filter(Boolean).join(', ') ||
									null;
								const firmStatus =
									firmNode?.firmStatus || l.firmStatus || l.status || l.registrationStatus || employmentMatch?.employmentStatus || employmentMatch?.firmBCScope || null;
								const secNumber =
									firmNode?.bdSecNumber || firmNode?.iaSecNumber || l.bdSecNumber || l.iaSecNumber || employmentMatch?.bdSecNumber || employmentMatch?.iaSECNumber || null;
								const startDate = l.startDate || l.registrationBeginDate || l.fromDate || l.effectiveDate || l.date || employmentMatch?.start || null;
								const endDate = l.endDate || l.registrationEndDate || l.toDate || employmentMatch?.end || null;
								const dateRange = startDate ? `${esc(startDate)} → ${esc(endDate || 'present')}` : null;
								const location =
									l.location ||
									employmentMatch?.loc ||
									(l.city || l.officeCity || l.state || l.officeState ? [l.city || l.officeCity, l.state || l.officeState].filter(Boolean).join(', ') : null);
								return `<div class="fg-tl-entry fg-control-card__entry active-pos">
		        <span class="fg-tl-firm fg-control-card__firm">${esc(firmNode?.label || l.firmName || employmentMatch?.firmName || l.name || l.organizationName || l.legalName || '')}${secNumber ? ` <small>SEC#${esc(String(secNumber))}</small>` : ''}</span>
	                ${dateRange ? `<span class="fg-tl-dates fg-control-card__date"><strong>${dateRange}</strong></span>` : ''}
	                ${firmStatus ? `<span class="fg-tl-status fg-control-card__status"><strong>${esc(firmStatus)}</strong></span>` : ''}
	                ${l.position ? `<span class="fg-tl-loc fg-control-card__position"><strong>${esc(l.position)}</strong></span>` : ''}
	                ${location ? `<span class="fg-tl-loc fg-control-card__location">${esc(location)}</span>` : ''}
	                ${firmAddress ? `<span class="fg-tl-loc fg-control-card__address">${esc(firmAddress)}</span>` : ''}
	              </div>`;
							})
							.join('')}
					</div>`
				:	''
			}

      ${
				allExams.length ?
					`<div class="fg-section-title fg-section-title--sticky">Qualifications &amp; Exams (${allExams.length})</div>
            <div class="fg-timeline">
              ${allExams
								.map((ex) => {
									const examScopeDisplay = /^bc$/i.test(String(ex.examScope || '').trim()) ? '' : String(ex.examScope || '').trim();
									return `
                <div class="fg-tl-entry">
                  <span class="fg-tl-firm">${esc(ex.examCategory || '')} – ${esc(ex.examName || '')}</span>
                  ${ex.examTakenDate ? `<span class="fg-tl-dates">Passed: ${esc(ex.examTakenDate)}</span>` : ''}
									  ${examScopeDisplay ? `<span class="fg-tl-loc">${esc(examScopeDisplay)}</span>` : ''}
                </div>`;
								})
								.join('')}
            </div>`
				:	''
			}

      ${
				allDisclosures.length ?
					`<details class="fg-section-toggle">
					  <summary class="fg-section-title fg-section-title--sticky">Disclosures (${allDisclosures.length})</summary>
					  ${allDisclosures.map(renderDisclosure).join('')}
					</details>`
				: d.disclosureFlag === 'Y' || d.iaDisclosureFlag === 'Y' ?
					`<details class="fg-section-toggle">
					  <summary class="fg-section-title fg-section-title--sticky">Disclosures</summary>
					  <p class="fg-sb-note">FINRA or SEC marks this record as having disclosures, but the current API response did not include structured disclosure bodies for this profile.</p>
					  <div class="fg-ext-links">
						${brokerCheckSummaryUrl ? `<a class="fg-ext-link bc" href="${brokerCheckSummaryUrl}" target="_blank" rel="noopener noreferrer">&#x2197; Open FINRA Summary</a>` : ''}
						${brokerCheckReportUrl ? `<a class="fg-ext-link bc" href="${brokerCheckReportUrl}" target="_blank" rel="noopener noreferrer">&#x2197; Open FINRA Detailed Report (PDF)</a>` : ''}
						${secSummaryUrl ? `<a class="fg-ext-link sec" href="${secSummaryUrl}" target="_blank" rel="noopener noreferrer">&#x2197; Open SEC AdvisorInfo Summary</a>` : ''}
					  </div>
					</details>`
				:	''
			}
		</div>
    </div>
  `;
}

// ── Firm detail ──────────────────────────────────────────────────────────────
function renderFirmDetail(d) {
	const owners = d.directOwners || [];
	const disclosures = d.disclosures || [];
	function parseFirmSortDateValue(value) {
		const raw = String(value || '').trim();
		if (!raw) return Number.NEGATIVE_INFINITY;
		const shortDateMatch = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
		if (shortDateMatch) {
			const [, month, day, year] = shortDateMatch;
			return Date.UTC(Number(year), Number(month) - 1, Number(day));
		}
		const parsed = Date.parse(raw);
		return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
	}

	function compareFirmDatesDesc(a, b, dateKeys: string[] = []) {
		for (const key of dateKeys) {
			const diff = parseFirmSortDateValue(b?.[key]) - parseFirmSortDateValue(a?.[key]);
			if (diff !== 0) return diff;
		}
		return String(a?.brochureName || a?.type || a?.disclosureType || '').localeCompare(String(b?.brochureName || b?.type || b?.disclosureType || ''));
	}

	const statusDate = d.firmStatusDate || '';
	const statusText = d.firmStatus ? capitalize(String(d.firmStatus || '').toLowerCase()) : '';
	const statusIsActive = d.firmStatus ? /\bactive\b|\bapproved\b/i.test(String(d.firmStatus)) : false;
	const statusIsTerminated = d.firmStatus ? /terminated|inactive|revoked|suspended/i.test(String(d.firmStatus)) : false;
	const statusClass =
		statusIsActive ? 'active'
		: statusIsTerminated ? 'terminated'
		: 'inactive';
	const statusBadge = d.firmStatus ? `<span class="fg-badge ${statusClass}">${esc(statusText)}${statusDate ? ` ${statusDate}` : ''}</span>` : '';
	const legacyBadge = d.isLegacy === 'Y' ? `<span class="fg-badge inactive">PR Previously Registered Brokerage Firm</span>` : '';
	const scopeBadge =
		d.bcScope ?
			`<span class="fg-badge ${/\b(active|approved)\b/i.test(String(d.bcScope || '').trim()) ? 'active' : 'inactive'}">${esc(capitalize(String(d.bcScope || '').toLowerCase()))}</span>`
		:	'';

	const sros = Array.isArray(d.selfRegulatoryOrgs) && d.selfRegulatoryOrgs.length ? d.selfRegulatoryOrgs.join(', ') : 'N/A';
	const states = Array.isArray(d.activeStates) && d.activeStates.length ? d.activeStates.join(', ') : 'N/A';

	const firmId = d.firmId || String(d.id).replace(/^firm[:_]/, '');
	const brokerCheckReportUrl = firmId ? `https://files.brokercheck.finra.org/firm/firm_${encodeURIComponent(firmId)}.pdf` : null;
	const bcRawUrl = firmId ? `https://api.brokercheck.finra.org/search/firm/${encodeURIComponent(firmId)}`.trim() : null;
	const secRawUrl = firmId ? `https://api.adviserinfo.sec.gov/search/firm/${encodeURIComponent(firmId)}`.trim() : null;
	const normalizeSecFirmId = (value: string | number | null | undefined) => {
		const raw = String(value || '').trim();
		if (!raw) return '';
		if (/^8-\d+$/i.test(raw)) return raw;
		if (/^\d+$/.test(raw)) return `8-${raw}`;
		return raw;
	};
	const iaSecRaw = String(d.iaSecNumber || d.basicInformation?.iaSECNumber || d.basicInformation?.iaSecNumber || '')
		.trim()
		.toUpperCase();
	const hasAdviserStyleIaSec = /^801-?\d+$/.test(iaSecRaw);
	const secScopeFlags = d.orgScopeStatusFlags || {};
	const hasPositiveSecScopeFlags =
		secScopeFlags.isSECRegistered === 'Y' ||
		secScopeFlags.isStateRegistered === 'Y' ||
		secScopeFlags.isERARegistered === 'Y' ||
		secScopeFlags.isSECERARegistered === 'Y' ||
		secScopeFlags.isStateERARegistered === 'Y';
	const hasPublicSecFirmPage = Boolean(hasPositiveSecScopeFlags || hasAdviserStyleIaSec);
	const secFirmId = normalizeSecFirmId(d.iaSecNumber || d.bdSecNumber || d.bdSECNumber || d.basicInformation?.iaSECNumber || d.basicInformation?.bdSECNumber);
	const crdSec = [firmId ? `CRD#: ${firmId}` : null, secFirmId ? `SEC#: ${secFirmId}` : null].filter(Boolean).join(' / ');
	const secSummaryUrl = firmId ? `https://adviserinfo.sec.gov/firm/summary/${encodeURIComponent(firmId)}` : null;
	const hasFinraPage = d.hasFinraData === true;
	const hasSecPage = hasPublicSecFirmPage && Boolean(firmId);
	const secDocumentLinks =
		hasSecPage ?
			(() => {
				const defaultLinks =
					firmId ?
						[
							{ label: 'SEC AdvisorInfo Summary', href: secSummaryUrl },
							{ label: 'Latest Form ADV filed', href: `https://reports.adviserinfo.sec.gov/reports/ADV/${encodeURIComponent(firmId)}/PDF/${encodeURIComponent(firmId)}.pdf` },
							{ label: 'SEC firm brochure', href: `https://adviserinfo.sec.gov/firm/brochure/${encodeURIComponent(firmId)}` },
							{ label: 'SEC Form CRS', href: `https://reports.adviserinfo.sec.gov/crs/crs_${encodeURIComponent(firmId)}.pdf` },
						]
					:	[];

				if (!Array.isArray(d.secDocumentLinks) || !d.secDocumentLinks.length) return defaultLinks;

				return d.secDocumentLinks.map((link) => {
					const label = String(link?.label || '').trim();
					if (!label) return link;
					if (/^SEC AdvisorInfo Summary$/i.test(label)) return { ...link, href: secSummaryUrl };
					if (/^Latest Form ADV filed$/i.test(label)) {
						return {
							...link,
							href: `https://reports.adviserinfo.sec.gov/reports/ADV/${encodeURIComponent(firmId)}/PDF/${encodeURIComponent(firmId)}.pdf`,
						};
					}
					if (/^SEC firm brochure$/i.test(label)) {
						return { ...link, href: `https://adviserinfo.sec.gov/firm/brochure/${encodeURIComponent(firmId)}` };
					}
					if (/^SEC Form CRS$/i.test(label)) {
						return { ...link, href: `https://reports.adviserinfo.sec.gov/crs/crs_${encodeURIComponent(firmId)}.pdf` };
					}
					return link;
				});
			})()
		:	[];
	const secSummaryDescription = hasSecPage && d.secSummaryDescription ? String(d.secSummaryDescription).trim() : '';
	const showBrokerCheckSummary = hasFinraPage;
	const disclosureTotal =
		Number.isFinite(Number(d.disclosureCount)) ? Number(d.disclosureCount) : disclosures.reduce((sum, dis) => sum + Number(dis?.count ?? dis?.disclosureCount ?? 0), 0);
	const disclosureLabel = disclosureTotal === 1 ? 'Disclosure' : 'Disclosures';
	const disclosureBadge = disclosureTotal > 0 ? `<span class="fg-badge inactive">${disclosureLabel} ${esc(String(disclosureTotal))}</span>` : '';
	const hasAffiliateDisclosureSummary = Boolean(d.affiliateDisclosures);
	const sortedBrochures = Array.isArray(d.brochures) ? d.brochures.slice().sort((a, b) => compareFirmDatesDesc(a, b, ['dateSubmitted'])) : [];
	const officeAddressRaw = String(d.officeAddress || '').trim();
	const officeAddress = /^(?:-|n\/?a|na|none|null|undefined)$/i.test(officeAddressRaw) ? '' : officeAddressRaw;
	const hasOfficeAddress = Boolean(officeAddress);
	const businessPhone = String(d.businessPhone || '').trim();
	const districtLabel = String(d.districtName || '').trim();
	const finraSummaryLabel = `Brokerage Firm${districtLabel ? ` Regulated by FINRA (${districtLabel})` : ' Regulated by FINRA'}`;
	const secSummaryLabel = 'Investment Adviser Firm';
	const topSummaryRoleHtml = `
		<div class="fg-firm-summary__roles">
			<div class="fg-firm-summary__role">
				<span class="fg-firm-summary__role-icon fg-firm-summary__role-icon--broker" aria-hidden="true">B</span>
				<div class="fg-firm-summary__role-copy">
					<div class="fg-firm-summary__role-title">${esc(finraSummaryLabel)}</div>
				</div>
			</div>
			${
				hasSecPage ?
					`
			<div class="fg-firm-summary__role">
				<span class="fg-firm-summary__role-icon fg-firm-summary__role-icon--ia" aria-hidden="true">IA</span>
				<div class="fg-firm-summary__role-copy">
					<div class="fg-firm-summary__role-title">${esc(secSummaryLabel)}</div>
				</div>
			</div>`
				:	''
			}
		</div>`;

	return `
		<div class="fg-sb-header firm">
			<div class="fg-sb-title-row">
				<div class="fg-sb-title">${esc(getPreferredNodeLabel(d))}</div>
			</div>
			${crdSec ? `<div class="fg-sb-crd">${crdSec}</div>` : ''}
      <div class="fg-sb-badges">
        ${legacyBadge}
        ${(() => {
					if (d.firmSize && d.firmStatus) {
						const combined = `${esc(firmSizeLabel(d.firmSize))} - ${esc(statusText)}`;
						return `<span class="fg-badge ${statusClass}">${combined}</span>`;
					}
					return `${statusBadge}${d.firmSize ? `<span class="fg-badge">${esc(firmSizeLabel(d.firmSize))}</span>` : ''}`;
				})()}
        ${scopeBadge}
        ${disclosureBadge}
      </div>
			<div class="fg-sb-role-summary">
				${topSummaryRoleHtml}
			</div>
			<div class="fg-sb-title-actions fg-sb-title-actions--below-tags">
				${renderMobileSidebarToggle()}
				${renderSidebarSelectionLogToggle()}
			</div>
    </div>
    <div class="fg-sb-body">
			<div class="fg-firm-summary">
				<div class="fg-firm-summary__header">
					${d.otherNames?.length ? `<div class="fg-firm-summary__aliases">${esc(d.otherNames.join(', '))}</div>` : ''}
					${crdSec ? `<div class="fg-firm-summary__crd">${esc(crdSec)}</div>` : ''}
				</div>
				${
					hasOfficeAddress ?
						`<div class="fg-firm-summary__grid">
							<div class="fg-firm-summary__panel fg-firm-summary__panel--address">
								<div class="fg-firm-summary__panel-title">Main Address</div>
								<div class="fg-firm-summary__address">${esc(officeAddress)}</div>
							</div>
						</div>`
					:	''
				}
			</div>
      <div class="fg-ext-links">
        ${showBrokerCheckSummary ? `<a class="fg-ext-link bc" href="https://brokercheck.finra.org/firm/summary/${encodeURIComponent(firmId)}" target="_blank" rel="noopener noreferrer">&#x2197; FINRA Summary</a>` : ''}
        ${secDocumentLinks
					.map((link) => (link?.href ? `<a class="fg-ext-link sec" href="${esc(link.href)}" target="_blank" rel="noopener noreferrer">&#x2197; ${esc(link.label)}</a>` : ''))
					.join('')}
      </div>
			<div class="fg-sb-copy-below-links">
      ${secSummaryDescription ? `<div class="fg-section-title fg-section-title--sticky">SEC summary</div><p class="fg-sb-note">${esc(secSummaryDescription)}</p>` : ''}
			${d.isLegacy === 'Y' ? `<p class="fg-sb-note">Not currently registered as broker. FINRA contains only limited information about this firm.</p>` : ''}
			${
				hasOfficeAddress || businessPhone ?
					`<div class="fg-section-title fg-section-title--sticky">Contact</div>
					${hasOfficeAddress ? row('Address', esc(officeAddress)) : ''}
					${businessPhone ? row('Phone', esc(businessPhone)) : ''}`
				:	''
			}
			</div>
      <div class="fg-section-title fg-section-title--sticky">Registration</div>
			${row('ID source check', esc(formatNodeSourceTruthSummary(d)))}
			${row('SEC Registration Status', d.firmStatus ? esc(d.firmStatus) + (statusDate ? ` (${statusDate})` : '') : '–')}
			${d.districtName ? row('FINRA District', esc(d.districtName)) : ''}
			${row('Company Type', esc(d.firmType || 'N/A'))}
			${row('Self-Regulatory Orgs', esc(sros))}
			${row(
				'U.S. States &amp; Territories',
				states !== 'N/A' ? esc(states)
				: d.activeStates?.length ? `${d.activeStates.length} states/territories`
				: 'N/A',
			)}
      ${row('Regulator', esc(d.regulator || '–'))}
			<div class="fg-section-title fg-section-title--sticky">General Information</div>
      ${row('Established in', d.formedState ? `${esc(d.formedState)}${d.formedDate ? ' since ' + d.formedDate : ''}` : '–')}
      ${row('Type', esc(d.firmType || '–'))}
      ${row('Fiscal Year End', esc(d.fiscalYearEnd || '–'))}
      ${
				sortedBrochures.length ?
					`
				<div class="fg-section-title fg-section-title--sticky">Form ADV Brochures</div>
						${sortedBrochures
							.slice(0, 5)
							.map((b) => `<div class="fg-detail-row"><span class="fg-label">${esc(b.brochureName || '')}</span><span>${esc(b.dateSubmitted || '')}</span></div>`)
							.join('')}
      `
				:	''
			}

      ${
				disclosures.length || disclosureTotal > 0 || hasAffiliateDisclosureSummary ?
					`
        <div class="fg-section-title fg-section-title--sticky">Disclosures</div>
					<div class="fg-disclosure">
						${disclosures
							.map(
								(dis) => `
							<div class="fg-dis-header">
								<span class="fg-dis-type">${esc(dis.type || dis.disclosureType || '')}:</span>
							</div>
							<div class="fg-dis-row"><span class="fg-dis-label">Total Disclosure</span> ${esc(String(dis.count ?? dis.disclosureCount ?? ''))}</div>
						`,
							)
							.join('')}
						${
							disclosureTotal > 0 && !disclosures.length ?
								`<div class="fg-dis-header">
								<span class="fg-dis-type">Total Disclosure</span>
							</div>
							<div class="fg-dis-row">${esc(String(disclosureTotal))}</div>`
							:	''
						}
						${
							disclosureTotal > 0 ?
								`<div class="fg-dis-row">For details of these disclosures as well as disclosures involving non-registered affiliated entities refer to the Detailed Report${brokerCheckReportUrl ? ` <a class="fg-ext-link bc" href="${brokerCheckReportUrl}" target="_blank" rel="noopener noreferrer">&#x2197; FINRA Detailed Report (PDF)</a>` : ''}. For disclosures involving registered affiliated entities visit the BrokerCheck page for those firms.</div>`
							:	''
						}
						${
							hasAffiliateDisclosureSummary ?
								`<div class="fg-dis-header">
								<span class="fg-dis-type">Affiliate Disclosure (registered)</span>
							</div>
							<div class="fg-dis-row"><span class="fg-dis-label">Count:</span> ${esc(String(d.affiliateDisclosures.registeredAffiliateDisclosureCount ?? 0))}</div>
							<div class="fg-dis-header">
								<span class="fg-dis-type">Affiliate Disclosure (non-registered)</span>
							</div>
							<div class="fg-dis-row"><span class="fg-dis-label">Count:</span> ${esc(String(d.affiliateDisclosures.nonRegisteredAffiliateDisclosureCount ?? 0))}</div>`
							:	''
						}
					</div>
      `
				:	''
			}

      ${
				owners.length ?
					`
        <div class="fg-section-title fg-section-title--sticky">Form BD — Direct Owners &amp; Executive Officers</div>
        ${owners
					.map(
						(o) => `
          <div class="fg-owner-row">
            <span class="fg-owner-name">${esc(o.legalName || '')}</span>
            <span class="fg-owner-pos">${esc(o.position || '')}</span>
            ${o.crdNumber ? `<a class="fg-owner-crd" href="https://brokercheck.finra.org/individual/summary/${encodeURIComponent(o.crdNumber)}" target="_blank" rel="noopener noreferrer">CRD ${o.crdNumber}</a>` : ''}
          </div>
        `,
					)
					.join('')}
      `
				:	''
			}
    </div>
  `;
}

// ── Entity detail ────────────────────────────────────────────────────────────
function renderEntityDetail(d) {
	return `
    <div class="fg-sb-header entity">
		<div class="fg-sb-title-row">
	<div class="fg-sb-title">${esc(getPreferredNodeLabel(d))}</div>
		</div>
      <div class="fg-sb-badges">
        <span class="fg-badge">Entity</span>
        ${d.bcScope ? `<span class="fg-badge">${esc(d.bcScope)}</span>` : ''}
      </div>
		<div class="fg-sb-title-actions fg-sb-title-actions--below-tags">
			${renderMobileSidebarToggle()}
			${renderSidebarSelectionLogToggle()}
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
			color: 'var(--c-individual)',
			label: 'Individual',
		},
		{
			color: GRAPH_COLORS.nodeInactive,
			shape: 'circle-inactive',
			label: 'Inactive node',
			opacity: 0.82,
		},
		{
			color: 'var(--c-individual)',
			shape: 'circle-s',
			label: 'Stub (Form BD only)',
			opacity: 0.45,
		},
		{ color: 'var(--c-firm)', shape: 'rect', label: 'Firm' },
		{ color: GRAPH_COLORS.lineEmployedBy, shape: 'line', label: 'Current emp/reg' },
		{ color: GRAPH_COLORS.linePreviousEmployment, shape: 'line-dashed', label: 'Previous emp/reg' },
		{ color: GRAPH_COLORS.lineControls, shape: 'line', label: 'Controls (From BD, Red)' },
		{ color: GRAPH_COLORS.lineDisclosure, shape: 'ring', label: 'Has disclosures' },
	];

	const legendMarkup = items
		.map(({ color, shape, label, opacity = 1 }) => {
			let svg;
			if (shape === 'circle' || shape === 'circle-s') {
				svg = `<svg width="16" height="16"><circle cx="8" cy="8" r="7" fill="${color}" opacity="${opacity}" stroke="#fff" stroke-width="1.5"/></svg>`;
			} else if (shape === 'circle-inactive') {
				svg = `<svg width="16" height="16"><circle cx="8" cy="8" r="7" fill="${color}" opacity="${opacity}" stroke="${GRAPH_COLORS.nodeInactiveStroke}" stroke-width="1.5"/></svg>`;
			} else if (shape === 'rect') {
				svg = `<svg width="16" height="16"><rect x="2" y="2" width="12" height="12" rx="2" fill="${color}" stroke="#fff" stroke-width="1.5" opacity="0.9"/></svg>`;
			} else if (shape === 'diamond') {
				svg = `<svg width="16" height="16"><polygon points="8,1 15,8 8,15 1,8" fill="${color}" stroke="#fff" stroke-width="1.5" opacity="0.8"/></svg>`;
			} else if (shape === 'ring') {
				svg = `<svg width="16" height="16"><circle cx="8" cy="8" r="6" fill="none" stroke="${color}" stroke-width="2" stroke-dasharray="3 2"/></svg>`;
			} else if (shape === 'line-dashed') {
				svg = `<svg width="16" height="4"><line x1="0" y1="2" x2="16" y2="2" stroke="${color}" stroke-width="1.5" stroke-dasharray="4 3"/></svg>`;
			} else {
				svg = `<svg width="16" height="4"><line x1="0" y1="2" x2="16" y2="2" stroke="${color}" stroke-width="1.5"/></svg>`;
			}
			return `<div class="fg-legend-item">${svg}<span>${label}</span></div>`;
		})
		.join('');

	Array.from(document.querySelectorAll<HTMLElement>('#fg-legend, #fg-mobile-legend')).forEach((legend) => {
		legend.innerHTML = legendMarkup;
	});
}

// ── Resize ────────────────────────────────────────────────────────────────────
function onResize() {
	if (!graphData) return;
	// Just update the viewBox — no re-simulation, positions stay frozen
	const main = document.getElementById('fg-main');
	const W = main.clientWidth;
	const H = main.clientHeight;
	d3.select('#fg-svg').attr('viewBox', `0 0 ${W} ${H}`);
	try {
		ensureGraphViewportVisible({ duration: 0 });
	} catch {
		// non-critical
	}
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function esc(str) {
	return escImpl(str);
}

function normalizePersonLabel(str) {
	return normalizePersonLabelImpl(str);
}

function formatNodeLabel(str) {
	return formatNodeLabelImpl(str);
}

function capitalize(str) {
	return capitalizeImpl(str);
}

function formatUiText(str) {
	return formatUiTextImpl(str);
}

function formatLocationText(str) {
	return formatLocationTextImpl(str);
}

function truncate(str, n) {
	return truncateImpl(str, n);
}

// Return a human-friendly firm size label. Accepts numeric or textual values.
function firmSizeLabel(size) {
	return firmSizeLabelImpl(size);
}

function openSidebarToggles() {
	return openSidebarTogglesImpl();
}

function row(label, value, extraClass = '') {
	return rowImpl(label, value, extraClass);
}
