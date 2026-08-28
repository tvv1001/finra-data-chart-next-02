/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * finra.ts  –  FINRA BrokerCheck Network Graph
 */

import * as d3Module from 'd3';
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
	formatOtherName as formatOtherNameImpl,
	openSidebarToggles as openSidebarTogglesImpl,
	row as rowImpl,
	truncate as truncateImpl,
	safeJoin as safeJoinImpl,
} from './finra-graph/formatters';
import {
	DEFAULT_CLICK_EXPANSION_HOPS,
	DEFAULT_EXPANSION_HOPS,
	DEFAULT_NODE_LABEL_FONT_SIZE,
	DEFAULT_NODE_LABEL_FONT_SIZE_PX,
	DEFAULT_NODE_LABEL_FONT_WEIGHT,
	DEFAULT_NODE_LABEL_GAP_PX,
	DEFAULT_SELECTION_HOPS,
	getRuntimeHopDefaults,
	setRuntimeHopDefaults,
} from './finra-graph-defaults';
import { mergeGraphNodesForAppend } from './graphIdentity';
import { isValidLocationStateFilter, isZipLikeLocationQuery, normalizeLocationStateFilter } from './locationSearch';
import { buildParentFirmSummaryLinks } from './finra-graph/externalLinks';
import { resolveIndividualSourceDetail, hasIndividualSourceCoverage } from './sourceTruth';
import { normalizeNodeRouteId, buildNodeRoutePath } from './node-route';
import { requestRender } from './finra-graph-canvas';
import {
	getFilterEnabled,
	getFilterTags,
	getFilterText,
	matchesFilterTags,
	setFilterEnabled,
	setFilterTags,
	setFilterText,
	shouldPreviewUnfilteredConnections,
	subscribeFilterEnabled,
	subscribeFilterTags,
	subscribeFilterText,
} from './filterTags';

// API base. When VITE_API_URL is not set, use relative paths so the dev
// server proxy (`/api`) is used and we don't hardcode a backend port.
const BASE = (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_API_URL) || '';

// Firms known to have broken or unreachable FINRA/BrokerCheck summary pages.
// Add CRD numbers here to suppress FINRA links for those firms.
const BROKEN_FINRA_FIRM_IDS = new Set(['134139', '298880', '314694', '325639']);
// Individual IDs for which SEC AdvisorInfo links should be suppressed.
// Add numeric individual CRD-like ids (no prefix) here when upstream SEC pages are incorrect or undesirable.
const SUPPRESSED_SEC_INDIV_IDS = new Set(['18040']);
// Firm IDs for which SEC AdvisorInfo links should be suppressed.
// Add numeric firm CRD-like ids (no prefix) here when upstream SEC pages are unavailable or incorrect.
const SUPPRESSED_SEC_FIRM_IDS = new Set(['4039', '25156', '36773']);

// Simple once-only logger sets to avoid spamming the console during render loops.
const _loggedBadNodeCoords = new Set<string | number>();
const _loggedBadTransforms = new Set<string>();

function _logOnce(set: Set<any>, key: any, level: 'warn' | 'info' | 'error', ...args: any[]) {
	try {
		const k = typeof key === 'string' || typeof key === 'number' ? String(key) : JSON.stringify(key);
		if (set.has(k)) return;
		set.add(k);
	} catch (e) {
		// ignore serialization errors
	}
	// keep logs conspicuous and searchable
	if (level === 'warn') console.warn('[finra-graph]', ...args);
	else if (level === 'error') console.error('[finra-graph]', ...args);
	else console.info('[finra-graph]', ...args);
}

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
	nodeControls: 'var(--color-highlight-controls)',
	lineEmployedBy: 'var(--color-highlight-employed)',
	lineControls: 'var(--color-highlight-controls)',
	lineControlsHighlight: 'rgba(200, 45, 2, 0.615)',
	lineDisclosure: 'rgba(57, 243, 10, 0.818)',
	lineInactive: 'var(--color-default-line)',
	lineNeutral: 'var(--color-default-line)',
	linePreviousEmployment: 'var(--color-default-line)',
	nodeFirmEmployedStroke: 'var(--color-node-firm-employed-stroke)',
	nodeFirmControlsStroke: 'var(--color-node-firm-controls-stroke)',
};

const ENABLE_DETAIL_LOAD_DEBUG_LOGS = typeof process !== 'undefined' && process.env.NEXT_PUBLIC_FINRA_GRAPH_DEBUG === '1';

const NODE_STROKE_WIDTH_DEFAULT = 'var(--stroke-width-node-default)';
const NODE_OPACITY_STUB = 'var(--opacity-node-stub)';
const SOFT_LOCATION_GROUPING_ENABLED = true;

const STATE_NAME_TO_CODE = {
	'alabama': 'AL',
	'alaska': 'AK',
	'arizona': 'AZ',
	'arkansas': 'AR',
	'california': 'CA',
	'colorado': 'CO',
	'connecticut': 'CT',
	'delaware': 'DE',
	'district of columbia': 'DC',
	'florida': 'FL',
	'georgia': 'GA',
	'hawaii': 'HI',
	'idaho': 'ID',
	'illinois': 'IL',
	'indiana': 'IN',
	'iowa': 'IA',
	'kansas': 'KS',
	'kentucky': 'KY',
	'louisiana': 'LA',
	'maine': 'ME',
	'maryland': 'MD',
	'massachusetts': 'MA',
	'michigan': 'MI',
	'minnesota': 'MN',
	'mississippi': 'MS',
	'missouri': 'MO',
	'montana': 'MT',
	'nebraska': 'NE',
	'nevada': 'NV',
	'new hampshire': 'NH',
	'new jersey': 'NJ',
	'new mexico': 'NM',
	'new york': 'NY',
	'north carolina': 'NC',
	'north dakota': 'ND',
	'ohio': 'OH',
	'oklahoma': 'OK',
	'oregon': 'OR',
	'pennsylvania': 'PA',
	'rhode island': 'RI',
	'south carolina': 'SC',
	'south dakota': 'SD',
	'tennessee': 'TN',
	'texas': 'TX',
	'utah': 'UT',
	'vermont': 'VT',
	'virginia': 'VA',
	'washington': 'WA',
	'west virginia': 'WV',
	'wisconsin': 'WI',
	'wyoming': 'WY',
	'puerto rico': 'PR',
	'virgin islands': 'VI',
	'guam': 'GU',
	'american samoa': 'AS',
	'northern mariana islands': 'MP',
};

// Toggle: enable graph-derived connections (layout/graph inference) in the
// sidebar. Default is disabled to avoid surfacing inferred/derived edges that
// come from cache/graph artifacts. Enable by setting
// NEXT_PUBLIC_ENABLE_GRAPH_DERIVED_CONNECTIONS=1 in the environment if you
// explicitly want graph-derived connections back.
const ENABLE_GRAPH_DERIVED_CONNECTIONS =
	typeof process !== 'undefined' &&
	(String(process.env.NEXT_PUBLIC_ENABLE_GRAPH_DERIVED_CONNECTIONS || '').trim() === '1' ||
		String(process.env.NEXT_PUBLIC_ENABLE_GRAPH_DERIVED_CONNECTIONS || '')
			.trim()
			.toLowerCase() === 'true');

const STATE_CODES = new Set(Object.values(STATE_NAME_TO_CODE));

const LOCATION_REGION_ANCHORS = {
	west: { x: 0.19, y: 0.43 },
	midwest: { x: 0.45, y: 0.34 },
	northeast: { x: 0.73, y: 0.25 },
	southeast: { x: 0.72, y: 0.66 },
	southwest: { x: 0.42, y: 0.72 },
	territory: { x: 0.56, y: 0.82 },
};

const STATE_REGION_MAP = {
	WA: 'west',
	OR: 'west',
	CA: 'west',
	NV: 'west',
	ID: 'west',
	UT: 'west',
	AZ: 'west',
	AK: 'west',
	HI: 'west',
	MT: 'west',
	WY: 'west',
	CO: 'west',
	NM: 'southwest',
	TX: 'southwest',
	OK: 'southwest',
	KS: 'midwest',
	NE: 'midwest',
	SD: 'midwest',
	ND: 'midwest',
	MN: 'midwest',
	IA: 'midwest',
	MO: 'midwest',
	WI: 'midwest',
	IL: 'midwest',
	IN: 'midwest',
	MI: 'midwest',
	OH: 'midwest',
	KY: 'southeast',
	TN: 'southeast',
	AR: 'southeast',
	LA: 'southeast',
	MS: 'southeast',
	AL: 'southeast',
	GA: 'southeast',
	FL: 'southeast',
	SC: 'southeast',
	NC: 'southeast',
	VA: 'southeast',
	WV: 'southeast',
	MD: 'northeast',
	DE: 'northeast',
	PA: 'northeast',
	NJ: 'northeast',
	NY: 'northeast',
	CT: 'northeast',
	RI: 'northeast',
	MA: 'northeast',
	VT: 'northeast',
	NH: 'northeast',
	ME: 'northeast',
	DC: 'northeast',
	PR: 'territory',
	VI: 'territory',
	GU: 'territory',
	AS: 'territory',
	MP: 'territory',
};

const LOCATION_SOURCE_STRENGTH = {
	current_office: 0.92,
	office_address: 0.88,
	registered_state: 0.72,
	basic_state: 0.62,
	formed_state: 0.5,
	district: 0.46,
};

const ENABLE_SERVER_PROFILE_SYNC = typeof process !== 'undefined' && process.env.NEXT_PUBLIC_ENABLE_SERVER_PROFILE_SYNC === '1';

// Safely build an absolute URL for API calls. When `BASE` is empty the
// browser `location.origin` will be used so `new URL` never throws.
function makeApiUrl(path) {
	const p = path.startsWith('/') ? path : `/${path}`;
	let base = BASE || '';
	if (typeof location !== 'undefined') {
		const origin = location.origin;
		const searchParams = new URLSearchParams(location.search);
		if (searchParams.get('localApi') === '1' || searchParams.get('localApi') === 'true') {
			base = 'http://localhost:4444';
		} else if (!base) {
			base = origin;
		} else {
			try {
				const candidate = new URL(base);
				if (origin.startsWith('https:') && candidate.protocol === 'http:') {
					base = origin;
				}
			} catch {
				base = origin;
			}
		}
	}
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

let d3 = d3Module;

type GraphSimulationNode = {
	id: string | number;
	x?: number;
	y?: number;
	fx?: number | null;
	fy?: number | null;
	group?: string;
	_deg?: { total?: number };
	_locationBiasX?: number;
	_locationBiasY?: number;
	_locationBiasStrength?: number;
	[key: string]: any;
};

type GraphSimulationLink = {
	source?: any;
	target?: any;
	relationship?: string;
	[key: string]: any;
};

// ── State ──────────────────────────────────────────────────────────────────
let graphData = null; // { nodes, links, meta } — full dataset
let simulation = null;
let selectedId = null;
let hoveredNodeId = null;
let focusedNodeId = null;
let highlightedSelections = []; // [{ id, hops }] — hop/line highlight roots (cleared by Clear Highlight)
/** Nodes the user has selected/expanded — keep `.selected` chrome even after Clear Highlight (lines only). */
let persistentSelectedIds = new Set<string>();
let visitedNodeIds = new Set();
let linkSel = null; // current <line> selection
let nodeSel = null; // current <g.fg-node> selection
let arrowSel = null; // current top-line marker selection
let layoutNodes: GraphSimulationNode[] | null = null; // node objects with x/y positions
let layoutLinks: GraphSimulationLink[] | null = null; // link objects (source/target resolved to objects)
let fullAdjacencyMap = null; // Map<nodeId, Array<{ nodeId, link }>> — cached full graph adjacency
let spreadAnimId = null; // rAF handle for neighbor spread animation
let spreadReleaseTimer = null; // timeout released when reheat freeze animation expires
let activeSpreadFrozenNodes = []; // nodes frozen during click spread/reveal reheat
let nodePinReleaseTimer = null; // timeout for pinned-node reheat decay
let isSubsetMode = false; // true when only a random sample is rendered
let neighborMap = null; // Map<nodeId, Set<nodeId>> — rebuilt each renderGraph
let nodeGroup = null; // <g.fg-nodes> selection — for live node injection
let linkGroup = null; // <g.fg-links> selection — for live link injection
let arrowGroup = null; // <g.fg-arrowheads> selection — for top-layer arrowheads
let linkBottomGroup = null;
let linkMidGroup = null;
let linkTopGroup = null;
let arrowBottomGroup = null;
let arrowMidGroup = null;
let arrowTopGroup = null;
let rootGroup = null; // <g.fg-root> selection — for zoom/state-driven graph styling
let allowFirstFetchZoom = false; // only auto-zoom on the first user fetch into an empty graph
// D3 references needed for restoring zoom state
let svgSel = null; // d3 selection for #fg-svg
let zoomBehavior = null; // d3.zoom() instance
let zoomSaveTimer = null; // debounce timer for zoom-state persistence
let refreshLayoutStopTimer = null; // timer used to stop refresh-layout sooner
let refreshFinalizeLayoutFn: (() => void) | null = null; // referenced finalize function for refresh layout
let selectionRestoreTimer = null; // timer used when restoring a saved selection after reload
let traceRefreshTimer: ReturnType<typeof setTimeout> | null = null; // trailing trace refresh when async reveals land after selection
let nodePulseTimer = null; // timer used to pulse the restored node after focus animation
let nodePulseInterval = null; // interval used to keep the restored node pulsing until interaction
let sessionSaveTimer: number | null = null;
let nodePulseInteractionCleanup: (() => void) | null = null; // removes reload pulse interaction listeners once the user interacts
let searchPulseInterval: number | null = null; // interval used to keep the current find-match pulsing until enter
let lastArrowNavCoord: { x: number; y: number } | null = null; // track last whitespace click for arrow nav origin
let activeLabelZoomThreshold = 0.3;
let inactiveLabelCompactZoomThreshold = 0.42;
let inactiveLabelCompactMode = false;
let graphTickFrameId: number | null = null;
let networkStatusListenerBound = false;
const OFFLINE_FETCH_STATUS_MESSAGE = 'Offline — reconnect to load graph data.';
const FIND_NODE_MIN_SCALE = 1.35;

function isBrowserOffline() {
	return typeof navigator !== 'undefined' && navigator.onLine === false;
}

function showOfflineFetchStatus() {
	if (activeFetchStatusMessage === OFFLINE_FETCH_STATUS_MESSAGE) return;
	activeFetchStatusMessage = OFFLINE_FETCH_STATUS_MESSAGE;
	applyStatusPresentation(OFFLINE_FETCH_STATUS_MESSAGE, { transient: true, dismissible: true, pinned: activeFetchStatusPinned });
}

function clearOfflineFetchStatus() {
	if (activeFetchStatusMessage !== OFFLINE_FETCH_STATUS_MESSAGE) return;
	clearFetchStatus();
}
// Render modes for node labels. compact mode still uses text, but without disabling labels entirely.
let nodeLabelRenderMode: 'full' | 'compact' = 'full';
// Canvas renderer mode for very large graphs
let canvasModeActive = false;
let canvasApi: any = null;
let pixiModeActive = true;
let pixiApi: any = null;
let overlayApi: any = null;
let overlayRefreshFrameCounter = 0;
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

function getCurrentZoomTransform() {
	try {
		if (!svgSel?.node || !d3?.zoomTransform) return { x: 0, y: 0, k: 1 };
		const t = d3.zoomTransform(svgSel.node());
		return { x: t.x || 0, y: t.y || 0, k: t.k || 1 };
	} catch {
		return { x: 0, y: 0, k: 1 };
	}
}

function getFocusedLabelScale(zoomScale: number | string | null | undefined): number {
	const normalizedScale = Math.max(0.01, Number(zoomScale) || 1);
	const baseScale = 1.6;
	const dynamicScale = normalizedScale < activeLabelZoomThreshold ? baseScale * (activeLabelZoomThreshold / normalizedScale) : baseScale;
	return Math.min(dynamicScale, 15.0);
}

export function getSelectionLinkEmphasis(zoomScale = getCurrentGraphZoomScale()) {
	const normalizedScale = Math.max(0.18, Math.min(1, Number(zoomScale) || 1));
	const zoomWeight = Math.max(0, Math.min(1, (normalizedScale - 0.18) / 0.82));

	return {
		strokeWidthScale: 0.52 + zoomWeight * 0.42,
		strokeOpacity: 0.8 + zoomWeight * 0.16,
		showActiveFilter: normalizedScale >= 0.45,
	};
}

export function getSelectionLinkOpacity(d, selectionLinkEmphasis, options: { connected?: boolean } = {}) {
	const isGrayLine = hasInactiveEndpoint(d) || isPreviousEmploymentLink(d) || isForcedGrayConnectionLink(d);
	if (isGrayLine) {
		return 0.84;
	}
	if (options.connected) {
		return selectionLinkEmphasis.strokeOpacity;
	}
	return 0.5 * selectionLinkEmphasis.strokeOpacity;
}

function syncTraceLabelPresentation(zoomScale = getCurrentGraphZoomScale()) {
	if (typeof document !== 'undefined') {
		document.documentElement.style.setProperty('--fg-node-label-font-size', DEFAULT_NODE_LABEL_FONT_SIZE);
		document.documentElement.style.setProperty('--fg-node-label-font-weight', DEFAULT_NODE_LABEL_FONT_WEIGHT);
	}

	if (!rootGroup) return;
	const traceActive = isAnyTraceModeActive();
	const normalizedScale = Math.max(0.1, Number(zoomScale) || 1);
	const dynamicScale = getFocusedLabelScale(normalizedScale);
	const globalLabelScale = dynamicScale;
	const traceLabelScale = traceActive ? dynamicScale : 1;
	const selectionLogLabelScale = isSelectionLogBold ? dynamicScale : 1;

	rootGroup
		.classed('fg-trace-labels', traceActive)
		.classed('fg-selection-log-labels', isSelectionLogBold)
		.classed('fg-labels-hidden', normalizedScale < activeLabelZoomThreshold)
		.style('--fg-node-label-font-size', DEFAULT_NODE_LABEL_FONT_SIZE)
		.style('--fg-node-label-font-weight', DEFAULT_NODE_LABEL_FONT_WEIGHT)
		.style('--fg-global-label-scale', String(globalLabelScale))
		.style('--fg-trace-label-scale', String(traceLabelScale))
		.style('--fg-selection-log-label-scale', String(selectionLogLabelScale))
		.style('--fg-current-zoom', String(normalizedScale));

	// Hide all node labels when zoomed out below threshold.
	const labelGroup = rootGroup.select('.fg-label-group');
	if (labelGroup && labelGroup.size()) {
		labelGroup.classed('fg-labels-hidden', normalizedScale < activeLabelZoomThreshold);
	}

	updateInactiveLabelZoomState(rootGroup, normalizedScale);
}

export function setGraphLabelRenderMode(_nodeCount = layoutNodes?.length || 0) {
	// The reduced-detail graph presentation is now the default experience: it keeps
	// the layout responsive while preserving readable node labels and selected-node
	// focus states.
	nodeLabelRenderMode = 'compact';
}

function animateToWasmPositions(duration = 2500) {
	if (simulation) simulation.stop();
	if (graphTickFrameId != null) {
		cancelAnimationFrame(graphTickFrameId);
		graphTickFrameId = null;
	}
	if (nodeSel) {
		nodeSel
			.transition()
			.duration(duration)
			.ease(d3.easeCubicOut)
			.attr('transform', (d) => `translate(${Number.isFinite(d.x) ? d.x : 0},${Number.isFinite(d.y) ? d.y : 0})`);
	}
	if (linkSel) {
		linkSel
			.transition()
			.duration(duration)
			.ease(d3.easeCubicOut)
			.attr('x1', (d) => (Number.isFinite(d.source?.x) ? d.source.x : 0))
			.attr('y1', (d) => (Number.isFinite(d.source?.y) ? d.source.y : 0))
			.attr('x2', (d) => (Number.isFinite(d.target?.x) ? d.target.x : 0))
			.attr('y2', (d) => (Number.isFinite(d.target?.y) ? d.target.y : 0));
	}
	if (arrowSel) {
		arrowSel
			.transition()
			.duration(duration)
			.ease(d3.easeCubicOut)
			.attr('x1', (d) => (Number.isFinite(d.source?.x) ? d.source.x : 0))
			.attr('y1', (d) => (Number.isFinite(d.source?.y) ? d.source.y : 0))
			.attr('x2', (d) => (Number.isFinite(d.target?.x) ? d.target.x : 0))
			.attr('y2', (d) => (Number.isFinite(d.target?.y) ? d.target.y : 0));
	}
}

function updateGraphTickPositions(linkSelection, nodeSelection, arrowSelection) {
	if (!linkSelection || !nodeSelection) return;
	linkSelection
		.attr('x1', (d) => (Number.isFinite(d.source?.x) ? d.source.x : 0))
		.attr('y1', (d) => (Number.isFinite(d.source?.y) ? d.source.y : 0))
		.attr('x2', (d) => (Number.isFinite(d.target?.x) ? d.target.x : 0))
		.attr('y2', (d) => (Number.isFinite(d.target?.y) ? d.target.y : 0));
	if (arrowSelection) {
		arrowSelection
			.attr('x1', (d) => d.source.x)
			.attr('y1', (d) => d.source.y)
			.attr('x2', (d) => d.target.x)
			.attr('y2', (d) => d.target.y);
	}
	nodeSelection.attr('transform', (d) => `translate(${Number.isFinite(d.x) ? d.x : 0},${Number.isFinite(d.y) ? d.y : 0})`);
}

function shouldRefreshOverlayLabels(nodeCount = layoutNodes?.length || 0) {
	if (nodeCount <= 1200) return true;
	const interval = 2;
	const shouldUpdate = overlayRefreshFrameCounter % interval === 0;
	overlayRefreshFrameCounter += 1;
	return shouldUpdate;
}

function resetProgressiveRevealState() {
	// SVG rendering stays on the main DOM path; progressive reveal is no longer needed.
}

function startProgressiveRevealForGraph(_nodeCount = layoutNodes?.length || 0) {
	// Intentionally left as a no-op so large graphs stay on the SVG renderer.
}

function scheduleGraphTickPositions(linkSelection, nodeSelection, arrowSelection) {
	if (graphTickFrameId != null) return;
	graphTickFrameId = requestAnimationFrame(() => {
		graphTickFrameId = null;
		if (pixiModeActive && pixiApi && typeof pixiApi.drawFrame === 'function') {
			try {
				const transform = getCurrentZoomTransform();
				const labelScale = selectedId || isSelectionLogBold ? getFocusedLabelScale(transform.k) : 1;
				pixiApi.drawFrame(layoutNodes || [], layoutLinks || [], transform, { selectedId, labelScale });
				if (shouldRefreshOverlayLabels(layoutNodes?.length) && overlayApi && typeof overlayApi.update === 'function') {
					try {
						overlayApi.update(layoutNodes || [], transform, { selectedId, labelScale });
					} catch (e) {}
				}
			} catch (e) {
				_logOnce(_loggedBadTransforms, 'pixi-draw-error', 'warn', 'Pixi draw failed', e);
			}
			return;
		}
		if (canvasModeActive && canvasApi) {
			try {
				const transform = getCurrentZoomTransform();
				const labelScale = selectedId || isSelectionLogBold ? getFocusedLabelScale(transform.k) : 1;
				canvasApi.drawFrame(layoutNodes || [], layoutLinks || [], transform, { selectedId, labelScale });
				if (shouldRefreshOverlayLabels(layoutNodes?.length) && overlayApi && typeof overlayApi.update === 'function') {
					try {
						overlayApi.update(layoutNodes || [], transform, { selectedId, labelScale });
					} catch (e) {}
				}
			} catch (e) {
				_logOnce(_loggedBadTransforms, 'canvas-draw-error', 'warn', 'Canvas draw failed', e);
			}
			return;
		}
		updateGraphTickPositions(linkSelection, nodeSelection, arrowSelection);
	});
}

function cancelGraphTickPositions() {
	if (graphTickFrameId == null) return;
	cancelAnimationFrame(graphTickFrameId);
	graphTickFrameId = null;
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

function updateFetchStatus(msg: string) {
	activeFetchStatusMessage = msg;
	applyStatusPresentation(msg, { transient: true, dismissible: true, pinned: activeFetchStatusPinned });
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
let appendFetched = appendFetchedImpl;
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

const INITIAL_SEED_COUNT = 0; // random seed nodes on first load (default select)
const FILTER_MATCH_LIMIT = 100; // maximum number of direct matches to show when filtering
const LS_SESSION_KEY = 'finra_session'; // storage key for persisted session nodes
const LS_GRAPH_TEMPLATES_KEY = 'finra_graph_templates'; // durable saved graph templates (survives reset/session clear)
const SESSION_TTL_MS = 365 * 24 * 60 * 60 * 1000; // 1 year
const SESSION_STORAGE_SOFT_LIMIT_BYTES = 4 * 1024 * 1024; // stay comfortably below common browser quotas
const SESSION_FULL_LAYOUT_NODE_LIMIT = 100000; // above this, store only compact positioning data
const GRAPH_TEMPLATES_SOFT_LIMIT_BYTES = 4 * 1024 * 1024;
const NON_GRAY_HOP_ANIMATION_MS = 1200;
const NON_GRAY_HOP_DELAY_MS = 850;

const NON_GRAY_DETAIL_BATCH_SIZE = 6;
const AUTO_EXPANSION_DIRECT_NEIGHBOR_LIMIT = 16;
/** Hard cap: never dump mega-firm neighborhoods (e.g. Merrill ~2500) onto the canvas in one expand. */
const MAX_AUTO_REVEAL_NEIGHBORS_PER_EXPAND = 48;
const PROFILE_SEED_FETCH_CONCURRENCY = 4;
const SEED_QUERY_FETCH_CONCURRENCY = 4;
const TEXT_SEARCH_DETAIL_HYDRATION_LIMIT = 24;
const TEXT_SEARCH_DETAIL_HYDRATION_CONCURRENCY = 4;

const individualDetailRequestCache = new Map<string, Promise<void>>();
const firmDetailRequestCache = new Map<string, Promise<void>>();
const expansionRequestCache = new Map<string, Promise<any>>();

function getDefaultSelectionHops(): number {
	const runtime = getRuntimeHopDefaults();
	const normalized = normalizeHighlightHops(runtime.selection);
	return normalized === 'all' ? 100 : normalized;
}

function getDefaultExpansionHops(): number {
	const runtime = getRuntimeHopDefaults();
	const normalized = normalizeHighlightHops(runtime.expansion);
	return normalized === 'all' ? 100 : normalized;
}

function getDefaultClickExpansionHops(): number {
	const runtime = getRuntimeHopDefaults();
	const normalized = normalizeHighlightHops(runtime.click);
	return normalized === 'all' ? 10 : normalized;
}

function getCurrentHopDefaultsSnapshot() {
	return {
		selection: getDefaultSelectionHops(),
		expansion: getDefaultExpansionHops(),
		click: getDefaultClickExpansionHops(),
	};
}

// Expose hop controls to window for UI sliders
if (typeof window !== 'undefined') {
	(window as any).setRuntimeHopDefaults = (expansion, click, selection) => {
		setRuntimeHopDefaults(expansion, click, selection);
		refreshTraceState();
		refreshGraphColors();
	};
	(window as any).getRuntimeHopDefaults = getRuntimeHopDefaults;
	(window as any).exportConnectedRenderedGraphSnapshot = exportConnectedRenderedGraphSnapshot;
}

function hasTrustedCurrentRelationshipData(node) {
	if (!node || typeof node !== 'object') return false;
	if (node.group === 'individual') {
		if (node._trustedCurrentRelationshipData === true) return true;
		return Boolean(node._detailLoaded && hasRichIndividualDetail(node));
	}
	if (node.group === 'firm') {
		return Boolean(node._detailLoaded && node._detailValidated === true);
	}
	return false;
}

function hasKnownRevealableChildCount(node) {
	if (!node || typeof node !== 'object') return false;
	if (node.group === 'individual') {
		const hasKnownCurrentEmployments = Array.isArray(node.currentEmployments) && Array.isArray(node.currentIAEmployments);
		if (!hasKnownCurrentEmployments) return false;
		if (!isNodeInactive(node)) return true;

		const hasKnownPreviousEmployments = Array.isArray(node.previousEmployments);
		const hasKnownPreviousIaEmployments = !Object.prototype.hasOwnProperty.call(node, 'previousIAEmployments') || Array.isArray(node.previousIAEmployments);
		return hasKnownPreviousEmployments && hasKnownPreviousIaEmployments;
	}
	if (node.group === 'firm') {
		return Array.isArray(node.directOwners) || getKnownCurrentFirmConnectionIds(node).size > 0;
	}
	return false;
}

function getExpectedIndividualRevealableEmployments(node) {
	if (!node || node.group !== 'individual') return [];
	return [
		...(Array.isArray(node.currentEmployments) ? node.currentEmployments : []),
		...(Array.isArray(node.currentIAEmployments) ? node.currentIAEmployments : []),
		...(Array.isArray(node.previousEmployments) ? node.previousEmployments : []),
		...(Array.isArray(node.previousIAEmployments) ? node.previousIAEmployments : []),
	];
}

function getKnownCurrentFirmConnectionIds(node) {
	const currentConnectionIds = new Set<string>();
	const firmNodeId = String(node?.id || '').trim();
	if (!firmNodeId) return currentConnectionIds;

	const seenLinkKeys = new Set<string>();
	const allLinks = [...(Array.isArray(layoutLinks) ? layoutLinks : []), ...(Array.isArray(graphData?.links) ? graphData.links : [])];
	allLinks.forEach((link) => {
		if (!link) return;
		const linkKey = getLinkKey(link);
		if (seenLinkKeys.has(linkKey)) return;
		seenLinkKeys.add(linkKey);

		const sourceId = String(link.source?.id ?? link.source ?? '').trim();
		const targetId = String(link.target?.id ?? link.target ?? '').trim();
		if (!sourceId || !targetId) return;
		if (sourceId !== firmNodeId && targetId !== firmNodeId) return;

		if (link.relationship === 'controls') {
			const endDate = String(link?.endDate || link?.registrationEndDate || link?.toDate || '').trim();
			if (endDate) return;
		} else if (!isCurrentRegistration(link)) {
			return;
		}

		const otherId = sourceId === firmNodeId ? targetId : sourceId;
		if (otherId) currentConnectionIds.add(otherId);
	});

	return currentConnectionIds;
}

function isFetchedLeafNode(node) {
	if (!node?.id) return false;
	if (initialServerNodeIds instanceof Set && initialServerNodeIds.has(node.id)) return false;
	if (!hasTrustedCurrentRelationshipData(node)) return false;
	if (!hasKnownRevealableChildCount(node)) return false;
	if (getExpectedRevealableNeighborIds(node).size > 0) return false;
	const neighborCount = neighborMap?.get(node.id)?.size;
	if (typeof neighborCount === 'number') return neighborCount === 0;
	if (!Array.isArray(layoutLinks) || layoutLinks.length === 0) return true;
	return !layoutLinks.some((link) => {
		const sourceId = link.source?.id ?? link.source;
		const targetId = link.target?.id ?? link.target;
		return sourceId === node.id || targetId === node.id;
	});
}

function getVisibleRevealableNeighborIds(nodeId) {
	const visibleNeighborIds = new Set<string>();
	if (!nodeId || !Array.isArray(layoutLinks) || !layoutLinks.length) return visibleNeighborIds;
	layoutLinks.forEach((link) => {
		if (!isNonGrayExpansionLink(link)) return;
		const sourceId = link.source?.id ?? link.source;
		const targetId = link.target?.id ?? link.target;
		if (sourceId === nodeId && targetId) visibleNeighborIds.add(targetId);
		if (targetId === nodeId && sourceId) visibleNeighborIds.add(sourceId);
	});
	return visibleNeighborIds;
}

function getExpectedRevealableNeighborIds(node) {
	const expectedNeighborIds = new Set<string>();
	if (!node || typeof node !== 'object') return expectedNeighborIds;

	if (node.group === 'individual') {
		const employments = getExpectedIndividualRevealableEmployments(node);
		employments.forEach((employment) => {
			const firmId = String(employment?.firmId || employment?.firm_id || employment?.firmIdNumber || employment?.organizationId || employment?.orgId || '').trim();
			const firmName = String(
				employment?.firmName || employment?.firm_name || employment?.organizationName || employment?.firm || employment?.name || employment?.legalName || '',
			).trim();
			const existingFirmNode = findExistingFirmNode(firmId, { label: firmName });
			const syntheticFirmNodeId = !firmId && !existingFirmNode && firmName ? buildSyntheticFirmNodeId(firmName) : null;
			const firmNodeId = existingFirmNode?.id || (firmId ? `firm:${firmId}` : syntheticFirmNodeId);
			if (firmNodeId) expectedNeighborIds.add(firmNodeId);
		});
		return expectedNeighborIds;
	}

	if (node.group === 'firm') {
		for (const connectedNodeId of getKnownCurrentFirmConnectionIds(node)) {
			expectedNeighborIds.add(connectedNodeId);
		}
		for (const owner of node.directOwners || []) {
			const personId = String(owner?.crdNumber || owner?.crd || owner?.personId || '').trim();
			if (personId) expectedNeighborIds.add(`person:${personId}`);
		}
	}

	return expectedNeighborIds;
}

export function isRevealableChainExhausted(
	startNodeId: string,
	getNodeById: (nodeId: string) => any,
	getExpectedNeighborIds: (node: any) => Set<string>,
	getVisibleNeighborIdsForNode: (nodeId: string) => Set<string>,
	canInspectNode: (node: any, nodeId: string) => boolean = () => true,
) {
	const normalizedStartNodeId = String(startNodeId || '').trim();
	if (!normalizedStartNodeId) return false;

	const queue = [normalizedStartNodeId];
	const seen = new Set<string>();

	while (queue.length > 0) {
		const currentNodeId = queue.shift();
		if (!currentNodeId || seen.has(currentNodeId)) continue;
		seen.add(currentNodeId);

		const currentNode = getNodeById(currentNodeId);
		if (!currentNode) continue;
		if (currentNodeId !== normalizedStartNodeId && !canInspectNode(currentNode, currentNodeId)) {
			return false;
		}

		const expectedNeighborIds = getExpectedNeighborIds(currentNode);
		if (!expectedNeighborIds.size) continue;

		const visibleNeighborIds = getVisibleNeighborIdsForNode(currentNodeId);
		for (const expectedNeighborId of expectedNeighborIds) {
			if (!visibleNeighborIds.has(expectedNeighborId)) return false;
		}

		for (const visibleNeighborId of visibleNeighborIds) {
			if (expectedNeighborIds.has(visibleNeighborId) && !seen.has(visibleNeighborId)) {
				queue.push(visibleNeighborId);
			}
		}
	}

	return true;
}

function isFetchedExhaustedConnectedNode(node) {
	if (!node?.id) return false;
	if (initialServerNodeIds instanceof Set && initialServerNodeIds.has(node.id)) return false;
	if (!hasTrustedCurrentRelationshipData(node)) return false;
	if (!hasKnownRevealableChildCount(node)) return false;

	const neighborCount = neighborMap?.get(node.id)?.size;
	if (!(typeof neighborCount === 'number' ? neighborCount > 0 : getNeighborIds(node.id).size > 0)) return false;

	const expectedNeighborIds = getExpectedRevealableNeighborIds(node);
	if (!expectedNeighborIds.size) return false;

	const visibleNeighborIds = getVisibleRevealableNeighborIds(node.id);
	if (!visibleNeighborIds.size) return false;

	return isRevealableChainExhausted(
		node.id,
		(nodeId) => layoutNodes?.find((entry) => entry.id === nodeId) || graphData?.nodes?.find((entry) => entry.id === nodeId) || null,
		getExpectedRevealableNeighborIds,
		getVisibleRevealableNeighborIds,
		(candidateNode) => hasTrustedCurrentRelationshipData(candidateNode) && hasKnownRevealableChildCount(candidateNode),
	);
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

	const focusIds = new Set(
		[selectedId, ...highlightedSelections.map((entry) => entry?.id), ...Array.from(persistentSelectedIds)].map((value) => String(value || '').trim()).filter(Boolean),
	);
	if (!focusIds.size) return [];
	return layoutNodes.filter((node) => focusIds.has(String(node.id))).map((node) => buildPersistedNodePosition(node));
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
		highlightedSelections.length === 0 &&
		persistentSelectedIds.size === 0;

	return {
		cleared: effectiveCleared,
		hopDefaults: getCurrentHopDefaultsSnapshot(),
		renderedServerIds,
		selectedNodeId: selectedId || null,
		sidebarViewMode: sidebarViewMode,
		highlightedNodes: highlightedSelections.map((entry) => ({
			id: entry.id,
			hops: entry.hops === 'all' ? 'all' : Number(entry.hops) || 1,
		})),
		// Node selected chrome that survives Clear Highlight (line emphasis only).
		selectedNodeIds: Array.from(persistentSelectedIds),
		visitedNodeIds: Array.from(visitedNodeIds),
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

const SESSION_IDB_DB_NAME = 'finra_graph_session';
const SESSION_IDB_STORE_NAME = 'session_store';
const SESSION_IDB_ENTRY_KEY = 'active_session';
const TEMPLATES_IDB_DB_NAME = 'finra_graph_templates';
const TEMPLATES_IDB_STORE_NAME = 'template_store';
const TEMPLATES_IDB_ENTRY_KEY = 'saved_templates';

type GraphTemplateRecord = {
	id: string;
	name: string;
	createdAt: number;
	updatedAt: number;
	session: Record<string, any>;
	selectionLog: Array<{ id: string; label: string; secondaryId: string; group: string }>;
	selectionLogBold?: boolean;
};

let savedGraphTemplates: Array<GraphTemplateRecord> = [];
let isSelectionLogTemplatesOpen = false;
let graphTemplatesHydrated = false;
let graphTemplatesHydrationPromise: Promise<void> | null = null;
let applyingGraphTemplate = false;

// Bulk "paste a CRD list" import, mounted alongside Save/Load Template controls. Lets a user
// paste lines like "Gerard Francis Hallaren :: CRD# 1408026" and have each individual fetched
// and added to the graph + selection log in one action.
let isCrdPasteImportOpen = false;
let pasteCrdImportText = '';
let crdPasteImportBusy = false;
let crdPasteImportStatus = '';

function openSessionDatabase() {
	return new Promise<IDBDatabase>((resolve, reject) => {
		if (typeof indexedDB === 'undefined') {
			reject(new Error('IndexedDB unavailable'));
			return;
		}
		const request = indexedDB.open(SESSION_IDB_DB_NAME, 1);
		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains(SESSION_IDB_STORE_NAME)) {
				db.createObjectStore(SESSION_IDB_STORE_NAME);
			}
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error || new Error('IndexedDB open failed'));
	});
}

function openTemplatesDatabase() {
	return new Promise<IDBDatabase>((resolve, reject) => {
		if (typeof indexedDB === 'undefined') {
			reject(new Error('IndexedDB unavailable'));
			return;
		}
		const request = indexedDB.open(TEMPLATES_IDB_DB_NAME, 1);
		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains(TEMPLATES_IDB_STORE_NAME)) {
				db.createObjectStore(TEMPLATES_IDB_STORE_NAME);
			}
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error || new Error('IndexedDB open failed'));
	});
}

async function saveSessionToIndexedDB(envelope: any) {
	try {
		const db = await openSessionDatabase();
		const tx = db.transaction(SESSION_IDB_STORE_NAME, 'readwrite');
		const store = tx.objectStore(SESSION_IDB_STORE_NAME);
		store.put(envelope, SESSION_IDB_ENTRY_KEY);
		return new Promise<void>((resolve, reject) => {
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error || new Error('IndexedDB write failed'));
			tx.onabort = () => reject(tx.error || new Error('IndexedDB write aborted'));
		});
	} catch {
		// Fallback to localStorage if IndexedDB is not available or fails.
	}
}

async function loadSessionFromIndexedDB() {
	try {
		const db = await openSessionDatabase();
		const tx = db.transaction(SESSION_IDB_STORE_NAME, 'readonly');
		const store = tx.objectStore(SESSION_IDB_STORE_NAME);
		const request = store.get(SESSION_IDB_ENTRY_KEY);
		return await new Promise<any>((resolve, reject) => {
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error || new Error('IndexedDB read failed'));
		});
	} catch {
		return null;
	}
}

async function deleteSessionFromIndexedDB() {
	try {
		const db = await openSessionDatabase();
		const tx = db.transaction(SESSION_IDB_STORE_NAME, 'readwrite');
		const store = tx.objectStore(SESSION_IDB_STORE_NAME);
		store.delete(SESSION_IDB_ENTRY_KEY);
		return new Promise<void>((resolve) => {
			tx.oncomplete = () => resolve();
			tx.onerror = () => resolve();
			tx.onabort = () => resolve();
		});
	} catch {
		return;
	}
}

async function saveTemplatesToIndexedDB(templates: Array<GraphTemplateRecord>) {
	try {
		const db = await openTemplatesDatabase();
		const tx = db.transaction(TEMPLATES_IDB_STORE_NAME, 'readwrite');
		const store = tx.objectStore(TEMPLATES_IDB_STORE_NAME);
		store.put(templates, TEMPLATES_IDB_ENTRY_KEY);
		return await new Promise<void>((resolve, reject) => {
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error || new Error('IndexedDB write failed'));
			tx.onabort = () => reject(tx.error || new Error('IndexedDB write aborted'));
		});
	} catch {
		// Fallback handled by caller.
	}
}

async function loadTemplatesFromIndexedDB() {
	try {
		const db = await openTemplatesDatabase();
		const tx = db.transaction(TEMPLATES_IDB_STORE_NAME, 'readonly');
		const store = tx.objectStore(TEMPLATES_IDB_STORE_NAME);
		const request = store.get(TEMPLATES_IDB_ENTRY_KEY);
		return await new Promise<any>((resolve, reject) => {
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error || new Error('IndexedDB read failed'));
		});
	} catch {
		return null;
	}
}

function cloneJsonValue<T>(value: T): T {
	if (typeof structuredClone === 'function') {
		try {
			return structuredClone(value);
		} catch {
			// fall through
		}
	}
	return JSON.parse(JSON.stringify(value)) as T;
}

function createGraphTemplateId() {
	if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
		return `template-${crypto.randomUUID()}`;
	}
	return `template-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function escapeHtml(value: unknown) {
	return String(value ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function formatGraphTemplateTimestamp(value: number) {
	const date = new Date(Number(value) || Date.now());
	if (Number.isNaN(date.getTime())) return '';
	return date.toLocaleString(undefined, {
		month: 'short',
		day: 'numeric',
		hour: 'numeric',
		minute: '2-digit',
	});
}

function sanitizeSelectionLogEntries(entries: unknown): Array<{ id: string; label: string; secondaryId: string; group: string }> {
	if (!Array.isArray(entries)) return [];
	return entries
		.map((entry) => {
			if (!entry || typeof entry !== 'object') return null;
			const id = String((entry as any).id || '').trim();
			if (!id) return null;
			return {
				id,
				label: String((entry as any).label || id),
				secondaryId: String((entry as any).secondaryId || ''),
				group: String((entry as any).group || ''),
			};
		})
		.filter(Boolean) as Array<{ id: string; label: string; secondaryId: string; group: string }>;
}

function sanitizeGraphTemplateRecord(raw: unknown): GraphTemplateRecord | null {
	if (!raw || typeof raw !== 'object') return null;
	const id = String((raw as any).id || '').trim() || createGraphTemplateId();
	const name = String((raw as any).name || '').trim();
	const session = (raw as any).session && typeof (raw as any).session === 'object' ? cloneJsonValue((raw as any).session) : null;
	if (!session) return null;
	const createdAt = Number((raw as any).createdAt) || Date.now();
	const updatedAt = Number((raw as any).updatedAt) || createdAt;
	return {
		id,
		name: name || generateGraphTemplateName(session, sanitizeSelectionLogEntries((raw as any).selectionLog), createdAt),
		createdAt,
		updatedAt,
		session,
		selectionLog: sanitizeSelectionLogEntries((raw as any).selectionLog),
		selectionLogBold: Boolean((raw as any).selectionLogBold),
	};
}

export function generateGraphTemplateName(session: Record<string, any> | null | undefined, selectionLog: Array<{ id?: string; label?: string }> = [], createdAt = Date.now()) {
	const selectedLabel =
		sanitizeSelectionLogEntries(selectionLog).find((entry) => entry.id && entry.id === session?.selectedNodeId)?.label || sanitizeSelectionLogEntries(selectionLog)[0]?.label || '';
	const nodeCount = Math.max(
		Array.isArray(session?.renderedServerIds) ? session.renderedServerIds.length : 0,
		Array.isArray(session?.extraNodes) ? session.extraNodes.length : 0,
		Array.isArray(session?.extraNodeIds) ? session.extraNodeIds.length : 0,
		Array.isArray(selectionLog) ? selectionLog.length : 0,
	);
	const stamp = formatGraphTemplateTimestamp(createdAt);
	if (selectedLabel) {
		const shortLabel = String(selectedLabel).trim().slice(0, 28);
		return nodeCount > 1 ? `${shortLabel} +${Math.max(0, nodeCount - 1)} · ${stamp}` : `${shortLabel} · ${stamp}`;
	}
	if (nodeCount > 0) return `Graph ${nodeCount} nodes · ${stamp}`;
	return `Template · ${stamp}`;
}

function normalizeGraphTemplateList(raw: unknown): Array<GraphTemplateRecord> {
	if (!Array.isArray(raw)) return [];
	return raw
		.map((entry) => sanitizeGraphTemplateRecord(entry))
		.filter(Boolean)
		.sort((a, b) => Number(b!.updatedAt || 0) - Number(a!.updatedAt || 0)) as Array<GraphTemplateRecord>;
}

function persistGraphTemplatesSync(templates: Array<GraphTemplateRecord>) {
	const normalized = normalizeGraphTemplateList(templates);
	savedGraphTemplates = normalized;
	const serialized = JSON.stringify(normalized);
	if (serialized.length > GRAPH_TEMPLATES_SOFT_LIMIT_BYTES && typeof indexedDB !== 'undefined') {
		void saveTemplatesToIndexedDB(normalized).catch(() => undefined);
		try {
			localStorage.setItem(LS_GRAPH_TEMPLATES_KEY, JSON.stringify({ pointer: 'idb', count: normalized.length, updatedAt: Date.now() }));
		} catch {
			/* ignore persistence errors */
		}
		return normalized;
	}
	try {
		localStorage.setItem(LS_GRAPH_TEMPLATES_KEY, serialized);
	} catch (error) {
		if (typeof indexedDB !== 'undefined') {
			void saveTemplatesToIndexedDB(normalized).catch(() => undefined);
			try {
				localStorage.setItem(LS_GRAPH_TEMPLATES_KEY, JSON.stringify({ pointer: 'idb', count: normalized.length, updatedAt: Date.now() }));
			} catch {
				console.warn('Failed to persist graph templates.', error);
			}
		} else {
			console.warn('Failed to persist graph templates.', error);
		}
	}
	return normalized;
}

export function loadGraphTemplatesSync() {
	try {
		const raw = localStorage.getItem(LS_GRAPH_TEMPLATES_KEY);
		if (!raw) {
			savedGraphTemplates = [];
			return savedGraphTemplates;
		}
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed === 'object' && parsed.pointer === 'idb') {
			// Keep whatever is already hydrated; async loader will replace this if needed.
			return savedGraphTemplates;
		}
		savedGraphTemplates = normalizeGraphTemplateList(parsed);
		return savedGraphTemplates;
	} catch {
		savedGraphTemplates = [];
		return savedGraphTemplates;
	}
}

export async function loadGraphTemplatesAsync() {
	if (graphTemplatesHydrationPromise) return graphTemplatesHydrationPromise;
	graphTemplatesHydrationPromise = (async () => {
		try {
			const raw = localStorage.getItem(LS_GRAPH_TEMPLATES_KEY);
			if (raw) {
				const parsed = JSON.parse(raw);
				if (parsed && typeof parsed === 'object' && parsed.pointer === 'idb') {
					const fromIdb = await loadTemplatesFromIndexedDB();
					savedGraphTemplates = normalizeGraphTemplateList(fromIdb);
				} else {
					savedGraphTemplates = normalizeGraphTemplateList(parsed);
				}
			} else {
				const fromIdb = await loadTemplatesFromIndexedDB();
				savedGraphTemplates = normalizeGraphTemplateList(fromIdb);
				if (savedGraphTemplates.length) {
					persistGraphTemplatesSync(savedGraphTemplates);
				}
			}
		} catch {
			savedGraphTemplates = loadGraphTemplatesSync();
		} finally {
			graphTemplatesHydrated = true;
			updateSelectionLogTemplatesUI();
		}
	})();
	return graphTemplatesHydrationPromise;
}

export function getSavedGraphTemplates() {
	return savedGraphTemplates.slice();
}

export function buildGraphTemplateSnapshot() {
	const session = buildSessionPayload({ compact: false, extraNodeMode: 'full' });
	// Templates are intentional bookmarks, never a cleared marker.
	session.cleared = false;
	return {
		session: cloneJsonValue(session),
		selectionLog: cloneJsonValue(selectedNodesLog || []),
		selectionLogBold: Boolean(isSelectionLogBold),
	};
}

export function saveCurrentGraphTemplate(customName?: string) {
	// Prefer a live session snapshot. If the graph is empty/not ready, still allow
	// saving the current selection-log bookmark so templates remain useful after
	// reset/clear flows.
	const canSnapshotLiveGraph = Boolean(graphData && Array.isArray(layoutNodes));
	const snapshot =
		canSnapshotLiveGraph ? buildGraphTemplateSnapshot() : (
			{
				session: {
					cleared: false,
					selectedNodeId: null,
					sidebarViewMode: 'log',
					highlightedNodes: [],
					visitedNodeIds: [],
					nodePositions: [],
					renderedServerIds: [],
					extraNodes: [],
					extraNodeIds: [],
					extraLinks: [],
					zoomTransform: null,
				},
				selectionLog: cloneJsonValue(selectedNodesLog || []),
				selectionLogBold: Boolean(isSelectionLogBold),
			}
		);

	const hasContent =
		(Array.isArray(snapshot.selectionLog) && snapshot.selectionLog.length > 0) ||
		(Array.isArray(snapshot.session?.extraNodes) && snapshot.session.extraNodes.length > 0) ||
		(Array.isArray(snapshot.session?.extraNodeIds) && snapshot.session.extraNodeIds.length > 0) ||
		(Array.isArray(snapshot.session?.renderedServerIds) && snapshot.session.renderedServerIds.length > 0) ||
		Boolean(snapshot.session?.selectedNodeId);

	if (!hasContent) {
		updateFetchStatus('Nothing to save as a template yet');
		return null;
	}

	const now = Date.now();
	const name = String(customName || '').trim() || generateGraphTemplateName(snapshot.session, snapshot.selectionLog, now);
	const template: GraphTemplateRecord = {
		id: createGraphTemplateId(),
		name,
		createdAt: now,
		updatedAt: now,
		session: snapshot.session,
		selectionLog: snapshot.selectionLog,
		selectionLogBold: snapshot.selectionLogBold,
	};
	persistGraphTemplatesSync([template, ...savedGraphTemplates]);
	isSelectionLogTemplatesOpen = true;
	updateSelectionLogTemplatesUI();
	updateFetchStatus(`Saved template “${template.name}”`);
	return template;
}

export function renameGraphTemplate(templateId: string, nextName: string) {
	const normalizedId = String(templateId || '').trim();
	const trimmedName = String(nextName || '').trim();
	if (!normalizedId || !trimmedName) return null;
	const index = savedGraphTemplates.findIndex((template) => template.id === normalizedId);
	if (index < 0) return null;
	const updated = {
		...savedGraphTemplates[index],
		name: trimmedName,
		updatedAt: Date.now(),
	};
	const next = savedGraphTemplates.slice();
	next[index] = updated;
	persistGraphTemplatesSync(next);
	updateSelectionLogTemplatesUI();
	return updated;
}

export function deleteGraphTemplate(templateId: string) {
	const normalizedId = String(templateId || '').trim();
	if (!normalizedId) return false;
	const next = savedGraphTemplates.filter((template) => template.id !== normalizedId);
	if (next.length === savedGraphTemplates.length) return false;
	persistGraphTemplatesSync(next);
	updateSelectionLogTemplatesUI();
	return true;
}

async function applyGraphTemplateSession(session: Record<string, any>) {
	if (!session || typeof session !== 'object') return false;

	const hasSessionNodes = Boolean(
		session.extraNodes?.length || session.extraNodeIds?.length || session.renderedServerIds?.length || session.selectedNodeId || session.highlightedNodes?.length,
	);
	if (!hasSessionNodes) {
		clearGraphData();
		return true;
	}

	const profileName = currentProfileName || 'custom';
	if (!graphData || !Array.isArray(graphData.nodes) || graphData.nodes.length === 0) {
		try {
			await loadBaselineGraph(profileName, { suppressRender: true });
		} catch (error) {
			console.warn('Failed to load baseline graph while applying template:', error);
			graphData = { nodes: [], links: [], meta: {} };
			initialServerNodeIds = new Set();
			initialServerLinkKeys = new Set();
		}
	}

	if (!graphData) {
		graphData = { nodes: [], links: [], meta: {} };
	}

	const renderedSavedSession = renderSavedSessionGraph(session);
	if (!renderedSavedSession) {
		// Fall back to full restore into whatever graph we currently have.
		if (!Array.isArray(graphData.nodes) || !graphData.nodes.length) {
			graphData = { nodes: [], links: [], meta: graphData.meta || {} };
			renderGraph(graphData);
			showEmpty(true);
		} else {
			renderBaselineGraphData();
		}
	}

	await restoreSavedSession(session);
	isSessionCleared = false;
	persistSessionPayload(cloneJsonValue(session));
	return true;
}

export async function applyGraphTemplate(templateId: string) {
	const normalizedId = String(templateId || '').trim();
	if (!normalizedId || applyingGraphTemplate) return false;
	const template = savedGraphTemplates.find((entry) => entry.id === normalizedId);
	if (!template) {
		updateFetchStatus('Template not found');
		return false;
	}

	applyingGraphTemplate = true;
	updateFetchStatus(`Loading template “${template.name}”…`);
	try {
		selectedNodesLog = sanitizeSelectionLogEntries(template.selectionLog);
		saveSelectionLog();
		if (typeof template.selectionLogBold === 'boolean') {
			isSelectionLogBold = template.selectionLogBold;
			saveSelectionLogBoldPreference();
		}
		await applyGraphTemplateSession(cloneJsonValue(template.session));
		updateSelectionLogUI();
		syncSelectionLogActionButtonStates();
		refreshTraceState();
		syncTraceLabelPresentation();
		syncSelectionLogAuxiliaryRenderers();
		updateFetchStatus(`Loaded template “${template.name}”`);
		return true;
	} catch (error) {
		console.error('Failed to apply graph template:', error);
		updateFetchStatus('Failed to load template');
		return false;
	} finally {
		applyingGraphTemplate = false;
		updateSelectionLogTemplatesUI();
	}
}

function renderSelectionLogTemplatesMarkup() {
	const templates = savedGraphTemplates;
	const rows =
		templates.length ?
			templates
				.map((template) => {
					const nodeCount = Math.max(
						Array.isArray(template.session?.renderedServerIds) ? template.session.renderedServerIds.length : 0,
						Array.isArray(template.session?.extraNodes) ? template.session.extraNodes.length : 0,
						Array.isArray(template.session?.extraNodeIds) ? template.session.extraNodeIds.length : 0,
						Array.isArray(template.selectionLog) ? template.selectionLog.length : 0,
					);
					const metaBits = [`${nodeCount} node${nodeCount === 1 ? '' : 's'}`, formatGraphTemplateTimestamp(template.updatedAt || template.createdAt)].filter(Boolean);
					return `
						<div class="fg-template-row" data-template-id="${escapeHtml(template.id)}">
							<div class="fg-template-row__main">
								<input
									class="fg-template-name-input"
									type="text"
									value="${escapeHtml(template.name)}"
									aria-label="Template name"
									title="Edit template name"
									data-fg-template-action="rename"
									data-template-id="${escapeHtml(template.id)}"
								/>
								<div class="fg-template-row__meta">${escapeHtml(metaBits.join(' · '))}</div>
							</div>
							<div class="fg-template-row__actions">
								<button
									type="button"
									class="fg-ghost-btn fg-btn-sm"
									data-fg-template-action="load"
									data-template-id="${escapeHtml(template.id)}"
									title="Load this saved template">
									Load
								</button>
								<button
									type="button"
									class="fg-ghost-btn fg-btn-sm"
									data-fg-template-action="delete"
									data-template-id="${escapeHtml(template.id)}"
									title="Delete this saved template">
									Delete
								</button>
							</div>
						</div>
					`;
				})
				.join('')
		:	`<div class="fg-template-empty">No saved templates yet. Save the current graph layout to restore it later, even after Reset Session.</div>`;

	return `
		<div class="fg-selection-log-templates" data-open="${isSelectionLogTemplatesOpen ? 'true' : 'false'}">
			<div class="fg-selection-log-templates__header">
				<button
					type="button"
					class="fg-selection-log-templates__toggle"
					data-fg-template-action="toggle-panel"
					aria-expanded="${isSelectionLogTemplatesOpen ? 'true' : 'false'}"
					title="Show or hide saved graph templates">
					<span class="fg-selection-log-templates__toggle-label">Saved Templates</span>
					<span class="fg-selection-log-templates__count">${templates.length}</span>
					<span class="fg-selection-log-templates__chevron" aria-hidden="true">${isSelectionLogTemplatesOpen ? '▾' : '▸'}</span>
				</button>
				<button
					type="button"
					class="fg-ghost-btn fg-btn-sm fg-selection-log-templates__save"
					data-fg-template-action="save-current"
					title="Save the current graph session as a reusable template">
					Save Template
				</button>
			</div>
			<div class="fg-selection-log-templates__body${isSelectionLogTemplatesOpen ? '' : ' is-collapsed'}">
				${rows}
			</div>
			<div class="fg-crd-paste-import">
				<button
					type="button"
					class="fg-selection-log-templates__toggle"
					data-fg-template-action="toggle-paste-panel"
					aria-expanded="${isCrdPasteImportOpen ? 'true' : 'false'}"
					title="Paste a list of Name :: CRD# numbers to bulk add individuals">
					<span class="fg-selection-log-templates__toggle-label">Paste CRD List</span>
					<span class="fg-selection-log-templates__chevron" aria-hidden="true">${isCrdPasteImportOpen ? '▾' : '▸'}</span>
				</button>
				<div class="fg-crd-paste-import__body${isCrdPasteImportOpen ? '' : ' is-collapsed'}">
					<textarea
						class="fg-crd-paste-textarea"
						rows="4"
						placeholder="Gerard Francis Hallaren :: CRD# 1408026&#10;Darcy Gail Glenn :: CRD# 1420846&#10;One per line"
						aria-label="Paste CRD list"
						data-fg-template-action="paste-textarea"
						${crdPasteImportBusy ? 'disabled' : ''}
					>${escapeHtml(pasteCrdImportText)}</textarea>
					<div class="fg-crd-paste-import__actions">
						<button
							type="button"
							class="fg-ghost-btn fg-btn-sm"
							data-fg-template-action="paste-import"
							${crdPasteImportBusy ? 'disabled' : ''}
							title="Fetch and add each pasted CRD to the graph and selection log">
							${crdPasteImportBusy ? 'Importing…' : 'Import CRDs'}
						</button>
						${crdPasteImportStatus ? `<span class="fg-crd-paste-import__status">${escapeHtml(crdPasteImportStatus)}</span>` : ''}
					</div>
				</div>
			</div>
		</div>
	`;
}

function ensureSelectionLogTemplateMounts() {
	const hosts: Array<HTMLElement> = [];

	const standaloneList = document.getElementById('fg-selection-log-list');
	const standalonePanel = document.getElementById('fg-selection-log');
	if (standalonePanel) {
		let mount = standalonePanel.querySelector<HTMLElement>('#fg-selection-log-templates');
		if (!mount) {
			mount = document.createElement('div');
			mount.id = 'fg-selection-log-templates';
			mount.className = 'fg-selection-log-templates-host';
			if (standaloneList?.parentElement === standalonePanel) {
				standalonePanel.insertBefore(mount, standaloneList.nextSibling);
			} else {
				standalonePanel.appendChild(mount);
			}
		}
		hosts.push(mount);
	}

	const sidebarList = document.getElementById('fg-sidebar-selection-log-list');
	if (sidebarList?.parentElement) {
		let mount = sidebarList.parentElement.querySelector<HTMLElement>('#fg-sidebar-selection-log-templates');
		if (!mount) {
			mount = document.createElement('div');
			mount.id = 'fg-sidebar-selection-log-templates';
			mount.className = 'fg-selection-log-templates-host';
			sidebarList.parentElement.insertBefore(mount, sidebarList.nextSibling);
		}
		hosts.push(mount);
	}

	return hosts;
}

function bindSelectionLogTemplateHost(host: HTMLElement) {
	if (host.dataset.templatesBound === 'true') return;
	host.dataset.templatesBound = 'true';

	host.addEventListener('click', (event) => {
		const target = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-fg-template-action]') : null;
		if (!target || !host.contains(target)) return;
		const action = target.getAttribute('data-fg-template-action');
		const templateId = target.getAttribute('data-template-id') || '';

		if (action === 'toggle-panel') {
			isSelectionLogTemplatesOpen = !isSelectionLogTemplatesOpen;
			updateSelectionLogTemplatesUI();
			return;
		}

		if (action === 'save-current') {
			const template = saveCurrentGraphTemplate();
			if (template) {
				flashSelectionLogActionButton(target as HTMLButtonElement, 'Saved!');
			}
			return;
		}

		if (action === 'load' && templateId) {
			void applyGraphTemplate(templateId).then((ok) => {
				if (ok) flashSelectionLogActionButton(target as HTMLButtonElement, 'Loaded!');
			});
			return;
		}

		if (action === 'delete' && templateId) {
			if (deleteGraphTemplate(templateId)) {
				flashSelectionLogActionButton(target as HTMLButtonElement, 'Deleted!');
			}
			return;
		}

		if (action === 'toggle-paste-panel') {
			isCrdPasteImportOpen = !isCrdPasteImportOpen;
			updateSelectionLogTemplatesUI();
			return;
		}

		if (action === 'paste-import') {
			const textarea = host.querySelector<HTMLTextAreaElement>('[data-fg-template-action="paste-textarea"]');
			const text = textarea ? textarea.value : pasteCrdImportText;
			void importPastedCrdList(text);
		}
	});

	host.addEventListener('input', (event) => {
		const target = event.target instanceof HTMLTextAreaElement ? event.target : null;
		if (!target || target.getAttribute('data-fg-template-action') !== 'paste-textarea') return;
		pasteCrdImportText = target.value;
	});

	host.addEventListener('change', (event) => {
		const target = event.target instanceof HTMLInputElement ? event.target : null;
		if (!target || target.getAttribute('data-fg-template-action') !== 'rename') return;
		const templateId = target.getAttribute('data-template-id') || '';
		if (!templateId) return;
		const renamed = renameGraphTemplate(templateId, target.value);
		if (!renamed) {
			updateSelectionLogTemplatesUI();
			return;
		}
		target.value = renamed.name;
	});

	host.addEventListener('keydown', (event) => {
		const target = event.target instanceof HTMLInputElement ? event.target : null;
		if (!target || target.getAttribute('data-fg-template-action') !== 'rename') return;
		if (event.key === 'Enter') {
			event.preventDefault();
			target.blur();
		}
	});
}

function updateSelectionLogTemplatesUI() {
	const hosts = ensureSelectionLogTemplateMounts();
	if (!hosts.length) return;
	const markup = renderSelectionLogTemplatesMarkup();
	hosts.forEach((host) => {
		bindSelectionLogTemplateHost(host);
		host.innerHTML = markup;
	});
}

function persistSessionPayload(payload) {
	const envelope = {
		expiresAt: Date.now() + SESSION_TTL_MS,
		data: payload,
	};
	const serialized = JSON.stringify(envelope);
	if (serialized.length > SESSION_STORAGE_SOFT_LIMIT_BYTES && typeof indexedDB !== 'undefined') {
		saveSessionToIndexedDB(envelope).catch(() => undefined);
		try {
			localStorage.setItem(LS_SESSION_KEY, JSON.stringify({ expiresAt: envelope.expiresAt, pointer: 'idb' }));
		} catch {
			/* ignore persistence errors */
		}
		return;
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

function persistSessionNow() {
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

function saveSession() {
	if (!layoutNodes || !graphData) return;
	if (sessionSaveTimer) return;
	if (typeof window !== 'undefined' && typeof window.setTimeout === 'function') {
		sessionSaveTimer = window.setTimeout(() => {
			sessionSaveTimer = null;
			persistSessionNow();
		}, 140);
		return;
	}
	persistSessionNow();
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
	deleteSessionFromIndexedDB().catch(() => undefined);
	sessionStorage.removeItem(LS_SESSION_KEY);
}

function emitSelectedNodeRoute(nodeId: string | null, { replace = false }: { replace?: boolean } = {}) {
	if (typeof window === 'undefined') return;
	try {
		// As a fallback for UI listeners that may not be mounted yet, ensure the
		// browser URL reflects the selected node immediately using replaceState.
		if (nodeId) {
			const nextPath = buildNodeRoutePath(nodeId);
			if (window.history && typeof window.history.replaceState === 'function') {
				window.history.replaceState(window.history.state, document.title || '', nextPath);
			}
		}
	} catch (e) {
		/* non-critical */
	}
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
	const normalizedNodeId = normalizeNodeRouteId(nodeId) || String(nodeId || '').trim();
	if (!normalizedNodeId) return null;

	let liveNode = getNodeById(normalizedNodeId);
	if (!liveNode) {
		const candidateNode =
			Array.isArray(graphData?.nodes) ?
				graphData.nodes.find(
					(entry) =>
						entry?.id &&
						String(entry.id)
							.replace(/^person[:_]/, '')
							.replace(/^firm[:_]/, '') ===
							String(normalizedNodeId)
								.replace(/^person[:_]/, '')
								.replace(/^firm[:_]/, ''),
				)
			:	null;
		if (candidateNode) liveNode = candidateNode;
	}
	if (liveNode && !layoutNodes?.some((node) => node.id === normalizedNodeId)) {
		injectNodesById([normalizedNodeId]);
		liveNode = getNodeById(normalizedNodeId) || liveNode;
	}
	if (liveNode) return liveNode;

	// Prefer firm/person detail hydration first. Deep links like /firm/107342 start from an empty
	// custom profile; expand/nodes-by-ids load the shared Redis graph and can time out or miss
	// nodes that still have detail records in Redis. Detail keys are cheap single-key GETs.
	const [nodePrefix, rawNodeId] = normalizedNodeId.split(':');
	if (rawNodeId && /^[0-9]+$/.test(rawNodeId) && (nodePrefix === 'person' || nodePrefix === 'firm')) {
		try {
			const fetchedBatch = nodePrefix === 'person' ? await fetchIndividualBatch(rawNodeId) : await fetchFirmBatch(rawNodeId);
			if (fetchedBatch.nodes.length || fetchedBatch.links.length) {
				mergeIntoGraphData(fetchedBatch.nodes, fetchedBatch.links);
				appendFetched?.(fetchedBatch.nodes, fetchedBatch.links);
				liveNode = layoutNodes?.find((node) => node.id === normalizedNodeId) || graphData?.nodes?.find((node) => node.id === normalizedNodeId) || null;
			}
		} catch (error) {
			console.warn('Failed to hydrate route-selected node directly from detail APIs:', error);
		}
	}

	// Disabled: the graph-expand / nodes-by-ids fallback stages that used to run after direct
	// detail hydration failed were both best-effort and, for records that are genuinely not
	// found (e.g. a firm connection card pointing at an individual with no cached detail
	// record), redundant — they cost extra round-trips and repeated console warnings without
	// ever resolving the node. If direct detail hydration didn't find the node, give up here.
	return liveNode;
}

let routeNodeUnavailableToastTimer: ReturnType<typeof setTimeout> | null = null;

// Clicking a CRD/connection card that isn't cached locally previously failed completely
// silently (only a console.warn), so the click looked unresponsive/"not clickable". Surface
// a brief, dismissible toast so it's clear the click was registered but the record isn't
// available yet (e.g. blocked by the local-dev external-fetch gate).
function showRouteNodeUnavailableToast(nodeId: string) {
	if (typeof document === 'undefined') return;
	const [prefix, rawId] = String(nodeId || '').split(':');
	const label = prefix === 'firm' ? 'Firm' : 'Individual';

	let toast = document.getElementById('fg-route-unavailable-toast');
	if (!toast) {
		toast = document.createElement('div');
		toast.id = 'fg-route-unavailable-toast';
		toast.className = 'fg-route-unavailable-toast';
		toast.setAttribute('role', 'status');
		toast.setAttribute('aria-live', 'polite');
		document.body.appendChild(toast);
	}
	toast.textContent = `${label} ${rawId || nodeId} isn't available in the local cache yet.`;
	toast.classList.add('is-visible');

	if (routeNodeUnavailableToastTimer) clearTimeout(routeNodeUnavailableToastTimer);
	routeNodeUnavailableToastTimer = setTimeout(() => {
		toast?.classList.remove('is-visible');
	}, 4000);
}

const routeNodeSelectionState = {
	inFlightId: null as string | null,
	promise: null as Promise<boolean> | null,
	seq: 0,
};

async function applyPendingRouteNodeSelection() {
	const targetNodeId = String(pendingRouteNodeId || '').trim();
	if (!targetNodeId) return false;
	if (!graphData || !layoutNodes) return false;
	if (routeNodeSelectionState.inFlightId === targetNodeId && routeNodeSelectionState.promise) {
		return routeNodeSelectionState.promise;
	}

	const selectionSeq = ++routeNodeSelectionState.seq;
	routeNodeSelectionState.inFlightId = targetNodeId;

	// Export in-flight state to DOM so React UI can prevent redundant route requests
	const sidebar = document.getElementById('fg-sidebar');
	if (sidebar) {
		sidebar.dataset.inFlightId = targetNodeId;
	}

	const selectionPromise = (async () => {
		const liveNode = await ensureRouteNodeAvailable(targetNodeId);
		if (!liveNode) {
			// Give up on this route selection rather than leaving pendingRouteNodeId set —
			// otherwise every subsequent loadGraph() call retries the same unresolved node
			// (e.g. a firm-connection CRD card pointing at an individual with no cached
			// detail record) and spams the console indefinitely.
			const latestPendingRouteNodeId = String(pendingRouteNodeId || '').trim();
			if (latestPendingRouteNodeId === targetNodeId) {
				pendingRouteNodeId = null;
				pendingRouteAutoExpand = false;
				pendingRouteForceAutoExpand = false;
			}
			showRouteNodeUnavailableToast(targetNodeId);
			return false;
		}

		const latestPendingRouteNodeId = String(pendingRouteNodeId || '').trim();
		if (selectionSeq !== routeNodeSelectionState.seq && latestPendingRouteNodeId && latestPendingRouteNodeId !== targetNodeId) {
			return false;
		}

		if (latestPendingRouteNodeId === targetNodeId) {
			pendingRouteNodeId = null;
		}

		const targetAlreadySelected = !shouldAutoExpandRouteSelection(targetNodeId, selectedId);
		const shouldExpand = pendingRouteAutoExpand && (!targetAlreadySelected || pendingRouteForceAutoExpand);
		const hasExplicitRoutePulseDuration = typeof pendingRoutePulseDuration === 'number' && Number.isFinite(pendingRoutePulseDuration);
		const shouldFocusRouteSelection = hasExplicitRoutePulseDuration || !targetAlreadySelected;
		pendingRouteAutoExpand = false;
		pendingRouteForceAutoExpand = false;

		await selectNode(liveNode, {
			skipAutoExpand: true,
			skipProfileSync: true,
			skipLog: targetAlreadySelected,
			focus: shouldFocusRouteSelection,
			focusDuration: 520,
			syncRoute: false,
			preserveRestoreTimer: true,
		});
		if (shouldExpand) {
			await materializeRouteSelectionNeighborhood(liveNode, getDefaultExpansionHops());
		}
		return true;
	})();
	routeNodeSelectionState.promise = selectionPromise;

	try {
		return await selectionPromise;
	} finally {
		if (routeNodeSelectionState.promise === selectionPromise) {
			routeNodeSelectionState.promise = null;
			routeNodeSelectionState.inFlightId = null;
			const sidebar = document.getElementById('fg-sidebar');
			if (sidebar && sidebar.dataset.inFlightId === targetNodeId) {
				delete sidebar.dataset.inFlightId;
			}
		}
	}
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

async function loadSessionAsync() {
	try {
		const raw = localStorage.getItem(LS_SESSION_KEY);
		if (raw) {
			const parsed = JSON.parse(raw);
			if (parsed && typeof parsed === 'object' && parsed.pointer === 'idb') {
				const envelope = await loadSessionFromIndexedDB();
				if (envelope && typeof envelope === 'object') {
					const expiresAt = Number(envelope.expiresAt || 0);
					if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) {
						localStorage.removeItem(LS_SESSION_KEY);
						return null;
					}
					return envelope.data || null;
				}
			}
			if (parsed && typeof parsed === 'object' && 'data' in parsed) {
				const expiresAt = Number(parsed.expiresAt || 0);
				if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) {
					localStorage.removeItem(LS_SESSION_KEY);
					return null;
				}
				return parsed.data || null;
			}
			return parsed || null;
		}

		const legacy = sessionStorage.getItem(LS_SESSION_KEY);
		return legacy ? JSON.parse(legacy) : null;
	} catch {
		return null;
	}
}

type SidebarViewMode = 'none' | 'info' | 'log';

let currentProfileName = null;
let currentProfileEnabled = true;
let isSessionCleared = false;
type SelectionLogEntry = { id: string; label: string; secondaryId: string; group: string };

let selectedNodesLog: Array<SelectionLogEntry> = [];
let sidebarSelectedNode = null;
let sidebarLogSticky = false; // true if user has explicitly opened log toggle
let sidebarSourceToggle = 'finra';
// Persists the sidebar "Filter connections…" search term and tags across node selections
// (renderSidebar() re-renders the whole panel on every click, which would otherwise wipe out
// whatever the user typed). Backed by localStorage (see ./filterTags.ts) so it also stays in
// sync with the dashboard's Current/Previous Connections filter and survives navigation.
let sidebarConnectionsFilterQuery = getFilterText();
let sidebarConnectionsFilterTags: string[] = getFilterTags();
let sidebarConnectionsFilterEnabled = getFilterEnabled();
let sidebarConnectionsFilterFocused = false;
let sidebarConnectionsFilterJustCommitted = false;
let sidebarConnectionsFilterRowRefreshing = false;
if (typeof window !== 'undefined') {
	// Keep the sidebar's filter state in sync when the dashboard (or another tab) changes it.
	subscribeFilterTags((tags) => {
		sidebarConnectionsFilterTags = tags;
		renderSidebar(sidebarSelectedNode);
	});
	subscribeFilterText((text) => {
		sidebarConnectionsFilterQuery = text;
		renderSidebar(sidebarSelectedNode);
	});
	subscribeFilterEnabled((enabled) => {
		sidebarConnectionsFilterEnabled = enabled;
		renderSidebar(sidebarSelectedNode);
	});
}
let isTraceMode = false;
let isTraceLogMode = false;
let isSelectionLogBold = false;
let isSelectionLogEditMode = false;
// Set by clearHighlights() to temporarily suppress the "every selection-log individual
// is a highlight root" behavior while Log Bold stays on. Cleared whenever a new
// highlight root is introduced (selection, hover, focus, find match) so the button
// only clears existing highlighting rather than disabling Log Bold itself.
let logBoldHighlightRootsSuppressed = false;
let selectionLogFilterText = '';
// Node ids whose "large label" emphasis has been manually cleared via the
// "Clear Labels" action while Log Bold is on. Re-selecting/re-clicking a node
// removes it from this set so its label becomes enlarged again.
let clearedSelectionLogLabelNodeIds = new Set<string>();
type SelectionLogClearLabelsScope = 'all' | 'people';
let isSelectionLogClearLabelsMenuOpen = false;
let pendingRouteNodeId: string | null = null;
let pendingRoutePulseDuration: number | null = null; // optional pulse duration (ms) requested with route
let pendingRouteAutoExpand = false; // optional auto-expand requested with route
let pendingRouteForceAutoExpand = false; // allow route requests to expand even when the node is already selected
let pendingSelectedNodeIds: string[] = []; // node ids to hydrate into the selection log from a shared `?selected=` link
let isolateToSharedSelection = false; // when true, skip the baseline/profile graph load and render only the shared `?selected=` + routed nodes
let routeNodeRequestListenerBound = false;
let findRequestListenersBound = false;
let traceShortestIds = new Set<string>(); // node and link IDs
let traceLongestIds = new Set<string>(); // node and link IDs
let traceLogIds = new Set<string>(); // node and link IDs
let traceShortestConnectorIds = new Set<string>(); // intermediate nodes only
let traceLongestConnectorIds = new Set<string>(); // intermediate nodes only
let traceLogConnectorIds = new Set<string>(); // intermediate nodes only
let activeFindQuery = '';
let activeFindMatchIds = new Set<string>();
let activeFindMatchOrder: string[] = [];
let activeFindMatchIndex = -1;

const LS_LOG_KEY = 'finra_selection_log';
const LS_LOG_BOLD_KEY = 'finra_selection_log_bold';
const SIDEBAR_VIEW_MODE_STORAGE_KEY = 'finra_sidebar_view_mode';
const ROUTE_NODE_REQUEST_EVENT = 'finra:route-node-request';
const SELECTED_NODE_ROUTE_EVENT = 'finra:selected-node-route';
const FIND_QUERY_EVENT = 'finra:find-query';
const FIND_NEXT_EVENT = 'finra:find-next';
const FIND_PREV_EVENT = 'finra:find-prev';
const FIND_MOVE_EVENT = 'finra:find-move';
const FIND_CLOSE_EVENT = 'finra:find-close';
const FIND_STATE_EVENT = 'finra:find-state';
const MOBILE_SIDEBAR_COLLAPSE_REQUEST_EVENT = 'finra:mobile-sidebar-collapse-request';
const MOBILE_FIND_CLOSE_REQUEST_EVENT = 'finra:mobile-find-close-request';
const TRACE_LOG_GUARD_WARNING_PREFIX = '[finra-graph] Trace with Log guard:';
let lastTraceLogGuardWarning = '';

function normalizeSidebarViewMode(value: unknown, fallback: SidebarViewMode = 'info'): SidebarViewMode {
	return value === 'none' || value === 'info' || value === 'log' ? value : fallback;
}

function loadPersistedSidebarViewMode(fallback: SidebarViewMode = 'info'): SidebarViewMode {
	try {
		if (typeof window === 'undefined' || !window.sessionStorage) return fallback;
		return normalizeSidebarViewMode(sessionStorage.getItem(SIDEBAR_VIEW_MODE_STORAGE_KEY), fallback);
	} catch {
		return fallback;
	}
}

function normalizeSecComparable(value) {
	const raw = String(value || '')
		.trim()
		.toLowerCase();
	if (!raw) return '';
	if (/^8-\d+$/.test(raw)) return raw;
	if (/^\d+$/.test(raw)) return `8-${raw}`;
	return raw;
}

function collectSearchableNodeKeys(node) {
	if (!node || typeof node !== 'object') return [];
	const basic = node.basicInformation || {};
	const idSuffix = String(node.id || '')
		.split(':')
		.pop();
	const preferredLabel = getPreferredNodeLabel(node);
	const group = node.group || (node.type === 'firm' || node.firmId || node.firm_id ? 'firm' : 'individual');
	const keys =
		group === 'firm' ?
			[
				node.id,
				idSuffix,
				node.crd,
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
				...(Array.isArray(node.otherNames) ? node.otherNames : []),
				...(Array.isArray(basic.otherNames) ? basic.otherNames : []),
			]
		:	[
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
				node.addressSearchText,
				[basic.firstName, basic.middleName, basic.lastName].filter(Boolean).join(' '),
				...(Array.isArray(node.otherNames) ? node.otherNames : []),
				...(Array.isArray(basic.otherNames) ? basic.otherNames : []),
			];
	return keys.map((entry) => String(entry || '').trim()).filter(Boolean);
}

function getLevenshteinDistance(a: string, b: string): number {
	if (a === b) return 0;
	if (a.length === 0) return b.length;
	if (b.length === 0) return a.length;

	const v0 = new Array(b.length + 1);
	const v1 = new Array(b.length + 1);
	for (let i = 0; i <= b.length; i++) v0[i] = i;
	for (let i = 0; i < a.length; i++) {
		v1[0] = i + 1;
		for (let j = 0; j < b.length; j++) {
			const cost = a[i] === b[j] ? 0 : 1;
			v1[j + 1] = Math.min(v1[j] + 1, v0[j + 1] + 1, v0[j] + cost);
		}
		for (let j = 0; j <= b.length; j++) v0[j] = v1[j];
	}
	return v1[b.length];
}

function containsWholePhrase(text, phrase) {
	if (!text || !phrase) return false;
	return ` ${text} `.includes(` ${phrase} `);
}

export function selectTextSearchHydrationTargets(
	candidates: Array<{ nodeId?: string | null; group?: string | null; hasEmbeddedDetail?: boolean | null }> = [],
	limit = TEXT_SEARCH_DETAIL_HYDRATION_LIMIT,
) {
	const normalizedLimit = Math.max(0, Number(limit) || 0);
	if (!normalizedLimit) return [];

	const selected: Array<{ nodeId: string; group: 'individual' | 'firm' }> = [];
	const seen = new Set<string>();

	for (const candidate of Array.isArray(candidates) ? candidates : []) {
		if (!candidate || candidate.hasEmbeddedDetail) continue;
		const nodeId = String(candidate.nodeId || '').trim();
		if (!nodeId) continue;
		const group = candidate.group === 'firm' ? 'firm' : 'individual';
		const key = `${group}:${nodeId}`;
		if (seen.has(key)) continue;
		seen.add(key);
		selected.push({ nodeId, group });
		if (selected.length >= normalizedLimit) break;
	}

	return selected;
}

export function rankFindNodeMatches(rawQuery, nodePool = [], liveLinks = []) {
	const query = String(rawQuery || '').trim();
	if (!query) return [];
	const comparableQuery = normalizeComparableName(query);
	const numericQuery = /^\d+$/.test(query) ? query : '';
	const normalizedSecQuery = normalizeSecComparable(query);
	const byId = new Map((Array.isArray(nodePool) ? nodePool : []).filter(Boolean).map((node) => [node.id, node]));
	const connectionCounts = new Map();
	for (const link of Array.isArray(liveLinks) ? liveLinks : []) {
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
			if (comparableQuery && containsWholePhrase(keyComparable, comparableQuery)) {
				bestScore = Math.max(bestScore, 150);
			}
			if (comparableQuery && (keyComparable.includes(comparableQuery) || comparableQuery.includes(keyComparable))) {
				bestScore = Math.max(bestScore, 120);
			}

			// 7.5 Address match
			const group = node.group || (node.type === 'firm' || node.firmId || node.firm_id ? 'firm' : 'individual');
			if (group !== 'firm' && comparableQuery && node.addressSearchText && node.addressSearchText.includes(comparableQuery)) {
				bestScore = Math.max(bestScore, 130);
			}

			// 8. Word-by-word fuzzy matching
			if (comparableQuery) {
				const queryWords = comparableQuery.split(/\s+/).filter((w) => w.length > 0);
				const keyWords = keyComparable.split(/\s+/).filter((w) => w.length > 0);

				if (queryWords.length > 0 && keyWords.length > 0) {
					let matchCount = 0;
					let fuzzyScoreAcc = 0;
					let validQueryWords = 0;

					for (const qw of queryWords) {
						if (qw.length <= 2) continue;
						validQueryWords++;
						let bestKwScore = 0;
						for (const kw of keyWords) {
							if (kw === qw) {
								bestKwScore = Math.max(bestKwScore, 140);
							} else if (kw.includes(qw)) {
								bestKwScore = Math.max(bestKwScore, 130);
							} else if (kw.length > 2) {
								const dist = getLevenshteinDistance(qw, kw);
								const maxDist = Math.max(1, Math.floor(qw.length * 0.3));
								if (dist <= maxDist) {
									bestKwScore = Math.max(bestKwScore, 110 - dist * 5);
								}
							}
						}
						if (bestKwScore > 0) {
							matchCount++;
							fuzzyScoreAcc += bestKwScore;
						}
					}

					if (validQueryWords > 0 && matchCount === validQueryWords) {
						bestScore = Math.max(bestScore, Math.floor(fuzzyScoreAcc / matchCount));
					} else if (matchCount > 0 && queryWords.length === 1) {
						bestScore = Math.max(bestScore, fuzzyScoreAcc);
					}
				}
			}
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

	return scored.sort((a, b) => b.connections - a.connections || b.score - a.score || String(getPreferredNodeLabel(a.node)).localeCompare(String(getPreferredNodeLabel(b.node))));
}

function emitFindState() {
	if (typeof window === 'undefined') return;
	window.dispatchEvent(
		new CustomEvent(FIND_STATE_EVENT, {
			detail: {
				query: activeFindQuery,
				total: activeFindMatchOrder.length,
				activeOrdinal: activeFindMatchIndex >= 0 ? activeFindMatchIndex + 1 : 0,
				activeNodeId: activeFindMatchIndex >= 0 ? activeFindMatchOrder[activeFindMatchIndex] || null : null,
			},
		}),
	);
}

function clearFindMatches() {
	const hadMatches = activeFindQuery || activeFindMatchOrder.length || activeFindMatchIds.size;
	activeFindQuery = '';
	activeFindMatchIds = new Set<string>();
	activeFindMatchOrder = [];
	activeFindMatchIndex = -1;
	updateFocusReadout(null);
	if (hadMatches) {
		refreshGraphColors();
	}
	emitFindState();
}

function refreshFindMatches(rawQuery, options: { preserveActiveMatch?: boolean } = {}) {
	const query = String(rawQuery || '').trim();
	if (!query) {
		clearFindMatches();
		return [];
	}
	const previousActiveId = options.preserveActiveMatch && activeFindMatchIndex >= 0 ? activeFindMatchOrder[activeFindMatchIndex] || null : null;
	const nodePool = [...(Array.isArray(layoutNodes) ? layoutNodes : []), ...(Array.isArray(graphData?.nodes) ? graphData.nodes : [])];
	const matches = rankFindNodeMatches(query, nodePool, Array.isArray(layoutLinks) ? layoutLinks : []);
	activeFindQuery = query;
	activeFindMatchIds = new Set(matches.map((match) => String(match.node.id)));
	activeFindMatchOrder = matches.map((match) => String(match.node.id));
	activeFindMatchIndex = previousActiveId && activeFindMatchIds.has(previousActiveId) ? activeFindMatchOrder.indexOf(previousActiveId) : -1;
	refreshGraphColors();
	emitFindState();
	return matches;
}

function cycleToFindMatch(rawQuery = activeFindQuery, direction = 1) {
	const query = String(rawQuery || '').trim();
	let nodeIds: string[] = [];
	if (query) {
		const matches = refreshFindMatches(rawQuery, { preserveActiveMatch: true });
		if (matches.length) {
			nodeIds = matches.map((match) => match.node.id);
		} else {
			nodeIds = getVisibleNodeIds();
		}
	} else {
		nodeIds = getVisibleNodeIds();
	}
	if (!nodeIds.length) return false;
	if (activeFindMatchIndex < 0 || activeFindMatchIndex >= nodeIds.length) {
		activeFindMatchIndex = getNearestActiveMatchIndex();
	} else {
		activeFindMatchIndex = (activeFindMatchIndex + direction + nodeIds.length) % nodeIds.length;
	}
	const nodeId = nodeIds[activeFindMatchIndex];
	const liveNode = Array.isArray(layoutNodes) ? layoutNodes.find((node) => node.id === nodeId) : null;
	if (!liveNode) {
		emitFindState();
		return false;
	}
	activeFindMatchOrder = nodeIds;
	activeFindMatchIds = new Set(nodeIds);
	activeFindMatchIndex = activeFindMatchOrder.indexOf(String(liveNode.id));
	focusNodeById(liveNode.id, { duration: 520 });
	startSearchPulseLoop(liveNode.id, { interval: 1400, immediate: true });
	updateFocusReadout(liveNode);
	refreshGraphColors();
	emitFindState();
	return true;
}

function getNearestActiveMatchIndex() {
	const viewport = getVisibleGraphViewport();
	const centerX = viewport.centerX;
	const centerY = viewport.centerY;
	let nearestDistance = Number.POSITIVE_INFINITY;
	let nearestIndex = 0;
	for (let index = 0; index < activeFindMatchOrder.length; index += 1) {
		const nodeId = activeFindMatchOrder[index];
		const node = Array.isArray(layoutNodes) ? layoutNodes.find((entry) => entry.id === nodeId) : null;
		if (!node || !Number.isFinite(node.x) || !Number.isFinite(node.y)) continue;
		const dx = node.x - centerX;
		const dy = node.y - centerY;
		const distance = dx * dx + dy * dy;
		if (distance < nearestDistance) {
			nearestDistance = distance;
			nearestIndex = index;
		}
	}
	return nearestIndex;
}

let sidebarViewMode: SidebarViewMode = loadPersistedSidebarViewMode();

function loadSelectionLogBoldPreference() {
	try {
		const savedPreference = localStorage.getItem(LS_LOG_BOLD_KEY);
		if (savedPreference === null) return true;
		return savedPreference === 'true';
	} catch {
		return true;
	}
}

let cachedPersistedSessionNodeMap: Map<string, any> | null = null;

function getPersistedSessionNodeMap() {
	if (cachedPersistedSessionNodeMap) return cachedPersistedSessionNodeMap;
	const map = new Map<string, any>();
	if (typeof window === 'undefined' || !window.localStorage) {
		cachedPersistedSessionNodeMap = map;
		return map;
	}
	try {
		const raw = localStorage.getItem(LS_SESSION_KEY);
		if (!raw) {
			cachedPersistedSessionNodeMap = map;
			return map;
		}
		const parsed = JSON.parse(raw);
		const session =
			parsed && typeof parsed === 'object' ?
				'data' in parsed ?
					parsed.data
				:	parsed
			:	null;
		if (!session || session.pointer === 'idb') {
			cachedPersistedSessionNodeMap = map;
			return map;
		}

		const extraNodes = Array.isArray(session.extraNodes) ? session.extraNodes.map((node) => sanitizePersistedNode(node)) : [];
		const positions = Array.isArray(session.nodePositions) ? session.nodePositions : [];
		for (const node of extraNodes) {
			const id = String(node?.id || '').trim();
			const x = Number(node?.x);
			const y = Number(node?.y);
			if (!id || !Number.isFinite(x) || !Number.isFinite(y)) continue;
			map.set(id, { ...node, x, y });
		}
		for (const pos of positions) {
			const id = String(pos?.id || '').trim();
			const x = Number(pos?.x);
			const y = Number(pos?.y);
			if (!id || !Number.isFinite(x) || !Number.isFinite(y)) continue;
			if (!map.has(id)) {
				map.set(id, { id, x, y });
			}
		}
		if (Array.isArray(session.renderedServerIds) && graphData?.nodes) {
			for (const id of session.renderedServerIds) {
				const normalizedId = String(id || '').trim();
				if (!normalizedId || map.has(normalizedId)) continue;
				const node = Array.isArray(graphData.nodes) ? graphData.nodes.find((n) => n.id === normalizedId) : null;
				if (node && Number.isFinite(node.x) && Number.isFinite(node.y)) {
					map.set(normalizedId, node);
				}
			}
		}
	} catch {
		// ignore malformed session payloads or storage access failures
	}
	cachedPersistedSessionNodeMap = map;
	return map;
}

function getArrowableNodes() {
	const nodesById = new Map<string, any>();
	if (Array.isArray(layoutNodes) && layoutNodes.length) {
		for (const node of layoutNodes) {
			if (!node || !Number.isFinite(node.x) || !Number.isFinite(node.y)) continue;
			nodesById.set(String(node.id), node);
		}
	}

	const persisted = getPersistedSessionNodeMap();
	for (const [id, node] of persisted.entries()) {
		if (!id || !node || !Number.isFinite(node.x) || !Number.isFinite(node.y) || nodesById.has(id)) continue;
		nodesById.set(id, node);
	}

	return Array.from(nodesById.values());
}

function getNearestArrowableNode(currentNode) {
	const nodes = getArrowableNodes();
	if (!nodes.length) return null;
	const metrics = getGraphViewportMetrics();
	if (!metrics) return nodes[0] || null;
	const centerX = currentNode && Number.isFinite(currentNode.x) ? currentNode.x * metrics.transform.k + metrics.transform.x : metrics.width / 2;
	const centerY = currentNode && Number.isFinite(currentNode.y) ? currentNode.y * metrics.transform.k + metrics.transform.y : metrics.height / 2;
	let nearest = null;
	let nearestDistance = Number.POSITIVE_INFINITY;
	for (const node of nodes) {
		if (!node || !Number.isFinite(node.x) || !Number.isFinite(node.y)) continue;
		const sx = node.x * metrics.transform.k + metrics.transform.x;
		const sy = node.y * metrics.transform.k + metrics.transform.y;
		const dx = sx - centerX;
		const dy = sy - centerY;
		const dist = dx * dx + dy * dy;
		if (dist < nearestDistance) {
			nearestDistance = dist;
			nearest = node;
		}
	}
	return nearest;
}

function moveFindMatch(rawQuery = activeFindQuery, direction = 'ArrowRight') {
	const query = String(rawQuery || '').trim();
	// A recent canvas whitespace click seeds arrow-key navigation from that
	// point; while that origin is pending, arrow keys should navigate to the
	// nearest/directional node from the click instead of cycling in-page find
	// matches, even if a find query is still active.
	if (!lastArrowNavCoord && query && activeFindMatchOrder.length && (direction === 'ArrowRight' || direction === 'ArrowLeft')) {
		return cycleToFindMatch(rawQuery, direction === 'ArrowLeft' ? -1 : 1);
	}

	const arrowable = getArrowableNodes();
	if (!arrowable.length) return false;
	const currentNode =
		(activeFindMatchIndex >= 0 && Array.isArray(layoutNodes) ? layoutNodes.find((node) => node.id === activeFindMatchOrder[activeFindMatchIndex]) : null) ||
		(selectedId ? layoutNodes.find((n) => n.id === selectedId) : null);
	let nextNode = getDirectionalVisibleNode(currentNode, direction);
	if (!nextNode) {
		nextNode = getNearestArrowableNode(currentNode);
	}
	if (!nextNode) return false;
	const nodeIds = arrowable.map((node) => String(node.id));
	activeFindMatchOrder = nodeIds;
	activeFindMatchIds = new Set(nodeIds);
	activeFindMatchIndex = activeFindMatchOrder.indexOf(nextNode.id);
	lastArrowNavCoord = null; // Resume normal node-to-node nav after starting from whitespace
	focusNodeById(nextNode.id, { duration: 520 });
	startSearchPulseLoop(nextNode.id, { interval: 1400, immediate: true });
	updateFocusReadout(nextNode);
	refreshGraphColors();
	emitFindState();
	return true;
}

function getVisibleNodeIds() {
	if (!Array.isArray(layoutNodes) || !layoutNodes.length || !svgSel) return [];
	const metrics = getGraphViewportMetrics();
	if (!metrics) return [];
	const { transform, width, height } = metrics;
	const { x, y, k } = transform;
	return layoutNodes
		.filter((node) => {
			if (!node || !Number.isFinite(node.x) || !Number.isFinite(node.y)) return false;
			const radius = (node._vizHalf ?? NODE_R[node.group] ?? 10) * k;
			const sx = node.x * k + x;
			const sy = node.y * k + y;
			return sx + radius >= 0 && sx - radius <= width && sy + radius >= 0 && sy - radius <= height;
		})
		.map((node) => String(node.id));
}

function getVisibleNodes() {
	if (!Array.isArray(layoutNodes) || !layoutNodes.length || !svgSel) return [];
	const metrics = getGraphViewportMetrics();
	if (!metrics) return [];
	const { transform, width, height } = metrics;
	const { x, y, k } = transform;
	return layoutNodes.filter((node) => {
		if (!node || !Number.isFinite(node.x) || !Number.isFinite(node.y)) return false;
		const radius = (node._vizHalf ?? NODE_R[node.group] ?? 10) * k;
		const sx = node.x * k + x;
		const sy = node.y * k + y;
		return sx + radius >= 0 && sx - radius <= width && sy + radius >= 0 && sy - radius <= height;
	});
}

function getDirectionalVisibleNode(currentNode, direction) {
	const visible = getArrowableNodes();
	if (!visible.length) return null;
	const directionVector = {
		ArrowRight: { x: 1, y: 0 },
		ArrowLeft: { x: -1, y: 0 },
		ArrowDown: { x: 0, y: 1 },
		ArrowUp: { x: 0, y: -1 },
	}[direction];
	if (!directionVector) return null;
	const metrics = getGraphViewportMetrics();
	if (!metrics) return null;
	const refX =
		lastArrowNavCoord ? lastArrowNavCoord.x
		: currentNode && Number.isFinite(currentNode.x) ? currentNode.x * metrics.transform.k + metrics.transform.x
		: metrics.width / 2;
	const refY =
		lastArrowNavCoord ? lastArrowNavCoord.y
		: currentNode && Number.isFinite(currentNode.y) ? currentNode.y * metrics.transform.k + metrics.transform.y
		: metrics.height / 2;
	let best = null;
	let bestScore = Number.POSITIVE_INFINITY;
	for (const node of visible) {
		if (!node || !Number.isFinite(node.x) || !Number.isFinite(node.y)) continue;
		const sx = node.x * metrics.transform.k + metrics.transform.x;
		const sy = node.y * metrics.transform.k + metrics.transform.y;
		const dx = sx - refX;
		const dy = sy - refY;
		const primary = dx * directionVector.x + dy * directionVector.y;
		if (primary <= 0) continue;
		const secondary = Math.abs(dx * directionVector.y - dy * directionVector.x);
		const score = secondary + Math.abs(primary) * 0.15;
		if (score < bestScore) {
			bestScore = score;
			best = node;
		}
	}
	return best;
}

function saveSelectionLogBoldPreference() {
	try {
		localStorage.setItem(LS_LOG_BOLD_KEY, isSelectionLogBold ? 'true' : 'false');
	} catch {
		/* ignore persistence errors */
	}
}

isSelectionLogBold = loadSelectionLogBoldPreference();

function isDevelopmentRuntime() {
	if (typeof process !== 'undefined' && process.env.NODE_ENV) {
		return process.env.NODE_ENV !== 'production';
	}
	if (typeof location !== 'undefined') {
		return /(?:localhost|127\.0\.0\.1)$/i.test(location.hostname);
	}
	return false;
}

function logDetailLoadDebug(...args: any[]) {
	if (!ENABLE_DETAIL_LOAD_DEBUG_LOGS) return;
	if (!isDevelopmentRuntime()) return;
	console.info('[finra-graph]', ...args);
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

function getSelectionLogActionButtons(action: 'trace' | 'copy-all' | 'copy-link' | 'clear' | 'clear-others' | 'clear-labels' | 'toggle-bold' | 'edit' | 'clear-labels-menu') {
	return Array.from(document.querySelectorAll<HTMLButtonElement>(`[data-fg-selection-log-action="${action}"]`));
}

export function isSelectionLogPeopleEntry(entry: { id?: string; group?: string } | null | undefined) {
	const group = String(entry?.group || '')
		.trim()
		.toLowerCase();
	if (group === 'individual' || group === 'person') return true;
	if (group === 'firm' || group === 'entity') return false;
	const id = String(entry?.id || '')
		.trim()
		.toLowerCase();
	return id.startsWith('person:') || id.startsWith('person_');
}

export function filterSelectionLogLabelNodeIdsByScope(
	nodeIds: Array<string | null | undefined> = [],
	selectionLog: Array<{ id?: string; group?: string }> = [],
	scope: SelectionLogClearLabelsScope = 'all',
) {
	const uniqueIds = Array.from(new Set(nodeIds.map((id) => String(id || '').trim()).filter(Boolean)));
	if (scope === 'all') return uniqueIds;

	const peopleIds = new Set(
		selectionLog
			.filter((entry) => isSelectionLogPeopleEntry(entry))
			.map((entry) => String(entry?.id || '').trim())
			.filter(Boolean),
	);

	return uniqueIds.filter((id) => {
		if (peopleIds.has(id)) return true;
		return isSelectionLogPeopleEntry({ id });
	});
}

function syncSelectionLogAuxiliaryRenderers() {
	const transform = getCurrentZoomTransform();
	const labelScale = selectedId || isSelectionLogBold ? getFocusedLabelScale(transform.k) : 1;
	const logLabelNodeIds = getSelectionLogLabelNodeIds();
	if (shouldRefreshOverlayLabels(layoutNodes?.length) && overlayApi && typeof overlayApi.update === 'function') {
		try {
			overlayApi.update(layoutNodes || [], transform, { selectedId, labelScale, logLabelNodeIds });
		} catch {}
	}
	if (canvasApi && typeof canvasApi.drawFrame === 'function') {
		try {
			canvasApi.drawFrame(layoutNodes || [], layoutLinks || [], transform, { selectedId, labelScale, logLabelNodeIds });
		} catch {}
	}
	if (pixiApi && typeof pixiApi.drawFrame === 'function') {
		try {
			pixiApi.drawFrame(layoutNodes || [], layoutLinks || [], transform, { selectedId, labelScale, logLabelNodeIds });
		} catch {}
	}
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

	getSelectionLogActionButtons('toggle-bold').forEach((button) => {
		button.classList.toggle('active', isSelectionLogBold);
		button.setAttribute('aria-pressed', isSelectionLogBold ? 'true' : 'false');
		button.title = isSelectionLogBold ? 'Use normal graph node label size' : 'Make graph node labels larger like trace mode';
		button.textContent = isSelectionLogBold ? 'Log Bold On' : 'Log Bold';
	});

	const enlargedNodeIds = getSelectionLogLabelNodeIds();
	const enlargedPeopleNodeIds = filterSelectionLogLabelNodeIdsByScope(enlargedNodeIds, selectedNodesLog, 'people');
	const clearLabelsDisabled = !isSelectionLogBold || enlargedNodeIds.length === 0;
	const clearPeopleLabelsDisabled = !isSelectionLogBold || enlargedPeopleNodeIds.length === 0;

	document.querySelectorAll<HTMLElement>('.fg-clear-labels-control').forEach((control) => {
		control.classList.toggle('is-open', isSelectionLogClearLabelsMenuOpen);
		control.setAttribute('data-open', isSelectionLogClearLabelsMenuOpen ? 'true' : 'false');
		const menu = control.querySelector<HTMLElement>('.fg-clear-labels-control__menu');
		if (menu) menu.hidden = !isSelectionLogClearLabelsMenuOpen;
	});

	getSelectionLogActionButtons('clear-labels-menu').forEach((button) => {
		button.disabled = clearLabelsDisabled;
		button.setAttribute('aria-expanded', isSelectionLogClearLabelsMenuOpen ? 'true' : 'false');
		button.title =
			!isSelectionLogBold ? 'Enable Log Bold to use large labels'
			: enlargedNodeIds.length ? 'Choose whether to clear all large labels or only people labels'
			: 'No enlarged labels to clear';
		button.textContent = 'Clear Labels';
	});

	getSelectionLogActionButtons('clear-labels').forEach((button) => {
		const scope = normalizeSelectionLogClearLabelsScope(button.dataset.fgClearLabelsScope);
		const scopedIds = scope === 'people' ? enlargedPeopleNodeIds : enlargedNodeIds;
		const disabled = scope === 'people' ? clearPeopleLabelsDisabled : clearLabelsDisabled;
		button.disabled = disabled;
		button.hidden = !isSelectionLogClearLabelsMenuOpen;
		button.title =
			!isSelectionLogBold ? 'Enable Log Bold to use large labels'
			: scope === 'people' ?
				scopedIds.length ?
					'Shrink only enlarged people labels without clearing the log'
				:	'No enlarged people labels to clear'
			: scopedIds.length ? 'Shrink all currently enlarged labels without clearing the log'
			: 'No enlarged labels to clear';
		button.textContent = scope === 'people' ? 'People only' : 'All labels';
	});

	getSelectionLogActionButtons('edit').forEach((button) => {
		button.classList.toggle('active', isSelectionLogEditMode);
		button.setAttribute('aria-pressed', isSelectionLogEditMode ? 'true' : 'false');
		button.title = isSelectionLogEditMode ? 'Done editing selection log entries' : 'Edit selection log entries';
		button.textContent = 'Edit';
	});

	getSelectionLogActionButtons('clear-others').forEach((button) => {
		button.disabled = selectedNodesLog.length === 0;
		button.title = selectedNodesLog.length ? 'Keep logged nodes and any intermediaries connecting them' : 'No selection log entries to keep';
		button.textContent = 'Clear Others';
	});
}

// Listen for overlay hover/click events dispatched from the HTML overlay so
// overlay labels can update the central graph hover/selection state.
if (typeof window !== 'undefined') {
	try {
		window.addEventListener('finra:overlay-hover', (ev: any) => {
			try {
				const id = ev?.detail?.id || null;
				if (id) {
					setHoveredNode(String(id));
				}
			} catch (e) {}
		});

		window.addEventListener('finra:overlay-hover-end', () => {
			try {
				setHoveredNode(null);
			} catch (e) {}
		});

		window.addEventListener('finra:overlay-click', (ev: any) => {
			try {
				const id = ev?.detail?.id || null;
				if (id) {
					// emulate user click on the node
					const node = getNodeById(String(id));
					if (node) {
						// mark as selected (persist) like a normal node click
						markNodeSelected(node, { persist: true });
						reapplySelectionState();
						try {
							// render sidebar detail for clicked node and emit route event
							renderSidebar(node);
							emitSelectedNodeRoute(node.id, { replace: false });
						} catch (e) {}
					}
				}
			} catch (e) {}
		});
	} catch (e) {
		/* ignore environments without window */
	}
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

function setSidebarViewMode(mode: SidebarViewMode, options: { expandMobile?: boolean } = {}) {
	sidebarViewMode = mode;
	try {
		if (typeof window !== 'undefined' && window.sessionStorage) {
			sessionStorage.setItem(SIDEBAR_VIEW_MODE_STORAGE_KEY, mode);
		}
	} catch {
		/* ignore persistence errors */
	}

	const sidebar = document.getElementById('fg-sidebar');
	if (sidebar) {
		sidebar.dataset.viewMode = mode;
		if (options.expandMobile) {
			sidebar.dataset.mobileExpanded = 'true';
			sidebar.classList.remove('hidden');
			document.getElementById('fg-sidebar-backdrop')?.classList.remove('hidden');
			if (isMobileSidebarViewport() && mode !== 'none') {
				window.dispatchEvent(new CustomEvent(MOBILE_FIND_CLOSE_REQUEST_EVENT));
			}
		}
	}

	if (sidebarSelectedNode) renderSidebar(sidebarSelectedNode);
	// Always re-render sidebar to ensure toggles are present even with no selection.
	renderSidebar(sidebarSelectedNode);
	updateSelectionLogChrome();
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
function getSelectionLogLabelNodeIds() {
	if (!isSelectionLogBold) return [];
	const visibleNodeIds = new Set((layoutNodes || []).map((node) => String(node?.id || '').trim()).filter(Boolean));
	return Array.from(
		new Set(selectedNodesLog.map((entry) => String(entry?.id || '').trim()).filter((id) => Boolean(id) && visibleNodeIds.has(id) && !clearedSelectionLogLabelNodeIds.has(id))),
	);
}

function normalizeSelectionLogClearLabelsScope(scope: string | null | undefined): SelectionLogClearLabelsScope {
	return (
			String(scope || '')
				.trim()
				.toLowerCase() === 'people'
		) ?
			'people'
		:	'all';
}

function clearSelectionLogLabels(scope: SelectionLogClearLabelsScope = 'all') {
	const enlargedNodeIds = filterSelectionLogLabelNodeIdsByScope(getSelectionLogLabelNodeIds(), selectedNodesLog, scope);
	if (!enlargedNodeIds.length) return 0;
	enlargedNodeIds.forEach((id) => {
		clearedSelectionLogLabelNodeIds.add(id);
	});
	isSelectionLogClearLabelsMenuOpen = false;
	updateSelectionLogUI();
	syncSelectionLogActionButtonStates();
	reapplySelectionState();
	syncTraceLabelPresentation();
	syncSelectionLogAuxiliaryRenderers();
	return enlargedNodeIds.length;
}

function getConnectedRenderedGraphSnapshot() {
	const nodes = Array.isArray(layoutNodes) ? layoutNodes.filter((node) => node && String(node.id || '').trim()) : [];
	const links =
		Array.isArray(layoutLinks) ?
			layoutLinks.filter((link) => {
				const sourceId = String(link?.source?.id ?? link?.source ?? '').trim();
				const targetId = String(link?.target?.id ?? link?.target ?? '').trim();
				return Boolean(sourceId && targetId);
			})
		:	[];

	const nodeMap = new Map(nodes.map((node) => [String(node.id), node]));
	const adjacency = new Map<string, Set<string>>();
	for (const node of nodes) adjacency.set(String(node.id), new Set<string>());
	for (const link of links) {
		const sourceId = String(link?.source?.id ?? link?.source ?? '').trim();
		const targetId = String(link?.target?.id ?? link?.target ?? '').trim();
		if (!sourceId || !targetId || !nodeMap.has(sourceId) || !nodeMap.has(targetId)) continue;
		adjacency.get(sourceId)?.add(targetId);
		adjacency.get(targetId)?.add(sourceId);
	}

	const connectedNodeIds = new Set<string>();
	for (const [nodeId, neighbors] of adjacency.entries()) {
		if (neighbors.size > 0) connectedNodeIds.add(nodeId);
	}

	const connectedNodes = nodes.filter((node) => connectedNodeIds.has(String(node.id)));
	const connectedLinks = links.filter((link) => {
		const sourceId = String(link?.source?.id ?? link?.source ?? '').trim();
		const targetId = String(link?.target?.id ?? link?.target ?? '').trim();
		return connectedNodeIds.has(sourceId) && connectedNodeIds.has(targetId);
	});

	const degreeById = new Map<string, number>();
	for (const node of connectedNodes) {
		degreeById.set(String(node.id), adjacency.get(String(node.id))?.size || 0);
	}

	const visited = new Set<string>();
	const components = [] as Array<any>;

	const sortByDegreeThenLabel = (aId: string, bId: string) => {
		const degreeDiff = (degreeById.get(bId) || 0) - (degreeById.get(aId) || 0);
		if (degreeDiff !== 0) return degreeDiff;
		const a = nodeMap.get(aId);
		const b = nodeMap.get(bId);
		return String(getPreferredNodeLabel(a) || a?.label || aId).localeCompare(String(getPreferredNodeLabel(b) || b?.label || bId));
	};

	for (const startNode of connectedNodes.slice().sort((a, b) => sortByDegreeThenLabel(String(a.id), String(b.id)))) {
		const startId = String(startNode.id);
		if (visited.has(startId)) continue;
		const queue = [startId];
		const componentNodes = new Set<string>();
		const componentLinks: Array<any> = [];
		const parentById = new Map<string, string | null>([[startId, null]]);
		visited.add(startId);

		while (queue.length) {
			const currentId = queue.shift() as string;
			componentNodes.add(currentId);
			for (const link of connectedLinks) {
				const sourceId = String(link?.source?.id ?? link?.source ?? '').trim();
				const targetId = String(link?.target?.id ?? link?.target ?? '').trim();
				if (sourceId !== currentId && targetId !== currentId) continue;
				componentLinks.push({
					source: sourceId,
					target: targetId,
					relationship: link?.relationship || null,
					isCurrent: link?.isCurrent ?? null,
					startDate: link?.startDate || null,
					endDate: link?.endDate || null,
				});
				const nextId = sourceId === currentId ? targetId : sourceId;
				if (!componentNodes.has(nextId) && !visited.has(nextId)) {
					visited.add(nextId);
					parentById.set(nextId, currentId);
					queue.push(nextId);
				}
			}
		}

		const childrenById = new Map<string, string[]>();
		for (const nodeId of componentNodes) childrenById.set(nodeId, []);
		for (const [nodeId, parentId] of parentById.entries()) {
			if (!parentId) continue;
			childrenById.get(parentId)?.push(nodeId);
		}

		for (const children of childrenById.values()) {
			children.sort(sortByDegreeThenLabel);
		}

		const buildTree = (nodeId: string): any => {
			const node = nodeMap.get(nodeId);
			return {
				id: nodeId,
				label: getPreferredNodeLabel(node) || node?.label || nodeId,
				group: node?.group || null,
				firmId: node?.firmId || null,
				crd: node?.crd || null,
				connectedTo: Array.from(adjacency.get(nodeId) || []).sort(sortByDegreeThenLabel),
				children: (childrenById.get(nodeId) || []).map((childId) => buildTree(childId)),
			};
		};

		const rootId = Array.from(componentNodes).sort(sortByDegreeThenLabel)[0] || startId;
		components.push({
			rootId,
			rootLabel: getPreferredNodeLabel(nodeMap.get(rootId)) || nodeMap.get(rootId)?.label || rootId,
			nodeCount: componentNodes.size,
			linkCount: componentLinks.length,
			nodes: Array.from(componentNodes)
				.sort(sortByDegreeThenLabel)
				.map((nodeId) => {
					const node = nodeMap.get(nodeId);
					return {
						id: nodeId,
						label: getPreferredNodeLabel(node) || node?.label || nodeId,
						group: node?.group || null,
						firmId: node?.firmId || null,
						crd: node?.crd || null,
						degree: degreeById.get(nodeId) || 0,
						connectedTo: Array.from(adjacency.get(nodeId) || []).sort(sortByDegreeThenLabel),
					};
				}),
			links: componentLinks,
			tree: buildTree(rootId),
		});
	}

	return {
		generatedAt: new Date().toISOString(),
		nodeCount: connectedNodes.length,
		linkCount: connectedLinks.length,
		components,
	};
}

export function exportConnectedRenderedGraphSnapshot(options: { print?: boolean } = {}) {
	const snapshot = getConnectedRenderedGraphSnapshot();
	if (options.print !== false && typeof console !== 'undefined') {
		console.log(JSON.stringify(snapshot, null, 2));
	}
	return snapshot;
}

function isSelectionLogChildNode(nodeId: string) {
	const normalizedNodeId = String(nodeId || '').trim();
	if (!normalizedNodeId || !Array.isArray(layoutLinks) || !layoutLinks.length) return false;
	return layoutLinks.some((link) => {
		const sourceId = String(link?.source?.id ?? link?.source ?? '').trim();
		const targetId = String(link?.target?.id ?? link?.target ?? '').trim();
		return Boolean(sourceId && targetId && targetId === normalizedNodeId && sourceId !== normalizedNodeId);
	});
}

function clearChildNodeSelectionVisualState(nodeId: string) {
	const normalizedNodeId = String(nodeId || '').trim();
	if (!normalizedNodeId) return;
	highlightedSelections = highlightedSelections.filter((entry) => String(entry?.id || '').trim() !== normalizedNodeId);
	visitedNodeIds.delete(normalizedNodeId);
	persistentSelectedIds.delete(normalizedNodeId);
	if (selectedId && String(selectedId).trim() === normalizedNodeId) {
		selectedId = null;
	}
}

function restoreChildNodeSelectionVisualState(nodeId: string) {
	const normalizedNodeId = String(nodeId || '').trim();
	if (!normalizedNodeId) return;
	upsertHighlightedSelection(normalizedNodeId, getDefaultSelectionHops());
	visitedNodeIds.add(normalizedNodeId);
}

function calculateTrace() {
	const traceModeNodeIds = isTraceMode ? getTraceModeNodeIds() : [];
	const traceLogNodeIds = isTraceLogMode ? getTraceLogNodeIds() : [];
	const hasTraceTargets = traceModeNodeIds.length >= 2;
	const hasTraceLogTargets = traceLogNodeIds.length >= 2;
	// Strict trace rule: gray or inactive links must be excluded from pathfinding
	// and must never be highlighted. This includes links that are dashed via
	// inactive endpoints as well as explicit "previous employment" links.
	const blockedTraceLinkIds = new Set<string>(
		(layoutLinks || []).filter((link) => Boolean(getLinkDash(link)) || hasInactiveEndpoint(link) || isPreviousEmploymentLink(link)).map((link) => getLinkKey(link)),
	);
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
	layoutNodes.forEach((n) => adj.set(String(n.id), []));
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
	const visited = new Set<string>([startId]);
	const queue: Array<{ nodeId: string; path: string[] }> = [{ nodeId: startId, path: [startId] }];
	while (queue.length) {
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
	const returnBlockedLinkIds = new Set<string>([...blockedLinkIds, ...getPathLinkIds(forwardPath)]);
	const returnPath = forwardPath ? findShortestPath(endId, startId, adj, { blockedLinkIds: returnBlockedLinkIds }) : null;

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

function upsertSelectionLogEntry(entries: Array<SelectionLogEntry>, entry: SelectionLogEntry) {
	const normalizedEntryId = String(entry?.id || '').trim();
	if (!normalizedEntryId) return entries.slice();
	const nextEntries = entries.filter((existingEntry) => String(existingEntry?.id || '').trim() !== normalizedEntryId);
	nextEntries.push(entry);
	return nextEntries;
}

function addToSelectionLog(d) {
	const secondaryId = getSecondaryId(d);
	const entry = {
		id: d.id,
		label: d.label,
		secondaryId: secondaryId,
		group: d.group,
	};

	// Only add if this node was explicitly selected (not just visited/expanded).
	// Re-selecting an existing node moves it to the most-recent slot.
	selectedNodesLog = upsertSelectionLogEntry(selectedNodesLog, entry);
	// A fresh click on this node means the user wants to see its label emphasized
	// again, even if "Clear Labels" previously hid it.
	clearedSelectionLogLabelNodeIds.delete(String(d.id || '').trim());
	saveSelectionLog();
	updateSelectionLogUI();
	syncSelectionLogAuxiliaryRenderers();
}

function removeSelectionLogEntry(entryId: string) {
	const normalizedEntryId = String(entryId || '').trim();
	if (!normalizedEntryId) return;
	const nextLog = selectedNodesLog.filter((entry) => String(entry?.id || '').trim() !== normalizedEntryId);
	if (nextLog.length === selectedNodesLog.length) return;
	selectedNodesLog = nextLog;
	if (!selectedNodesLog.length) {
		isSelectionLogEditMode = false;
	}

	if (isSelectionLogEditMode && graphData) {
		// 1. Find all nodes reachable from normalizedEntryId (A)
		const reachableFromA = new Set<string>([normalizedEntryId]);
		const aQueue = [normalizedEntryId];
		while (aQueue.length > 0) {
			const curr = aQueue.shift()!;
			for (const l of graphData.links) {
				const s = String(l.source?.id ?? l.source).trim();
				const t = String(l.target?.id ?? l.target).trim();
				if (s === curr && !reachableFromA.has(t)) {
					reachableFromA.add(t);
					aQueue.push(t);
				} else if (t === curr && !reachableFromA.has(s)) {
					reachableFromA.add(s);
					aQueue.push(s);
				}
			}
		}

		// 2. Find keep-roots: clicked-on nodes (excluding A) and nodes not reachable from A at all
		const clickedNodes = Array.from(visitedNodeIds)
			.map((id) => String(id).trim())
			.filter((id) => id !== normalizedEntryId);

		const visited = new Set<string>(clickedNodes);
		const queue = [...clickedNodes];

		for (const n of graphData.nodes) {
			const nid = String(n.id).trim();
			if (!reachableFromA.has(nid) && !visited.has(nid)) {
				visited.add(nid);
				queue.push(nid);
			}
		}

		// 3. Traverse from keep-roots along all links (excluding those connected to normalizedEntryId) to identify all protected nodes
		while (queue.length > 0) {
			const curr = queue.shift()!;
			for (const l of graphData.links) {
				const s = String(l.source?.id ?? l.source).trim();
				const t = String(l.target?.id ?? l.target).trim();
				if (s === curr && t !== normalizedEntryId && !visited.has(t)) {
					visited.add(t);
					queue.push(t);
				} else if (t === curr && s !== normalizedEntryId && !visited.has(s)) {
					visited.add(s);
					queue.push(s);
				}
			}
		}

		// 'visited' set now contains all nodes that should be KEPT.
		// The nodes to REMOVE are everything else (which includes normalizedEntryId).
		const removedNodeIds = new Set<string>();
		for (const n of graphData.nodes) {
			const nid = String(n.id).trim();
			if (!visited.has(nid)) {
				removedNodeIds.add(nid);
			}
		}

		// Remove the nodes from graphData.nodes
		graphData.nodes = graphData.nodes.filter((n) => !removedNodeIds.has(String(n.id).trim()));

		// Remove links connecting to any removed node
		graphData.links = graphData.links.filter((l) => {
			const s = String(l.source?.id ?? l.source).trim();
			const t = String(l.target?.id ?? l.target).trim();
			return !removedNodeIds.has(s) && !removedNodeIds.has(t);
		});

		// Clean up selected/highlighted/visited sets for all removed nodes
		for (const removedId of removedNodeIds) {
			if (selectedId && String(selectedId).trim() === removedId) {
				selectedId = null;
				sidebarSelectedNode = null;
				sidebarViewMode = 'none';
				showSidebarHint();
				emitSelectedNodeRoute(null, { replace: true });
			}
			highlightedSelections = highlightedSelections.filter((sel) => String(sel.id).trim() !== removedId);
			persistentSelectedIds.delete(removedId);
			visitedNodeIds.delete(removedId);

			if (initialServerNodeIds instanceof Set) {
				initialServerNodeIds.delete(removedId);
			}
			if (initialServerLinkKeys instanceof Set) {
				for (const key of Array.from(initialServerLinkKeys)) {
					if (key.startsWith(`${removedId}|`) || key.endsWith(`|${removedId}`)) {
						initialServerLinkKeys.delete(key);
					}
				}
			}
		}

		renderGraph(graphData);
		updateMeta();
		saveSession();
	}

	saveSelectionLog();
	updateSelectionLogUI();
	syncSelectionLogActionButtonStates();
	refreshTraceState();
	syncTraceLabelPresentation();
	syncSelectionLogAuxiliaryRenderers();
}

async function ensureNodeFetchedAndOnScreen(entry: SelectionLogEntry) {
	const entryId = entry.id;
	const isOnScreen = Array.isArray(layoutNodes) && layoutNodes.some((n) => String(n.id).trim() === String(entryId).trim());
	if (isOnScreen) {
		const liveNode = layoutNodes.find((n) => String(n.id).trim() === String(entryId).trim());
		if (liveNode) {
			selectNode(liveNode, { focus: true, pulse: true });
		}
		return;
	}

	if (graphData && Array.isArray(graphData.nodes)) {
		const nodeInGraph = graphData.nodes.find((n) => String(n.id).trim() === String(entryId).trim());
		if (nodeInGraph) {
			injectNodesById([entryId]);
			const liveNode = layoutNodes.find((n) => String(n.id).trim() === String(entryId).trim());
			if (liveNode) {
				selectNode(liveNode, { focus: true, pulse: true });
			}
			return;
		}
	}

	const crd = entryId.split(':').pop() || '';
	if (!crd) return;

	updateFetchStatus(`Fetching CRD ${crd} into graph...`);
	try {
		const success = await fetchAndInjectLocalQuery(crd);
		if (success && graphData && Array.isArray(graphData.nodes)) {
			const nodeInGraph = graphData.nodes.find((n) => String(n.id).trim() === String(entryId).trim());
			if (nodeInGraph) {
				injectNodesById([entryId]);
				const liveNode = layoutNodes.find((n) => String(n.id).trim() === String(entryId).trim());
				if (liveNode) {
					selectNode(liveNode, { focus: true, pulse: true });
					clearFetchStatus();
					return;
				}
			}
		}
		updateFetchStatus(`CRD ${crd} could not be found.`);
	} catch (err) {
		console.error(`Failed to fetch node for ${entryId}:`, err);
		updateFetchStatus(`Failed to fetch CRD ${crd}.`);
	}
}

function buildUndirectedAdjacencyList(links: Array<any>): Map<string, string[]> {
	const adj = new Map<string, string[]>();
	for (const link of links) {
		const sourceId = String(link?.source?.id ?? link?.source ?? '').trim();
		const targetId = String(link?.target?.id ?? link?.target ?? '').trim();
		if (!sourceId || !targetId || sourceId === targetId) continue;
		if (!adj.has(sourceId)) adj.set(sourceId, []);
		if (!adj.has(targetId)) adj.set(targetId, []);
		adj.get(sourceId)!.push(targetId);
		adj.get(targetId)!.push(sourceId);
	}
	return adj;
}

function getBfsDistances(adj: Map<string, string[]>, start: string): Map<string, number> {
	const distances = new Map<string, number>();
	distances.set(start, 0);
	const queue: string[] = [start];
	while (queue.length > 0) {
		const current = queue.shift()!;
		const currentDist = distances.get(current)!;
		for (const neighbor of adj.get(current) || []) {
			if (!distances.has(neighbor)) {
				distances.set(neighbor, currentDist + 1);
				queue.push(neighbor);
			}
		}
	}
	return distances;
}

function collectSteinerTreeConnectorIds(adj: Map<string, string[]>, terminalIds: Set<string>): Set<string> {
	const keepIds = new Set<string>(terminalIds);
	if (terminalIds.size <= 1) return keepIds;

	const terminalArray = Array.from(terminalIds);
	const distancesFrom = new Map<string, Map<string, number>>();
	for (const terminalId of terminalArray) {
		distancesFrom.set(terminalId, getBfsDistances(adj, terminalId));
	}

	// Greedy minimum spanning tree in hypergraph space: repeatedly add the shortest
	// path from any not-yet-connected terminal to the already-kept subgraph.
	const connected = new Set<string>();
	connected.add(terminalArray[0]);

	while (connected.size < terminalIds.size) {
		let bestTerminal: string | null = null;
		let bestPath: string[] | null = null;
		let bestLength = Infinity;

		for (const terminalId of terminalArray) {
			if (connected.has(terminalId)) continue;
			const distances = distancesFrom.get(terminalId)!;

			for (const connectedId of connected) {
				const totalDistance = distances.get(connectedId);
				if (totalDistance === undefined || totalDistance >= bestLength) continue;

				// Reconstruct one shortest path to this connected node.
				const path: string[] = [];
				let current: string | undefined = connectedId;
				while (current !== undefined) {
					path.push(current);
					const currentDist = distances.get(current);
					if (currentDist === undefined || currentDist === 0) break;

					const neighbors = adj.get(current) || [];
					let next: string | undefined;
					for (const neighbor of neighbors) {
						const neighborDist = distances.get(neighbor);
						if (neighborDist !== undefined && neighborDist < currentDist) {
							next = neighbor;
							break;
						}
					}
					current = next;
				}

				bestTerminal = terminalId;
				bestPath = path;
				bestLength = totalDistance;
			}
		}

		if (!bestTerminal || !bestPath) break;
		connected.add(bestTerminal);
		for (const nodeId of bestPath) {
			keepIds.add(nodeId);
			connected.add(nodeId);
		}
	}

	return keepIds;
}

export function pruneGraphToSelectionLogEntries(
	graphData: { nodes?: Array<any>; links?: Array<any> } | null,
	entries: Array<SelectionLogEntry> = selectedNodesLog,
	extraKeepIds: Set<string> = new Set(),
) {
	if (!graphData || !Array.isArray(graphData.nodes) || !Array.isArray(graphData.links)) return graphData;

	const logIds = new Set<string>((Array.isArray(entries) ? entries : []).map((entry) => String(entry?.id || '').trim()).filter(Boolean));

	const adj = buildUndirectedAdjacencyList(graphData.links);
	const keepIds = collectSteinerTreeConnectorIds(adj, logIds);
	// Preserve any additional nodes the caller wants kept regardless of the
	// log-entry Steiner tree — e.g. nodes connected by a line to a node the
	// user currently has selected/highlighted in the graph.
	for (const extraId of extraKeepIds) {
		const normalizedExtraId = String(extraId || '').trim();
		if (normalizedExtraId) keepIds.add(normalizedExtraId);
	}

	const keptNodes = graphData.nodes.filter((node) => keepIds.has(String(node?.id || '').trim()));
	const keptLinks = graphData.links.filter((link) => {
		const sourceId = String(link?.source?.id ?? link?.source ?? '').trim();
		const targetId = String(link?.target?.id ?? link?.target ?? '').trim();
		return Boolean(sourceId && targetId && keepIds.has(sourceId) && keepIds.has(targetId));
	});

	graphData.nodes = keptNodes;
	graphData.links = keptLinks;
	return graphData;
}

function pruneGraphDataToKeepIds(keepIds: Set<string>) {
	if (!graphData || !Array.isArray(graphData.nodes) || !Array.isArray(graphData.links)) return;

	graphData.nodes = graphData.nodes.filter((node) => keepIds.has(String(node?.id || '').trim()));
	graphData.links = graphData.links.filter((link) => {
		const sourceId = String(link?.source?.id ?? link?.source ?? '').trim();
		const targetId = String(link?.target?.id ?? link?.target ?? '').trim();
		return Boolean(sourceId && targetId && keepIds.has(sourceId) && keepIds.has(targetId));
	});

	const keptNodeIds = new Set<string>(graphData.nodes.map((node) => String(node?.id || '').trim()).filter(Boolean));

	if (selectedId && !keptNodeIds.has(String(selectedId).trim())) {
		selectedId = null;
		sidebarSelectedNode = null;
		sidebarViewMode = 'none';
		showSidebarHint();
		emitSelectedNodeRoute(null, { replace: true });
	}

	highlightedSelections = highlightedSelections.filter((selection) => keptNodeIds.has(String(selection?.id || '').trim()));
	persistentSelectedIds = new Set(Array.from(persistentSelectedIds).filter((id) => keptNodeIds.has(String(id).trim())));
	visitedNodeIds = new Set(Array.from(visitedNodeIds).filter((id) => keptNodeIds.has(String(id).trim())));

	if (initialServerNodeIds instanceof Set) {
		for (const nodeId of Array.from(initialServerNodeIds)) {
			if (!keptNodeIds.has(String(nodeId).trim())) {
				initialServerNodeIds.delete(nodeId);
			}
		}
	}

	if (initialServerLinkKeys instanceof Set) {
		for (const key of Array.from(initialServerLinkKeys)) {
			const [sourceId, targetId] = key.split('|');
			if (!keptNodeIds.has(String(sourceId).trim()) || !keptNodeIds.has(String(targetId).trim())) {
				initialServerLinkKeys.delete(key);
			}
		}
	}

	renderGraph(graphData);
	updateMeta();
	saveSession();
	refreshTraceState();
	syncTraceLabelPresentation();
	syncSelectionLogAuxiliaryRenderers();
}

function clearGraphAction(button?: HTMLButtonElement) {
	clearGraphData();
	if (button) flashSelectionLogActionButton(button, 'Cleared!');
}

function clearNonLogAction(button?: HTMLButtonElement) {
	const logIds = new Set<string>(selectedNodesLog.map((entry) => String(entry?.id || '').trim()).filter(Boolean));
	if (logIds.size === 0) {
		updateFetchStatus('Selection log is empty');
		if (button) flashSelectionLogActionButton(button, 'Empty');
		return;
	}
	pruneGraphDataToKeepIds(logIds);
	if (button) flashSelectionLogActionButton(button, 'Pruned!');
}

function clearNonConnectedAction(button?: HTMLButtonElement) {
	const rootId = selectedId || (selectedNodesLog.length ? selectedNodesLog[selectedNodesLog.length - 1].id : null);

	if (!rootId) {
		if (!graphData?.nodes || !graphData?.links) {
			if (button) flashSelectionLogActionButton(button, 'No nodes');
			return;
		}
		const keepIds = new Set<string>();
		for (const link of graphData.links) {
			const sid = String(link?.source?.id ?? link?.source ?? '').trim();
			const tid = String(link?.target?.id ?? link?.target ?? '').trim();
			if (sid) keepIds.add(sid);
			if (tid) keepIds.add(tid);
		}
		pruneGraphDataToKeepIds(keepIds);
		if (button) flashSelectionLogActionButton(button, 'Pruned Isolated!');
		return;
	}

	if (!graphData?.links?.length) {
		updateFetchStatus('No current selection to connect from');
		if (button) flashSelectionLogActionButton(button, 'No selection');
		return;
	}
	const adj = buildUndirectedAdjacencyList(graphData.links);
	const reachable = getBfsDistances(adj, String(rootId).trim());
	const keepIds = new Set<string>(reachable.keys());
	pruneGraphDataToKeepIds(keepIds);
	if (button) flashSelectionLogActionButton(button, 'Pruned!');
}

function updateSelectionLogUI() {
	const containers = Array.from(document.querySelectorAll<HTMLElement>('#fg-selection-log-list, #fg-sidebar-selection-log-list'));

	// Force a node update on the canvas so labels can reflect isLogged status
	if (typeof (window as any).updateNodeStyles === 'function') {
		(window as any).updateNodeStyles();
	}

	const filterInputs = Array.from(document.querySelectorAll<HTMLInputElement>('.fg-selection-log-filter'));
	filterInputs.forEach((input) => {
		if (input.dataset.bound !== 'true') {
			input.dataset.bound = 'true';
			input.value = selectionLogFilterText;
			input.addEventListener('input', (e) => {
				selectionLogFilterText = (e.target as HTMLInputElement).value || '';
				filterInputs.forEach((fi) => {
					if (fi !== input) fi.value = selectionLogFilterText;
				});
				updateSelectionLogUI();
			});
		}
	});

	if (!containers.length) {
		updateSelectionLogTemplatesUI();
		return;
	}

	containers.forEach((container) => {
		container.innerHTML = '';
		const fragment = document.createDocumentFragment();

		selectedNodesLog
			.slice()
			.filter(
				(entry) =>
					!selectionLogFilterText ||
					(entry.label || '').toLowerCase().includes(selectionLogFilterText.toLowerCase()) ||
					(entry.secondaryId || '').toLowerCase().includes(selectionLogFilterText.toLowerCase()),
			)
			.reverse()
			.forEach((entry) => {
				const div = document.createElement('div');
				div.className = `fg-log-entry ${entry.group}${isSelectionLogEditMode ? ' is-editing' : ''}`;
				const text = `${entry.label} :: ${entry.secondaryId}`;
				const entryTextTitle = isSelectionLogEditMode ? 'Edit mode enabled' : 'Click to copy';
				const actionButtonTitle = isSelectionLogEditMode ? 'Remove from log' : 'Copy to clipboard';
				const actionButtonClass = `fg-log-item-action-btn${isSelectionLogEditMode ? ' is-delete' : ''}`;
				const actionButtonIcon =
					isSelectionLogEditMode ?
						'<svg viewBox="0 0 16 16" fill="none" width="18" height="18" aria-hidden="true"><path d="M4 4L12 12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M12 4L4 12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>'
					:	'<svg viewBox="0 0 16 16" fill="currentColor" width="18" height="18" aria-hidden="true"><path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z"></path><path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"></path></svg>';
				const childNode = isSelectionLogChildNode(entry.id);
				const secondaryLineHidden = childNode && clearedSelectionLogLabelNodeIds.has(String(entry.id).trim());
				const isLabelShown = isSelectionLogBold && !clearedSelectionLogLabelNodeIds.has(String(entry.id)) && (layoutNodes || []).some((n) => String(n?.id) === String(entry.id));
				const labelToggleTitle = isLabelShown ? 'Hide large label' : 'Show large label';
				const labelToggleDisabled = !isSelectionLogBold;
				const labelToggleClass = `fg-log-label-toggle-btn${labelToggleDisabled ? ' is-disabled' : ''}`;
				const labelToggleIcon =
					isLabelShown ?
						'<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M1 8h14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'
					:	'<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';

				const textSpan = document.createElement('span');
				textSpan.className = 'fg-log-text';
				textSpan.title = entryTextTitle;

				const strongLabel = document.createElement('strong');
				strongLabel.className = 'fg-log-label';
				strongLabel.textContent = entry.label || '';
				textSpan.appendChild(strongLabel);

				if (!secondaryLineHidden) {
					const subtext = document.createElement('span');
					subtext.className = 'fg-log-subtext';
					subtext.textContent = ` :: ${entry.secondaryId || ''}`;
					textSpan.appendChild(subtext);
				}
				div.appendChild(textSpan);

				const labelToggleBtn = document.createElement('button');
				labelToggleBtn.className = labelToggleClass;
				labelToggleBtn.title = labelToggleTitle;
				labelToggleBtn.setAttribute('aria-label', labelToggleTitle);
				if (labelToggleDisabled) labelToggleBtn.disabled = true;
				labelToggleBtn.dataset.logId = String(entry.id);
				labelToggleBtn.innerHTML = labelToggleIcon;
				div.appendChild(labelToggleBtn);

				const actionBtn = document.createElement('button');
				actionBtn.className = actionButtonClass;
				actionBtn.title = actionButtonTitle;
				actionBtn.setAttribute('aria-label', actionButtonTitle);
				actionBtn.innerHTML = actionButtonIcon;
				div.appendChild(actionBtn);

				if (!isSelectionLogEditMode) {
					textSpan.addEventListener('click', () => {
						copyToClipboard(text, div);
						ensureNodeFetchedAndOnScreen(entry);
					});
				}
				actionBtn.addEventListener('click', () => {
					if (isSelectionLogEditMode) {
						removeSelectionLogEntry(entry.id);
						return;
					}
					copyToClipboard(text, div);
					ensureNodeFetchedAndOnScreen(entry);
				});

				// label toggle handler (show/hide enlarged label without clicking node)
				if (labelToggleBtn) {
					div.classList.toggle('is-child-node', childNode);
					div.classList.toggle('is-child-line-muted', childNode && !isLabelShown);
					labelToggleBtn.addEventListener('click', (ev) => {
						ev.preventDefault();
						ev.stopPropagation();
						const id = String(labelToggleBtn.dataset.logId || entry.id);
						if (!isSelectionLogBold) {
							flashSelectionLogActionButton(labelToggleBtn, 'Enable Log Bold');
							return;
						}
						const wasCleared = clearedSelectionLogLabelNodeIds.has(id);
						if (wasCleared) {
							// remove from cleared set to show label
							clearedSelectionLogLabelNodeIds.delete(id);
							flashSelectionLogActionButton(labelToggleBtn, 'Shown');
						} else {
							// add to cleared set to hide label
							clearedSelectionLogLabelNodeIds.add(id);
							flashSelectionLogActionButton(labelToggleBtn, 'Hidden');
						}
						updateSelectionLogUI();
						reapplySelectionState();
						syncTraceLabelPresentation();
						syncSelectionLogAuxiliaryRenderers();
					});
				}
				fragment.appendChild(div);
			});
		container.appendChild(fragment);
	});

	updateSelectionLogTemplatesUI();
}

function buildShareableSelectionUrl(): string {
	if (typeof window === 'undefined' || !selectedNodesLog.length) return '';
	const MAX_SELECTED_URL = 200;
	const allIds = selectedNodesLog.map((entry) => String(entry?.id || '').trim()).filter(Boolean);
	const ids = allIds.length > MAX_SELECTED_URL ? allIds.slice(-MAX_SELECTED_URL) : allIds;
	if (!ids.length) return '';
	const url = new URL(window.location.href);
	url.searchParams.set('selected', ids.join(','));
	return url.toString();
}

function copyToClipboard(text, element) {
	navigator.clipboard.writeText(text).then(() => {
		const originalBackground = element.style.background;
		element.style.background = 'rgba(34, 91, 197, 0.2)';
		setTimeout(() => {
			element.style.background = originalBackground;
		}, 500);
	});
}

function closeSelectionLogClearLabelsMenu() {
	if (!isSelectionLogClearLabelsMenuOpen) return;
	isSelectionLogClearLabelsMenuOpen = false;
	syncSelectionLogActionButtonStates();
}

function handleSelectionLogClearLabelsOutsideClick(event: MouseEvent) {
	if (!isSelectionLogClearLabelsMenuOpen) return;
	const target = event.target instanceof Element ? event.target : null;
	if (target?.closest('.fg-clear-labels-control')) return;
	closeSelectionLogClearLabelsMenu();
}

function handleDelegatedButtonClicks(event: MouseEvent) {
	const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button') : null;
	if (!target) return;

	if (target.id === 'fg-subset-info-pin') {
		clearFetchStatus();
		return;
	}

	if (target.matches('#fg-trace-mode, [data-fg-trace-mode-button]')) {
		closeSelectionLogClearLabelsMenu();
		toggleTraceMode();
		return;
	}

	const action = target.dataset.fgSelectionLogAction as
		| 'trace'
		| 'copy-all'
		| 'copy-link'
		| 'clear'
		| 'clear-others'
		| 'clear-labels'
		| 'clear-labels-menu'
		| 'toggle-bold'
		| 'edit'
		| undefined;
	if (!action) return;

	if (action === 'trace') {
		closeSelectionLogClearLabelsMenu();
		toggleTraceLogMode();
		return;
	}

	if (action === 'copy-all') {
		closeSelectionLogClearLabelsMenu();
		const text = selectedNodesLog
			.map((entry) => `${entry.label} :: ${entry.secondaryId}`)
			.reverse()
			.join('\n');
		navigator.clipboard.writeText(text).then(() => {
			flashSelectionLogActionButton(target, 'Copied!');
		});
		return;
	}

	if (action === 'copy-link') {
		closeSelectionLogClearLabelsMenu();
		const url = buildShareableSelectionUrl();
		if (!url) return;
		navigator.clipboard.writeText(url).then(() => {
			flashSelectionLogActionButton(target, 'Link Copied!');
		});
		return;
	}

	if (action === 'toggle-bold') {
		closeSelectionLogClearLabelsMenu();
		isSelectionLogBold = !isSelectionLogBold;
		// Re-enabling Log Bold after a Clear Highlight should resume highlighting every
		// selection-log individual again, so lift the suppression here explicitly.
		if (isSelectionLogBold) logBoldHighlightRootsSuppressed = false;
		saveSelectionLogBoldPreference();
		updateSelectionLogUI();
		syncSelectionLogActionButtonStates();
		reapplySelectionState();
		syncTraceLabelPresentation();
		syncSelectionLogAuxiliaryRenderers();
		return;
	}

	if (action === 'clear-labels-menu') {
		if (!isSelectionLogBold || getSelectionLogLabelNodeIds().length === 0) {
			flashSelectionLogActionButton(target, !isSelectionLogBold ? 'Enable Log Bold' : 'Empty');
			syncSelectionLogActionButtonStates();
			return;
		}
		isSelectionLogClearLabelsMenuOpen = !isSelectionLogClearLabelsMenuOpen;
		syncSelectionLogActionButtonStates();
		return;
	}

	if (action === 'clear-labels') {
		const scope = normalizeSelectionLogClearLabelsScope(target.dataset.fgClearLabelsScope);
		const clearedCount = clearSelectionLogLabels(scope);
		if (!clearedCount) {
			flashSelectionLogActionButton(target, 'Empty');
			syncSelectionLogActionButtonStates();
			return;
		}
		flashSelectionLogActionButton(target, scope === 'people' ? 'People Cleared!' : 'Cleared!');
		return;
	}

	if (action === 'edit') {
		closeSelectionLogClearLabelsMenu();
		isSelectionLogEditMode = !isSelectionLogEditMode;
		updateSelectionLogUI();
		syncSelectionLogActionButtonStates();
		return;
	}

	if (action === 'clear') {
		closeSelectionLogClearLabelsMenu();
		selectedNodesLog = [];
		isSelectionLogEditMode = false;
		saveSelectionLog();
		updateSelectionLogUI();
		syncSelectionLogActionButtonStates();
		refreshTraceState();
		syncTraceLabelPresentation();
		syncSelectionLogAuxiliaryRenderers();
		flashSelectionLogActionButton(target, 'Cleared!');
		return;
	}

	if (action === 'clear-others') {
		closeSelectionLogClearLabelsMenu();
		if (!selectedNodesLog.length) {
			flashSelectionLogActionButton(target, 'Empty');
			return;
		}

		// Only keep nodes that are explicitly in the selection log plus any
		// connector nodes required to join those log entries. Previously we
		// also preserved arbitrary one-hop neighbors of the currently
		// selected/highlighted nodes which kept many unintended nodes on the
		// screen. The user's expectation is to remove everything not in the
		// log (except for nodes that serve as connectors between log entries),
		// so pass an empty extraKeepIds set here.
		pruneGraphToSelectionLogEntries(graphData, selectedNodesLog, new Set<string>());

		const keptNodeIds = new Set<string>((Array.isArray(graphData?.nodes) ? graphData.nodes : []).map((node) => String(node?.id || '').trim()).filter(Boolean));

		if (selectedId && !keptNodeIds.has(String(selectedId).trim())) {
			selectedId = null;
			sidebarSelectedNode = null;
			sidebarViewMode = 'none';
			showSidebarHint();
			emitSelectedNodeRoute(null, { replace: true });
		}

		highlightedSelections = highlightedSelections.filter((selection) => keptNodeIds.has(String(selection?.id || '').trim()));
		persistentSelectedIds = new Set(Array.from(persistentSelectedIds).filter((id) => keptNodeIds.has(String(id).trim())));
		visitedNodeIds = new Set(Array.from(visitedNodeIds).filter((id) => keptNodeIds.has(String(id).trim())));

		if (initialServerNodeIds instanceof Set) {
			for (const nodeId of Array.from(initialServerNodeIds)) {
				if (!keptNodeIds.has(String(nodeId).trim())) {
					initialServerNodeIds.delete(nodeId);
				}
			}
		}

		if (initialServerLinkKeys instanceof Set) {
			for (const key of Array.from(initialServerLinkKeys)) {
				const [sourceId, targetId] = key.split('|');
				if (!keptNodeIds.has(String(sourceId).trim()) || !keptNodeIds.has(String(targetId).trim())) {
					initialServerLinkKeys.delete(key);
				}
			}
		}

		renderGraph(graphData);
		updateMeta();
		saveSession();
		syncSelectionLogActionButtonStates();
		refreshTraceState();
		syncTraceLabelPresentation();
		syncSelectionLogAuxiliaryRenderers();
		flashSelectionLogActionButton(target, 'Pruned!');
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
	stopSearchPulseLoop();
	if (nodePulseInterval) {
		clearInterval(nodePulseInterval);
		nodePulseInterval = null;
	}
	if (nodePulseTimer) {
		clearTimeout(nodePulseTimer);
		nodePulseTimer = null;
	}
	// Remove any transient pulse rings immediately so clicks clear visual state
	try {
		if (nodeSel && typeof nodeSel.selectAll === 'function') {
			nodeSel.selectAll('circle.fg-restore-ring, circle.fg-restore-ring--static').remove();
		}
		const svg = typeof document !== 'undefined' ? document.getElementById('fg-svg') : null;
		if (svg) {
			const rings = svg.querySelectorAll('circle.fg-restore-ring, circle.fg-restore-ring--static');
			rings.forEach((el) => el.remove());
		}
	} catch (e) {
		/* ignore */
	}
}

export function updateFocusReadout(node) {
	const el = document.getElementById('fg-focus-readout');
	if (!el) return;

	if (!node) {
		el.classList.remove('fg-focus-readout--visible');
		return;
	}

	const label = getRenderedNodeLabel(node);
	const rawId =
		String(node.id || '')
			.split(':')
			.pop() || '';
	const numericId = /^\d+$/.test(rawId) ? rawId : null;
	const crdLabel = node.group === 'firm' ? 'CRD#' : 'CRD#'; // Always CRD# for now as per request

	el.innerHTML = `
		<span class="fg-focus-readout__name">${label}</span>
		${numericId ? `<span class="fg-focus-readout__crd">${crdLabel} ${numericId}</span>` : ''}
	`;
	el.classList.add('fg-focus-readout--visible');
}

function stopSearchPulseLoop() {
	if (searchPulseInterval) {
		clearInterval(searchPulseInterval);
		searchPulseInterval = null;
	}
}

function startSearchPulseLoop(id, { interval = 1400, immediate = true }: { interval?: number; immediate?: boolean } = {}) {
	if (!id) return;
	stopSearchPulseLoop();
	armNodePulseStopOnInteraction();
	if (immediate) {
		pulseNodeHighlightById(id, { duration: 900 });
	}
	searchPulseInterval = window.setInterval(() => {
		pulseNodeHighlightById(id, { duration: 900 });
	}, interval);
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

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
	const settledResults: PromiseSettledResult<R>[] = new Array(items.length);
	if (!items.length) return settledResults;

	const maxConcurrent = Math.max(1, Math.min(concurrency, items.length));
	let nextIndex = 0;

	const runWorker = async () => {
		while (nextIndex < items.length) {
			const currentIndex = nextIndex++;
			try {
				const value = await worker(items[currentIndex]);
				settledResults[currentIndex] = { status: 'fulfilled', value };
			} catch (reason) {
				settledResults[currentIndex] = { status: 'rejected', reason };
			}
		}
	};

	await Promise.all(Array.from({ length: maxConcurrent }, () => runWorker()));
	return settledResults;
}

function rememberPersistentSelection(id: string | null | undefined) {
	const normalized = String(id || '').trim();
	if (!normalized) return;
	persistentSelectedIds.add(normalized);
}

function upsertHighlightedSelection(id, hops = getDefaultSelectionHops(), options: { replace?: boolean } = {}) {
	if (!id) return;
	const normalizedHops = normalizeHighlightHops(hops);
	const { replace = false } = options;
	rememberPersistentSelection(id);
	// Default: accumulate hop roots so prior selections still light their lines until Clear Highlight.
	// replace: true is reserved for explicit reset-style selection if needed later.
	if (replace) {
		highlightedSelections = [{ id, hops: normalizedHops }];
		return;
	}
	highlightedSelections = highlightedSelections.filter((entry) => entry.id !== id);
	highlightedSelections.push({ id, hops: normalizedHops });
}

function setHoveredNode(id) {
	const nextId = id ? String(id).trim() : null;
	if (hoveredNodeId === nextId) return;
	hoveredNodeId = nextId;
	reapplySelectionState();
}

function setFocusedNode(id) {
	const nextId = id ? String(id).trim() : null;
	if (focusedNodeId === nextId) return;
	focusedNodeId = nextId;
	reapplySelectionState();
}

function bindHoverAndFocus(selection) {
	return selection
		.attr('focusable', 'true')
		.attr('tabindex', '0')
		.on('mouseenter', function (event, d) {
			setHoveredNode(d.id);
		})
		.on('mouseleave', function (event, d) {
			setHoveredNode(null);
		})
		.on('focus', function (event, d) {
			setFocusedNode(d.id);
		})
		.on('blur', function (event, d) {
			setFocusedNode(null);
		})
		.on('keydown', function (event, d) {
			handleNodeKeyboardActivation(event, d);
		});
}

export function getLinkIdentityKey(link) {
	const sourceId = String(link?.source?.id ?? link?.source ?? '');
	const targetId = String(link?.target?.id ?? link?.target ?? '');
	const relationship = String(link?.relationship || '');
	const currentState =
		typeof link?.isCurrent === 'boolean' ?
			link.isCurrent ?
				'1'
			:	'0'
		:	'u';
	const startDate = String(link?.startDate ?? '');
	const endDate = String(link?.endDate ?? '');
	return `${sourceId}|${targetId}|${relationship}|${currentState}|${startDate}|${endDate}`;
}

function getLinkKey(link) {
	return getLinkIdentityKey(link);
}

function isNonGrayExpansionLink(link) {
	return isAutoExpansionLink(link);
}

function isAutoExpansionLink(link) {
	if (!link) return false;
	const rel = String(link.relationship || '')
		.trim()
		.toLowerCase();
	// Person clicks must still draw employment/registration lines — including previous
	// jobs and links that touch inactive (gray) parent firms. Those render dashed.
	if (rel.includes('employed') || rel.includes('registered') || isPreviousEmploymentLink(link)) {
		if (isPreviousEmploymentLink(link) || rel.includes('previous')) return true;
		if (rel === 'employed_by' || rel === 'registered_by') return isCurrentRegistration(link) || (typeof link.isCurrent === 'boolean' ? link.isCurrent : true);
		return link.isCurrent !== false;
	}
	if (isForcedGrayConnectionLink(link) || hasInactiveEndpoint(link)) return false;
	// Ownership/control links are always revealable in the graph.
	if (rel === 'controls' || rel === 'controlled_by' || rel === 'owner' || rel === 'officer' || rel === 'associated_with') return true;
	// Direct entity relationships
	if (rel === 'subsidiary_of' || rel === 'parent_of') return true;
	// General fallback for neutral or unlabeled links
	if (!rel || rel === 'neutral') return true;
	return false;
}

// Clicking a firm node should only reveal its Form BD — Direct Owners & Executive
// Officers ("controls") connections, not employment/registration history — that
// data is expensive to fetch/render for mega-firms and is dashboard-only now.
function isFirmControlOnlyExpansionLink(link) {
	if (!link) return false;
	const rel = String(link.relationship || '')
		.trim()
		.toLowerCase();
	return rel === 'controls' || rel === 'controlled_by' || rel === 'owner' || rel === 'officer';
}

function getDirectAutoExpansionNeighborCount(node) {
	if (!node || typeof node !== 'object') return 0;
	const id = node.id;
	const fullAdj = getFullAdjacencyMap();
	const neighbors = fullAdj.get(id) || [];
	let count = 0;
	neighbors.forEach(({ link }) => {
		if (isAutoExpansionLink(link)) count++;
	});

	// If node is a firm, also count potential owners not yet in graph links
	if (node.group === 'firm' && Array.isArray(node.directOwners)) {
		const seenIds = new Set(neighbors.map(({ nodeId }) => nodeId));
		for (const owner of node.directOwners) {
			const personId = String(owner?.crdNumber || owner?.crd || owner?.personId || '').trim();
			if (personId && !seenIds.has(`person:${personId}`)) count++;
		}
	}

	return count;
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

	const activeFindId = activeFindMatchIndex >= 0 && Array.isArray(activeFindMatchOrder) ? activeFindMatchOrder[activeFindMatchIndex] : null;

	const nodeById = new Map<string, any>((layoutNodes || []).map((node) => [String(node.id), node]));

	const tempRoots = highlightedSelections.map((r) => ({ ...r, isSelection: true }));
	if (hoveredNodeId && !tempRoots.some((r) => r.id === hoveredNodeId)) {
		tempRoots.push({ id: hoveredNodeId, hops: 1, isSelection: false });
	}
	if (focusedNodeId && !tempRoots.some((r) => r.id === focusedNodeId)) {
		tempRoots.push({ id: focusedNodeId, hops: 1, isSelection: false });
	}
	if (activeFindId && !tempRoots.some((r) => r.id === activeFindId)) {
		tempRoots.push({ id: activeFindId, hops: 1, isSelection: false });
	}

	if (isSelectionLogBold && !logBoldHighlightRootsSuppressed && Array.isArray(selectedNodesLog)) {
		selectedNodesLog.forEach((entry) => {
			const node = nodeById.get(entry.id);
			if (node?.group === 'individual') {
				if (!tempRoots.some((r) => String(r.id) === String(entry.id))) {
					tempRoots.push({ id: entry.id, hops: 1, isSelection: false });
				}
			}
		});
	}

	if (!tempRoots.length) {
		return { rootIds, nodeIds, hopNodeIds, linkKeys };
	}

	const adjacency = new Map<string, Array<{ nodeId: string; link: any }>>((layoutNodes || []).map((node) => [String(node.id), []]));
	(layoutLinks || []).forEach((link) => {
		const sourceId = link.source?.id ?? link.source;
		const targetId = link.target?.id ?? link.target;
		if (!adjacency.has(sourceId)) adjacency.set(sourceId, []);
		if (!adjacency.has(targetId)) adjacency.set(targetId, []);
		adjacency.get(sourceId).push({ nodeId: targetId, link });
		adjacency.get(targetId).push({ nodeId: sourceId, link });
	});

	tempRoots.forEach((entry) => {
		if (!entry?.id) return;
		const entryNode = nodeById.get(entry.id) || null;
		const entryInactive = isNodeInactive(entryNode);

		rootIds.add(entry.id);
		nodeIds.add(entry.id);

		if (!adjacency.has(entry.id)) return;

		// Use the entry's stored hops if they were explicitly requested (e.g. from an API expansion)
		// but default to the global RUNTIME setting if we want the sliders to control existing highlights.
		const runtime = getRuntimeHopDefaults();
		const baseHops = Number(entry.hops || runtime.selection);
		const maxHops = normalizeHighlightHops(baseHops);
		const dist = new Map<string, number>([[entry.id, 0]]);
		const queue = [entry.id];

		for (let index = 0; index < queue.length; index += 1) {
			const currentId = queue[index];
			const currentDist = dist.get(currentId) ?? 0;
			const neighbors = adjacency.get(currentId) || [];
			neighbors.forEach(({ nodeId, link }) => {
				const nextDist = currentDist + 1;
				if (maxHops !== 'all' && nextDist > maxHops) return;

				const neighborNode = nodeById.get(nodeId) || null;
				if (!entryInactive && isNodeInactive(neighborNode)) return;

				// If a firm is selected, do not highlight its connecting lines to person nodes.
				// Person nodes will highlight the lines to the firm when they are selected,
				// keeping the firm's large roster from lighting up the entire graph.
				if (entryNode?.group === 'firm' && entry.isSelection && neighborNode?.group === 'individual') {
					return;
				}

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

// Pulse a rotating set of node ids. Used when multiple new nodes are revealed so
// they each get a transient blue ring until the user interacts with the view.
function startMultiNodePulseLoop(ids: Array<string | number>, options: { duration?: number; startDelayMs?: number } = {}) {
	const { duration = 5000, startDelayMs = 0 } = options;
	if (!Array.isArray(ids) || !ids.length) return;
	stopNodePulseLoop();
	const begin = () => {
		armNodePulseStopOnInteraction();
		// Stagger a single blue pulse for each new node so they draw attention.
		try {
			ids.forEach((id, i) => {
				setTimeout(() => {
					pulseNodeHighlightById(id, { duration, stroke: GRAPH_COLORS.nodePulse });
				}, i * 100);
			});
		} catch (e) {
			/* ignore */
		}
		// Ensure we clear any timers after the duration so stopNodePulseLoop won't linger
		nodePulseTimer = setTimeout(
			() => {
				nodePulseTimer = null;
				stopNodePulseLoop();
			},
			duration + ids.length * 120,
		);
	};
	if (startDelayMs > 0) {
		nodePulseTimer = setTimeout(() => {
			nodePulseTimer = null;
			begin();
		}, startDelayMs);
		return;
	}
	begin();
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

function pulseNodeHighlightById(id, { duration = 600, stroke = GRAPH_COLORS.nodePulse }: { duration?: number; stroke?: string } = {}) {
	try {
		if (!nodeSel) return;
		const selectedNode = nodeSel.filter((nodeDatum) => nodeDatum.id === id);

		if (!selectedNode || typeof selectedNode.empty !== 'function' || selectedNode.empty()) return;

		const classDuration = Math.max(duration, 1500);
		selectedNode.each(function () {
			const el = this as any;
			if (el._pulseTargetTimeout) clearTimeout(el._pulseTargetTimeout);
			d3.select(el).classed('fg-node-pulse-target', true);
			el._pulseTargetTimeout = setTimeout(() => {
				try {
					d3.select(el).classed('fg-node-pulse-target', false);
					el._pulseTargetTimeout = null;
				} catch (e) {}
			}, classDuration);
		});

		const resolvedStroke = resolveCssColorValue(stroke);

		selectedNode.each(function (nodeDatum) {
			const nodeGroupSel = d3.select(this);
			nodeGroupSel.selectAll('circle.fg-restore-ring').remove();
			const baseRadius = Math.max((nodeDatum?._vizHalf || NODE_R[nodeDatum?.group] || 10) + 8, 14);

			// When trace mode is active, do not animate the pulse growth — simply
			// show a static green (or provided stroke) ring so labels are stable.
			if (isTraceMode || isTraceLogMode) {
				nodeGroupSel
					.append('circle')
					.attr('class', 'fg-restore-ring fg-restore-ring--static')
					.attr('fill', 'none')
					.attr('stroke', resolvedStroke)
					.attr('stroke-width', 'var(--stroke-width-node-pulse)')
					.attr('stroke-opacity', 'var(--stroke-opacity-node-pulse)')
					.attr('pointer-events', 'none')
					.attr('r', baseRadius);
				// remove after duration to mirror transient pulse behavior
				setTimeout(() => {
					try {
						nodeGroupSel.selectAll('circle.fg-restore-ring--static').remove();
					} catch (e) {
						/* ignore */
					}
				}, duration);
				return;
			}

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
	const currentHopDefaults = getCurrentHopDefaultsSnapshot();
	const storedSelectionDefault = session?.hopDefaults && typeof session.hopDefaults === 'object' ? normalizeHighlightHops(session.hopDefaults.selection) : null;
	const shouldReuseStoredSelectionHops = storedSelectionDefault === currentHopDefaults.selection;
	const restoredHighlights =
		Array.isArray(session?.highlightedNodes) ? session.highlightedNodes
		: session?.selectedNodeId ? [{ id: session.selectedNodeId, hops: currentHopDefaults.selection }]
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

			// Notify canvas renderer (Pixi) that a selection was restored so it
			// can mark the node visually (canvas keeps its own selected set).
			try {
				if (typeof window !== 'undefined' && selectedId) {
					window.dispatchEvent(new CustomEvent(ROUTE_NODE_REQUEST_EVENT, { detail: { nodeId: selectedId } }));
				}
			} catch (e) {
				/* ignore */
			}

			const selectedNode = Array.isArray(layoutNodes) ? layoutNodes.find((entry) => entry.id === selectedId) : null;
			if (!selectedNode) return;
			resetTransientDetailState(selectedNode);
			renderSidebar(selectedNode);
			if (session && session.sidebarViewMode != null) {
				setSidebarViewMode(normalizeSidebarViewMode(session.sidebarViewMode, loadPersistedSidebarViewMode()), {
					expandMobile: session.sidebarViewMode !== 'none',
				});
			}
			return;
		}

		// Merge (rather than replace) with any highlights already applied since this restore was
		// scheduled: navigating back from the dashboard triggers an immediate route-based
		// selectNode() call for the current URL's node (see applyPendingRouteNodeSelection) that
		// races ahead of this deferred restore. That call adds its own single-node highlight to
		// highlightedSelections before this timer fires, so unioning here (instead of overwriting)
		// ensures the full previously-selected set survives a graph -> dashboard -> graph round trip.
		const preRestoreHighlights = Array.isArray(highlightedSelections) ? highlightedSelections : [];
		const mergedHighlightsById = new Map<string, { id: string; hops: any }>();
		for (const entry of restoredHighlights) {
			const id = entry?.id ? String(entry.id).trim() : '';
			if (!id) continue;
			mergedHighlightsById.set(id, {
				id,
				hops: shouldReuseStoredSelectionHops ? normalizeHighlightHops(entry?.hops ?? currentHopDefaults.selection) : currentHopDefaults.selection,
			});
		}
		for (const entry of preRestoreHighlights) {
			const id = entry?.id ? String(entry.id).trim() : '';
			if (!id || mergedHighlightsById.has(id)) continue;
			mergedHighlightsById.set(id, { id, hops: normalizeHighlightHops(entry?.hops ?? currentHopDefaults.selection) });
		}

		highlightedSelections = Array.from(mergedHighlightsById.values()).filter((entry) => entry.id && Array.isArray(layoutNodes) && layoutNodes.some((node) => node.id === entry.id));

		// Restore durable selected-node chrome (survives Clear Highlight).
		const restoredSelectedIds = Array.isArray(session?.selectedNodeIds) ? session.selectedNodeIds : [];
		const nextPersistent = new Set<string>();
		for (const id of restoredSelectedIds) {
			const normalized = String(id || '').trim();
			if (normalized && Array.isArray(layoutNodes) && layoutNodes.some((node) => node.id === normalized)) {
				nextPersistent.add(normalized);
			}
		}
		for (const entry of highlightedSelections) {
			if (entry?.id) nextPersistent.add(String(entry.id));
		}
		if (session?.selectedNodeId) nextPersistent.add(String(session.selectedNodeId));
		persistentSelectedIds = nextPersistent;

		selectedId =
			(Array.isArray(layoutNodes) && layoutNodes.some((node) => node.id === selectedId) ? selectedId : null) ||
			highlightedSelections.find((entry) => entry.id === session?.selectedNodeId)?.id ||
			highlightedSelections[highlightedSelections.length - 1]?.id ||
			null;

		reapplySelectionState();

		const node = Array.isArray(layoutNodes) ? layoutNodes.find((entry) => entry.id === selectedId) : null;
		if (!node) return;
		resetTransientDetailState(node);
		renderSidebar(node);
		if (session && session.sidebarViewMode != null) {
			setSidebarViewMode(normalizeSidebarViewMode(session.sidebarViewMode, loadPersistedSidebarViewMode()), {
				expandMobile: session.sidebarViewMode !== 'none',
			});
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

	if (Array.isArray(session.visitedNodeIds)) {
		visitedNodeIds = new Set(session.visitedNodeIds);
	}

	const missingServerIds = (session.renderedServerIds || []).filter((id) => !renderedIds.has(id));
	if (missingServerIds.length) {
		injectNodesById(missingServerIds, { skipPersist: true });
	}

	if (session.extraNodes?.length || session.extraLinks?.length) {
		const restoredExtraNodes = (session.extraNodes || []).map((node) => sanitizePersistedNode(node));
		restoredExtraNodes.forEach((node) => resetTransientDetailState(node));
		const normalized = normalizeGraphPayloadByIdentity(restoredExtraNodes, session.extraLinks || []);
		mergeIntoGraphData(normalized.nodes, normalized.links);
		appendFetched(normalized.nodes, normalized.links);
	} else if (session.extraNodeIds?.length) {
		const missingExtraNodeIds = session.extraNodeIds.filter((id) => !layoutNodes.some((node) => node.id === id));
		if (missingExtraNodeIds.length) {
			injectNodesById(missingExtraNodeIds, { skipPersist: true });
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

export function clearSelectionState(_state: { selectedId?: string | null; highlightedSelections?: Array<any>; sidebarSelectedNode?: any } = {}) {
	return {
		selectedId: null,
		highlightedSelections: [],
		persistentSelectedIds: [] as string[],
		sidebarSelectedNode: null,
	};
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
	const resetSelectionState = clearSelectionState();
	selectedId = resetSelectionState.selectedId;
	highlightedSelections = resetSelectionState.highlightedSelections;
	persistentSelectedIds = new Set(resetSelectionState.persistentSelectedIds || []);
	updateFocusReadout(null);
	visitedNodeIds.clear();
	sidebarSelectedNode = resetSelectionState.sidebarSelectedNode;
	sidebarViewMode = 'none';
	stopNodePulseLoop();
	clearSubsetInfo();
	renderGraph(graphData);
	updateMeta({ totalIndividuals: 0, totalFirms: 0, totalLinks: 0 });
	showSidebarHint();
	showEmpty(true);
}

function renderBaselineGraphData() {
	if (!graphData) return null;
	const hasGraphContent = Boolean((graphData?.nodes?.length || 0) > 0 || (graphData?.links?.length || 0) > 0);
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

async function loadBaselineGraph(profileName, { suppressRender = false }: { suppressRender?: boolean } = {}) {
	isSessionCleared = false;
	if (isBrowserOffline()) {
		showOfflineFetchStatus();
		showEmpty(true);
		return null;
	}
	clearOfflineFetchStatus();
	const url = makeApiUrl('/api/finra/graph');
	if (!profileName && INITIAL_SEED_COUNT > 0) {
		url.searchParams.set('limit', String(INITIAL_SEED_COUNT));
	}
	if (profileName) {
		url.searchParams.set('profile', profileName);
	}
	const res = await fetch(url.toString());
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
	initialServerNodeIds = new Set(graphData.nodes.map((n) => n.id));
	initialServerLinkKeys = new Set(
		graphData.links.map((l) => {
			const s = l.source?.id ?? l.source;
			const t = l.target?.id ?? l.target;
			return `${s}|${t}`;
		}),
	);
	if (suppressRender) return graphData;
	return renderBaselineGraphData();
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
		nodeSel.attr('transform', (d) => `translate(${Number.isFinite(d.x) ? d.x : 0},${Number.isFinite(d.y) ? d.y : 0})`);
	}

	simulation.alpha(0).restart();
}

export function buildSessionRenderGraphData(session, baseGraphData = graphData) {
	if (!baseGraphData || !Array.isArray(baseGraphData.nodes) || !Array.isArray(baseGraphData.links)) return null;

	const requestedIds = new Set(
		[
			...(Array.isArray(session?.renderedServerIds) ? session.renderedServerIds : []),
			session?.selectedNodeId,
			...(Array.isArray(session?.highlightedNodes) ? session.highlightedNodes.map((entry) => entry?.id) : []),
		]
			.map((value) => String(value || '').trim())
			.filter(Boolean),
	);

	if (!requestedIds.size) return null;

	const nodeById = new Map<string, any>();
	(baseGraphData.nodes || []).forEach((node) => {
		if (node?.id) nodeById.set(String(node.id), node);
	});
	(Array.isArray(session?.extraNodes) ? session.extraNodes : []).forEach((node) => {
		if (node?.id) nodeById.set(String(node.id), node);
	});

	const requiredIds = new Set<string>(requestedIds);
	const candidateLinks = [...(baseGraphData.links || []), ...(Array.isArray(session?.extraLinks) ? session.extraLinks : [])];
	let changed = true;
	while (changed) {
		changed = false;
		for (const link of candidateLinks) {
			const sourceId = String(link?.source?.id ?? link?.source ?? '').trim();
			const targetId = String(link?.target?.id ?? link?.target ?? '').trim();
			if (!sourceId || !targetId) continue;
			if (requiredIds.has(sourceId) && !requiredIds.has(targetId)) {
				requiredIds.add(targetId);
				changed = true;
			} else if (requiredIds.has(targetId) && !requiredIds.has(sourceId)) {
				requiredIds.add(sourceId);
				changed = true;
			}
		}
	}

	if (!requiredIds.size) return null;

	const sessionNodes = [];
	for (const node of [...(baseGraphData.nodes || []), ...(Array.isArray(session?.extraNodes) ? session.extraNodes : [])]) {
		if (!node?.id) continue;
		const nodeId = String(node.id);
		if (!requiredIds.has(nodeId)) continue;
		sessionNodes.push({ ...node, id: nodeId });
	}

	const normalizedSession = normalizeGraphPayloadByIdentity(sessionNodes, candidateLinks);
	const dedupedSessionNodes = normalizedSession.nodes;
	if (!dedupedSessionNodes.length) return null;

	const sessionNodeIds = new Set(dedupedSessionNodes.map((node) => String(node.id)));
	const sessionLinks = normalizedSession.links.filter((link) => {
		const sourceId = String(link?.source?.id ?? link?.source ?? '').trim();
		const targetId = String(link?.target?.id ?? link?.target ?? '').trim();
		return sessionNodeIds.has(sourceId) && sessionNodeIds.has(targetId);
	});

	return {
		...baseGraphData,
		nodes: dedupedSessionNodes,
		links: sessionLinks,
	};
}

function renderSavedSessionGraph(session) {
	if (!graphData || !Array.isArray(graphData.nodes) || !Array.isArray(graphData.links)) return false;

	const sessionGraphData = buildSessionRenderGraphData(session, graphData);
	if (!sessionGraphData || !Array.isArray(sessionGraphData.nodes) || !Array.isArray(sessionGraphData.links)) return false;

	const sessionNodes = sessionGraphData.nodes;
	if (!sessionNodes.length) return false;

	isSubsetMode = sessionNodes.length < graphData.nodes.length;
	if (isSubsetMode) {
		updateSubsetInfo(sessionNodes.length, graphData.nodes.length);
	} else {
		clearSubsetInfo();
	}

	renderGraph({
		...graphData,
		nodes: sessionNodes,
		links: sessionGraphData.links,
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
	// Detect and log invalid transforms (once) to help track down NaN origins.
	try {
		const tKey = `${String(transform?.x)}|${String(transform?.y)}|${String(transform?.k)}`;
		if (!Number.isFinite(transform?.k) || !Number.isFinite(transform?.x) || !Number.isFinite(transform?.y)) {
			_logOnce(_loggedBadTransforms, tKey, 'warn', `Detected non-finite zoom transform: x=${transform?.x} y=${transform?.y} k=${transform?.k}`);
		}
	} catch {
		// ignore
	}

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
		isHuge ? 10
		: isLarge ? 8
		: 6;
	const refreshDurationMs = Math.min(
		getRefreshLayoutDurationMs(nodeCount),
		isHuge ? 900
		: isLarge ? 1200
		: 1600,
	);

	layoutNodes.forEach((node, index) => {
		node.fx = null;
		node.fy = null;

		if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) {
			// Log the occurrence once per node so we can track which nodes become non-finite.
			const origX = node.x;
			const origY = node.y;
			_logOnce(_loggedBadNodeCoords, node.id || index, 'warn', `Node has non-finite coords; id=${node.id} origX=${origX} origY=${origY}. Assigning jittered position.`);
			node.x = centerX + (Math.random() - 0.5) * 80;
			node.y = centerY + (Math.random() - 0.5) * 80;
		} else {
			const angle = (index / Math.max(1, layoutNodes.length)) * Math.PI * 2;
			const jitter = jitterBase + (index % 3) * 1.25;
			node.x += Math.cos(angle) * jitter + (Math.random() - 0.5) * 6;
			node.y += Math.sin(angle) * jitter + (Math.random() - 0.5) * 6;
		}
	});

	if (refreshLayoutStopTimer) {
		clearTimeout(refreshLayoutStopTimer);
		refreshLayoutStopTimer = null;
	}

	// Create a stable finalize function so other code (e.g. revealNeighbors)
	// can delay the final stop briefly after newly-revealed nodes settle.
	refreshFinalizeLayoutFn = () => {
		simulation.alphaTarget(0);
		simulation.stop();
		refreshLayoutStopTimer = null;
		try {
			saveSession();
		} catch {
			// non-critical
		}
	};

	simulation.alphaTarget(0.04);
	simulation
		.alpha(
			isHuge ? 0.28
			: isLarge ? 0.34
			: 0.42,
		)
		.restart();

	simulation.on('end.refresh-layout', refreshFinalizeLayoutFn);
	refreshLayoutStopTimer = setTimeout(() => {
		if (refreshFinalizeLayoutFn) refreshFinalizeLayoutFn();
	}, refreshDurationMs);
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
export function init(_d3, options: { initialRouteNodeId?: string | null; initialSelectedNodeIds?: Array<string | null | undefined>; isolateToSelection?: boolean } = {}) {
	d3 = _d3;
	const initialRouteNodeId = String(options?.initialRouteNodeId || '').trim();
	pendingRouteNodeId = initialRouteNodeId || pendingRouteNodeId;
	pendingSelectedNodeIds =
		Array.isArray(options?.initialSelectedNodeIds) ? options.initialSelectedNodeIds.map((id) => String(id || '').trim()).filter(Boolean) : pendingSelectedNodeIds;
	isolateToSharedSelection = Boolean(options?.isolateToSelection) && pendingSelectedNodeIds.length > 0;
	if (initialRouteNodeId) {
		// In isolate mode, don't auto-expand the routed node's neighbors — only the explicitly
		// shared `?selected=` nodes (+ the routed node itself) should be rendered.
		pendingRouteAutoExpand = !isolateToSharedSelection;
		pendingRouteForceAutoExpand = !isolateToSharedSelection;
	}

	if (!routeNodeRequestListenerBound && typeof window !== 'undefined') {
		window.addEventListener(ROUTE_NODE_REQUEST_EVENT, ((event: Event) => {
			const detail =
				(event as CustomEvent<{ nodeId?: string | null; searchQuery?: string; pulseDuration?: number | string | null; autoExpand?: boolean; forceAutoExpand?: boolean }>).detail ||
				{};
			// If caller requested a text search (e.g., firm name), run the search
			// and attempt to resolve a firm node by label before routing.
			if (detail.searchQuery && String(detail.searchQuery || '').trim()) {
				const q = String(detail.searchQuery || '').trim();
				void (async () => {
					try {
						await fetchAndInjectQuery(q);
						const candidate = findFirmNodeByLabel(q);
						if (candidate && candidate.id) {
							pendingRouteNodeId = candidate.id;
							// preserve any requested pulse duration when resolving via search
							pendingRoutePulseDuration = Number(detail.pulseDuration) || null;
							pendingRouteAutoExpand = detail.autoExpand !== false;
							pendingRouteForceAutoExpand = detail.forceAutoExpand === true;
							void applyPendingRouteNodeSelection();
						}
					} catch (e) {
						console.warn('Search-based route resolution failed:', e);
					}
				})();
				return;
			}
			pendingRouteNodeId = String(detail.nodeId || '').trim() || null;
			// capture optional pulse duration (ms) requested by the event sender
			pendingRoutePulseDuration = typeof detail.pulseDuration !== 'undefined' ? Number(detail.pulseDuration) || null : pendingRoutePulseDuration;
			pendingRouteAutoExpand = detail.autoExpand !== false;
			pendingRouteForceAutoExpand = detail.forceAutoExpand === true;
			if (pendingRouteNodeId) {
				void applyPendingRouteNodeSelection();
			}
		}) as EventListener);
		routeNodeRequestListenerBound = true;
	}

	if (!findRequestListenersBound && typeof window !== 'undefined') {
		window.addEventListener(MOBILE_SIDEBAR_COLLAPSE_REQUEST_EVENT, (() => {
			if (!isMobileSidebarViewport()) return;
			showSidebarHint({ keepOpen: false });
		}) as EventListener);
		// Allow other code to request the sidebar re-render of no-selection content.
		window.addEventListener('finra:ensure-sidebar-content', (() => {
			try {
				renderSidebar(sidebarSelectedNode || null);
			} catch (e) {
				/* ignore */
			}
		}) as EventListener);
		window.addEventListener(FIND_QUERY_EVENT, ((event: Event) => {
			const detail = (event as CustomEvent<{ query?: string | null }>).detail || {};
			refreshFindMatches(detail.query, { preserveActiveMatch: true });
		}) as EventListener);
		window.addEventListener(FIND_NEXT_EVENT, ((event: Event) => {
			const detail = (event as CustomEvent<{ query?: string | null }>).detail || {};
			cycleToFindMatch(detail.query || activeFindQuery, 1);
		}) as EventListener);
		window.addEventListener(FIND_PREV_EVENT, ((event: Event) => {
			const detail = (event as CustomEvent<{ query?: string | null }>).detail || {};
			cycleToFindMatch(detail.query || activeFindQuery, -1);
		}) as EventListener);
		window.addEventListener(FIND_MOVE_EVENT, ((event: Event) => {
			const detail = (event as CustomEvent<{ query?: string | null; direction?: string | null }>).detail || {};
			moveFindMatch(detail.query || activeFindQuery, String(detail.direction || 'ArrowRight'));
		}) as EventListener);
		// Lightweight event used by UI code to request a reapplication of selection
		// emphasis after keyboard-driven routing/selection flows that can race with
		// other DOM updates.
		window.addEventListener('finra:reapply-selection', (() => {
			reapplySelectionState();
		}) as EventListener);
		window.addEventListener(FIND_CLOSE_EVENT, ((event: Event) => {
			const detail = (event as CustomEvent<{ clearQuery?: boolean }>).detail || {};
			stopSearchPulseLoop();
			updateFocusReadout(null);
			if (detail.clearQuery) {
				clearFindMatches();
				return;
			}

			const selectAndOpenMatch = (nodeId: string) => {
				startSearchPulseLoop(nodeId, { interval: 1400, immediate: true });
				const liveNode = Array.isArray(layoutNodes) ? layoutNodes.find((n) => n.id === nodeId) : null;
				if (liveNode) {
					markUserInitiatedGraphExpansion();
					anchorNode(liveNode);
					selectNode(liveNode, { skipAutoExpand: true });
					void expandNodeThroughNonGrayHops(liveNode).catch((err) => {
						console.error('Progressive non-gray hop expansion failed:', err);
						refreshTraceState({ deferMs: 120 });
					});
					void fetchCacheStats();
				}
			};

			if (activeFindMatchIndex >= 0 && activeFindMatchOrder[activeFindMatchIndex]) {
				selectAndOpenMatch(activeFindMatchOrder[activeFindMatchIndex]);
				return;
			}
			if (activeFindMatchOrder.length) {
				activeFindMatchIndex = getNearestActiveMatchIndex();
				const nodeId = activeFindMatchOrder[activeFindMatchIndex];
				if (nodeId) {
					selectAndOpenMatch(nodeId);
				}
			}
		}) as EventListener);
		findRequestListenersBound = true;
	}

	if (isSidebarPersistentlyPinned()) {
		showSidebarHint({ keepOpen: true });
	}
	loadSelectionLog();
	loadGraphTemplatesSync();
	void loadGraphTemplatesAsync();
	try {
		localStorage.removeItem('finra_selection_log_pinned');
	} catch {
		// ignore storage errors
	}
	updateSelectionLogUI();
	updateSelectionLogTemplatesUI();
	updateSelectionLogChrome();
	(document.getElementById('btn-log-close') as HTMLButtonElement | null)?.addEventListener('click', closeLog);
	document.addEventListener('click', handleDelegatedButtonClicks);
	document.addEventListener('click', handleSelectionLogClearLabelsOutsideClick);
	const handleFetchStatusDismissal = (event: Event) => {
		if (!activeFetchStatusMessage || activeFetchStatusPinned) return;
		const target = event.target as Node | null;
		if (!target) return;
		const fetchArea = document.querySelector<HTMLElement>('.fg-fetch');
		const statusWrap = document.querySelector<HTMLElement>('.fg-toolbar-status--top');
		if (fetchArea?.contains(target) || statusWrap?.contains(target)) return;
		clearFetchStatus();
	};
	document.addEventListener('click', handleFetchStatusDismissal, true);
	document.addEventListener('focusin', handleFetchStatusDismissal, true);
	syncSelectionLogActionButtonStates();

	const refreshLayoutButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-fg-action="refresh-layout"]'));
	refreshLayoutButtons.forEach((button) => bindTouchDragClickSuppression(button));
	refreshLayoutButtons.forEach((refreshLayoutBtn) => {
		refreshLayoutBtn.addEventListener('click', async () => {
			const buttons = refreshLayoutButtons;
			buttons.forEach((button) => {
				button.disabled = true;
				button.dataset.refreshing = 'true';
				button.setAttribute('aria-busy', 'true');
			});
			try {
				// Attempt to run the Rust/WASM layout in a worker for a quick, non-blocking layout
				let usedWasm = false;
				try {
					if (typeof window !== 'undefined' && Array.isArray(layoutNodes) && layoutNodes.length && Array.isArray(layoutLinks)) {
						const width = document.getElementById('fg-main')?.clientWidth || 800;
						const height = document.getElementById('fg-main')?.clientHeight || 600;
						// build minimal node/link payloads
						const nodesPayload = layoutNodes.map((n) => ({
							id: n.id,
							x: n.x,
							y: n.y,
							r: n._vizHalf,
							locX: n._locationBiasX,
							locY: n._locationBiasY,
							locStrength: n._locationBiasStrength,
						}));
						const linksPayload = layoutLinks.map((l) => ({ source: l.source?.id || l.source, target: l.target?.id || l.target }));
						// dynamic import to avoid bundling when not needed
						const mod = await import('@/lib/graphLayoutWorker');
						const createWorker = mod.default || mod.createGraphLayoutWorker;
						if (typeof createWorker === 'function') {
							const { compute } = createWorker();
							const positions = await compute(nodesPayload, linksPayload, width, height);
							if (Array.isArray(positions)) {
								// apply positions to layoutNodes
								const posMap = new Map(positions.map((p) => [String(p.id), p]));
								for (const ln of layoutNodes) {
									const p = posMap.get(String(ln.id));
									if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
										ln.x = p.x;
										ln.y = p.y;
									}
								}
								// force a render
								try {
									animateToWasmPositions(2500);
								} catch {}
								usedWasm = true;
							}
						}
					}
				} catch (wasmErr) {
					// swallow and fall back to JS simulation
					console.info('WASM layout failed, falling back to JS/D3 simulation:', wasmErr?.message || wasmErr);
				}

				if (!usedWasm) {
					refreshNodeLayout();
				}

				void fetchCacheStats();
			} catch (err) {
				console.error('refreshNodeLayout failed:', err);
			} finally {
				setTimeout(() => {
					buttons.forEach((button) => {
						button.disabled = false;
						delete button.dataset.refreshing;
						button.removeAttribute('aria-busy');
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
			// Preserve/restore a meaningful dashboard route when clearing highlights
			// so the URL still reflects the currently displayed sidebar node (if any).
			try {
				const side = document.getElementById('fg-sidebar');
				const displayedId = (side && side.dataset && side.dataset.displayedId) || selectedId || '';
				if (displayedId) {
					const nextPath = buildNodeRoutePath(displayedId);
					if (typeof window !== 'undefined' && window.history && typeof window.history.replaceState === 'function') {
						window.history.replaceState(window.history.state, document.title || '', nextPath);
					}
				}
			} catch (e) {
				// non-critical
			}
		});
	});

	const graphActionButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-fg-graph-action]'));
	graphActionButtons.forEach((button) => bindTouchDragClickSuppression(button));
	graphActionButtons.forEach((graphActionBtn) => {
		graphActionBtn.addEventListener('click', () => {
			const action = graphActionBtn.dataset.fgGraphAction;
			graphActionBtn.closest('details')?.removeAttribute('open');
			switch (action) {
				case 'clear':
					clearGraphAction(graphActionBtn);
					break;
				case 'clear-non-log':
					clearNonLogAction(graphActionBtn);
					break;
				case 'clear-non-connected':
					clearNonConnectedAction(graphActionBtn);
					break;
				default:
					break;
			}
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
				const r = await fetch(url.toString());
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
		const findFilterScope = (input: HTMLElement): HTMLElement | null => {
			const row = input.closest('.fg-connections-filter-row') as HTMLElement | null;
			return (
				row?.nextElementSibling?.classList.contains('fg-connections-filter-scope') ?
					(row.nextElementSibling as HTMLElement)
				:	(input.closest('.fg-connections-filter-scope') as HTMLElement | null)
			);
		};
		// Updates just the tag-chips/input row and re-applies the filter to the connections
		// list in place, instead of calling the full renderSidebar() (which does
		// `innerHTML = ...` on the whole panel). A full re-render destroys and recreates the
		// <input> element on every tag add/remove, which steals focus away from the filter box
		// and resets the sidebar's scroll position — very disruptive while actively filtering.
		const refreshFilterRowInPlace = (input: HTMLInputElement, options: { refocus?: boolean } = {}) => {
			const row = input.closest('.fg-connections-filter-row') as HTMLElement | null;
			const scope = findFilterScope(input);
			if (!row) return;
			sidebarConnectionsFilterRowRefreshing = true;
			row.innerHTML = renderConnectionsFilterTagsHtml();
			if (scope) applyConnectionsFilterToScope(scope, sidebarConnectionsFilterTags, sidebarConnectionsFilterQuery);
			if (options.refocus !== false) {
				const newInput = row.querySelector('.fg-connections-filter') as HTMLInputElement | null;
				if (newInput) {
					newInput.focus();
					const pos = newInput.value.length;
					try {
						newInput.setSelectionRange(pos, pos);
					} catch {
						/* ignore (e.g. unsupported input type) */
					}
				}
			}
			sidebarConnectionsFilterRowRefreshing = false;
		};
		if (!(sidebarInner as any).dataset.fgConnectionsFilterBound) {
			(sidebarInner as any).dataset.fgConnectionsFilterBound = '1';
			sidebarInner.addEventListener('input', (ev) => {
				const target = ev.target as HTMLElement | null;
				const input = (target?.closest ? target.closest('.fg-connections-filter') : null) as HTMLInputElement | null;
				if (!input) return;
				const scope = findFilterScope(input);
				if (!scope) return;
				// Remember the term so it survives the next renderSidebar() re-render
				// (e.g. clicking another node), instead of resetting on every click.
				sidebarConnectionsFilterQuery = input.value;
				if (input.value.trim()) sidebarConnectionsFilterJustCommitted = false;
				setFilterText(input.value);
				applyConnectionsFilterToScope(scope, sidebarConnectionsFilterTags, input.value);
			});
			sidebarInner.addEventListener('focusin', (ev) => {
				const target = ev.target as HTMLElement | null;
				const input = (target?.closest ? target.closest('.fg-connections-filter') : null) as HTMLInputElement | null;
				if (!input) return;
				sidebarConnectionsFilterFocused = true;
				const scope = findFilterScope(input);
				if (scope) applyConnectionsFilterToScope(scope, sidebarConnectionsFilterTags, sidebarConnectionsFilterQuery);
			});
			sidebarInner.addEventListener('focusout', (ev) => {
				if (sidebarConnectionsFilterRowRefreshing) return;
				const target = ev.target as HTMLElement | null;
				const input = (target?.closest ? target.closest('.fg-connections-filter') : null) as HTMLInputElement | null;
				if (!input) return;
				sidebarConnectionsFilterFocused = false;
				sidebarConnectionsFilterJustCommitted = false;
				const scope = findFilterScope(input);
				if (scope) applyConnectionsFilterToScope(scope, sidebarConnectionsFilterTags, sidebarConnectionsFilterQuery);
			});
			sidebarInner.addEventListener('keydown', (ev) => {
				const keyEv = ev as KeyboardEvent;
				const target = keyEv.target as HTMLElement | null;
				const input = (target?.closest ? target.closest('.fg-connections-filter') : null) as HTMLInputElement | null;
				if (!input) return;
				if (keyEv.key === 'Enter' || keyEv.key === ',') {
					keyEv.preventDefault();
					const trimmed = input.value.trim();
					if (!trimmed) return;
					// Multiple tags are OR'd together (matchesFilterTags), so adding a second tag
					// broadens the match instead of narrowing it (tag1 OR tag2).
					sidebarConnectionsFilterTags = setFilterTags([...sidebarConnectionsFilterTags, trimmed]);
					sidebarConnectionsFilterQuery = '';
					setFilterText('');
					sidebarConnectionsFilterJustCommitted = true;
					sidebarConnectionsFilterFocused = true;
					refreshFilterRowInPlace(input);
				} else if (keyEv.key === 'Backspace' && !input.value && sidebarConnectionsFilterTags.length > 0) {
					sidebarConnectionsFilterTags = setFilterTags(sidebarConnectionsFilterTags.slice(0, -1));
					refreshFilterRowInPlace(input);
				}
			});
			sidebarInner.addEventListener('change', (ev) => {
				const target = ev.target as HTMLElement | null;
				const enabledInput = (target?.closest ? target.closest('.fg-filter-enabled') : null) as HTMLInputElement | null;
				if (!enabledInput) return;
				sidebarConnectionsFilterEnabled = setFilterEnabled(enabledInput.checked);
				const row = enabledInput.closest('.fg-connections-filter-row') as HTMLElement | null;
				const anyInput = row?.querySelector('.fg-connections-filter') as HTMLInputElement | null;
				if (anyInput) refreshFilterRowInPlace(anyInput, { refocus: false });
				else {
					const scope =
						row?.nextElementSibling?.classList.contains('fg-connections-filter-scope') ? (row.nextElementSibling as HTMLElement) : null;
					if (scope) applyConnectionsFilterToScope(scope, sidebarConnectionsFilterTags, sidebarConnectionsFilterQuery);
				}
			});
			sidebarInner.addEventListener('click', (ev) => {
				const target = ev.target as HTMLElement | null;
				const removeBtn = (target?.closest ? target.closest('.fg-filter-tag-remove') : null) as HTMLElement | null;
				if (!removeBtn) return;
				ev.preventDefault();
				const tag = removeBtn.getAttribute('data-fg-filter-tag') || '';
				sidebarConnectionsFilterTags = setFilterTags(sidebarConnectionsFilterTags.filter((t) => t !== tag));
				const row = removeBtn.closest('.fg-connections-filter-row') as HTMLElement | null;
				const anyInput = row?.querySelector('.fg-connections-filter') as HTMLInputElement | null;
				if (anyInput) refreshFilterRowInPlace(anyInput, { refocus: false });
				else {
					const scope =
						row?.nextElementSibling?.classList.contains('fg-connections-filter-scope') ? (row.nextElementSibling as HTMLElement) : null;
					if (scope) applyConnectionsFilterToScope(scope, sidebarConnectionsFilterTags, sidebarConnectionsFilterQuery);
				}
			});
		}
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

	// Database search button – search ALL results, inject every hit, persist to server
	const fetchBtn = document.getElementById('fg-database-search') as HTMLButtonElement | null;
	const fetchInput = document.getElementById('fg-fetch-input') as HTMLInputElement | null;
	if (fetchBtn && fetchInput) {
		const findExistingNodeMatches = (rawQuery, explicitNodePool = null) => {
			const nodePool =
				Array.isArray(explicitNodePool) ? explicitNodePool : [...(Array.isArray(layoutNodes) ? layoutNodes : []), ...(Array.isArray(graphData?.nodes) ? graphData.nodes : [])];
			return rankFindNodeMatches(rawQuery, nodePool, Array.isArray(layoutLinks) ? layoutLinks : []);
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

			openNodeWithExpansion(liveNode, {
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

		const runDatabaseSearch = async () => {
			let q = String(fetchInput.value || '').trim();
			if (!q) return;

			let tokens = q
				.split(/[\s,;\t\n]+/g)
				.map((t) => t.trim())
				.filter(Boolean);
			let isCrdList = tokens.length > 1 && tokens.every((t) => /^\d{1,10}$/.test(t));

			if (!isCrdList) {
				const crdMatches = Array.from(q.matchAll(/CRD#?\s*(\d{1,10})/gi));
				if (crdMatches.length > 0) {
					tokens = crdMatches.map((m) => String(m[1]).trim());
					if (tokens.length > 1) {
						isCrdList = true;
					} else {
						q = tokens[0];
					}
				}
			}

			clearFetchStatus();
			if (!(await ensureFetchRuntimeReady())) {
				updateFetchStatus('Graph is still loading. Please try again.');
				return;
			}
			fetchBtn.disabled = true;
			fetchBtn.dataset.fetching = 'true';
			fetchBtn.setAttribute('aria-busy', 'true');
			try {
				// ── 1. Search local indexed endpoints in parallel ─────────────
				// These hit /api/finra/search and /api/finra/sec-search which query local indexes.
				const PAGE_SIZE = 100; // FINRA Solr supports up to 100 per page

				const fetchSingleCrd = async (crd) => {
					const SINGLE_PAGE_SIZE = 12;
					const finraIndUrl = makeApiUrl('/api/finra/search');
					finraIndUrl.searchParams.set('query', crd);
					finraIndUrl.searchParams.set('rows', String(SINGLE_PAGE_SIZE));
					finraIndUrl.searchParams.set('start', '0');

					const finraFirmUrl = makeApiUrl('/api/finra/search');
					finraFirmUrl.searchParams.set('query', crd);
					finraFirmUrl.searchParams.set('rows', String(SINGLE_PAGE_SIZE));
					finraFirmUrl.searchParams.set('start', '0');
					finraFirmUrl.searchParams.set('firm', '1');

					const secUrl = makeApiUrl('/api/finra/sec-search');
					secUrl.searchParams.set('query', crd);
					secUrl.searchParams.set('pageSize', String(SINGLE_PAGE_SIZE));
					secUrl.searchParams.set('pageNumber', '1');

					const headers = { Accept: 'application/json' };
					const [r1, r2, r3] = await Promise.allSettled([
						fetch(finraIndUrl.toString(), { headers }).then((r) => (r.ok ? r.json() : null)),
						fetch(finraFirmUrl.toString(), { headers }).then((r) => (r.ok ? r.json() : null)),
						fetch(secUrl.toString(), { headers }).then((r) => (r.ok ? r.json() : null)),
					]);

					const extractHits = (res) => {
						const d = res.status === 'fulfilled' ? res.value : null;
						return d?.hits?.hits || d?.response?.docs || d?.results || d?.currentPage || [];
					};

					const hits = [...extractHits(r1), ...extractHits(r2), ...extractHits(r3)];

					if (!hits.length) {
						hits.push({ _source: { ind_source_id: crd } }, { _source: { firm_id: crd } });
					}
					return hits;
				};

				const fetchFinraAll = async (useFirm) => {
					const hits = [];
					let start = 0;
					let total = null;
					try {
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
					} catch (err) {
						console.warn('Database search request failed', err);
					}
					return hits;
				};

				const fetchSec = async () => {
					const su = makeApiUrl('/api/finra/sec-search');
					su.searchParams.set('query', q);
					su.searchParams.set('pageSize', '50'); // SEC pagination
					su.searchParams.set('pageNumber', '1');
					try {
						const sr = await fetch(su.toString());
						if (!sr.ok) return [];
						const sj = await sr.json();
						return sj?.hits?.hits || sj?.response?.docs || sj?.currentPage || sj?.results || [];
					} catch (err) {
						console.warn('SEC database search request failed', err);
						return [];
					}
				};

				let allHits = [];
				if (isCrdList) {
					const batchSize = 5;
					for (let i = 0; i < tokens.length; i += batchSize) {
						const batch = tokens.slice(i, i + batchSize);
						const batchResults = await Promise.all(batch.map((t) => fetchSingleCrd(t)));
						for (const hits of batchResults) {
							allHits.push(...hits);
						}
					}
				} else {
					const results = await Promise.allSettled([fetchFinraAll(false), fetchFinraAll(true), fetchSec()]);
					results.forEach((result, index) => {
						if (result.status === 'fulfilled') {
							allHits.push(...result.value);
						} else {
							console.warn(`Database search request ${index} failed`, result.reason);
						}
					});
				}

				// Respect header search type selector (all | people | firms)
				let headerSearchType = 'all';
				try {
					const stEl = document.getElementById('fg-search-type') as HTMLSelectElement | null;
					if (stEl && stEl.value)
						headerSearchType = String(stEl.value || 'all')
							.trim()
							.toLowerCase();
				} catch {}

				// headerSearchType will be applied after we have the helper predicates

				const getSearchHitIndividualId = (hit) => {
					const src = hit?._source || hit || {};
					const baseId = String(src?.basicInformation?.individualId || src?.ind_source_id || src?.ind_crd || '').trim();
					if (baseId) return baseId;
					if (typeof src?.id === 'string' && src.id.startsWith('person:')) return src.id.split(':')[1] || '';
					// Minimal FINRA search-index stub docs ({id, crd, label, type, source}) use ids like
					// "finra:individual:<crd>" and carry a bare `crd` field — fall back to it when type matches.
					if (src?.type === 'individual' && src?.crd) return String(src.crd).trim();
					if (typeof src?.content === 'string') {
						try {
							const parsed = JSON.parse(src.content);
							return String(parsed?.basicInformation?.individualId || parsed?.ind_source_id || parsed?.ind_crd || '').trim();
						} catch {
							return '';
						}
					}
					return '';
				};

				const getSearchHitFirmId = (hit) => {
					const src = hit?._source || hit || {};
					const baseId = String(src?.basicInformation?.firmId || src?.firm_id || src?.firmId || src?.firm_source_id || '').trim();
					if (baseId) return baseId;
					if (typeof src?.id === 'string' && src.id.startsWith('firm:')) return src.id.split(':')[1] || '';
					// Minimal FINRA search-index stub docs ({id, crd, label, type, source}) use ids like
					// "finra:firm:<crd>" and carry a bare `crd` field — fall back to it when type matches.
					if (src?.type === 'firm' && src?.crd) return String(src.crd).trim();
					if (typeof src?.content === 'string') {
						try {
							const parsed = JSON.parse(src.content);
							return String(parsed?.basicInformation?.firmId || parsed?.firm_id || parsed?.firmId || parsed?.firm_source_id || '').trim();
						} catch {
							return '';
						}
					}
					return '';
				};

				const hitHasIndividualId = (hit) => Boolean(getSearchHitIndividualId(hit));
				const hitHasFirmId = (hit) => Boolean(getSearchHitFirmId(hit));

				// Respect header search type selector (all | people | firms)
				try {
					const stEl = document.getElementById('fg-search-type') as HTMLSelectElement | null;
					if (stEl && stEl.value)
						headerSearchType = String(stEl.value || 'all')
							.trim()
							.toLowerCase();
				} catch {}

				if (headerSearchType === 'people') {
					const before = allHits.length;
					allHits = allHits.filter((hit) => hitHasIndividualId(hit));
					// console.debug(`[search] filtered to people: ${before} -> ${allHits.length}`);
				} else if (headerSearchType === 'firms') {
					const before = allHits.length;
					allHits = allHits.filter((hit) => hitHasFirmId(hit));
					// console.debug(`[search] filtered to firms: ${before} -> ${allHits.length}`);
				}

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
					updateFetchStatus(`No database results for "${q}"`);
					return;
				}

				// ── 2. Build nodes directly from search hit _source data ──────────
				// The search results already contain ind_firstname/lastname + ind_current_employments
				// (firm_id, firm_name) — no extra per-hit fetch needed.
				// We only fetch full detail for pure-numeric queries (direct CRD/firm ID lookup).
				const batchAllNodes = [];
				const batchAllLinks = [];
				const updatedExistingNodeIds = new Set<string>();
				const textSearchHydrationCandidates: Array<{ nodeId?: string | null; group?: string | null; hasEmbeddedDetail?: boolean | null }> = [];

				const isDirectId = /^\d+$/.test(q) || isCrdList;

				function addIndividualFromSource(src) {
					const resolved = resolveIndividualSourceDetail(src);
					const parsed = resolved.detail || src;

					const crd = String(parsed?.individualId || parsed?.basicInformation?.individualId || src?.ind_source_id || src?.ind_crd || '').trim();
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
						existingGraphNode._trustedCurrentRelationshipData =
							existingGraphNode._trustedCurrentRelationshipData === true || (resolved.hasEmbeddedDetail && hasRichIndividualDetail(parsed));
						existingGraphNode.bcScope = src?.ind_bc_scope ?? parsed?.basicInformation?.bcScope ?? parsed?.bcScope ?? existingGraphNode.bcScope ?? null;
						existingGraphNode.iaScope = src?.ind_ia_scope ?? parsed?.basicInformation?.iaScope ?? parsed?.iaScope ?? existingGraphNode.iaScope ?? null;
						existingGraphNode.hasFinraData = resolved.hasFinraData;
						existingGraphNode.hasSecData = resolved.hasSecData;
						existingGraphNode.registrationCount = {
							...(existingGraphNode.registrationCount || {}),
							approvedFinraRegistrationCount:
								src?.ind_approved_finra_registration_count ??
								parsed?.registrationCount?.approvedFinraRegistrationCount ??
								existingGraphNode.registrationCount?.approvedFinraRegistrationCount ??
								0,
							approvedSRORegistrationCount:
								src?.ind_approved_sro_registration_count ??
								parsed?.registrationCount?.approvedSRORegistrationCount ??
								existingGraphNode.registrationCount?.approvedSRORegistrationCount ??
								0,
							approvedStateRegistrationCount:
								src?.ind_approved_state_registration_count ??
								parsed?.registrationCount?.approvedStateRegistrationCount ??
								existingGraphNode.registrationCount?.approvedStateRegistrationCount ??
								0,
							approvedIAStateRegistrationCount:
								src?.ind_approved_ia_state_registration_count ??
								parsed?.registrationCount?.approvedIAStateRegistrationCount ??
								existingGraphNode.registrationCount?.approvedIAStateRegistrationCount ??
								0,
						};
						existingGraphNode.currentEmployments = Array.isArray(parsed?.currentEmployments) ? parsed.currentEmployments : (existingGraphNode.currentEmployments ?? []);
						existingGraphNode.currentIAEmployments = Array.isArray(parsed?.currentIAEmployments) ? parsed.currentIAEmployments : (existingGraphNode.currentIAEmployments ?? []);
						applyIndividualDetail(existingGraphNode, parsed, crd);
						updatedExistingNodeIds.add(existingGraphNode.id);
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
									bcScope: src?.ind_bc_scope ?? parsed?.basicInformation?.bcScope ?? parsed?.bcScope ?? null,
									iaScope: src?.ind_ia_scope ?? parsed?.basicInformation?.iaScope ?? parsed?.iaScope ?? null,
									registrationCount: {
										approvedFinraRegistrationCount: src?.ind_approved_finra_registration_count ?? parsed?.registrationCount?.approvedFinraRegistrationCount ?? 0,
										approvedSRORegistrationCount: src?.ind_approved_sro_registration_count ?? parsed?.registrationCount?.approvedSRORegistrationCount ?? 0,
										approvedStateRegistrationCount: src?.ind_approved_state_registration_count ?? parsed?.registrationCount?.approvedStateRegistrationCount ?? 0,
										approvedIAStateRegistrationCount: src?.ind_approved_ia_state_registration_count ?? parsed?.registrationCount?.approvedIAStateRegistrationCount ?? 0,
									},
									currentEmployments: Array.isArray(parsed?.currentEmployments) ? parsed.currentEmployments : [],
									currentIAEmployments: Array.isArray(parsed?.currentIAEmployments) ? parsed.currentIAEmployments : [],
									disclosureFlag,
									iaDisclosureFlag,
									hasFinraData: resolved.hasFinraData,
									hasSecData: resolved.hasSecData,
									_trustedCurrentRelationshipData: resolved.hasEmbeddedDetail && hasRichIndividualDetail(parsed),
								},
								parsed,
								crd,
							),
						);
					}
					// Build graph-visible firm connections from embedded employment data.
					// Historical/previous employers stay in the sidebar detail stack; they should
					// not be injected as graph neighbors during a search fetch.
					const emps = [
						...(parsed?.currentEmployments || []).map((e) => ({ ...e, _isCurrent: true })),
						...(parsed?.currentIAEmployments || []).map((e) => ({ ...e, _isCurrent: true })),
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
						if (
							!batchAllLinks.some(
								(l) => getLinkIdentityKey(l) === getLinkIdentityKey({ source: personId, target: firmNodeId, relationship: getEmploymentRelationship(e), isCurrent: e._isCurrent }),
							)
						) {
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
					const firmId = getSearchHitFirmId(src);
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
							const crd = getSearchHitIndividualId(src);
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
							const firmId = getSearchHitFirmId(src);
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
						const resolved = resolveIndividualSourceDetail(src);
						const parsed = resolved.detail || src;
						const crd = getSearchHitIndividualId(src);
						if (crd) {
							addIndividualFromSource(src);
							textSearchHydrationCandidates.push({
								nodeId: `person:${crd}`,
								group: 'individual',
								hasEmbeddedDetail: resolved.hasEmbeddedDetail,
							});
							continue;
						}
						const firmId = getSearchHitFirmId(src);
						if (firmId) {
							addFirmFromSource(src);
							textSearchHydrationCandidates.push({
								nodeId: `firm:${firmId}`,
								group: 'firm',
								hasEmbeddedDetail:
									Array.isArray(parsed?.directOwners) || Array.isArray(parsed?.owners) || Array.isArray(parsed?.disclosures) || Array.isArray(parsed?.activeStates),
							});
							continue;
						}
						// stub for hits with no ID
						const label = normalizePersonLabel(src?.name || [src?.ind_firstname, src?.ind_middlename, src?.ind_lastname].filter(Boolean).join(' ') || '');
						if (label)
							batchAllNodes.push({
								id: `database:${Date.now()}:${Math.random()}`,
								label,
								group: 'individual',
							});
					}
				}

				// ── 3. Append all nodes/links to the live view ─────────────────────
				if (batchAllNodes.length === 0) {
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
				if (updatedExistingNodeIds.size) {
					rerenderGraphNodesByIds(Array.from(updatedExistingNodeIds));
					refreshGraphColors();
					refreshTraceState();
				}

				if (!isDirectId) {
					const textSearchHydrationTargets = selectTextSearchHydrationTargets(textSearchHydrationCandidates, TEXT_SEARCH_DETAIL_HYDRATION_LIMIT);
					if (textSearchHydrationTargets.length) {
						const hydratedResults = await mapWithConcurrency(textSearchHydrationTargets, TEXT_SEARCH_DETAIL_HYDRATION_CONCURRENCY, async (target) => {
							const targetId = String(target.nodeId || '').trim();
							if (!targetId) return null;
							const rawId = targetId.split(':').pop() || '';
							if (!rawId) return null;
							const batch = target.group === 'firm' ? await fetchFirmBatch(rawId) : await fetchIndividualBatch(rawId);
							return { targetId, batch };
						});

						const hydratedNodes = [];
						const hydratedLinks = [];
						const hydratedNodeIds = new Set<string>();
						const hydratedLinkKeys = new Set<string>();
						const hydratedIds: string[] = [];

						for (const result of hydratedResults) {
							if (result.status !== 'fulfilled' || !result.value?.batch) continue;
							const { targetId, batch } = result.value;
							if (targetId) hydratedIds.push(targetId);
							const liveTargetNode = layoutNodes?.find((node) => node.id === targetId) || null;
							const primaryNode = Array.isArray(batch?.nodes) ? batch.nodes.find((node) => node?.id === targetId) || null : null;
							if (liveTargetNode && primaryNode && typeof primaryNode === 'object') {
								Object.assign(liveTargetNode, primaryNode);
								normalizeNodeLabelInPlace(liveTargetNode);
							}
							for (const node of batch?.nodes || []) {
								if (!node?.id || hydratedNodeIds.has(node.id)) continue;
								hydratedNodeIds.add(node.id);
								hydratedNodes.push(node);
							}
							for (const link of batch?.links || []) {
								const linkKey = getLinkIdentityKey(link);
								if (hydratedLinkKeys.has(linkKey)) continue;
								hydratedLinkKeys.add(linkKey);
								hydratedLinks.push(link);
							}
						}

						if (hydratedNodes.length || hydratedLinks.length) {
							appendFetched(hydratedNodes, hydratedLinks);
							mergeIntoGraphData(hydratedNodes, hydratedLinks);
						}

						if (hydratedIds.length) {
							rerenderGraphNodesByIds(hydratedIds);
							refreshGraphColors();
							refreshTraceState();
						}
					}
				}

				// ── 6. Persist to server so data survives page reload ──────────────
				persistToServer(batchAllNodes, batchAllLinks);
				void fetchCacheStats();

				const newCount = batchAllNodes.length;
				updateFetchStatus(`Added ${newCount} node${newCount !== 1 ? 's' : ''} for "${q}"`);
				focusExistingNodeMatch(q, { statusPrefix: 'Opened' });
			} catch (err) {
				console.error('database search failed', err);
				updateFetchStatus(`Search error: ${err?.message || err}`);
			} finally {
				delete fetchBtn.dataset.fetching;
				fetchBtn.removeAttribute('aria-busy');
				fetchBtn.disabled = false;
				fetchInput.value = '';
				fetchInput.dispatchEvent(new Event('input', { bubbles: true }));
				fetchInput.focus();
			}
		};

		fetchBtn.addEventListener('click', runDatabaseSearch);
		fetchInput.addEventListener('keydown', (ev) => {
			if (ev.key === 'Enter') {
				ev.preventDefault();
				runDatabaseSearch();
			}
		});
	}

	const subsetInfoPinBtn = document.getElementById('fg-subset-info-pin') as HTMLButtonElement | null;
	if (subsetInfoPinBtn) {
		subsetInfoPinBtn.addEventListener('click', () => {
			clearFetchStatus();
		});
	}

	// Keep the shared fetch appender available even if reset happens before the
	// next render cycle settles.
	appendFetched = appendFetchedImpl;

	renderLegend();
	void fetchCacheStats();
	void loadGraph().finally(() => {
		void fetchCacheStats();
	});

	// Ensure the sidebar is rendered on initial load so the Log toggle is visible
	// even when no node is selected (useful after page refreshes).
	try {
		renderSidebar(sidebarSelectedNode || null);
	} catch (e) {
		/* ignore */
	}
	// Poll lightweight meta/cache endpoints so externally updated Redis totals
	// appear in the UI without a hard refresh.
	let _metaPollId = null;
	const META_POLL_MS = 15000;

	async function fetchMetaOnce() {
		if (isBrowserOffline()) {
			showOfflineFetchStatus();
			return;
		}
		clearOfflineFetchStatus();
		try {
			const hasProfileParam = new URLSearchParams(window.location.search).has('profile');
			const profileName = hasProfileParam ? new URLSearchParams(window.location.search).get('profile') : 'custom';
			const url = makeApiUrl('/api/finra/graph');
			url.searchParams.set('limit', '1');
			if (profileName) url.searchParams.set('profile', profileName);
			const r = await fetch(url.toString());
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

	if (typeof window !== 'undefined' && !networkStatusListenerBound) {
		window.addEventListener('offline', () => {
			showOfflineFetchStatus();
		});
		window.addEventListener('online', () => {
			clearOfflineFetchStatus();
			void loadGraph().finally(() => {
				void fetchMetaOnce();
				void fetchCacheStats();
			});
		});
		networkStatusListenerBound = true;
	}
	if (isBrowserOffline()) {
		showOfflineFetchStatus();
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
		console.log(`Local data not found for "${q}". Searching database to update graph...`);
		try {
			await fetchAndInjectQuery(q);
			return true;
		} catch (dbErr) {
			console.error(`Database search also failed for "${q}":`, dbErr);
			return false;
		}
	}
}

/**
 * Search local database for a text query and inject every result hit as a node.
 * This is the programmatic equivalent of pressing the "Search Database" button.
 * Called during profile seed auto-loading on page load.
 */
async function fetchAndInjectQuery(q) {
	const ROWS = '1000';
	const headers = { Accept: 'application/json' };

	const [finraIndResp, finraFirmResp, secResp] = await Promise.allSettled([
		fetch(makeApiUrl(`/api/finra/search?query=${encodeURIComponent(q)}&rows=${ROWS}&_=${Date.now()}`).toString(), { headers, cache: 'no-store' }).then((r) =>
			r.ok ? r.json() : null,
		),
		fetch(makeApiUrl(`/api/finra/search?query=${encodeURIComponent(q)}&firm=1&rows=${ROWS}&_=${Date.now()}`).toString(), { headers, cache: 'no-store' }).then((r) =>
			r.ok ? r.json() : null,
		),
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
		const resolved = resolveIndividualSourceDetail(src);
		const parsed = resolved.detail || src;

		// Minimal FINRA search-index stub docs only carry {id, crd, label, type, source} — fall back
		// to the stub's own bare `crd` field when explicitly type: 'individual' (never for type: 'firm').
		const isStubIndividual = src?.type === 'individual' && src?.crd;
		const crd = String(parsed?.basicInformation?.individualId || src?.ind_source_id || src?.ind_crd || (isStubIndividual ? src?.crd : '') || '').trim();

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
					hasFinraData: resolved.hasFinraData,
					hasSecData: resolved.hasSecData,
					registrationCount: {
						approvedFinraRegistrationCount: src?.ind_approved_finra_registration_count ?? parsed?.registrationCount?.approvedFinraRegistrationCount ?? 0,
						approvedSRORegistrationCount: src?.ind_approved_sro_registration_count ?? parsed?.registrationCount?.approvedSRORegistrationCount ?? 0,
						approvedStateRegistrationCount: src?.ind_approved_state_registration_count ?? parsed?.registrationCount?.approvedStateRegistrationCount ?? 0,
						approvedIAStateRegistrationCount: src?.ind_approved_ia_state_registration_count ?? parsed?.registrationCount?.approvedIAStateRegistrationCount ?? 0,
					},
					currentEmployments: Array.isArray(parsed?.currentEmployments) ? parsed.currentEmployments : [],
					currentIAEmployments: Array.isArray(parsed?.currentIAEmployments) ? parsed.currentIAEmployments : [],
					disclosureFlag,
					iaDisclosureFlag,
					_trustedCurrentRelationshipData: resolved.hasEmbeddedDetail && hasRichIndividualDetail(parsed),
					_source: 'finra',
				});

				const emps = [...(parsed?.currentEmployments || []), ...(parsed?.currentIAEmployments || [])];
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

		// Minimal FINRA search-index stub docs only carry {id, crd, label, type, source} — fall back
		// to the stub's own bare `crd` field when explicitly type: 'firm'.
		const isStubFirm = src?.type === 'firm' && src?.crd;
		const firmId = String(src?.firm_id || src?.firmId || src?.firm_source_id || (isStubFirm ? src?.crd : '') || '').trim();

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
		fetch(makeApiUrl(`/api/finra/search?query=${encodeURIComponent(q)}&rows=${ROWS}&_=${Date.now()}`).toString(), { headers, cache: 'no-store' }).then((r) =>
			r.ok ? r.json() : null,
		),
		fetch(makeApiUrl(`/api/finra/search?query=${encodeURIComponent(q)}&firm=1&rows=${ROWS}&_=${Date.now()}`).toString(), { headers, cache: 'no-store' }).then((r) =>
			r.ok ? r.json() : null,
		),
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
		const resolved = resolveIndividualSourceDetail(src);
		const parsed = resolved.detail || src;

		// Minimal FINRA search-index stub docs only carry {id, crd, label, type, source} — fall back
		// to the stub's own bare `crd` field when explicitly type: 'individual' (never for type: 'firm').
		const isStubIndividual = src?.type === 'individual' && src?.crd;
		const crd = String(parsed?.basicInformation?.individualId || src?.ind_source_id || src?.ind_crd || (isStubIndividual ? src?.crd : '') || '').trim();

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
					hasFinraData: resolved.hasFinraData,
					hasSecData: resolved.hasSecData,
					registrationCount: {
						approvedFinraRegistrationCount: src?.ind_approved_finra_registration_count ?? parsed?.registrationCount?.approvedFinraRegistrationCount ?? 0,
						approvedSRORegistrationCount: src?.ind_approved_sro_registration_count ?? parsed?.registrationCount?.approvedSRORegistrationCount ?? 0,
						approvedStateRegistrationCount: src?.ind_approved_state_registration_count ?? parsed?.registrationCount?.approvedStateRegistrationCount ?? 0,
						approvedIAStateRegistrationCount: src?.ind_approved_ia_state_registration_count ?? parsed?.registrationCount?.approvedIAStateRegistrationCount ?? 0,
					},
					currentEmployments: Array.isArray(parsed?.currentEmployments) ? parsed.currentEmployments : [],
					currentIAEmployments: Array.isArray(parsed?.currentIAEmployments) ? parsed.currentIAEmployments : [],
					disclosureFlag,
					iaDisclosureFlag,
					_source: 'finra',
				});

				const emps = [...(parsed?.currentEmployments || []), ...(parsed?.currentIAEmployments || [])];
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

		// Minimal FINRA search-index stub docs only carry {id, crd, label, type, source} — fall back
		// to the stub's own bare `crd` field when explicitly type: 'firm'.
		const isStubFirm = src?.type === 'firm' && src?.crd;
		const firmId = String(src?.firm_id || src?.firmId || src?.firm_source_id || (isStubFirm ? src?.crd : '') || '').trim();
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

function inferNodeGroup(node) {
	if (!node || typeof node !== 'object') return '';
	const explicitGroup = String(node.group || node.type || '')
		.trim()
		.toLowerCase();
	if (explicitGroup === 'individual' || explicitGroup === 'person') return 'individual';
	if (explicitGroup === 'firm' || explicitGroup === 'organization' || explicitGroup === 'entity') return 'firm';

	const explicitId = String(node.id ?? '').trim();
	if (/^(?:person|individual)[:_]/i.test(explicitId) || /^person(?:[:_]+)?\d+$/i.test(explicitId) || /^individual(?:[:_]+)?\d+$/i.test(explicitId)) {
		return 'individual';
	}
	if (/^(?:firm|organization)[:_]/i.test(explicitId) || /^firm(?:[:_]+)?\d+$/i.test(explicitId)) {
		return 'firm';
	}

	const firmId = String(node.firmId || node.firm_id || node.basicInformation?.firmId || '').trim();
	if (firmId) return 'firm';

	const personCrd = String(node.crd || node.individualId || node.basicInformation?.individualId || node.basicInformation?.crd || node.basicInformation?.crdNumber || '').trim();
	if (personCrd) return 'individual';

	return '';
}

function getNodeIdentityBaseToken(node) {
	if (!node || typeof node !== 'object') return '';
	const explicitId = String(node.id ?? '').trim();
	const inferredGroup = inferNodeGroup(node);
	const idCandidates = [explicitId];
	if (inferredGroup === 'individual') {
		idCandidates.push(String(node.crd || node.basicInformation?.individualId || node.individualId || '').trim());
	} else if (inferredGroup === 'firm') {
		idCandidates.push(String(node.firmId || node.basicInformation?.firmId || node.firm_id || node.crd || node.basicInformation?.crd || '').trim());
	} else {
		idCandidates.push(
			String(
				node.firmId ||
					node.basicInformation?.firmId ||
					node.firm_id ||
					node.crd ||
					node.basicInformation?.individualId ||
					node.individualId ||
					node.basicInformation?.crd ||
					node.basicInformation?.crdNumber ||
					'',
			).trim(),
		);
	}
	for (const candidate of idCandidates) {
		if (!candidate) continue;
		const normalized = String(candidate)
			.replace(/^(?:person|firm|individual|entity|finra|sec)(?:[:_]+)?/i, '')
			.replace(/^[:_]+/, '')
			.trim();
		const lastToken = normalized.split(/[:_]/).filter(Boolean).pop() || normalized;
		if (lastToken) return lastToken;
	}
	return '';
}

function getNodeIdentityKey(node) {
	if (!node || typeof node !== 'object') return '';
	const explicitId = String(node.id ?? '').trim();
	const inferredGroup = inferNodeGroup(node);
	const identityBase = getNodeIdentityBaseToken(node);
	if (inferredGroup === 'individual') {
		const crd = String(node.crd || node.basicInformation?.individualId || node.individualId || '').trim();
		if (crd) return `individual:${crd}`;
		if (identityBase) return `individual:${identityBase}`;
		return explicitId ? `individual:${explicitId}` : '';
	}
	if (inferredGroup === 'firm') {
		const firmId = String(node.firmId || node.basicInformation?.firmId || node.firm_id || node.crd || node.basicInformation?.crd || '').trim();
		if (firmId) return `firm:${firmId}`;
		if (identityBase) return `firm:${identityBase}`;
		return explicitId ? `firm:${explicitId}` : '';
	}
	return explicitId ? `entity:${explicitId}` : '';
}

export function selectNodesToInjectById(ids = [], { renderedNodes = layoutNodes, graphNodes = graphData?.nodes } = {}) {
	const requestedIds = Array.from(new Set((Array.isArray(ids) ? ids : []).map((nodeId) => String(nodeId || '').trim()).filter(Boolean)));
	if (!requestedIds.length) return [];

	const renderedIdentityKeys = new Set<string>();
	(Array.isArray(renderedNodes) ? renderedNodes : []).forEach((node) => {
		const key = getNodeIdentityKey(node);
		if (key) renderedIdentityKeys.add(key);
	});

	const selectedNodes: any[] = [];
	const seenIdentityKeys = new Set<string>(renderedIdentityKeys);
	(Array.isArray(graphNodes) ? graphNodes : []).forEach((node) => {
		if (!node || typeof node !== 'object') return;
		const nodeId = String(node.id ?? '').trim();
		if (!nodeId || !requestedIds.includes(nodeId)) return;
		const identityKey = getNodeIdentityKey(node);
		if (!identityKey || seenIdentityKeys.has(identityKey)) return;
		seenIdentityKeys.add(identityKey);
		selectedNodes.push(node);
	});

	return selectedNodes;
}

function mergeGraphNodePayload(targetNode, incomingNode) {
	if (!targetNode || !incomingNode) return targetNode;
	const inferredGroup = inferNodeGroup(incomingNode) || inferNodeGroup(targetNode);
	if (!targetNode.group && inferredGroup) targetNode.group = inferredGroup;
	if (incomingNode.group) targetNode.group = incomingNode.group;
	if (inferredGroup === 'firm' && incomingNode.crd && !targetNode.firmId) targetNode.firmId = incomingNode.crd;
	if (incomingNode.firmId && !targetNode.firmId) targetNode.firmId = incomingNode.firmId;
	if (incomingNode.basicInformation?.firmId && !targetNode.basicInformation?.firmId) {
		targetNode.basicInformation = {
			...(targetNode.basicInformation || {}),
			firmId: incomingNode.basicInformation.firmId,
		};
	}
	if (incomingNode._trustedCurrentRelationshipData === true) targetNode._trustedCurrentRelationshipData = true;
	if (incomingNode.bcScope != null) targetNode.bcScope = incomingNode.bcScope;
	if (incomingNode.iaScope != null) targetNode.iaScope = incomingNode.iaScope;
	if (incomingNode.registrationCount) targetNode.registrationCount = { ...(targetNode.registrationCount || {}), ...incomingNode.registrationCount };
	if (Array.isArray(incomingNode.currentEmployments)) targetNode.currentEmployments = incomingNode.currentEmployments;
	if (Array.isArray(incomingNode.currentIAEmployments)) targetNode.currentIAEmployments = incomingNode.currentIAEmployments;
	if (incomingNode.basicInformation) {
		targetNode.basicInformation = {
			...(targetNode.basicInformation || {}),
			...Object.fromEntries(Object.entries(incomingNode.basicInformation || {}).filter(([, value]) => value != null)),
		};
	}
	if (incomingNode.name && !targetNode.name && !isGenericOrPlaceholderLabel(incomingNode.name, targetNode.group)) targetNode.name = incomingNode.name;
	const incomingFirmName = String(incomingNode.firmName || '').trim();
	if (incomingFirmName && !isGenericOrPlaceholderLabel(incomingFirmName, 'firm')) {
		if (!targetNode.firmName || isGenericOrPlaceholderLabel(targetNode.firmName, 'firm')) targetNode.firmName = incomingFirmName;
		if (!targetNode.basicInformation) targetNode.basicInformation = {};
		if (!targetNode.basicInformation.firmName || isGenericOrPlaceholderLabel(targetNode.basicInformation.firmName, 'firm')) {
			targetNode.basicInformation.firmName = incomingFirmName;
		}
	}
	if (incomingNode.crd && !targetNode.crd) targetNode.crd = incomingNode.crd;
	if (incomingNode.individualId && !targetNode.individualId) targetNode.individualId = incomingNode.individualId;
	const currentLabel = String(targetNode.label || '').trim();
	const incomingLabel = String(incomingNode.label || '').trim();
	const currentLabelIsPlaceholder = isGenericOrPlaceholderLabel(currentLabel, targetNode.group);
	const incomingLabelIsPlaceholder = isGenericOrPlaceholderLabel(incomingLabel, targetNode.group);
	const shouldAdoptIncomingLabel =
		Boolean(incomingLabel) && !incomingLabelIsPlaceholder && (currentLabelIsPlaceholder || incomingLabel.length > currentLabel.length);
	if (shouldAdoptIncomingLabel) {
		targetNode.label = targetNode.group === 'individual' ? normalizePersonLabel(incomingLabel) || incomingLabel : incomingLabel;
		if (targetNode.group === 'firm') {
			targetNode.firmName = incomingLabel;
			if (!targetNode.basicInformation) targetNode.basicInformation = {};
			targetNode.basicInformation.firmName = incomingLabel;
		}
		return targetNode;
	}
	if (!targetNode.label || isPlaceholderExpansionLabel(targetNode.label, targetNode.group)) {
		normalizeNodeLabelInPlace(targetNode);
	}
	return targetNode;
}

export function mergeRenderedNodesForReveal(existingNodes = [], incomingNodes = []) {
	return mergeIncomingNodesIntoExistingNodes(existingNodes, incomingNodes);
}

export function rewriteLinksForNodeIdMap(links = [], idRewriteMap = new Map<string, string>()) {
	if (!Array.isArray(links)) return [];
	if (!idRewriteMap || typeof idRewriteMap.get !== 'function') return links;
	return links.map((link) => {
		if (!link || typeof link !== 'object') return link;
		const rewritten = { ...link };
		const sourceValue = typeof link.source === 'object' && link.source !== null ? (link.source.id ?? null) : link.source;
		const targetValue = typeof link.target === 'object' && link.target !== null ? (link.target.id ?? null) : link.target;
		if (sourceValue != null && idRewriteMap.has(String(sourceValue))) {
			rewritten.source = idRewriteMap.get(String(sourceValue));
		}
		if (targetValue != null && idRewriteMap.has(String(targetValue))) {
			rewritten.target = idRewriteMap.get(String(targetValue));
		}
		return rewritten;
	});
}

function dedupeGraphLinksByIdentity(links = [], idRewriteMap = new Map<string, string>()) {
	const rewrittenLinks = rewriteLinksForNodeIdMap(links, idRewriteMap);
	const seen = new Set<string>();
	return rewrittenLinks.filter((link) => {
		const key = getLinkIdentityKey(link);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function normalizeGraphPayloadByIdentity(nodes = [], links = []) {
	const mergedNodes = mergeGraphNodesForAppend([], nodes);
	return {
		nodes: mergedNodes.nodes,
		links: dedupeGraphLinksByIdentity(links, mergedNodes.idRewriteMap),
	};
}

export function mergeIncomingNodesIntoExistingNodes(existingNodes = [], incomingNodes = []) {
	const mergedNodes = [];
	const identityMap = new Map<string, any>();
	const idRewriteMap = new Map<string, string>();

	const upsertNode = (node) => {
		if (!node || typeof node !== 'object') return null;
		const key = getNodeIdentityKey(node);
		if (key && identityMap.has(key)) {
			const targetNode = identityMap.get(key);
			mergeGraphNodePayload(targetNode, node);
			if (node?.id && targetNode?.id && String(node.id) !== String(targetNode.id)) {
				idRewriteMap.set(String(node.id), String(targetNode.id));
			}
			return targetNode;
		}

		const nodeToAdd = { ...node };
		normalizeNodeLabelInPlace(nodeToAdd);
		if (key) identityMap.set(key, nodeToAdd);
		mergedNodes.push(nodeToAdd);
		if (node?.id) {
			idRewriteMap.set(String(node.id), String(nodeToAdd.id));
		}
		return nodeToAdd;
	};

	(Array.isArray(existingNodes) ? existingNodes : []).forEach((node) => {
		upsertNode(node);
	});

	(Array.isArray(incomingNodes) ? incomingNodes : []).forEach((incomingNode) => {
		upsertNode(incomingNode);
	});

	return {
		nodes: mergedNodes,
		added: mergedNodes
			.filter((node) => !existingNodes.some((entry) => entry?.id === node?.id))
			.map((node) => node?.id)
			.filter(Boolean),
		idRewriteMap,
	};
}

export function mergeGraphNodesByIdentity(existingNodes = [], incomingNodes = []) {
	return mergeIncomingNodesIntoExistingNodes(existingNodes, incomingNodes).nodes;
}

function filterRevealableGraphPayload(payload, linkFilter) {
	const nextNodes = Array.isArray(payload?.nodes) ? payload.nodes : [];
	const nextLinks = Array.isArray(payload?.links) ? payload.links : [];
	if (typeof linkFilter !== 'function') return { nodes: nextNodes, links: nextLinks };
	const keptLinks = nextLinks.filter((link) => linkFilter(link));
	const keptNodeIds = new Set<string>();
	for (const link of keptLinks) {
		const sourceId = String(link?.source?.id ?? link?.source ?? '').trim();
		const targetId = String(link?.target?.id ?? link?.target ?? '').trim();
		if (sourceId) keptNodeIds.add(sourceId);
		if (targetId) keptNodeIds.add(targetId);
	}
	const keptNodes = nextNodes.filter((node) => !node?.id || keptNodeIds.has(String(node.id).trim()) || node.id === payload?._rootNodeId || node.id === payload?._selectedNodeId);
	return { nodes: keptNodes, links: keptLinks };
}

function mergeIntoGraphData(newNodes, newLinks) {
	if (!graphData) return;
	invalidateFullAdjacencyMap();
	const existingNodes = Array.isArray(graphData.nodes) ? graphData.nodes : [];
	const mergeResult = mergeIncomingNodesIntoExistingNodes(existingNodes, newNodes);
	const mergedNodes = mergeResult.nodes;
	const addedIds = mergedNodes.filter((node) => !existingNodes.some((entry) => entry.id === node.id)).map((node) => node.id);
	graphData.nodes = mergedNodes;
	const revealableLinks = Array.isArray(newLinks) ? newLinks.filter((link) => isAutoExpansionLink(link) || isPreviousEmploymentLink(link)) : [];
	const rewrittenLinks = rewriteLinksForNodeIdMap(revealableLinks, mergeResult.idRewriteMap);
	const gLinkKeys = new Set(graphData.links.map((l) => getLinkIdentityKey(l)));
	rewrittenLinks
		.filter((l) => {
			const k = getLinkIdentityKey(l);
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

	// Do not modify the browser URL here. Merging fetched nodes should not
	// clobber an existing deep-link route (e.g. /firm/:id or /individual/:id).
	// URL/history updates are handled by dedicated routing helpers elsewhere.

	updateGraphMeta();
	if (addedIds.length) {
		// Expose recent additions for the next render so they can be highlighted.
		graphData._recentlyAddedNodeIds = addedIds;
	}
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
		const revealableLinks = Array.isArray(links) ? links.filter((link) => isAutoExpansionLink(link)) : [];
		const totalLinks = revealableLinks.length;

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
				batchLinks.push(revealableLinks[linkIdx]);
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
				batchLinks.push(revealableLinks[linkIdx]);
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

async function fetchIndividualBatch(crd, queryLabel = null, options: { includePreviousEmployments?: boolean } = {}) {
	if (!/^[0-9]+$/.test(String(crd))) {
		throw new Error(`invalid individual id ${crd}`);
	}
	// Graph fetches should stay limited to active links; historical employment remains
	// sidebar-only until the user explicitly expands a firm/person path.
	const { includePreviousEmployments = false } = options;

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

	const emps = flattenEmploymentRecords(detail, { includeGeneric: true }).filter((employment) => includePreviousEmployments || employment?._isCurrent !== false);

	for (const e of emps) {
		const rawFirmId = String(e?.firmId || e?.firm_id || e?.firmIdNumber || e?.organizationId || e?.orgId || '').trim();
		const secFirmId = String(e?.bdSECNumber || e?.bdSecNumber || e?.iaSECNumber || e?.iaSecNumber || e?.firm_bd_sec_number || '').trim();
		const fid = rawFirmId || secFirmId || null;
		if (!fid) continue;
		const existingFirmNode = findExistingFirmNode(fid, { label: e?.firmName || e?.name || '' });
		const firmNodeId = existingFirmNode?.id || `firm:${fid}`;
		if (!existingFirmNode && !nodes.some((n) => n.id === firmNodeId)) {
			nodes.push({
				id: firmNodeId,
				label: e?.firmName || e?.name || `Firm ${fid}`,
				group: 'firm',
				firmId: String(fid),
				bdSecNumber: e?.bdSECNumber || e?.bdSecNumber || e?.firm_bd_sec_number || null,
				iaSecNumber: e?.iaSECNumber || e?.iaSecNumber || null,
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

// Parses pasted lines of the form "Gerard Francis Hallaren :: CRD# 1408026" (one per line) into
// { name, crd } entries. Tolerant of extra whitespace, missing names, and bare CRD numbers.
// Heuristic firm-vs-individual name detector, used to pick which endpoint to try first for a
// pasted CRD (we still fall back to the other endpoint if the guess turns out wrong).
const FIRM_NAME_KEYWORDS_RE =
	/\b(INC\.?|LLC|L\.L\.C\.?|LTD\.?|CORP\.?|CORPORATION|CO\.|CO|COMPANY|COMPANIES|SECURITIES|SERVICES|PARTNERS|GROUP|MANAGEMENT|CAPITAL|ADVISORS?|FINANCIAL|WEALTH|INVESTMENTS?|FUND|BANK|TRUST|HOLDINGS|ASSOCIATES|ASSOC\.?|ASSET|BROKERS?|BROKERAGE|EQUITY|EQUITIES|PLANNING|INSURANCE|P\.C\.|PC|LP|L\.P\.|INSTITUTIONAL|NETWORK|GLOBAL|INTERNATIONAL|CONSULTANTS|STRATEGIES|BANCORP|BANCSHARES|ASSURANCE|LIFE)\b|&/i;

function looksLikeFirmName(name: string): boolean {
	const trimmed = String(name || '').trim();
	if (!trimmed) return false;
	return FIRM_NAME_KEYWORDS_RE.test(trimmed);
}

function parsePastedCrdList(text: string): Array<{ crd: string; name: string; likelyFirm: boolean }> {
	const seen = new Set<string>();
	const results: Array<{ crd: string; name: string; likelyFirm: boolean }> = [];
	const lines = String(text || '').split(/\r?\n/);
	for (const rawLine of lines) {
		const line = rawLine.trim();
		if (!line) continue;
		const crdMatch = line.match(/CRD#?\s*[:]?\s*(\d{1,10})/i) || line.match(/^(\d{1,10})$/);
		if (!crdMatch) continue;
		const crd = crdMatch[1];
		if (seen.has(crd)) continue;
		seen.add(crd);
		const namePart = line.split(/::/)[0]?.trim() || '';
		const name = namePart && !/^\d+$/.test(namePart) && namePart !== line.trim() ? namePart : '';
		results.push({ crd, name, likelyFirm: looksLikeFirmName(name) });
	}
	return results;
}

// Bulk-imports a pasted CRD list: each entry may be an individual OR a firm CRD (the paste
// format "Name :: CRD# 123" is the same for both). We guess which endpoint to try first from the
// name (e.g. "INC", "LLC", "& CO", "SECURITIES" ⇒ firm), then fall back to the other endpoint if
// the first guess 404s — this lets a single paste box handle person lists, firm lists, or a mix.
async function importPastedCrdList(rawText: string) {
	if (crdPasteImportBusy) return { added: 0, skipped: 0, failed: 0 };
	const parsed = parsePastedCrdList(rawText);
	if (!parsed.length) {
		crdPasteImportStatus = 'No CRD numbers found in pasted text';
		updateSelectionLogTemplatesUI();
		return { added: 0, skipped: 0, failed: 0 };
	}

	crdPasteImportBusy = true;
	crdPasteImportStatus = `Importing ${parsed.length} CRD${parsed.length === 1 ? '' : 's'}…`;
	updateSelectionLogTemplatesUI();
	updateFetchStatus(crdPasteImportStatus);

	let added = 0;
	let skipped = 0;
	let failed = 0;
	const allNodes = [];
	const allLinks = [];
	const addedNodeIds: Array<string> = [];

	try {
		const results = await mapWithConcurrency(parsed, PROFILE_SEED_FETCH_CONCURRENCY, async (entry) => {
			const personId = `person:${entry.crd}`;
			const firmId = `firm:${entry.crd}`;
			if (layoutNodes.some((n) => n.id === personId)) return { entry, existed: true, nodeId: personId, nodes: [], links: [] };
			if (layoutNodes.some((n) => n.id === firmId)) return { entry, existed: true, nodeId: firmId, nodes: [], links: [] };

			const fetchAsFirm = () => fetchFirmBatch(entry.crd, entry.name || null).then((batch) => ({ entry, existed: false, nodeId: firmId, nodes: batch.nodes, links: batch.links }));
			const fetchAsIndividual = () =>
				fetchIndividualBatch(entry.crd, entry.name || null).then((batch) => ({ entry, existed: false, nodeId: personId, nodes: batch.nodes, links: batch.links }));
			const [tryFirst, tryFallback] = entry.likelyFirm ? [fetchAsFirm, fetchAsIndividual] : [fetchAsIndividual, fetchAsFirm];

			try {
				return await tryFirst();
			} catch (firstErr) {
				try {
					return await tryFallback();
				} catch (fallbackErr) {
					throw fallbackErr || firstErr;
				}
			}
		});

		for (const r of results) {
			if (r.status !== 'fulfilled') {
				failed += 1;
				continue;
			}
			if (r.value.existed) {
				skipped += 1;
				addedNodeIds.push(r.value.nodeId);
			} else {
				added += 1;
				addedNodeIds.push(r.value.nodeId);
				allNodes.push(...(r.value.nodes || []));
				allLinks.push(...(r.value.links || []));
			}
		}

		if (allNodes.length) {
			appendFetched(allNodes, allLinks);
			mergeIntoGraphData(allNodes, allLinks);
			persistToServer(allNodes, allLinks);
		}

		for (const nodeId of addedNodeIds) {
			const node = layoutNodes.find((n) => n.id === nodeId);
			if (node) addToSelectionLog(node);
		}

		if (added || skipped) openSelectionLog();

		crdPasteImportStatus = `Added ${added}${skipped ? `, ${skipped} already on canvas` : ''}${failed ? `, ${failed} failed (not found)` : ''}`;
	} catch (err) {
		console.warn('Bulk CRD paste import failed:', err);
		crdPasteImportStatus = 'Import failed — see console for details';
	} finally {
		crdPasteImportBusy = false;
		pasteCrdImportText = '';
		updateFetchStatus(crdPasteImportStatus);
		updateSelectionLogTemplatesUI();
	}

	return { added, skipped, failed };
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
		firmStatus: detail?.firmStatus || detail?.status || detail?.registrationStatus || detail?.basicInformation?.firmStatus || null,
		bcScope: detail?.bcScope || detail?.basicInformation?.bcScope || null,
		iaScope: detail?.iaScope || detail?.basicInformation?.iaScope || null,
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

	// Optional employee stubs for the firm. Cap time so deep links (/firm/:id) stay responsive
	// and shared Redis is not held by a long search fallback chain during initial hydrate.
	try {
		const searchUrl = `${BASE}/api/finra/search?query=${encodeURIComponent(firmId)}&nrows=30`;
		const searchRes = await Promise.race([fetch(searchUrl), new Promise<Response | null>((resolve) => setTimeout(() => resolve(null), 3500))]);
		if (searchRes && searchRes.ok) {
			const searchData = await searchRes.json();
			const hits = searchData?.hits?.hits || searchData?.results || [];
			for (const hit of hits) {
				const src = hit._source || hit;
				const pid = src.ind_source_id || src.ind_crd || src.individualId || null;
				if (!pid) continue;
				const personNodeId = `person:${pid}`;
				if (!nodes.some((n) => n.id === personNodeId) && !findExistingPersonNode(pid)) {
					const label = normalizePersonLabel(
						[src.ind_firstname || src.firstName, src.ind_middlename || src.middleName, src.ind_lastname || src.lastName].filter(Boolean).join(' ') || `Person ${pid}`,
					);
					nodes.push({
						id: personNodeId,
						label,
						group: 'individual',
						crd: pid,
						bcScope: src.ind_bc_scope || src.bcScope || null,
						stub: true,
					});
				}
				links.push({
					source: personNodeId,
					target: firmNodeId,
					relationship: 'employed_by',
					isCurrent: true,
				});
			}
		}
	} catch (e) {
		console.warn(`Failed to fetch additional employees for firm ${firmId}:`, e);
	}

	const mergedNodes = mergeGraphNodesForAppend([], nodes);
	return {
		nodes: mergedNodes.nodes,
		links: dedupeGraphLinksByIdentity(links, mergedNodes.idRewriteMap),
	};
}

async function loadGraph() {
	try {
		// Isolate mode: a shared `?selected=...&isolate=1` link from the dashboard requests that
		// ONLY the selected nodes (+ the routed node) be rendered — skip loading the baseline/
		// profile graph and any saved session entirely, then prune away any employer/owner
		// "stub" nodes that the per-node detail fetchers pull in automatically so exactly the
		// requested set (and nothing else) ends up on screen.
		if (isolateToSharedSelection) {
			const keepIds = new Set<string>(pendingSelectedNodeIds.map((id) => normalizeNodeRouteId(id) || String(id || '').trim()).filter(Boolean));
			const routedId = String(pendingRouteNodeId || '').trim();
			if (routedId) keepIds.add(routedId);

			// If the user already had a graph on screen (a saved session), restore it first and
			// APPEND the newly selected nodes on top rather than wiping the canvas — the isolate
			// param only means "don't load the default baseline/profile graph," not "discard
			// whatever the user already had rendered."
			const existingSession = await loadSessionAsync();
			const hasExistingSessionData = Boolean(
				existingSession &&
				!existingSession.cleared &&
				(existingSession.extraNodes?.length ||
					existingSession.extraNodeIds?.length ||
					existingSession.renderedServerIds?.length ||
					existingSession.selectedNodeId ||
					existingSession.highlightedNodes?.length),
			);

			if (hasExistingSessionData) {
				graphData = { nodes: [], links: [], meta: {} };
				initialServerNodeIds = new Set();
				initialServerLinkKeys = new Set();
				isSubsetMode = false;
				renderGraph(graphData);
				showEmpty(false);
				updateMeta({ totalIndividuals: 0, totalFirms: 0, totalLinks: 0 });
				await restoreSavedSession(existingSession);
				if (pendingRouteNodeId) {
					await applyPendingRouteNodeSelection();
				}
				if (pendingSelectedNodeIds.length) {
					await hydratePendingSelectedNodeIds();
				}
				return;
			}

			clearGraphData();
			if (pendingRouteNodeId) {
				await applyPendingRouteNodeSelection();
			}
			if (pendingSelectedNodeIds.length) {
				await hydratePendingSelectedNodeIds();
			}
			pruneGraphDataToKeepIds(keepIds);
			return;
		}

		const hasProfileParam = new URLSearchParams(window.location.search).has('profile');
		const profileName = hasProfileParam ? new URLSearchParams(window.location.search).get('profile') : 'custom';
		currentProfileName = profileName;

		// Load profile and session in parallel for faster startup
		const [profileData, session] = await Promise.all([loadProfile(profileName), loadSessionAsync()]);

		currentProfileEnabled = isProfileEnabled(profileData);
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
			await loadBaselineGraph(profileName, { suppressRender: Boolean(session) });
			if (!graphData) return;

			if (session) {
				const renderedSavedSession = renderSavedSessionGraph(session);
				if (!renderedSavedSession) {
					renderBaselineGraphData();
				}
				await restoreSavedSession(session);
				return;
			}
		}

		// Auto-load the profile specified in ?profile=<name>, or 'custom' by default.
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

			const indivResults = await mapWithConcurrency(indCrds, PROFILE_SEED_FETCH_CONCURRENCY, async (c) => {
				if (layoutNodes.some((n) => n.id === `person:${c}`)) return { nodes: [], links: [] };
				try {
					return await fetchIndividualBatch(c);
				} catch {
					return { nodes: [], links: [] };
				}
			});
			const firmResults = await mapWithConcurrency(firmIds, PROFILE_SEED_FETCH_CONCURRENCY, async (f) => {
				if (layoutNodes.some((n) => n.id === `firm:${f}`)) return { nodes: [], links: [] };
				try {
					return await fetchFirmBatch(f);
				} catch {
					return { nodes: [], links: [] };
				}
			});

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
				const seedBatchNodes = [];
				const seedBatchLinks = [];
				const seedResults = await mapWithConcurrency(seedQueries, SEED_QUERY_FETCH_CONCURRENCY, async (s) => {
					try {
						const local = await fetchLocalQueryBatch(s);
						if (local.nodes && local.nodes.length) return local;
						return await fetchQueryBatch(s);
					} catch {
						return { nodes: [], links: [] };
					}
				});
				for (const result of seedResults) {
					if (result.status !== 'fulfilled' || !result.value) continue;
					if (result.value.nodes?.length) seedBatchNodes.push(...result.value.nodes);
					if (result.value.links?.length) seedBatchLinks.push(...result.value.links);
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
		if (pendingSelectedNodeIds.length) {
			void hydratePendingSelectedNodeIds();
		}
	}
}

// Populates the selection log (without changing the focused/routed node) from ids
// shared via a `?selected=` link, fetching any nodes not already present in the graph.
// Large shared-selection links can carry 100+ ids (e.g. a firm's full connection list), so
// nodes are hydrated with bounded concurrency instead of one-at-a-time sequential awaits —
// previously this looped `for...of` with a blocking `await` per id, meaning a 200-id link took
// ~200 sequential network round-trips before the page felt fully loaded. Selection-log UI
// updates are also batched into a single refresh at the end instead of once per node.
async function hydratePendingSelectedNodeIds() {
	const ids = pendingSelectedNodeIds.slice();
	pendingSelectedNodeIds = [];
	if (!ids.length) return;

	const CONCURRENCY = 8;
	const resolvedEntries: SelectionLogEntry[] = [];
	let cursor = 0;

	async function worker() {
		while (cursor < ids.length) {
			const rawId = ids[cursor++];
			const normalizedId = normalizeNodeRouteId(rawId) || String(rawId || '').trim();
			if (!normalizedId) continue;
			try {
				const liveNode = await ensureRouteNodeAvailable(normalizedId);
				if (liveNode) {
					resolvedEntries.push({
						id: liveNode.id,
						label: liveNode.label,
						secondaryId: getSecondaryId(liveNode),
						group: liveNode.group,
					});
				}
			} catch (error) {
				console.warn(`Failed to hydrate shared selection for ${normalizedId}:`, error);
			}
		}
	}

	await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ids.length) }, () => worker()));

	if (!resolvedEntries.length) return;
	let nextLog = selectedNodesLog;
	for (const entry of resolvedEntries) {
		nextLog = upsertSelectionLogEntry(nextLog, entry);
		clearedSelectionLogLabelNodeIds.delete(String(entry.id || '').trim());
	}
	selectedNodesLog = nextLog;
	saveSelectionLog();
	updateSelectionLogUI();
	syncSelectionLogAuxiliaryRenderers();
}

// Build a subgraph from `seedCount` random nodes plus all their N-hop neighbors.
function subsetGraph(data, seedCount, hops = getDefaultExpansionHops()) {
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
		linkSel
			.style('stroke-opacity', null)
			.attr('stroke-opacity', (d) => getScaledLinkStrokeOpacity(defaultLinkOpacity(d)))
			.style('opacity', null);
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

		const queryTokens = ql.split(/\s+/).filter((w) => w.length > 0);
		if (queryTokens.length > 0) {
			const checkFuzzy = (textTokens) => {
				return queryTokens.every((qw) => {
					return textTokens.some((tw) => {
						if (tw === qw) return true;
						if (tw.includes(qw) && qw.length >= 4) return true;
						if (qw.includes(tw) && tw.length >= 4) return true;
						if (Math.min(qw.length, tw.length) < 4) return false;
						const maxDist = Math.max(1, Math.floor(qw.length * 0.3));
						return getLevenshteinDistance(qw, tw) <= maxDist;
					});
				});
			};
			if (checkFuzzy(labelLow.split(/\s+/).filter(Boolean)) || checkFuzzy(personFull.toLowerCase().split(/\s+/).filter(Boolean))) {
				matched.add(n.id);
				return;
			}
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
			const rendered = new Set(layoutNodes.map((n) => String(n.id)));
			const missing = Array.from(matched as Set<string>).filter((id) => !rendered.has(String(id)));
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
					const rendered = new Set(layoutNodes.map((n) => String(n.id)));
					const missing = Array.from(matched as Set<string>).filter((id) => !rendered.has(String(id)));
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
	if (isBrowserOffline()) {
		showOfflineFetchStatus();
		return Promise.resolve();
	}
	clearOfflineFetchStatus();
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
	employed_by: 0.9,
	previous_employed_by: 0.7,
	controls: 0.6,
};
const DEFAULT_LINK_WIDTH = 1.2;
const INACTIVE_LINK_OPACITY = 0.6;
const defaultLinkOpacity = (d) => {
	if (hasInactiveEndpoint(d)) return INACTIVE_LINK_OPACITY;
	if (usesCurrentEmploymentStyling(d)) return LINK_OPACITY.employed_by;
	return LINK_OPACITY[d.relationship] ?? 1;
};

function getEmploymentRelationship(entry) {
	return getEmploymentRelationshipImpl(entry);
}

function normalizeLinkNodeId(endpoint) {
	if (!endpoint) return '';
	if (typeof endpoint === 'object') {
		return String(endpoint.id || '').trim();
	}
	return String(endpoint || '').trim();
}

export function isForcedGrayConnectionLink(link) {
	if (!link) return false;
	if (link.forceGray === true || link.forceGray === 'true' || link.isForcedGray === true || link.isForcedGray === 'true') return true;

	const sourceId = normalizeLinkNodeId(link?.source)
		.replace(/^node[:_]/, '')
		.replace(/^person[:_]/, 'person:')
		.replace(/^firm[:_]/, 'firm:');
	const targetId = normalizeLinkNodeId(link?.target)
		.replace(/^node[:_]/, '')
		.replace(/^person[:_]/, 'person:')
		.replace(/^firm[:_]/, 'firm:');
	const pair = [sourceId, targetId].filter(Boolean).sort().join('|');
	return Boolean(link?.metadata?.forceGray || link?.data?.forceGray || (pair && link?.forceGray));
}

export function resolveEmploymentConnectionFirmNodeId(employment) {
	const rawFirmId = String(employment?.firmId || employment?.firm_id || employment?.firmIdNumber || employment?.organizationId || employment?.orgId || '').trim();
	const secFirmId = String(employment?.bdSECNumber || employment?.bdSecNumber || employment?.iaSECNumber || employment?.iaSecNumber || employment?.firm_bd_sec_number || '').trim();
	const firmId = rawFirmId || secFirmId;
	const firmName = String(
		employment?.firmName || employment?.firm_name || employment?.organizationName || employment?.firm || employment?.name || employment?.legalName || '',
	).trim();
	const existingFirmNode = findExistingFirmNode(firmId, { label: firmName });
	const syntheticFirmNodeId = !firmId && !existingFirmNode && firmName ? buildSyntheticFirmNodeId(firmName) : null;
	return existingFirmNode?.id || (firmId ? `firm:${firmId}` : syntheticFirmNodeId) || null;
}

function resolveControlConnectionFirmNodeId(controlRecord) {
	const firmId = String(controlRecord?.firmId || controlRecord?.firm_id || controlRecord?.organizationId || controlRecord?.orgId || '').trim();
	const firmName = String(controlRecord?.firmName || controlRecord?.organizationName || controlRecord?.firm || controlRecord?.name || controlRecord?.legalName || '').trim();
	const existingFirmNode = findExistingFirmNode(firmId, { label: firmName });
	const syntheticFirmNodeId = !firmId && !existingFirmNode && firmName ? buildSyntheticFirmNodeId(firmName) : null;
	return existingFirmNode?.id || (firmId ? `firm:${firmId}` : syntheticFirmNodeId) || null;
}

function getKnownNodeConnectionFloor(node) {
	const counts = { total: 0, controls: 0, employed: 0 };
	if (!node || typeof node !== 'object') return counts;

	// Load persisted per-node connection cache from localStorage when available.
	let connCache: Record<string, any> | null = null;
	try {
		if (typeof window !== 'undefined') {
			const raw = localStorage.getItem('finra_node_conn_count');
			if (raw) connCache = JSON.parse(raw);
		}
	} catch {
		connCache = null;
	}

	const seenConnectionKeys = new Set<string>();
	const addConnection = (bucket: 'controls' | 'employed', key: string | null | undefined) => {
		const normalizedKey = String(key || '').trim();
		if (!normalizedKey || seenConnectionKeys.has(normalizedKey)) return;
		seenConnectionKeys.add(normalizedKey);
		counts.total += 1;
		if (bucket === 'controls') counts.controls += 1;
		else counts.employed += 1;
	};

	if (node.group === 'individual') {
		for (const employment of Array.isArray(node.currentEmployments) ? node.currentEmployments : []) {
			const firmNodeId = resolveEmploymentConnectionFirmNodeId(employment);
			addConnection('employed', firmNodeId ? `current|${firmNodeId}` : null);
		}
		for (const employment of Array.isArray(node.currentIAEmployments) ? node.currentIAEmployments : []) {
			const firmNodeId = resolveEmploymentConnectionFirmNodeId(employment);
			addConnection('employed', firmNodeId ? `current|${firmNodeId}` : null);
		}
		for (const employment of Array.isArray(node.previousEmployments) ? node.previousEmployments : []) {
			const firmNodeId = resolveEmploymentConnectionFirmNodeId(employment);
			addConnection('employed', firmNodeId ? `previous|${firmNodeId}` : null);
		}
		for (const employment of Array.isArray(node.previousIAEmployments) ? node.previousIAEmployments : []) {
			const firmNodeId = resolveEmploymentConnectionFirmNodeId(employment);
			addConnection('employed', firmNodeId ? `previous|${firmNodeId}` : null);
		}

		const controlRecords = [
			...(Array.isArray(node.controlPositions) ? node.controlPositions : []),
			...(Array.isArray(node.controlPositionList) ? node.controlPositionList : []),
			...(Array.isArray(node.controlRelationships) ? node.controlRelationships : []),
			...(Array.isArray(node.brokerDetails?.controlPositions) ? node.brokerDetails.controlPositions : []),
		];
		for (const controlRecord of controlRecords) {
			const firmNodeId = resolveControlConnectionFirmNodeId(controlRecord);
			addConnection('controls', firmNodeId ? `controls|${firmNodeId}` : null);
		}

		// If we computed no connections but have a cached value, use it as a floor.
		if (!counts.total && connCache && node.id) {
			const cached = connCache[String(node.id)];
			if (cached && typeof cached === 'object') {
				return { total: Number(cached.total) || 0, controls: Number(cached.controls) || 0, employed: Number(cached.employed) || 0 };
			}
		}

		// persist computed counts to cache
		try {
			if (typeof window !== 'undefined') {
				const nid = String(node.id || '');
				if (nid) {
					connCache = connCache || {};
					connCache[nid] = { total: counts.total, controls: counts.controls, employed: counts.employed, ts: Date.now() };
					try {
						localStorage.setItem('finra_node_conn_count', JSON.stringify(connCache));
					} catch {}
				}
			}
		} catch {}

		return counts;
	}

	if (node.group === 'firm') {
		for (const owner of Array.isArray(node.directOwners) ? node.directOwners : []) {
			const personId = String(owner?.crdNumber || owner?.crd || owner?.personId || '').trim();
			addConnection('controls', personId ? `controls|person:${personId}` : null);
		}

		if (!counts.total && connCache && node.id) {
			const cached = connCache[String(node.id)];
			if (cached && typeof cached === 'object') {
				return { total: Number(cached.total) || 0, controls: Number(cached.controls) || 0, employed: Number(cached.employed) || 0 };
			}
		}

		// persist computed counts to cache
		try {
			if (typeof window !== 'undefined') {
				const nid = String(node.id || '');
				if (nid) {
					connCache = connCache || {};
					connCache[nid] = { total: counts.total, controls: counts.controls, employed: counts.employed, ts: Date.now() };
					try {
						localStorage.setItem('finra_node_conn_count', JSON.stringify(connCache));
					} catch {}
				}
			}
		} catch {}

		return counts;
	}

	// If nothing matched but we have a cached entry, return that as a floor
	try {
		if (connCache && node && node.id) {
			const cached = connCache[String(node.id)];
			if (cached && typeof cached === 'object') {
				return { total: Number(cached.total) || 0, controls: Number(cached.controls) || 0, employed: Number(cached.employed) || 0 };
			}
		}
	} catch {}

	return counts;
}

export function applyGraphDerivedNodeMetrics(nodes, links) {
	const nodeList = Array.isArray(nodes) ? nodes : [];
	const linkList = Array.isArray(links) ? links : [];
	const degMap = new Map<string, { total: number; controls: number; employed: number }>();

	nodeList.forEach((node) => {
		degMap.set(node.id, { total: 0, controls: 0, employed: 0 });
	});

	linkList.forEach((link) => {
		const sourceId = link.source?.id ?? link.source;
		const targetId = link.target?.id ?? link.target;

		// Include ALL auto-expansion links (current and historical) in the degree count
		// to ensure nodes remain visible and correctly scaled in the expansive layout.
		if (!isAutoExpansionLink(link)) return;

		[sourceId, targetId].forEach((id) => {
			const entry = degMap.get(id);
			if (!entry) return;
			entry.total += 1;
			if (isControlRelationship(link)) entry.controls += 1;
			else entry.employed += 1;
		});
	});

	// Use actual degree distribution for scaling instead of assuming max ranges
	const indDegs = nodeList.filter((n) => n.group === 'individual').map((n) => degMap.get(n.id)?.total || 0);
	const firmDegs = nodeList.filter((n) => n.group === 'firm').map((n) => degMap.get(n.id)?.total || 0);
	const maxIndDeg = Math.max(1, ...indDegs);
	const maxFirmDeg = Math.max(1, ...firmDegs);

	const MIN_INDIV = 12;
	const MIN_FIRM = 14;

	nodeList.forEach((node) => {
		const deg = degMap.get(node.id) || { total: 0, controls: 0, employed: 0 };
		const knownFloor = getKnownNodeConnectionFloor(node);
		deg.controls = Math.max(deg.controls, knownFloor.controls);
		deg.employed = Math.max(deg.employed, knownFloor.employed);
		// Base total should respect computed degree and known (cached) floor.
		deg.total = Math.max(deg.total, knownFloor.total, deg.controls + deg.employed);

		// Visual boost: make nodes more prominent even when their active degree is low
		// (for example when not yet expanded). This helps users see which nodes
		// warrant clicking. Use slightly higher minima for firms.
		if (node.group === 'individual') {
			deg.total = Math.max(deg.total, 3);
		} else if (node.group === 'firm') {
			deg.total = Math.max(deg.total, 4);
		}
		node._deg = deg;

		if (node.group === 'individual') {
			// Square root scale for more natural growth.
			// Nodes with "several" (3+) connections get significantly larger.
			const scale = 1 + (Math.sqrt(deg.total) / Math.sqrt(maxIndDeg)) * 2.8;
			let half = (NODE_R.individual * 1.7 * scale) / 2;
			if (!deg.total || !isFinite(half) || half < MIN_INDIV) half = MIN_INDIV;

			// Extra boost for nodes with high active degree relative to the cluster
			if (deg.total >= 3) half *= 1.15;
			if (deg.total >= 8) half *= 1.1;

			node._vizHalf = half;
			return;
		}

		if (node.group === 'firm') {
			const scale = 1 + (Math.sqrt(deg.total) / Math.sqrt(maxFirmDeg)) * 2.2;
			let half = (NODE_R.firm * 1.7 * scale) / 2;
			if (!deg.total || !isFinite(half) || half < MIN_FIRM) half = MIN_FIRM;

			if (deg.total >= 5) half *= 1.1;
			if (deg.total >= 20) half *= 1.1;

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
		nodeCount > 1000 ? 10.5
		: nodeCount > 600 ? 9.2
		: nodeCount > 300 ? 8.0
		: 6.5;
	const cap =
		nodeCount > 1000 ? 250
		: nodeCount > 600 ? 210
		: nodeCount > 300 ? 180
		: 140;
	return Math.min(cap, Math.sqrt(degree) * multiplier);
}

function normalizeStateCode(value) {
	const text = String(value || '')
		.replace(/\./g, '')
		.replace(/\s+/g, ' ')
		.trim();
	if (!text) return '';
	const upper = text.toUpperCase();
	if (STATE_CODES.has(upper)) return upper;
	return STATE_NAME_TO_CODE[text.toLowerCase()] || '';
}

function firstLocationText(...values) {
	for (const value of values) {
		const text = String(value || '')
			.replace(/\s+/g, ' ')
			.trim();
		if (text) return text;
	}
	return '';
}

function hashString(value) {
	const text = String(value || '');
	let hash = 0;
	for (let index = 0; index < text.length; index += 1) {
		hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
	}
	return hash;
}

function inferRegionFromDistrict(district) {
	const normalized = String(district || '')
		.trim()
		.toLowerCase();
	if (!normalized) return '';
	if (/(san francisco|los angeles|seattle|portland|salt lake|phoenix|las vegas|denver|honolulu|anchorage)/.test(normalized)) return 'west';
	if (/(dallas|houston|austin|oklahoma|new mexico)/.test(normalized)) return 'southwest';
	if (/(chicago|detroit|minneapolis|st\.?\s*louis|kansas city|milwaukee|omaha|indianapolis|cleveland|columbus)/.test(normalized)) return 'midwest';
	if (/(new york|boston|philadelphia|newark|jersey|baltimore|washington|pittsburgh|hartford|providence)/.test(normalized)) return 'northeast';
	if (/(atlanta|miami|charlotte|raleigh|nashville|memphis|new orleans|tampa|orlando|jacksonville|birmingham|louisville|richmond)/.test(normalized)) return 'southeast';
	return '';
}

function getLocationRegion(node) {
	const state = normalizeStateCode(node?.locationState || node?.basicInformation?.state || node?.basicInformation?.stateCode || node?.basicInformation?.formedState);
	if (state) return STATE_REGION_MAP[state] || '';
	return inferRegionFromDistrict(node?.locationDistrict || node?.basicInformation?.districtName);
}

function getLocationSourceStrength(node) {
	const source = String(node?.locationBiasSource || '')
		.trim()
		.toLowerCase();
	return LOCATION_SOURCE_STRENGTH[source] ?? (node?.locationDistrict ? LOCATION_SOURCE_STRENGTH.district : 0.55);
}

function getLocationGroupingBaseStrength(nodeCount = layoutNodes?.length || 0) {
	if (nodeCount > 1000) return 0.013;
	if (nodeCount > 300) return 0.015;
	return 0.018;
}

function getSoftLocationGroupingTarget(node, width, height, nodeCount = layoutNodes?.length || 0) {
	if (!SOFT_LOCATION_GROUPING_ENABLED || !node || node.group === 'entity') return null;
	const region = getLocationRegion(node);
	if (!region) return null;
	const anchor = LOCATION_REGION_ANCHORS[region];
	if (!anchor) return null;
	const state = normalizeStateCode(node?.locationState || node?.basicInformation?.state || node?.basicInformation?.stateCode || node?.basicInformation?.formedState);
	const district = firstLocationText(node?.locationDistrict, node?.basicInformation?.districtName);
	const jitterSeed = state || district || node.id;
	const jitterHash = hashString(jitterSeed);
	const jitterX = ((jitterHash % 1000) / 999 - 0.5) * width * 0.08;
	const jitterY = ((((jitterHash / 1000) | 0) % 1000) / 999 - 0.5) * height * 0.12;
	const baseStrength = getLocationGroupingBaseStrength(nodeCount);
	const sourceStrength = getLocationSourceStrength(node);
	const firmWeight = node.group === 'firm' ? 0.92 : 1;
	return {
		x: width * anchor.x + jitterX,
		y: height * anchor.y + jitterY,
		strength: baseStrength * sourceStrength * firmWeight,
	};
}

function applySoftLocationGroupingTargets(nodeList, width, height) {
	if (!Array.isArray(nodeList)) return;
	const nodeCount = nodeList.length;
	for (const node of nodeList) {
		const target = getSoftLocationGroupingTarget(node, width, height, nodeCount);
		if (!target) {
			delete node._locationBiasX;
			delete node._locationBiasY;
			delete node._locationBiasStrength;
			continue;
		}
		node._locationBiasX = target.x;
		node._locationBiasY = target.y;
		node._locationBiasStrength = target.strength;
	}
}

function refreshSoftLocationGroupingForces(nodeList = layoutNodes) {
	if (!simulation || !Array.isArray(nodeList)) return;
	const main = document.getElementById('fg-main');
	const width = Math.max(1, main?.clientWidth || 1);
	const height = Math.max(1, main?.clientHeight || 1);
	applySoftLocationGroupingTargets(nodeList, width, height);
	simulation
		.force('location-x')
		?.x((node) => (Number.isFinite(node?._locationBiasX) ? node._locationBiasX : width / 2))
		.strength((node) => node?._locationBiasStrength || 0);
	simulation
		.force('location-y')
		?.y((node) => (Number.isFinite(node?._locationBiasY) ? node._locationBiasY : height / 2))
		.strength((node) => (node?._locationBiasStrength || 0) * 0.85);
}

function getForceLinkDistance(link, nodeCount = layoutNodes?.length || 0) {
	const baseDistance =
		nodeCount > 1000 ? 320
		: nodeCount > 300 ? 260
		: nodeCount > 150 ? 220
		: nodeCount > 80 ? 300
		: 450;

	const sourceNode = typeof link?.source === 'object' ? link.source : layoutNodes?.find((node) => node.id === link?.source);
	const targetNode = typeof link?.target === 'object' ? link.target : layoutNodes?.find((node) => node.id === link?.target);

	// Multiplier for dense nodes to spread them out further
	const sourceDeg = sourceNode?._deg?.total || 0;
	const targetDeg = targetNode?._deg?.total || 0;
	const maxDeg = Math.max(sourceDeg, targetDeg);

	const densityMultiplier =
		maxDeg > 100 ? 1.85
		: maxDeg > 50 ? 1.6
		: maxDeg > 20 ? 1.35
		: 1.1;

	const scatterBoost = Math.max(getNodeScatterBoost(sourceNode, nodeCount), getNodeScatterBoost(targetNode, nodeCount));
	const relationshipBoost =
		link?.relationship === 'controls' ? 32
		: link?.relationship === 'previous_employed_by' ? 16
		: 0;

	return baseDistance * densityMultiplier + scatterBoost * 1.5 + relationshipBoost;
}

function getNodeCollisionRadius(node, nodeCount = layoutNodes?.length || 0) {
	const padding =
		nodeCount > 1000 ? 16
		: nodeCount > 600 ? 20
		: nodeCount > 300 ? 24
		: nodeCount > 120 ? 30
		: nodeCount > 60 ? 45
		: 65;
	const labelPadding =
		nodeCount > 1000 ? 24
		: nodeCount > 600 ? 20
		: nodeCount > 300 ? 16
		: 14;
	const scatterPadding = Math.min(nodeCount > 1000 ? 56 : 48, getNodeScatterBoost(node, nodeCount) * 0.35);
	const labelLengthPadding = Math.min(15, Math.max(0, formatNodeLabel(node?.label || '').length - 10) * 0.4);
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

export function getLargeNodeRevealBatchPlan(hiddenNodeCount = 0, currentNodeCount = layoutNodes?.length || 0) {
	const hiddenCount = Math.max(0, Number(hiddenNodeCount) || 0);
	const nodeCount = Math.max(0, Number(currentNodeCount) || 0);
	if (!hiddenCount) {
		return { shouldBatch: false, batchSize: 0, batchCount: 1, batchDelayMs: 0 };
	}

	const isLargeGraph = nodeCount > 800;
	const isHugeGraph = nodeCount > 2200;
	const batchSize =
		isHugeGraph ? 8
		: isLargeGraph ? 12
		: 20;
	const batchCount = Math.max(1, Math.ceil(hiddenCount / batchSize));
	return {
		shouldBatch: hiddenCount > batchSize || nodeCount > 1200,
		batchSize,
		batchCount,
		batchDelayMs:
			isHugeGraph ? 60
			: isLargeGraph ? 40
			: 24,
	};
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

export function rebindLinksToNodes(links = [], nodes = []) {
	if (!Array.isArray(links) || !Array.isArray(nodes)) return [];
	const nodeMap = new Map(nodes.map((node) => [node.id, node]));
	const resolved = [];
	for (const link of links) {
		if (!link || typeof link !== 'object') continue;
		const sourceId = link.source?.id ?? link.source;
		const targetId = link.target?.id ?? link.target;
		const sourceNode = sourceId ? nodeMap.get(sourceId) : null;
		const targetNode = targetId ? nodeMap.get(targetId) : null;
		if (!sourceNode || !targetNode) continue;
		link.source = sourceNode;
		link.target = targetNode;
		resolved.push(link);
	}
	links.length = 0;
	links.push(...resolved);
	return links;
}

export function resolveLinkEndpoints(links = [], nodes = []) {
	return rebindLinksToNodes(links, nodes);
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

function getRegistrationStatusActivityValues(node) {
	if (!node || typeof node !== 'object') return [];
	if (!Array.isArray(node.registrationStatus)) return [];
	return node.registrationStatus.map((entry: any) => entry?.status || entry?.registrationStatus || entry?.regStatus || entry?.scopeStatus || '').filter(Boolean);
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

function hasIndividualFinraPresence(node: any) {
	if (!node || typeof node !== 'object') return false;
	// Per-node suppression: if the node explicitly suppresses FINRA links, respect that.
	if (
		Array.isArray(node?.suppressedExternalLinks) &&
		node.suppressedExternalLinks.some(
			(s: any) =>
				String(s || '')
					.trim()
					.toLowerCase() === 'finra',
		)
	)
		return false;
	if (isNotInScopeValue(node?.bcScope) || isNotInScopeValue(node?.basicInformation?.bcScope)) return false;
	if (node.hasFinraData === true) return true;
	if (hasPublicFinraIndividualPage(node, node.basicInformation || {})) return true;
	if (hasAnyItems(node?.currentEmployments)) return true;
	if (hasAnyItems(node?.previousEmployments)) return true;
	if (hasApprovedSro(node?.registeredSROs)) return true;
	if (hasActiveRegisteredStates(node?.registeredStates, ['bc', 'b', 'broker'])) return true;
	const bcScopeFlags = collectNodeActivityFlags([node?.bcScope, node?.basicInformation?.bcScope]);
	if (bcScopeFlags.hasActive || bcScopeFlags.hasInactive) return true;
	return false;
}

function hasIndividualSecPresence(node: any) {
	if (!node || typeof node !== 'object') return false;

	// Per-node suppression: if the node explicitly suppresses SEC links, respect that.
	if (
		Array.isArray(node?.suppressedExternalLinks) &&
		node.suppressedExternalLinks.some(
			(s: any) =>
				String(s || '')
					.trim()
					.toLowerCase() === 'sec',
		)
	)
		return false;

	// Per-id suppression: if the node's id/crd is known to be invalid for SEC links, suppress.
	const rawId = String(node?.crd || node?.basicInformation?.individualId || node?.individualId || node?.id || '')
		.replace(/^person[:_]/, '')
		.replace(/^node[:_]/, '')
		.trim();
	if (rawId && SUPPRESSED_SEC_INDIV_IDS.has(rawId)) return false;
	if (isNotInScopeValue(node?.iaScope) || isNotInScopeValue(node?.basicInformation?.iaScope)) return false;
	if (node.hasSecData === true) return true;
	if (hasPublicSecIndividualPage(node, node.basicInformation || {})) return true;
	if (hasSecActivityEvidence(node)) return true;
	if (Number(node?.registrationCount?.approvedIAStateRegistrationCount || 0) > 0) return true;
	if (hasAnyItems(node?.previousIAEmployments)) return true;
	if (hasAnyItems(node?.disclosures)) return true;
	if (hasAnyItems(node?.iaDisclosures)) return true;
	if (hasActiveRegisteredStates(node?.registeredStates, ['ia'])) return true;
	const iaScopeFlags = collectNodeActivityFlags([node?.iaScope, node?.basicInformation?.iaScope]);
	if (iaScopeFlags.hasActive || iaScopeFlags.hasInactive) return true;
	return false;
}

function hasFirmFinraPresence(node: any) {
	if (!node || typeof node !== 'object') return false;

	// Per-node suppression: if the node explicitly suppresses FINRA links, respect that.
	if (
		Array.isArray(node?.suppressedExternalLinks) &&
		node.suppressedExternalLinks.some(
			(s: any) =>
				String(s || '')
					.trim()
					.toLowerCase() === 'finra',
		)
	)
		return false;

	// if this firm is explicitly blacklisted, treat as no FINRA presence
	const rawFirmId = String(node?.firmId || node?.id || '')
		.replace(/^firm[:_]/, '')
		.replace(/^node[:_]/, '')
		.trim();
	if (rawFirmId && BROKEN_FINRA_FIRM_IDS.has(rawFirmId)) return false;
	if (isNotInScopeValue(node?.bcScope) || isNotInScopeValue(node?.basicInformation?.bcScope)) return false;
	// Prefer explicit source-truth when available.
	if (node.hasFinraData === false) return false;
	if (node.hasFinraData === true) return true;
	if (node.isLegacy === 'Y') return true;
	if (hasAnyItems(node?.selfRegulatoryOrgs)) return true;
	if (Boolean(String(node?.districtName || '').trim())) return true;
	const bcScopeFlags = collectNodeActivityFlags([node?.bcScope, node?.basicInformation?.bcScope]);
	if (bcScopeFlags.hasActive || bcScopeFlags.hasInactive) return true;
	return false;
}

function hasFirmSecPresence(node: any) {
	if (!node || typeof node !== 'object') return false;
	if (
		Array.isArray(node?.suppressedExternalLinks) &&
		node.suppressedExternalLinks.some(
			(s: any) =>
				String(s || '')
					.trim()
					.toLowerCase() === 'sec',
		)
	)
		return false;
	const rawFirmId = String(node?.firmId || node?.id || '')
		.replace(/^firm[:_]/, '')
		.replace(/^node[:_]/, '')
		.trim();
	if (rawFirmId && SUPPRESSED_SEC_FIRM_IDS.has(rawFirmId)) return false;
	if (isNotInScopeValue(node?.iaScope) || isNotInScopeValue(node?.basicInformation?.iaScope)) return false;
	if (node.hasSecData === true) return true;
	if (Boolean(String(node?.iaSecNumber || node?.basicInformation?.iaSECNumber || node?.basicInformation?.iaSecNumber || '').trim())) return true;
	if (hasAnyItems(node?.secDocumentLinks)) return true;
	if (Boolean(String(node?.secSummaryDescription || '').trim())) return true;
	const secStatusFlags = collectNodeActivityFlags([
		node?.firmStatus,
		node?.basicInformation?.firmStatus,
		node?.iaScope,
		node?.basicInformation?.iaScope,
		...getRegistrationStatusActivityValues(node),
	]);
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
	if (Array.isArray(node?.disclosures) && node.disclosures.length > 0) return true;
	if (Array.isArray(node?.iaDisclosures) && node.iaDisclosures.length > 0) return true;
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
				collectNodeActivityFlags([node.firmStatus, node.basicInformation?.firmStatus, node.iaScope, node.basicInformation?.iaScope, ...getRegistrationStatusActivityValues(node)])
			:	{ hasActive: false, hasInactive: false };
		const registrationStatusFlags = collectNodeActivityFlags(getRegistrationStatusActivityValues(node));
		if (finraFlags.hasActive || secFlags.hasActive || registrationStatusFlags.hasActive) return false;
		if ((sourceTruth.finra || sourceTruth.sec) && Array.isArray(node.activeStates) && node.activeStates.length) return false;
		if (node.isLegacy === 'Y' && !sourceTruth.sec) return true;
		if (finraFlags.hasInactive || secFlags.hasInactive || registrationStatusFlags.hasInactive) return true;
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
		// Honor a client-side strictness toggle. When enabled, be more
		// conservative about marking nodes inactive based solely on
		// historical-only signals so UI interactions don't flip a node gray
		// unexpectedly. Toggle by setting localStorage.finra_strict_inactive = 'true'.
		try {
			const strict = typeof window !== 'undefined' && window.localStorage && window.localStorage.getItem('finra_strict_inactive') === 'true';
			if (strict) return false;
		} catch (e) {
			/* ignore */
		}
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
	if (isForcedGrayConnectionLink(link)) return true;
	const rel = String(link.relationship || '').trim().toLowerCase();
	if (!rel) {
		if (link.isCurrent === false) return true;
		if (link.endDate && String(link.endDate).trim() !== '') return true;
		return false;
	}
	if (rel === 'previous_employed_by' || rel === 'previous_registered_by') return true;
	if (link.isCurrent === false) return true;
	if ((rel === 'employed_by' || rel === 'registered_by') && link.endDate && String(link.endDate).trim() !== '') return true;
	if (rel === 'employed_by' || rel === 'registered_by') {
		const sourceNode = resolveLinkEndpointNode(link.source);
		if (sourceNode?.group === 'individual') {
			const targetId = String(typeof link.target === 'object' ? link.target?.id : link.target || '').replace(/^firm:/, '').trim();
			if (!targetId) return false;
			const previous = [...(sourceNode.previousEmployments || []), ...(sourceNode.previousIAEmployments || [])];
			const matchesPrevious = previous.some((employment) => String(employment?.firmId || employment?.firm_id || '').trim() === targetId);
			if (matchesPrevious) return true;
		}
		return !isCurrentRegistration(link);
	}
	return false;
}

function isControlRelationship(link) {
	if (!link) return false;
	const rel = String(link.relationship || '')
		.trim()
		.toLowerCase();
	return rel === 'controls' || rel === 'controlled_by' || rel === 'owner' || rel === 'officer' || rel === 'associated_with';
}

function usesCurrentEmploymentStyling(link) {
	if (!link || hasInactiveEndpoint(link) || isForcedGrayConnectionLink(link)) return false;
	// Only treat links that are current registrations as "current employment" styling.
	// Previous employment links should NOT be included here so they render with the
	// previous-employment (gray/dashed) styling.
	return isCurrentRegistration(link);
}

function isCurrentActiveConnection(link) {
	if (!link || hasInactiveEndpoint(link) || isForcedGrayConnectionLink(link)) return false;
	return usesCurrentEmploymentStyling(link) || isControlRelationship(link);
}

function getLinkHighlightColor(link) {
	if (hasInactiveEndpoint(link)) return getLinkColor(link);
	if (isControlRelationship(link)) return GRAPH_COLORS.lineControlsHighlight;
	return getLinkColor(link);
}

function getCompactInactiveNodeLabel(node) {
	const preferredLabel = getPreferredNodeLabel(node);
	if (!preferredLabel) return '';
	const isNodeIdLabel = /^Node\s+/i.test(preferredLabel);
	if (node?.group === 'firm') {
		const clippedLabel = clipFirmLabelAtWord(preferredLabel, 26);
		return !isNodeIdLabel && isPlaceholderExpansionLabel(clippedLabel, node?.group) ? '' : clippedLabel;
	}
	const formattedLabel = formatNodeLabel(preferredLabel, node?.group);
	const compactLabel = truncate(formattedLabel, 18);
	return !isNodeIdLabel && isPlaceholderExpansionLabel(compactLabel, node?.group) ? '' : compactLabel;
}

function updateInactiveLabelZoomState(rootSelection, zoomScale, forceExpandedLabels = false) {
	if (!rootSelection) return;
	const compactInactive = !forceExpandedLabels && zoomScale < inactiveLabelCompactZoomThreshold;
	rootSelection.classed('fg-inactive-labels-compact', compactInactive);
	if (inactiveLabelCompactMode === compactInactive) return;
	inactiveLabelCompactMode = compactInactive;
	rootSelection.selectAll('.fg-label--inactive').text((node) => getNodeVisualLabelText(node));
}

function rerenderGraphNodesByIds(nodeIds) {
	if (!nodeSel) return;
	const ids = Array.isArray(nodeIds) ? nodeIds.filter(Boolean) : Array.from(nodeIds || []).filter(Boolean);
	if (!ids.length) return;
	const idSet = new Set(ids);
	renderNodeContents(nodeSel.filter((node) => idSet.has(node.id)));
}

export function getNodeLabelFontSize({
	isSelected = false,
	isHovered = false,
	isBolded = false,
	isEmphasized = false,
	zoomScale = getCurrentGraphZoomScale(),
}: { isSelected?: boolean; isHovered?: boolean; isBolded?: boolean; isEmphasized?: boolean; zoomScale?: number } = {}) {
	const normalizedScale = Math.max(0.08, Number(zoomScale) || 1);
	const zoomBoost = normalizedScale < 0.85 ? 1 + (0.85 - normalizedScale) * 0.4 : 1;
	const shouldEmphasize = isSelected || isHovered || isBolded || isEmphasized;
	const emphasisBoost =
		shouldEmphasize ?
			normalizedScale >= 1 ?
				1.12
			:	1.04
		:	1;
	const size = DEFAULT_NODE_LABEL_FONT_SIZE_PX * zoomBoost * emphasisBoost;
	return Math.min(24, Math.max(DEFAULT_NODE_LABEL_FONT_SIZE_PX, size));
}

export function getNodeTooltipTitle(node) {
	const parts = [];
	const label = getPreferredNodeLabel(node);
	if (label) parts.push(label);
	const group = node?.group?.toUpperCase?.() || '';
	if (group) parts.push(group);
	const crd = node?.crd || (node?.group === 'firm' ? node?.firmId : null) || (typeof node?.id === 'string' && node.id.startsWith('firm:') ? node.id.replace(/^firm:/, '') : null);
	if (crd) parts.push(`CRD: ${crd}`);
	return parts.join('\n');
}

export function renderNodeContents(selection) {
	if (!selection) return;
	selection.each(function (d) {
		const element =
			this instanceof Element ? this
			: selection && typeof selection.node === 'function' ? selection.node()
			: null;
		const g = d3.select<SVGGElement, unknown>(element as SVGGElement | null);
		g.selectAll<SVGGElement, unknown>('*').remove();

		const r = NODE_R[d.group] || 10;
		const inactive = isNodeInactive(d);
		const deg = d._deg || { total: 0, controls: 0, employed: 0 };
		const isControlNode = Boolean(deg.controls > 0);
		const compactMode = nodeLabelRenderMode === 'compact';
		g.classed('fg-node--inactive', inactive)
			.classed('fg-node--individual', d.group === 'individual')
			.classed('fg-node--firm', d.group === 'firm')
			.classed('fg-node--entity', d.group === 'entity')
			.classed('fg-node--stub', d.group === 'individual' && Boolean(d.stub))
			.classed('fg-node--control-position', isControlNode);
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
			if (!inactive && deg.controls > 0 && deg.employed > 0 && !compactMode) {
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
				.attr('class', 'fg-node-hit-area')
				.attr('points', hexPoints(s / 2))
				.attr('fill', 'transparent')
				.attr('stroke', 'none')
				.attr('pointer-events', 'all');

			if (!compactMode) {
				g.append('polygon')
					.attr('class', 'fg-node-overlay')
					.attr('points', hexPoints(s / 2));

				g.append('polygon')
					.attr('class', 'fg-node-selected-ring')
					.attr('points', hexPoints(s / 2 + 4))
					.attr('fill', 'none');
			}
		} else if (d.group === 'entity') {
			const s = r * 1.5;
			g.append('polygon')
				.attr('class', 'fg-node-shape fg-node-shape--entity')
				.attr('points', `0,${-s} ${s},0 0,${s} ${-s},0`)
				.attr('fill', null)
				.attr('stroke', null)
				.attr('stroke-width', null)
				.attr('opacity', null);
			g.append('polygon')
				.attr('class', 'fg-node-hit-area')
				.attr('points', `0,${-s} ${s},0 0,${s} ${-s},0`)
				.attr('fill', 'transparent')
				.attr('stroke', 'none')
				.attr('pointer-events', 'all');
			if (!compactMode) {
				g.append('polygon').attr('class', 'fg-node-overlay').attr('points', `0,${-s} ${s},0 0,${s} ${-s},0`);
				g.append('polygon')
					.attr('class', 'fg-node-selected-ring')
					.attr('points', `0,${-(s + 4)} ${s + 4},0 0,${s + 4} ${-(s + 4)},0`)
					.attr('fill', 'none');
			}
		} else {
			const rv = d._vizHalf != null ? d._vizHalf : r;
			g.append('circle')
				.attr('class', 'fg-node-shape fg-node-shape--circle')
				.attr('r', rv)
				.attr('fill', null)
				.attr('stroke', null)
				.attr('stroke-width', null)
				.attr('opacity', null);
			g.append('circle').attr('class', 'fg-node-hit-area').attr('r', rv).attr('fill', 'transparent').attr('stroke', 'none').attr('pointer-events', 'all');
			if (!compactMode) {
				g.append('circle').attr('class', 'fg-node-overlay').attr('r', rv);
				g.append('circle')
					.attr('class', 'fg-node-selected-ring')
					.attr('r', rv + 4)
					.attr('fill', 'none');
			}
		}

		if (!compactMode) {
			drawDisclosureIndicator(g, d, r);
		}

		const labelText = getNodeVisualLabelText(d);
		const labelY = (d._vizHalf != null ? d._vizHalf : r) + DEFAULT_NODE_LABEL_GAP_PX;

		// Check if this node is in the selection log (by id)
		const isLogged = isSelectionLogBold && selectedNodesLog.some((e) => e.id === d.id);
		const labelFontSize = `${getNodeLabelFontSize({
			isSelected: selectedId != null && String(selectedId) === String(d.id),
			isHovered: hoveredNodeId != null && String(hoveredNodeId) === String(d.id),
			isBolded: isLogged,
		})}px`;

		const label = g
			.append('text')
			.attr('class', `fg-label${inactive ? ' fg-label--inactive' : ''}${isLogged ? ' fg-label--logged' : ''}`)
			.attr('y', labelY)
			.attr('text-anchor', 'middle')
			.attr('dominant-baseline', 'hanging')
			.attr('font-size', labelFontSize)
			.attr('font-family', 'var(--sans)')
			.attr('font-weight', isLogged ? '700' : DEFAULT_NODE_LABEL_FONT_WEIGHT)
			.attr('fill', nodeLabelColor)
			.attr('stroke', nodeLabelHalo)
			.attr('stroke-width', 4)
			.attr('stroke-linejoin', 'round')
			.attr('paint-order', 'stroke')
			.attr('pointer-events', 'all')
			.style('cursor', 'pointer')
			.text(labelText);

		g.append('title').text(() => getNodeTooltipTitle(d));
	});
}

function isCurrentRegistration(d) {
	if (!d) return false;
	const rel = String(d.relationship || '').trim().toLowerCase();
	if (rel && rel !== 'employed_by' && rel !== 'registered_by') return false;
	if (d.isCurrent !== undefined) return Boolean(d.isCurrent);
	if (d.endDate !== undefined && d.endDate !== null && String(d.endDate).trim() !== '') return false;

	const src = typeof d.source === 'object' ? d.source : layoutNodes?.find((n) => n.id === d.source);
	if (!src || src.group !== 'individual') return false;

	const tgtId = String(typeof d.target === 'object' ? d.target.id : d.target).replace(/^firm:/, '').trim();
	if (!tgtId) return false;

	const currents = [...(src.currentEmployments || []), ...(src.currentIAEmployments || [])];
	if (currents.some((e) => String(e.firmId || e.firm_id || '').trim() === tgtId)) return true;

	const previous = [...(src.previousEmployments || []), ...(src.previousIAEmployments || [])];
	if (previous.some((e) => String(e.firmId || e.firm_id || '').trim() === tgtId)) return false;

	if (d.endDate === null || d.endDate === '') return true;

	return false;
}

function getLinkColor(d) {
	if (hasInactiveEndpoint(d) || isForcedGrayConnectionLink(d)) return GRAPH_COLORS.nodeInactiveStroke;
	if (isControlRelationship(d)) return GRAPH_COLORS.lineControls;
	if (isPreviousEmploymentLink(d)) return GRAPH_COLORS.nodeInactiveStroke;
	if (usesCurrentEmploymentStyling(d)) return GRAPH_COLORS.lineEmployedBy;
	return LINK_COLOR[d.relationship] || DEFAULT_LINK_COLOR;
}

function getLinkMarker(d) {
	return null;
}

function getLinkDash(d) {
	if (hasInactiveEndpoint(d) || isForcedGrayConnectionLink(d) || isPreviousEmploymentLink(d)) return '2 3';
	return null;
}

function getLinkWidth(d) {
	if (hasInactiveEndpoint(d) || isForcedGrayConnectionLink(d) || isPreviousEmploymentLink(d)) return '0.6px';
	return `${DEFAULT_LINK_WIDTH}px`;
}

function getLinkBaseWidth(d) {
	const width = getLinkWidth(d);
	const numericWidth = typeof width === 'number' ? width : parseFloat(String(width));
	if (Number.isFinite(numericWidth)) return numericWidth;
	return DEFAULT_LINK_WIDTH;
}

function getLinkZoomOutScale() {
	const zoom = Math.max(0.02, Number(getCurrentGraphZoomScale()) || 1);
	// Only thicken once zoomed out past the point where small labels hide, capped at 35% thicker.
	if (zoom >= activeLabelZoomThreshold) return 1;
	return Math.min(1.35, Math.max(1, activeLabelZoomThreshold / zoom));
}

function getScaledLinkStrokeWidth(baseWidth: number) {
	return baseWidth * getLinkZoomOutScale();
}

function getLinkWidthPx(d) {
	return `${getScaledLinkStrokeWidth(getLinkBaseWidth(d))}px`;
}

// When zoomed out far, thin/dim link colors (grays and low-opacity relationship lines)
// become nearly invisible against the dark background. Boost stroke-opacity toward 1 as
// the zoom scale drops below the point where nodes start getting visually tiny, so lines
// stay legible at a distance without changing their appearance at normal/close zoom.
const LINK_ZOOM_OUT_OPACITY_BOOST_THRESHOLD = 0.6;
function getLinkZoomOutOpacityScale() {
	const zoom = Math.max(0.02, Number(getCurrentGraphZoomScale()) || 1);
	if (zoom >= LINK_ZOOM_OUT_OPACITY_BOOST_THRESHOLD) return 1;
	// Linearly ramp the boost from 1x (at the threshold) up to ~2.2x at the minimum zoom.
	const t = 1 - zoom / LINK_ZOOM_OUT_OPACITY_BOOST_THRESHOLD;
	return 1 + t * 1.2;
}

function getScaledLinkStrokeOpacity(baseOpacity: number) {
	const boosted = baseOpacity * getLinkZoomOutOpacityScale();
	return Math.max(0, Math.min(1, boosted));
}

function refreshRenderedLinkStrokeWidthsForZoom() {
	if (!linkSel) return;
	const zoomScale = getLinkZoomOutScale();
	const opacityScale = getLinkZoomOutOpacityScale();
	linkSel.each(function (d) {
		const sel = d3.select(this);
		const storedBase = Number.parseFloat(String(sel.attr('data-fg-base-stroke-width') || ''));
		const baseWidth = Number.isFinite(storedBase) ? storedBase : getLinkBaseWidth(d);
		const storedBaseOpacity = Number.parseFloat(String(sel.attr('data-fg-base-stroke-opacity') || ''));
		const baseOpacity = Number.isFinite(storedBaseOpacity) ? storedBaseOpacity : Number(defaultLinkOpacity(d)) || 1;
		sel
			.attr('data-fg-base-stroke-width', String(baseWidth))
			.attr('stroke-width', baseWidth * zoomScale)
			.style('--fg-link-width', `${baseWidth * zoomScale}px`)
			.attr('data-fg-base-stroke-opacity', String(baseOpacity))
			.attr('stroke-opacity', Math.max(0, Math.min(1, baseOpacity * opacityScale)));
	});
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
	const degreeBias = Math.max(0, Math.min(1000, getNodeDegreeValue(node)));

	// The absolute active search match (the one with the pulse) gets top priority
	const activeFindId = activeFindMatchIndex >= 0 ? activeFindMatchOrder[activeFindMatchIndex] : null;
	if (node.id === activeFindId) return 20000 + degreeBias;

	// Other active search matches or explicitly focused nodes
	if (node.id === selectedId || activeFindMatchIds.has(node.id)) return 10000 + degreeBias;

	// Nodes on an explicit trace get top priority
	if (isNodeOnAnyTrace(node.id)) return 4000 + degreeBias;

	// Nodes that have been explicitly selected (visited selections)
	// should render above ordinary nodes so their labels and connecting lines are visible.
	if (visitedNodeIds.has(node.id)) return 3000 + degreeBias;

	// Highlight roots/hop nodes (from trace/highlight state) also get high priority
	if (highlightState?.rootIds?.has(node.id) || highlightState?.hopNodeIds?.has(node.id)) return 3000 + degreeBias;
	if (isNodeInactive(node)) return 1000 + degreeBias;
	return 2000 + degreeBias;
}

function getLinkRenderPriority(link, highlightState) {
	if (!link) return 1;
	const linkKey = getLinkKey(link);
	// If either endpoint is inactive, demote the link to the lowest layer
	if (hasInactiveEndpoint(link)) return 0;

	// If the link connects to any node that is on an explicit trace, keep it very high
	if (isLinkOnAnyTrace(linkKey)) return 3;

	// If the link is part of the current highlight set, place above normal links
	if (highlightState?.linkKeys?.has(linkKey)) return 2;

	// Promote links that touch very-high-priority nodes (largest/selected/highlighted)
	try {
		const src = typeof link.source === 'object' ? link.source : layoutNodes?.find((n) => n.id === link.source);
		const tgt = typeof link.target === 'object' ? link.target : layoutNodes?.find((n) => n.id === link.target);
		const srcPriority = getNodeRenderPriority(src, highlightState);
		const tgtPriority = getNodeRenderPriority(tgt, highlightState);
		const maxNodePriority = Math.max(srcPriority || 0, tgtPriority || 0);
		// Any link connected to nodes with priority >= 3000 (highlight/root) should be on top of ordinary links
		if (maxNodePriority >= 3000) return 4;
	} catch (e) {
		// ignore and fall back to default
	}

	return 1;
}

function comparePriorityWithTieBreak(aPriority, bPriority, aTieBreak, bTieBreak) {
	if (aPriority !== bPriority) return aPriority - bPriority;
	return String(aTieBreak || '').localeCompare(String(bTieBreak || ''));
}

function getLinkDataKey(link) {
	const sourceId = link?.source?.id ?? link?.source;
	const targetId = link?.target?.id ?? link?.target;
	return `${sourceId}-${targetId}-${link?.relationship}`;
}

function selectRenderedLinkLines() {
	if (rootGroup) return rootGroup.selectAll('.fg-links-bottom line, .fg-links-mid line, .fg-links-top line');
	if (linkGroup) return linkGroup.selectAll('line');
	return null;
}

function selectRenderedArrowLines() {
	if (rootGroup) return rootGroup.selectAll('.fg-arrowheads-bottom line, .fg-arrowheads-mid line, .fg-arrowheads-top line');
	if (arrowGroup) return arrowGroup.selectAll('line');
	return null;
}

function joinLayeredLinkGroup(groupSel, data, enterDuration = 0) {
	if (!groupSel) return null;
	const bound = groupSel.selectAll('line').data(data, (d) => getLinkDataKey(d));
	bound.exit().remove();
	const entered = bound
		.enter()
		.append('line')
		.attr('class', 'fg-link')
		.attr('stroke-opacity', 0)
		// Set the real endpoint positions immediately so newly (re-)entered lines (e.g. when a
		// link is reassigned to a different render-priority layer, which forces a fresh DOM
		// enter()) never briefly render at the default (0,0) origin and visibly slide in from
		// the top-left corner before the next simulation tick repositions them.
		.attr('x1', (d) => (Number.isFinite(d.source?.x) ? d.source.x : 0))
		.attr('y1', (d) => (Number.isFinite(d.source?.y) ? d.source.y : 0))
		.attr('x2', (d) => (Number.isFinite(d.target?.x) ? d.target.x : 0))
		.attr('y2', (d) => (Number.isFinite(d.target?.y) ? d.target.y : 0));
	const merged = entered.merge(bound);
	merged
		.attr('class', 'fg-link')
		.attr('stroke', (d) => getLinkColor(d))
		.attr('data-fg-base-stroke-width', (d) => String(getLinkBaseWidth(d)))
		.attr('stroke-width', (d) => getScaledLinkStrokeWidth(getLinkBaseWidth(d)))
		.style('--fg-link-width', (d) => getLinkWidthPx(d))
		.attr('stroke-dasharray', (d) => getLinkDash(d));
	if (enterDuration > 0)
		entered
			.transition()
			.duration(enterDuration)
			.attr('stroke-opacity', (d) => getScaledLinkStrokeOpacity(defaultLinkOpacity(d)));
	else entered.attr('stroke-opacity', (d) => getScaledLinkStrokeOpacity(defaultLinkOpacity(d)));
	merged.attr('data-fg-base-stroke-opacity', (d) => String(defaultLinkOpacity(d))).attr('stroke-opacity', (d) => getScaledLinkStrokeOpacity(defaultLinkOpacity(d)));
	return merged;
}

function joinLayeredArrowGroup(groupSel, data) {
	if (!groupSel) return null;
	const bound = groupSel.selectAll('line').data(data, (d) => getLinkDataKey(d));
	bound.exit().remove();
	const entered = bound.enter().append('line').attr('stroke', 'none').attr('fill', 'none');
	const merged = entered.merge(bound);
	merged.attr('stroke', 'none').attr('fill', 'none');
	return merged;
}

function refreshLayeredLinkSelections({ enterDuration = 0, highlightState = computeHighlightState() }: { enterDuration?: number; highlightState?: any } = {}) {
	if (!layoutLinks) return;
	if (!(linkBottomGroup && linkMidGroup && linkTopGroup && arrowBottomGroup && arrowMidGroup && arrowTopGroup)) {
		linkSel = selectRenderedLinkLines();
		arrowSel = selectRenderedArrowLines();
		return;
	}

	const bottomLinks = [];
	const midLinks = [];
	const topLinks = [];
	for (const link of layoutLinks) {
		const priority = getLinkRenderPriority(link, highlightState);
		if (priority <= 0) bottomLinks.push(link);
		else if (priority >= 3) topLinks.push(link);
		else midLinks.push(link);
	}

	joinLayeredLinkGroup(linkBottomGroup, bottomLinks, enterDuration);
	joinLayeredLinkGroup(linkMidGroup, midLinks, enterDuration);
	joinLayeredLinkGroup(linkTopGroup, topLinks, enterDuration);
	joinLayeredArrowGroup(arrowBottomGroup, bottomLinks);
	joinLayeredArrowGroup(arrowMidGroup, midLinks);
	joinLayeredArrowGroup(arrowTopGroup, topLinks);

	linkSel = selectRenderedLinkLines();
	arrowSel = selectRenderedArrowLines();
	orderGraphVisualLayers(highlightState);
}

function orderGraphVisualLayers(highlightState = computeHighlightState()) {
	const rootNode = rootGroup?.node?.();
	if (!rootNode || !rootNode.isConnected || !rootNode.parentNode) return;

	if (linkSel && typeof linkSel.sort === 'function') {
		linkSel.sort((a, b) => comparePriorityWithTieBreak(getLinkRenderPriority(a, highlightState), getLinkRenderPriority(b, highlightState), getLinkKey(a), getLinkKey(b)));
	}

	if (arrowSel && typeof arrowSel.sort === 'function') {
		arrowSel.sort((a, b) => comparePriorityWithTieBreak(getLinkRenderPriority(a, highlightState), getLinkRenderPriority(b, highlightState), getLinkKey(a), getLinkKey(b)));
	}

	if (nodeSel && typeof nodeSel.sort === 'function') {
		nodeSel.sort((a, b) => comparePriorityWithTieBreak(getNodeRenderPriority(a, highlightState), getNodeRenderPriority(b, highlightState), a?.id, b?.id));
	}

	// Move individual link/arrow DOM nodes between link sub-groups so some links
	// can render above or below the main node group (provides 2.5D depth).
	try {
		if (linkGroup && linkBottomGroup && linkMidGroup && linkTopGroup && linkSel) {
			const bottomNode = linkBottomGroup.node();
			const midNode = linkMidGroup.node();
			const topNode = linkTopGroup.node();
			linkSel.each(function (d) {
				const pr = getLinkRenderPriority(d, highlightState);
				const el = this as any;
				if (pr <= 0) {
					if (el.parentNode !== bottomNode) bottomNode.appendChild(el);
				} else if (pr >= 3) {
					if (el.parentNode !== topNode) topNode.appendChild(el);
				} else {
					if (el.parentNode !== midNode) midNode.appendChild(el);
				}
			});
		}
		if (arrowGroup && arrowBottomGroup && arrowMidGroup && arrowTopGroup && arrowSel) {
			const bottomNode = arrowBottomGroup.node();
			const midNode = arrowMidGroup.node();
			const topNode = arrowTopGroup.node();
			arrowSel.each(function (d) {
				const pr = getLinkRenderPriority(d, highlightState);
				const el = this as any;
				if (pr <= 0) {
					if (el.parentNode !== bottomNode) bottomNode.appendChild(el);
				} else if (pr >= 3) {
					if (el.parentNode !== topNode) topNode.appendChild(el);
				} else {
					if (el.parentNode !== midNode) midNode.appendChild(el);
				}
			});
		}
	} catch (e) {
		// Non-fatal — DOM move failures should not break rendering
	}

	// Ensure linkTopGroup and arrowTopGroup are always placed below nodeGroup
	// so that lines are always beneath the nodes.
	try {
		if (nodeGroup && nodeGroup.node()) {
			const nodesEl = nodeGroup.node();
			const parent = nodesEl.parentNode;
			if (parent) {
				const topGroups = [];
				if (linkTopGroup && linkTopGroup.node()) topGroups.push(linkTopGroup.node());
				if (arrowTopGroup && arrowTopGroup.node()) topGroups.push(arrowTopGroup.node());
				for (const tg of topGroups) {
					if (tg.parentNode === parent && tg === nodesEl.previousSibling) continue;
					parent.insertBefore(tg, nodesEl);
				}
			}
		}
	} catch (e) {
		// Ignore DOM manipulation errors — non-fatal
	}

	// Expose a debug-friendly render order map for E2E tests and dev inspection.
	try {
		const nodeRender = [];
		if (nodeSel) {
			nodeSel.each(function (d) {
				try {
					const pr = getNodeRenderPriority(d, highlightState);
					const layer =
						pr >= 3000 ? 'top'
						: pr <= 1000 ? 'bottom'
						: 'mid';
					nodeRender.push({ id: d.id, priority: pr, layer });
				} catch (e) {
					/* ignore per-node errors */
				}
			});
		}

		const linkRender = [];
		if (linkSel) {
			linkSel.each(function (d) {
				try {
					const pr = getLinkRenderPriority(d, highlightState);
					const layer =
						pr >= 3 ? 'top'
						: pr <= 0 ? 'bottom'
						: 'mid';
					const key = `${d.source?.id || d.source}-${d.target?.id || d.target}-${d.relationship}`;
					linkRender.push({ key, priority: pr, layer });
				} catch (e) {
					/* ignore */
				}
			});
		}

		(window as any).__FG_RENDER_ORDER = { nodes: nodeRender, links: linkRender, timestamp: Date.now() };
	} catch (e) {
		/* ignore debug exposure errors */
	}
}

function reapplySelectionState() {
	if (!nodeSel) return;
	const highlightState = computeHighlightState();
	const activeConnectedIds = new Set<string>();
	(layoutLinks || []).forEach((link) => {
		if (!isCurrentActiveConnection(link)) return;
		const sId = String(link.source?.id ?? link.source);
		const tId = String(link.target?.id ?? link.target);
		activeConnectedIds.add(sId);
		activeConnectedIds.add(tId);
	});

	const activeParentConnectedIds = new Set<string>();
	const hasHighlights = highlightState.rootIds.size > 0;
	if (hasHighlights) {
		(layoutLinks || []).forEach((link) => {
			if (!isCurrentActiveConnection(link)) return;
			const sId = String(link.source?.id ?? link.source);
			const tId = String(link.target?.id ?? link.target);
			const sRoot = highlightState.rootIds.has(sId);
			const tRoot = highlightState.rootIds.has(tId);
			if (sRoot && !tRoot) {
				activeParentConnectedIds.add(tId);
			} else if (tRoot && !sRoot) {
				activeParentConnectedIds.add(sId);
			}
		});
	}

	nodeSel
		.classed('selected', (node) =>
			shouldRenderNodeSelected(node, {
				selectedId,
				highlightRootIds: highlightState.rootIds,
				persistentSelectedIds,
				visitedNodeIds,
				isFetchedLeafNode: (candidateNode) => isFetchedLeafNode(candidateNode),
				isFetchedExhaustedConnectedNode: (candidateNode) => isFetchedExhaustedConnectedNode(candidateNode),
			}),
		)
		// Hop emphasis (neighbor glow) is line-highlight companion state — cleared with Clear Highlight.
		.classed(
			'highlighted-hop',
			(node) => node.id !== selectedId && !highlightState.rootIds.has(node.id) && !persistentSelectedIds.has(node.id) && highlightState.hopNodeIds.has(node.id),
		);

	if (svgSel) {
		svgSel.classed('fg-svg--has-highlights', hasHighlights);
	}

	nodeSel
		.classed('fg-node--active-connected', (d) => activeConnectedIds.has(String(d.id)))
		.classed('fg-node--active-parent-connected', (d) => activeParentConnectedIds.has(String(d.id)));

	const isOnShortestTrace = (id: string) => traceShortestIds.has(id) || traceShortestConnectorIds.has(id);
	const isOnLongestTrace = (id: string) => traceLongestIds.has(id) || traceLongestConnectorIds.has(id);
	const isOnLogTrace = (id: string) => traceLogIds.has(id) || traceLogConnectorIds.has(id);
	const selectionLogLabelNodeIds = new Set(getSelectionLogLabelNodeIds());

	nodeSel
		.classed('fg-node--selection-log-label', (d) => selectionLogLabelNodeIds.has(d.id))
		.classed('fg-node--label-cleared', (d) => clearedSelectionLogLabelNodeIds.has(d.id))
		.classed('fg-node--find-match', (d) => activeFindMatchIds.has(d.id))
		.classed('fg-node--find-match-active', (d) => activeFindMatchIndex >= 0 && d.id === activeFindMatchOrder[activeFindMatchIndex])
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
	updateNodeVisuals(nodeSel, { highlightState, activeConnectedIds, activeParentConnectedIds, selectionLogLabelNodeIds });
}

export function shouldRenderNodeSelected(
	node,
	options: {
		selectedId?: string | null;
		highlightRootIds?: Set<any>;
		persistentSelectedIds?: Set<any> | Iterable<any>;
		visitedNodeIds?: Set<any>;
		isFetchedLeafNode?: (node: any) => boolean;
		isFetchedExhaustedConnectedNode?: (node: any) => boolean;
	} = {},
) {
	if (!node?.id) return false;
	const {
		selectedId: candidateSelectedId = null,
		highlightRootIds = new Set<any>(),
		persistentSelectedIds: durableSelectedIds = new Set<any>(),
		// visitedNodeIds intentionally unused for selected chrome — visiting during expand
		// must not paint every walked node as "selected" (that looked like multi-hop selection).
		visitedNodeIds: _visitedIds = new Set<any>(),
		isFetchedLeafNode: isFetchedLeafNodeFn = () => false,
		isFetchedExhaustedConnectedNode: isFetchedExhaustedConnectedNodeFn = () => false,
	} = options;

	const durableSet =
		durableSelectedIds instanceof Set ? durableSelectedIds : (
			new Set(
				Array.from(durableSelectedIds || [])
					.map((id) => String(id || '').trim())
					.filter(Boolean),
			)
		);

	// Active selection + every node the user has already selected/expanded stays selected.
	// Clear Highlight does not remove durableSelectedIds — only hop/line emphasis.
	// Hop neighbors use `highlighted-hop`; exhausted leaves keep the fetched-leaf markers.
	return node.id === candidateSelectedId || highlightRootIds.has(node.id) || durableSet.has(node.id) || isFetchedLeafNodeFn(node) || isFetchedExhaustedConnectedNodeFn(node);
}

function markNodeSelected(node, options: { persist?: boolean } = {}) {
	if (!node?.id) return;
	const { persist = true } = options;
	// Keep prior highlight roots; add this node + its direct neighbors.
	upsertHighlightedSelection(node.id, 1, { replace: false });
	selectedId = node.id;
	visitedNodeIds.add(node.id);
	refreshTraceState();
	if (!persist) return;
	try {
		saveSession();
	} catch (e) {
		/* ignore */
	}
}

function getNodeVisualLabelText(node) {
	const isFocused = node.id === selectedId || activeFindMatchIds.has(node.id) || (Array.isArray(highlightedSelections) && highlightedSelections.some((h) => h.id === node.id));

	return isNodeInactive(node) && inactiveLabelCompactMode && !isFocused ? getCompactInactiveNodeLabel(node) : getRenderedNodeLabel(node, { skipTruncation: isFocused });
}

function updateNodeVisuals(
	selection,
	options: {
		highlightState?: any;
		activeConnectedIds?: Set<string>;
		activeParentConnectedIds?: Set<string>;
		selectionLogLabelNodeIds?: Set<string>;
	} = {},
) {
	if (!selection) return;
	const highlightState = options.highlightState ?? computeHighlightState();
	const activeConnectedIds = options.activeConnectedIds ?? new Set<string>();
	const activeParentConnectedIds = options.activeParentConnectedIds ?? new Set<string>();
	const selectionLogLabelNodeIds = options.selectionLogLabelNodeIds ?? new Set(getSelectionLogLabelNodeIds());

	selection.each(function (d) {
		const g = d3.select(this);
		const inactive = isNodeInactive(d);
		const deg = d._deg || { total: 0, controls: 0, employed: 0 };
		const isControlNode = deg.controls > 0;
		const isSelectedNode = selectedId != null && String(selectedId) === String(d.id);
		const isHoveredNode = hoveredNodeId != null && String(hoveredNodeId) === String(d.id);
		const isFindMatchNode = activeFindMatchIds.has(d.id);
		const isHighlightRootNode = highlightState.rootIds.has(d.id);
		const isHighlightHopNode = highlightState.hopNodeIds.has(d.id);
		const isActiveParentConnectedNode = activeParentConnectedIds.has(String(d.id));
		const isLogged = isSelectionLogBold && selectedNodesLog.some((entry) => entry.id === d.id);
		const isEmphasized = isSelectedNode || isHoveredNode || isLogged || isFindMatchNode || isHighlightRootNode || isHighlightHopNode || isActiveParentConnectedNode;

		g.classed('fg-node--inactive', inactive)
			.classed('fg-node--individual', d.group === 'individual')
			.classed('fg-node--firm', d.group === 'firm')
			.classed('fg-node--entity', d.group === 'entity')
			.classed('fg-node--stub', d.group === 'individual' && Boolean(d.stub))
			.classed('fg-node--control-position', isControlNode);

		let color = inactive ? GRAPH_COLORS.nodeInactive : NODE_COLOR[d.group] || GRAPH_COLORS.nodeDefault;

		if (isControlNode && !inactive) {
			color = GRAPH_COLORS.nodeControls;
		}
		let nodeOpacity: number | string = inactive ? 0.82 : 1;
		let nodeStroke = inactive ? GRAPH_COLORS.nodeInactiveStroke : GRAPH_COLORS.nodeBorder;
		let nodeLabelColor = inactive ? GRAPH_COLORS.nodeInactiveLabel : GRAPH_COLORS.nodeLabel;
		let nodeLabelHalo = inactive ? 'rgba(248,250,252,0.95)' : GRAPH_COLORS.nodeLabelHalo;

		if (d.group === 'individual' && d.stub && !(isControlNode && !inactive)) {
			color = inactive ? GRAPH_COLORS.nodeInactive : GRAPH_COLORS.nodeStub;
			nodeOpacity = inactive ? 0.72 : NODE_OPACITY_STUB;
		}

		if (d.group === 'firm') {
			const r = NODE_R[d.group] || 10;
			const s = (d._vizHalf ?? r * 0.85) * 2;
			const deg = d._deg || { total: 0, controls: 0, employed: 0 };
			const hasConnections = deg.total > 0;
			const dominantStroke =
				inactive ? GRAPH_COLORS.nodeInactiveStroke
				: deg.controls > deg.employed ? GRAPH_COLORS.nodeFirmControlsStroke
				: deg.employed > deg.controls ? GRAPH_COLORS.nodeFirmEmployedStroke
				: GRAPH_COLORS.nodeBorder;

			const firmShape = g.select('.fg-node-shape--firm');
			if (!firmShape.empty()) {
				firmShape
					.attr('fill', color)
					.attr('stroke', dominantStroke)
					.attr('opacity', nodeOpacity === 1 ? 0.9 : nodeOpacity)
					.classed('fg-node-shape--firm-connected', hasConnections)
					.classed('fg-node-shape--firm-employed', deg.employed > deg.controls)
					.classed('fg-node-shape--firm-controls', deg.controls > deg.employed);
			}
		} else if (d.group === 'entity') {
			const shape = g.select('.fg-node-shape--entity');
			if (!shape.empty()) {
				shape.attr('fill', color).attr('stroke', nodeStroke).attr('opacity', nodeOpacity);
			}
		} else {
			const shape = g.select('.fg-node-shape--circle');
			if (!shape.empty()) {
				shape.attr('fill', color).attr('stroke', nodeStroke).attr('opacity', nodeOpacity);
			}
		}

		const labelText = getNodeVisualLabelText(d);
		const label = g.select('text.fg-label');
		if (!label.empty()) {
			const labelFontSize = `${getNodeLabelFontSize({
				isSelected: isSelectedNode,
				isHovered: isHoveredNode,
				isBolded: isLogged,
				isEmphasized,
			})}px`;
			label
				.text(labelText)
				.attr('fill', nodeLabelColor)
				.attr('stroke', nodeLabelHalo)
				.attr('opacity', inactive ? 0.86 : 1)
				.attr('font-size', labelFontSize)
				.attr('font-weight', isEmphasized ? '700' : DEFAULT_NODE_LABEL_FONT_WEIGHT);
		}
	});
}

// Refreshes colors for all nodes dynamically to ensure nodes and links correctly reflect state
function refreshGraphColors() {
	if (!nodeSel || !layoutLinks || !linkSel) return;

	updateNodeVisuals(nodeSel);

	linkSel.attr('stroke', (d) => getLinkColor(d)).attr('stroke-dasharray', (d) => getLinkDash(d));

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

function scheduleSidecarFirmLabelHydration(nodes) {
	const placeholders = (Array.isArray(nodes) ? nodes : []).filter((node) => node?.group === 'firm' && isGenericOrPlaceholderLabel(node.label, 'firm'));
	if (!placeholders.length) return;
	const ids = Array.from(
		new Set(
			placeholders
				.map((node) =>
					String(node.firmId || node.id || '')
						.replace(/^firm:/i, '')
						.trim(),
				)
				.filter(Boolean),
		),
	);
	if (!ids.length) return;
	void (async () => {
		try {
			const res = await fetch(`${BASE}/api/finra/search?type=firm&query=${encodeURIComponent(ids.join(' '))}&nrows=${Math.min(Math.max(ids.length, 12), 200)}`);
			if (!res.ok) return;
			const payload = await res.json();
			const docs = Array.isArray(payload?.results) ? payload.results : Array.isArray(payload?.response?.docs) ? payload.response.docs : [];
			const names = new Map();
			for (const doc of docs) {
				const id = String(doc?.firm_id || doc?.firmId || doc?.firm_source_id || '').trim();
				const name = String(doc?.firm_name || doc?.firmName || doc?.name || doc?.label || '').trim();
				if (id && name && !isGenericOrPlaceholderLabel(name, 'firm')) names.set(id, name);
			}
			if (!names.size) return;
			const applyName = (node) => {
				if (!node || node.group !== 'firm') return false;
				const id = String(node.firmId || node.id || '')
					.replace(/^firm:/i, '')
					.trim();
				const name = names.get(id);
				if (!name || !isGenericOrPlaceholderLabel(node.label, 'firm')) return false;
				node.label = name;
				node.firmName = name;
				if (!node.basicInformation) node.basicInformation = {};
				node.basicInformation.firmName = name;
				normalizeNodeLabelInPlace(node);
				return true;
			};
			const changedIds = [];
			for (const node of placeholders) {
				if (applyName(node)) changedIds.push(node.id);
			}
			for (const node of graphData?.nodes || []) {
				applyName(node);
			}
			if (!changedIds.length) return;
			rerenderGraphNodesByIds(changedIds);
			try {
				saveSession();
			} catch {
				/* ignore */
			}
		} catch {
			/* ignore sidecar label hydration failures */
		}
	})();
}

function appendFetchedImpl(newNodes, newLinks) {
	if (!Array.isArray(newNodes)) newNodes = [];
	if (!Array.isArray(newLinks)) newLinks = [];
	if (!layoutNodes || !layoutLinks) {
		if (graphData && Array.isArray(newNodes) && Array.isArray(newLinks)) {
			mergeIntoGraphData(newNodes, newLinks);
			scheduleSidecarFirmLabelHydration(graphData.nodes);
		}
		return;
	}
	normalizeNodeLabelsInPlace(newNodes);

	const mergeResult = mergeIncomingNodesIntoExistingNodes(layoutNodes, newNodes);
	const mergedNodes = mergeResult.nodes;
	const uniqNodes = mergedNodes.filter((node) => !layoutNodes.some((entry) => entry?.id === node?.id));
	const incomingNodeIdRewrites = mergeResult.idRewriteMap;
	const revealableIncomingLinks = Array.isArray(newLinks) ? newLinks.filter((link) => isAutoExpansionLink(link) || isPreviousEmploymentLink(link)) : [];
	const rewrittenLinks = rewriteLinksForNodeIdMap(revealableIncomingLinks, incomingNodeIdRewrites);

	// Place newly-added nodes near the expand origin (parent node) if known,
	// otherwise fall back to the viewport center so they're visible immediately.
	if (uniqNodes.length > 0) {
		const main = document.getElementById('fg-main');
		const W = main?.clientWidth || 800;
		const H = main?.clientHeight || 600;
		const originX = lastExpandOriginNode && Number.isFinite(lastExpandOriginNode.x) ? lastExpandOriginNode.x : W / 2;
		const originY = lastExpandOriginNode && Number.isFinite(lastExpandOriginNode.y) ? lastExpandOriginNode.y : H / 2;
		uniqNodes.forEach((n, idx) => {
			if (n.x == null && n.y == null) {
				const ringRadius = Math.max(34, 42 + idx * 12);
				const angle = (idx / uniqNodes.length) * Math.PI * 2;
				n.x = originX + Math.cos(angle) * ringRadius;
				n.y = originY + Math.sin(angle) * ringRadius;
			}
		});
	}

	layoutNodes = mergedNodes;
	scheduleSidecarFirmLabelHydration(mergedNodes);
	// Rebind any pre-existing links to the merged node objects so the visualization
	// keeps them attached after a fetch updates the node list.
	resolveLinkEndpoints(layoutLinks, layoutNodes);
	const resolvedNewLinks = resolveLinkEndpoints(rewrittenLinks, layoutNodes);
	const currentLayoutNodeIds = new Set(layoutNodes.map((n) => n.id));
	layoutLinks.push(
		...resolvedNewLinks.filter((l) => {
			const s = l.source?.id ?? l.source;
			const t = l.target?.id ?? l.target;
			// only include link if both nodes are currently rendered
			if (!currentLayoutNodeIds.has(s) || !currentLayoutNodeIds.has(t)) return false;
			// avoid duplicate link
			return !layoutLinks.some(
				(el) =>
					getLinkIdentityKey(el) === getLinkIdentityKey({ source: s, target: t, relationship: l.relationship, isCurrent: l.isCurrent, startDate: l.startDate, endDate: l.endDate }),
			);
		}),
	);
	applyGraphDerivedNodeMetrics(layoutNodes, layoutLinks);
	setGraphLabelRenderMode(layoutNodes.length);

	// Rebuild neighbor cache and update info
	neighborMap = buildNeighborMap(layoutNodes, layoutLinks);
	if (layoutNodes.length || layoutLinks.length) showEmpty(false);
	if (graphData) updateSubsetInfo(layoutNodes.length, graphData.nodes.length);
	updateMeta();

	// Persist session so reload restores these nodes
	saveSession();

	refreshLayeredLinkSelections({ enterDuration: 400 });

	if (!nodeGroup || !linkGroup || !simulation) {
		if (graphData) updateSubsetInfo(layoutNodes.length, graphData.nodes.length);
		refreshGraphColors();
		if (activeFindQuery) refreshFindMatches(activeFindQuery, { preserveActiveMatch: true });
		refreshTraceState();
		return;
	}

	const allNodes = nodeGroup.selectAll('g.fg-node').data(layoutNodes, (d) => d.id);
	const enteredNodes = allNodes.enter().append('g').attr('class', 'fg-node').attr('opacity', 0).call(fluidDrag()).on('click', handleNodeOpen).call(bindHoverAndFocus);

	// Apply initial transform so new nodes appear at their placed position
	// immediately (the renderGraph tick handler only covers old nodes).
	enteredNodes.attr('transform', (d) => `translate(${Number.isFinite(d.x) ? d.x : 0},${Number.isFinite(d.y) ? d.y : 0})`);

	enteredNodes.transition().duration(520).ease(d3.easeCubicOut).attr('opacity', 1);
	nodeSel = nodeGroup.selectAll('g.fg-node');
	linkSel = selectRenderedLinkLines();
	const impactedIds = getImpactedNodeIds(uniqNodes, newLinks);
	rerenderGraphNodesByIds(impactedIds);
	reapplySelectionState();

	refreshGraphColors();
	if (activeFindQuery) refreshFindMatches(activeFindQuery, { preserveActiveMatch: true });
	refreshTraceState();

	// If the current selection was impacted by newly appended nodes/links,
	// re-render the sidebar so any newly-merged detail (owners/children)
	// appears without requiring a full page refresh.
	try {
		if (selectedId && Array.isArray(impactedIds) && impactedIds.includes(selectedId)) {
			const selectedNode = layoutNodes?.find((node) => node.id === selectedId) || graphData?.nodes?.find((node) => node.id === selectedId);
			if (selectedNode) renderSidebar(selectedNode);
		}
	} catch (e) {
		/* ignore sidebar refresh errors */
	}

	// Replace tick handler so it covers the full updated selections.
	bindSimulationTickHandler(simulation, () => {
		scheduleGraphTickPositions(linkSel, nodeSel, arrowSel);
	});

	// Restart simulation with new nodes/links
	refreshSoftLocationGroupingForces(layoutNodes);
	simulation.nodes(layoutNodes);
	simulation.force('link').links(layoutLinks);
	simulation.force('collision').radius((d) => getNodeCollisionRadius(d, layoutNodes.length));
	simulation.alpha(getIncrementalRestartAlpha(layoutNodes.length, uniqNodes.length)).restart();
}

function renderGraph(_data) {
	let data = _data;
	invalidateFullAdjacencyMap();
	if (simulation) simulation.stop();
	cancelGraphTickPositions();
	if (spreadAnimId) {
		cancelAnimationFrame(spreadAnimId);
		spreadAnimId = null;
	}
	if (spreadReleaseTimer) {
		clearTimeout(spreadReleaseTimer);
		spreadReleaseTimer = null;
	}
	if (nodePinReleaseTimer) {
		clearTimeout(nodePinReleaseTimer);
		nodePinReleaseTimer = null;
	}
	if (activeSpreadFrozenNodes.length) {
		releaseFrozenNodes(activeSpreadFrozenNodes);
		activeSpreadFrozenNodes = [];
	}
	const svg = d3.select('#fg-svg');
	svg.selectAll('*').remove();

	const main = document.getElementById('fg-main');
	const W = main.clientWidth;
	const H = main.clientHeight;

	svg.attr('viewBox', `0 0 ${W} ${H}`);

	// Deep-copy so D3 mutation doesn't corrupt the original
	const nodes: GraphSimulationNode[] = data.nodes.map((n) => ({ ...n }) as GraphSimulationNode);
	const nodeIdSet = new Set(nodes.map((n) => n.id));
	const allLinks: GraphSimulationLink[] = data.links.map((l) => ({ ...l }) as GraphSimulationLink);
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
	const resolvedLinks = resolveLinkEndpoints(links, nodes);
	layoutLinks = resolvedLinks;
	// Async-resolve any orphaned link endpoints so they appear once fetched
	if (orphanLinks.length) fetchAndInjectOrphanNodes(orphanLinks, nodeIdSet);

	// ── Per-node degree stats for scaled / tinted nodes ──────────────────────
	applyGraphDerivedNodeMetrics(nodes, links);
	applySoftLocationGroupingTargets(nodes, W, H);

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
	setGraphLabelRenderMode(nodeCount);

	// The graph permanently uses the SVG DOM renderer so direct-route loads and
	// large graphs share the same rendering path without switching modes.
	canvasModeActive = false;
	pixiModeActive = true;
	try {
		if (pixiApi && pixiApi.destroy) pixiApi.destroy();
		if (canvasApi && canvasApi.destroy) canvasApi.destroy();
		if (overlayApi && overlayApi.destroy) overlayApi.destroy();
	} catch (e) {}
	pixiApi = null;
	canvasApi = null;
	overlayApi = null;

	// ── Zoom ──────────────────────────────────────────────────────────────────
	// LOD threshold: hide labels when zoomed out (less DOM paint, higher props)
	const labelZoomThreshold =
		isHuge ? 0.9
		: isLarge ? 0.7
		: 0.5;
	activeLabelZoomThreshold = labelZoomThreshold;
	inactiveLabelCompactZoomThreshold = labelZoomThreshold * 1.35;
	inactiveLabelCompactMode = initialScaleForCompactState(nodeCount) < inactiveLabelCompactZoomThreshold;

	function initialScaleForCompactState(count) {
		return count > 1000 ? 0.18 : 0.25;
	}

	function updateTraceStrokeScale(scale: number) {
		const minZoom = 0.15;
		const clampedZoom = Math.max(minZoom, Math.min(1, Number(scale) || 1));
		const normalized = (clampedZoom - minZoom) / (1 - minZoom);
		const gentleScale = 1.2 - normalized * 0.2;
		svg.style('--fg-trace-stroke-scale', String(gentleScale));
	}

	function updateInactiveLinkScale(_scale: number) {
		svg.style('--fg-inactive-link-scale', '1');
	}

	const zoom = d3
		.zoom()
		// Prevent zooming out too far — keep minimum consistent with label/trace thresholds
		.scaleExtent([0.15, 2.6])
		.on('zoom', (event) => {
			root.attr('transform', event.transform);
			updateTraceStrokeScale(event.transform.k);
			updateInactiveLinkScale(event.transform.k);
			refreshRenderedLinkStrokeWidthsForZoom();
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
	// Scale choices: small=1, medium≈0.8, large≈0.25, huge≈0.25
	const initialScale =
		isHuge ? 0.75
		: isLarge ? 0.55
		: 0.25;
	updateTraceStrokeScale(initialScale);
	updateInactiveLinkScale(initialScale);
	try {
		// Use immediate transition to set scale centered on the viewport
		const svgSelection = d3.select<SVGSVGElement, unknown>(svg.node() as SVGSVGElement | null);
		svgSelection.call(zoom.scaleTo, initialScale);
	} catch (e) {
		/* ignore if zoom API not available */
	}

	const root = svg.append('g').attr('class', 'fg-root');
	svg.classed('fg-huge-graph', isHuge);
	rootGroup = root;

	// Use root as the logical parent for link selections (individual layered groups exist separately)
	linkGroup = root;
	arrowGroup = root;
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
				: rel === 'inactive' ? GRAPH_COLORS.nodeInactiveStroke
				: rel === 'previous_employed_by' ? GRAPH_COLORS.nodeInactiveStroke
				: GRAPH_COLORS.lineEmployedBy,
			);
	});

	// ── Force simulation ──────────────────────────────────────────────────────
	// Scale simulation aggressiveness with graph size so large graphs converge faster
	const centeringStrength =
		isHuge ? 0.004
		: isLarge ? 0.006
		: 0.01;
	simulation = d3
		.forceSimulation<GraphSimulationNode>(nodes)
		.alphaDecay(
			isHuge ? 0.06
			: isLarge ? 0.03
			: 0.012,
		)
		.velocityDecay(isLarge ? 0.72 : 0.64)
		.force(
			'link',
			d3
				.forceLink<any, any>(links as any)
				.id((d: GraphSimulationNode) => String(d.id))
				.distance((link) => getForceLinkDistance(link, nodeCount))
				.strength((link) => {
					// Reduce link strength for dense nodes to allow charge/collision to spread them out
					const sourceDeg = (link.source as any)?._deg?.total || 0;
					const targetDeg = (link.target as any)?._deg?.total || 0;
					const maxDeg = Math.max(sourceDeg, targetDeg);
					const baseStrength =
						isHuge ? 0.35
						: isLarge ? 0.45
						: 0.55;
					return maxDeg > 20 ? baseStrength * 0.9 : baseStrength;
				}),
		)
		.force(
			'charge',
			d3
				.forceManyBody()
				.strength((d: any) => {
					const base =
						isHuge ? -900
						: isLarge ? -750
						: -600;
					const deg = d._deg?.total || 0;
					// Boost repulsion for dense nodes to give them more breathing room
					return deg > 20 ? base * 1.65 : base;
				})
				.theta(
					isHuge ? 1.5
					: isLarge ? 0.9
					: 0.8,
				),
		)
		// Use gentle forceX/Y instead of forceCenter — prevents the entire graph
		// from sliding when the center of mass shifts after adding nodes.
		.force('x', d3.forceX(W / 2).strength(centeringStrength))
		.force('y', d3.forceY(H / 2).strength(centeringStrength))
		.force(
			'location-x',
			d3
				.forceX((node: GraphSimulationNode) => (Number.isFinite(node?._locationBiasX) ? node._locationBiasX : W / 2))
				.strength((node: GraphSimulationNode) => node?._locationBiasStrength || 0),
		)
		.force(
			'location-y',
			d3
				.forceY((node: GraphSimulationNode) => (Number.isFinite(node?._locationBiasY) ? node._locationBiasY : H / 2))
				.strength((node: GraphSimulationNode) => (node?._locationBiasStrength || 0) * 0.85),
		)
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

	// ── Links (split into three stacked layers so some links can render above nodes) ──
	// create bottom/mid link layers now; the top layer is created after nodes
	linkBottomGroup = root.append('g').attr('class', 'fg-links-bottom');
	linkMidGroup = root.append('g').attr('class', 'fg-links-mid');
	// linkTopGroup will be appended after node group so top links can render above nodes

	// partition links by initial render priority
	const initialHighlight = computeHighlightState();
	const bottomLinks = links.filter((l) => getLinkRenderPriority(l, initialHighlight) <= 0);
	const topLinks = links.filter((l) => getLinkRenderPriority(l, initialHighlight) >= 3);
	const midLinks = links.filter((l) => {
		const p = getLinkRenderPriority(l, initialHighlight);
		return p > 0 && p < 3;
	});

	function joinLinkSelection(groupSel, data) {
		return groupSel
			.selectAll('line')
			.data(data, (d) => `${d.source?.id || d.source}-${d.target?.id || d.target}-${d.relationship}`)
			.join('line')
			.attr('class', 'fg-link')
			.attr('stroke', (d) => getLinkColor(d))
			.attr('stroke-opacity', (d) => getScaledLinkStrokeOpacity(defaultLinkOpacity(d)))
			.style('--fg-link-width', (d) => getLinkWidthPx(d))
			.attr('stroke-dasharray', (d) => getLinkDash(d));
	}

	joinLinkSelection(linkBottomGroup, bottomLinks);
	joinLinkSelection(linkMidGroup, midLinks);
	// topLinks will be joined after node group is created
	linkSel = root.selectAll('.fg-links-bottom line, .fg-links-mid line, .fg-links-top line');

	// ── Arrowheads (also split to mirror link stacking)
	// create bottom/mid arrow layers now; top arrow layer will be created after nodes
	arrowBottomGroup = root.append('g').attr('class', 'fg-arrowheads-bottom');
	arrowMidGroup = root.append('g').attr('class', 'fg-arrowheads-mid');

	function joinArrowSelection(groupSel, data) {
		return groupSel
			.selectAll('line')
			.data(data, (d) => `${d.source?.id || d.source}-${d.target?.id || d.target}-${d.relationship}`)
			.join('line')
			.attr('stroke', 'none')
			.attr('fill', 'none');
	}

	joinArrowSelection(arrowBottomGroup, bottomLinks);
	joinArrowSelection(arrowMidGroup, midLinks);
	// arrowTopGroup will be created and joined after node group creation
	arrowSel = root.selectAll('.fg-arrowheads-bottom line, .fg-arrowheads-mid line, .fg-arrowheads-top line');

	// ── Nodes ─────────────────────────────────────────────────────────────────
	let node = null;
	if (!canvasModeActive) {
		node = root
			.append('g')
			.attr('class', 'fg-nodes')
			.selectAll('g')
			.data(nodes, (d: GraphSimulationNode) => String(d.id))
			.join('g')
			.attr('class', 'fg-node')
			.call(fluidDrag() as any)
			.on('click', handleNodeOpen);
		nodeSel = node;
		nodeGroup = root.select('.fg-nodes');

		renderNodeContents(node);
	} else {
		// In canvas mode we do not create per-node DOM elements — drawing is
		// handled by the canvas renderer on each tick. Keep lightweight placeholders
		// for selections to avoid breaking code paths that expect these vars.
		nodeSel = null;
		nodeGroup = null;
	}

	// If the data payload included recently added node ids (set by mergeIntoGraphData),
	// pulse them to draw attention. Pulses will stop on the first user interaction.
	try {
		if (Array.isArray(data._recentlyAddedNodeIds) && data._recentlyAddedNodeIds.length) {
			startMultiNodePulseLoop(data._recentlyAddedNodeIds, { duration: 5000 });
			// Clear so subsequent renders don't re-trigger pulses.
			delete data._recentlyAddedNodeIds;
		}
	} catch (e) {
		/* ignore */
	}

	// Create top link/arrow groups after nodes so their contents render above node labels
	try {
		linkTopGroup = root.append('g').attr('class', 'fg-links-top');
		joinLinkSelection(linkTopGroup, topLinks);
		arrowTopGroup = root.append('g').attr('class', 'fg-arrowheads-top');
		joinArrowSelection(arrowTopGroup, topLinks);
		// refresh combined selections to include top groups
		linkSel = root.selectAll('.fg-links-bottom line, .fg-links-mid line, .fg-links-top line');
		arrowSel = root.selectAll('.fg-arrowheads-bottom line, .fg-arrowheads-mid line, .fg-arrowheads-top line');

		// If canvas mode is active, hide the SVG link/arrow groups to avoid
		// duplicate drawing and unnecessary DOM paint.
		if (canvasModeActive) {
			try {
				if (linkBottomGroup) linkBottomGroup.style('display', 'none');
				if (linkMidGroup) linkMidGroup.style('display', 'none');
				if (linkTopGroup) linkTopGroup.style('display', 'none');
				if (arrowBottomGroup) arrowBottomGroup.style('display', 'none');
				if (arrowMidGroup) arrowMidGroup.style('display', 'none');
				if (arrowTopGroup) arrowTopGroup.style('display', 'none');
			} catch (e) {
				/* ignore */
			}
		}
	} catch (e) {
		/* ignore */
	}

	// ── Tick ──────────────────────────────────────────────────────────────────
	let _tickN = 0;
	bindSimulationTickHandler(simulation, () => {
		_tickN++;
		// During high-energy early layout, aggressively throttle SVG repaints
		// to allow the main thread to handle user inputs and D3 physics calculations.
		if (isHuge && simulation.alpha() > 0.05 && _tickN % 10 !== 0) return;
		if (isLarge && simulation.alpha() > 0.1 && _tickN % 4 !== 0) return;
		if (!isHuge && !isLarge && simulation.alpha() > 0.15 && _tickN % 2 !== 0) return;

		scheduleGraphTickPositions(linkSel, nodeSel, arrowSel);
	});

	// Stop simulation after 5 seconds to prevent endless movement
	const stopAfterMs =
		isHuge ? 2500
		: isLarge ? 3500
		: 5000;
	setTimeout(() => simulation.stop(), stopAfterMs);

	// Preserve the current selection on blank click; highlights must be cleared explicitly.
	svg.on('click', (event) => {
		const [px, py] = d3.pointer(event);
		lastArrowNavCoord = { x: px, y: py };

		// Clicking the canvas hands arrow-key navigation over to "nearest node
		// from click point" mode; disable any active in-page find/search so
		// arrow keys don't instead cycle through typed find matches.
		if (activeFindQuery || activeFindMatchOrder.length) {
			clearFindMatches();
		}
		if (typeof window !== 'undefined') {
			window.dispatchEvent(new CustomEvent(FIND_CLOSE_EVENT, { detail: { clearQuery: true } }));
		}

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

export function bindSimulationTickHandler(simulationRef: any, handler: () => void, namespace = 'graph-layout') {
	if (!simulationRef || typeof simulationRef.on !== 'function') return;
	try {
		simulationRef.on(`tick.${namespace}`, null);
	} catch (e) {
		// ignore if the simulation implementation doesn't support namespaced listeners
	}
	if (typeof handler === 'function') {
		simulationRef.on(`tick.${namespace}`, handler);
	}
}

// ── Fluid Drag (simulation-driven neighbor repulsion) ────────────────────
function fluidDrag() {
	return d3
		.drag()
		.on('start', function (event, d: GraphSimulationNode) {
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
		.on('drag', function (event, d: GraphSimulationNode) {
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
		.on('end', function (event, d: GraphSimulationNode) {
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

export function resolveNodeByIdOrIdentity(nodeId, candidates = []) {
	const normalizedNodeId = String(nodeId || '').trim();
	if (!normalizedNodeId) return null;
	const directMatches = Array.isArray(candidates) ? candidates.filter((entry) => entry?.id === normalizedNodeId) : [];
	if (directMatches.length) return directMatches[0];

	const [prefix, rawSuffix] = normalizedNodeId.split(':');
	const inferredGroup =
		prefix === 'person' || prefix === 'individual' ? 'individual'
		: prefix === 'firm' ? 'firm'
		: null;
	const fallbackIdentityNode = {
		id: normalizedNodeId,
		group: inferredGroup,
		...(inferredGroup === 'individual' ? { crd: rawSuffix || '' }
		: inferredGroup === 'firm' ? { firmId: rawSuffix || '' }
		: {}),
	};
	const identityKey = getNodeIdentityKey(fallbackIdentityNode);
	if (!identityKey) return null;

	return Array.isArray(candidates) ?
			candidates.find((entry) => {
				if (!entry || typeof entry !== 'object') return false;
				return getNodeIdentityKey(entry) === identityKey;
			}) || null
		:	null;
}

function getNodeById(nodeId) {
	const normalizedNodeId = String(nodeId || '').trim();
	if (!normalizedNodeId) return null;
	if (Array.isArray(layoutNodes)) {
		const found = resolveNodeByIdOrIdentity(normalizedNodeId, layoutNodes);
		if (found) return found;
	}
	if (graphData?.nodes) {
		return Array.isArray(graphData.nodes) ? resolveNodeByIdOrIdentity(normalizedNodeId, graphData.nodes) || null : null;
	}
	return null;
}

function invalidateFullAdjacencyMap() {
	fullAdjacencyMap = null;
}

function getFullAdjacencyMap() {
	if (fullAdjacencyMap && graphData) return fullAdjacencyMap;
	if (!graphData) return new Map();

	const adjacency = new Map();
	(graphData.nodes || []).forEach((n) => adjacency.set(n.id, []));
	(graphData.links || []).forEach((link) => {
		const sourceId = link.source?.id ?? link.source;
		const targetId = link.target?.id ?? link.target;
		if (!sourceId || !targetId) return;
		if (!adjacency.has(sourceId)) adjacency.set(sourceId, []);
		if (!adjacency.has(targetId)) adjacency.set(targetId, []);
		adjacency.get(sourceId).push({ nodeId: targetId, link });
		adjacency.get(targetId).push({ nodeId: sourceId, link });
	});

	fullAdjacencyMap = adjacency;
	return adjacency;
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
function injectNodesById(ids, { skipPersist = false }: { skipPersist?: boolean } = {}) {
	if (!graphData || !layoutNodes || !layoutLinks || !nodeGroup || !linkGroup) return;
	const idSet = new Set(ids || []);
	const toAdd = selectNodesToInjectById(Array.from(idSet), { renderedNodes: layoutNodes, graphNodes: graphData.nodes });
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
			return (
				nowIds.has(s) &&
				nowIds.has(t) &&
				!layoutLinks.some(
					(el) =>
						getLinkIdentityKey(el) ===
						getLinkIdentityKey({ source: s, target: t, relationship: l.relationship, isCurrent: l.isCurrent, startDate: l.startDate, endDate: l.endDate }),
				)
			);
		})
		.map((l) => ({ ...l }));

	layoutNodes.push(...toAdd);
	layoutLinks.push(...newLinks);
	resolveLinkEndpoints(layoutLinks, layoutNodes);
	applyGraphDerivedNodeMetrics(layoutNodes, layoutLinks);
	setGraphLabelRenderMode(layoutNodes.length);

	neighborMap = buildNeighborMap(layoutNodes, layoutLinks);
	if (graphData) updateSubsetInfo(layoutNodes.length, graphData.nodes.length);

	refreshLayeredLinkSelections({ enterDuration: 400 });

	const allNodes = nodeGroup.selectAll('g.fg-node').data(layoutNodes, (d) => d.id);
	const enteredNodes = allNodes.enter().append('g').attr('class', 'fg-node').attr('opacity', 0).call(fluidDrag()).on('click', handleNodeOpen).call(bindHoverAndFocus);

	// Persist session so reload restores these server-rendered nodes
	if (!skipPersist) {
		try {
			saveSession();
		} catch (e) {
			/* ignore */
		}
	}

	enteredNodes.attr('transform', (d) => `translate(${Number.isFinite(d.x) ? d.x : 0},${Number.isFinite(d.y) ? d.y : 0})`);

	enteredNodes.transition().duration(400).attr('opacity', 1);
	nodeSel = nodeGroup.selectAll('g.fg-node');
	linkSel = selectRenderedLinkLines();
	rerenderGraphNodesByIds(getImpactedNodeIds(toAdd, newLinks));
	reapplySelectionState();

	// Pulse newly injected nodes so they're visually highlighted until interaction.
	try {
		if (toAdd.length) {
			startMultiNodePulseLoop(
				toAdd.map((n) => n.id),
				{ duration: 5000 },
			);
		}
	} catch (e) {
		/* ignore */
	}

	refreshGraphColors();
	if (activeFindQuery) refreshFindMatches(activeFindQuery, { preserveActiveMatch: true });
	refreshTraceState();

	refreshSoftLocationGroupingForces(layoutNodes);
	simulation.nodes(layoutNodes);
	simulation.force('link').links(layoutLinks);
	simulation.force('collision').radius((d) => getNodeCollisionRadius(d, layoutNodes.length));
	simulation.alpha(getIncrementalRestartAlpha(layoutNodes.length, toAdd.length)).restart();

	// Persist session so reload restores these nodes
	saveSession();

	let _updTick = 0;
	bindSimulationTickHandler(simulation, () => {
		_updTick++;
		const count = layoutNodes?.length || 0;
		if (count > 1000 && simulation.alpha() > 0.05 && _updTick % 10 !== 0) return;
		if (count > 300 && simulation.alpha() > 0.1 && _updTick % 4 !== 0) return;

		scheduleGraphTickPositions(linkSel, nodeSel, arrowSel);
	});

	// Persist session so reload restores these revealed neighbors
	try {
		saveSession();
	} catch (e) {
		/* ignore */
	}
	// Give the refresh/layout stop a small bump so the settling motion doesn't
	// stop immediately when nodes are revealed — helps visibility of progressive
	// reveals. If a refresh timer exists, extend it by a small delay.
	try {
		if (refreshLayoutStopTimer && refreshFinalizeLayoutFn) {
			// clear existing and schedule a short extra delay before finalizing
			clearTimeout(refreshLayoutStopTimer);
			refreshLayoutStopTimer = setTimeout(() => {
				if (refreshFinalizeLayoutFn) refreshFinalizeLayoutFn();
			}, 700);
		}
	} catch (e) {
		/* ignore timing errors */
	}
}

// ── Selection & Sidebar ─────────────────────────────────────────────────────

// Normalize wrapped detail payloads (e.g. from Elasticsearch/Solr hits)
function unwrapDetailPayload(detail) {
	if (!detail) return detail;

	// Helper to recursively parse string/wrapped/object detail content
	const parseEmbeddedDetail = (val) => {
		if (!val) return null;
		if (typeof val === 'string') {
			try {
				const parsed = JSON.parse(val);
				return parseEmbeddedDetail(parsed);
			} catch {
				return null;
			}
		}
		if (typeof val === 'object') {
			if (val.content !== undefined) {
				return parseEmbeddedDetail(val.content);
			}
			return val;
		}
		return null;
	};

	const isPlainObjectLocal = (value) => {
		return value != null && typeof value === 'object' && !Array.isArray(value);
	};

	const mergePreferPrimaryLocal = (primary, secondary) => {
		if (primary == null || primary === '') return secondary;
		if (secondary == null || secondary === '') return primary;
		if (Array.isArray(primary) && Array.isArray(secondary)) {
			if (!primary.length) return secondary;
			if (!secondary.length) return primary;
			const seen = new Set(primary.map((item) => JSON.stringify(item)));
			return [
				...primary,
				...secondary.filter((item) => {
					const key = JSON.stringify(item);
					if (seen.has(key)) return false;
					seen.add(key);
					return true;
				}),
			];
		}
		if (isPlainObjectLocal(primary) && isPlainObjectLocal(secondary)) {
			const merged = { ...primary };
			for (const [key, value] of Object.entries(secondary)) {
				merged[key] = key in merged ? mergePreferPrimaryLocal(merged[key], value) : value;
			}
			return merged;
		}
		return primary;
	};

	// 1. If it's a merged route response (contains .merged or .finraNode)
	if (detail?.merged || detail?.finraNode) {
		const wrapped = detail.merged || detail.finraNode;
		const parsedWrapped = parseEmbeddedDetail(wrapped);
		if (parsedWrapped) {
			return {
				...parsedWrapped,
				found: detail.found ?? parsedWrapped.found,
				hasFinraData: detail.hasFinraData ?? parsedWrapped.hasFinraData,
				hasSecData: detail.hasSecData ?? parsedWrapped.hasSecData,
				sources: detail.sources ?? parsedWrapped.sources,
			};
		}
	}

	// 2. If it is an unmerged response with separate bccontent and/or iacontent (either as string or object)
	if (detail?.bccontent !== undefined || detail?.iacontent !== undefined) {
		const finraDetail = parseEmbeddedDetail(detail.bccontent);
		const secDetail = parseEmbeddedDetail(detail.iacontent);

		if (finraDetail || secDetail) {
			const merged =
				finraDetail ?
					secDetail ? mergePreferPrimaryLocal(secDetail, finraDetail)
					:	finraDetail
				:	secDetail;

			if (merged && typeof merged === 'object') {
				// Enrich with metadata
				const finraNumeric = finraDetail ? finraDetail.individualId || finraDetail.crd || detail.crd || '' : '';
				const secNumeric = secDetail ? secDetail.individualId || secDetail.crd || detail.crd || '' : '';

				merged.found = detail.found ?? true;
				merged.hasFinraData = detail.hasFinraData ?? (!!finraDetail && !!finraNumeric && hasIndividualSourceCoverage(finraDetail, 'finra'));
				merged.hasSecData = detail.hasSecData ?? (!!secDetail && !!secNumeric && hasIndividualSourceCoverage(secDetail, 'sec'));
				merged.sources = detail.sources ?? {
					finra: finraDetail ? { bccontent: finraDetail } : null,
					sec: secDetail ? { iacontent: secDetail } : null,
				};
				return merged;
			}
		}
	}

	// 3. Fallback to parsing container directly (like Elasticsearch/Solr structures or top-level content)
	const parsedDirect = parseEmbeddedDetail(detail);
	if (parsedDirect && parsedDirect !== detail) {
		return {
			...parsedDirect,
			found: detail.found ?? parsedDirect.found,
			hasFinraData: detail.hasFinraData ?? parsedDirect.hasFinraData,
			hasSecData: detail.hasSecData ?? parsedDirect.hasSecData,
			sources: detail.sources ?? parsedDirect.sources,
		};
	}

	// 4. Solr / Elasticsearch search hits fallback
	const hit = detail?.hits?.hits?.[0] || detail?.response?.docs?.[0];
	if (hit) {
		const src = hit._source || hit;
		const parsedHit = parseEmbeddedDetail(src);
		if (parsedHit) {
			if (detail.found !== undefined) parsedHit.found = detail.found;
			return parsedHit;
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

export function shouldFetchFirmDetailForOwnerEvidence(options: { allowFirmDetailFetch?: boolean } = {}) {
	const { allowFirmDetailFetch = true } = options;
	return allowFirmDetailFetch;
}

async function mergeIndividualOwnerEvidence(personNode, options: { allowFirmDetailFetch?: boolean } = {}) {
	if (!personNode || !graphData) return false;
	const { allowFirmDetailFetch = true } = options;

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

		if (shouldFetchFirmDetailForOwnerEvidence({ allowFirmDetailFetch }) && (!Array.isArray(firmNode.directOwners) || !firmNode.directOwners.length)) {
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

async function loadIndividualDetailFromLocalSearch(crd) {
	const normalizedCrd = String(crd || '').trim();
	if (!normalizedCrd) return null;
	try {
		const searchRes = await fetch(`${BASE}/api/finra/search?query=${encodeURIComponent(normalizedCrd)}`);
		if (!searchRes.ok) return null;
		const searchJson = await searchRes.json();
		const hits = searchJson?.hits?.hits || searchJson?.hits || searchJson?.results || [];
		const match = (Array.isArray(hits) ? hits : []).find((hit) => {
			const src = hit?._source || hit;
			const hitCrd = String(src?.ind_source_id || src?.ind_crd || src?.individualId || src?.basicInformation?.individualId || '').trim();
			return hitCrd === normalizedCrd;
		});
		if (!match) return null;
		const resolved = resolveIndividualSourceDetail(match._source || match);
		const detail = resolved?.detail || null;
		return detail && hasRichIndividualDetail(detail) ? normalizeIndividualDetailPayload(detail, normalizedCrd) : null;
	} catch {
		return null;
	}
}

// Fetch individual detail from API and merge all data into the node.
// Called when an individual node is selected to hydrate missing data.
async function ensureIndividualDetail(
	personNode,
	options: {
		allowOwnerEvidenceFirmFetch?: boolean;
		/** When false, enrich the person node only — do not append employers/control firms into the live graph (keeps click expansion to one hop). */
		injectEmploymentGraph?: boolean;
	} = {},
) {
	if (!personNode || personNode.group !== 'individual') return;
	const { allowOwnerEvidenceFirmFetch = true, injectEmploymentGraph = true } = options;

	// Extract CRD from node ID.
	// Supports "person:6482604", legacy "person_6482604", and bare numeric ids.
	const match = personNode.id.match(/^(?:person[:_])?(\d+)$/);
	const crd = String(personNode.crd || match?.[1] || '').trim();
	if (!crd) {
		personNode._ownerEvidenceLoaded = await mergeIndividualOwnerEvidence(personNode, { allowFirmDetailFetch: allowOwnerEvidenceFirmFetch });
		personNode._detailMissing = !personNode._ownerEvidenceLoaded;
		return;
	}

	const hasStoredEmploymentHistory =
		hasRichIndividualDetail(personNode) ||
		(Array.isArray(personNode.currentEmployments) && personNode.currentEmployments.length > 0) ||
		(Array.isArray(personNode.previousEmployments) && personNode.previousEmployments.length > 0) ||
		(Array.isArray(personNode.currentIAEmployments) && personNode.currentIAEmployments.length > 0) ||
		(Array.isArray(personNode.previousIAEmployments) && personNode.previousIAEmployments.length > 0);
	const previousHistoryKnown = Array.isArray(personNode.previousEmployments) && Array.isArray(personNode.previousIAEmployments);

	// Clicking a person should always materialize known firm links, even when the node
	// was previously treated as owner-evidence-only or already hydrated without edges.
	if (injectEmploymentGraph && hasStoredEmploymentHistory) {
		syncIndividualConnectionsFromDetail(personNode, personNode, { includePrevious: true });
	}

	if (personNode._detailLoaded && hasRichIndividualDetail(personNode) && (!injectEmploymentGraph || previousHistoryKnown)) {
		return;
	}

	if (!injectEmploymentGraph && (personNode._detailMissing || personNode._ownerEvidenceLoaded)) {
		return;
	}

	const requestCacheKey = `${crd}|ownerEvidence:${allowOwnerEvidenceFirmFetch ? '1' : '0'}|injectGraph:${injectEmploymentGraph ? '1' : '0'}`;
	const existingRequest = individualDetailRequestCache.get(requestCacheKey);
	if (existingRequest) {
		await existingRequest;
		return;
	}

	const requestPromise = (async () => {
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

			const ownerEvidenceAvailable =
				!detail && !localDetail && !hasRichIndividualDetail(personNode) ?
					await mergeIndividualOwnerEvidence(personNode, { allowFirmDetailFetch: allowOwnerEvidenceFirmFetch })
				:	false;
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

			if (!detail || detail.found === false || !hasRichIndividualDetail(detail)) {
				const searchDetail = await loadIndividualDetailFromLocalSearch(crd);
				if (searchDetail && hasRichIndividualDetail(searchDetail)) {
					detail = searchDetail;
				}
			}

			if (!detail || detail.found === false) {
				personNode._ownerEvidenceLoaded = await mergeIndividualOwnerEvidence(personNode, { allowFirmDetailFetch: allowOwnerEvidenceFirmFetch });
				if (!detail || detail.found === false) {
					personNode._detailMissing = !personNode._ownerEvidenceLoaded;
					return;
				}
			}

			try {
				applyIndividualDetail(personNode, detail, crd);
				// Clicking a person should reveal its full employment history, including previous firms.
				if (injectEmploymentGraph) {
					syncIndividualConnectionsFromDetail(personNode, detail, { includePrevious: true });
				}
				personNode._trustedCurrentRelationshipData = hasRichIndividualDetail(detail);
				personNode._detailLoaded = true;
				personNode._detailMissing = false;
			} catch (e) {
				console.warn('Failed to merge individual detail:', e);
			}
			logDetailLoadDebug(`Detail loaded for CRD ${crd}: ${personNode.disclosures?.length || 0} BC disclosures, ${personNode.iaDisclosures?.length || 0} IA disclosures`);
			if (typeof refreshGraphColors === 'function') refreshGraphColors();
		} catch (err) {
			console.error(`Error fetching individual detail for ${crd}:`, err);
		}
	})();

	individualDetailRequestCache.set(requestCacheKey, requestPromise);
	try {
		await requestPromise;
	} finally {
		if (individualDetailRequestCache.get(requestCacheKey) === requestPromise) {
			individualDetailRequestCache.delete(requestCacheKey);
		}
	}
}

// Officer/control-type position text (e.g. "CHIEF COMPLIANCE OFFICER", "DIRECTOR", "PRINCIPAL")
// should render as a controls-type relationship, not a plain employment link.
function isControlPositionText(text) {
	const value = String(text || '').trim();
	if (!value) return false;
	return /officer|chief|director|principal|control\s*person|owner|partner|proprietor/i.test(value);
}

function syncIndividualConnectionsFromDetail(personNode, detail, options: { includePrevious?: boolean } = {}) {
	if (!personNode || !detail) return;
	// Clicking a person node should surface all of its known firm links, including previous/
	// historical employers, so the graph matches the person's full relationship history.
	const { includePrevious = true } = options;

	const personId = personNode.id;
	const newNodes = [];
	const newLinks = [];

	// Scraped-only reference record: connect to its parent firm/individual so it isn't orphaned in the graph.
	if (detail.orphan && typeof detail.orphan === 'object') {
		const orphan = detail.orphan;
		const parentCrd = String(orphan.parentCrd || '').trim();
		if (parentCrd) {
			const parentType = String(orphan.parentType || 'firm')
				.trim()
				.toLowerCase();
			const isParentIndividual = parentType === 'individual';
			const existingParentNode = isParentIndividual ? findExistingPersonNode(parentCrd) : findExistingFirmNode(parentCrd, { label: orphan.firmName || '' });
			const parentNodeId = existingParentNode?.id || (isParentIndividual ? `person:${parentCrd}` : `firm:${parentCrd}`);
			if (!existingParentNode && !newNodes.some((node) => node.id === parentNodeId)) {
				newNodes.push(
					isParentIndividual ?
						{ id: parentNodeId, label: `CRD ${parentCrd}`, group: 'individual', crd: parentCrd, stub: true }
					:	{
							id: parentNodeId,
							label: orphan.firmName || `Firm ${parentCrd}`,
							group: 'firm',
							firmId: parentCrd,
							firmStatus: orphan.firmStatus || orphan.status || orphan.registrationStatus || null,
						},
				);
			}
			const candidateLink = {
				source: personId,
				target: parentNodeId,
				relationship: isControlPositionText(orphan.position) ? 'officer' : 'employed_by',
			};
			const hasLayoutLink = layoutLinks.some((link) => getLinkIdentityKey(link) === getLinkIdentityKey(candidateLink));
			if (!hasLayoutLink) newLinks.push(candidateLink);
		}
		if (!newNodes.length && !newLinks.length) return;
		appendFetched(newNodes, newLinks);
		mergeIntoGraphData(newNodes, newLinks);
		return;
	}

	const employments = flattenEmploymentRecords(detail).filter((employment) => includePrevious || employment?._isCurrent !== false);

	for (const employment of employments) {
		const rawFirmId = String(employment?.firmId || employment?.firm_id || employment?.firmIdNumber || employment?.organizationId || employment?.orgId || '').trim();
		const secFirmId = String(
			employment?.bdSECNumber || employment?.bdSecNumber || employment?.iaSECNumber || employment?.iaSecNumber || employment?.firm_bd_sec_number || '',
		).trim();
		const firmId = rawFirmId || secFirmId;
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
				firmStatus: employment?.employmentStatus || employment?.status || employment?.firmStatus || null,
			});
		}

		const candidateLink = {
			source: personId,
			target: firmNodeId,
			relationship: getEmploymentRelationship(employment),
			isCurrent: employment._isCurrent,
			startDate: employment?.registrationBeginDate || employment?.startDate || employment?.fromDate || null,
			endDate: employment._isCurrent ? null : employment?.registrationEndDate || employment?.endDate || employment?.toDate || null,
		};
		const hasLayoutLink = layoutLinks.some((link) => getLinkIdentityKey(link) === getLinkIdentityKey(candidateLink));
		const hasPendingLink = newLinks.some((link) => getLinkIdentityKey(link) === getLinkIdentityKey(candidateLink));
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
				firmStatus: controlRecord?.firmStatus || controlRecord?.status || controlRecord?.registrationStatus || null,
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
		applyGraphDerivedNodeMetrics(layoutNodes, layoutLinks);
		rerenderGraphNodesByIds([personId]);
		refreshGraphColors();
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

	// Scraped-only reference record (e.g. an employer entry scraped directly from an
	// individual's page): connect back to its parent individual/firm so it isn't orphaned
	// in the graph.
	if (detail.orphan && typeof detail.orphan === 'object') {
		const orphan = detail.orphan;
		const parentCrd = String(orphan.parentCrd || '').trim();
		if (parentCrd) {
			const parentType = String(orphan.parentType || 'individual')
				.trim()
				.toLowerCase();
			const isParentIndividual = parentType === 'individual';
			const existingParentNode = isParentIndividual ? findExistingPersonNode(parentCrd) : findExistingFirmNode(parentCrd, { label: orphan.firmName || '' });
			const parentNodeId = existingParentNode?.id || (isParentIndividual ? `person:${parentCrd}` : `firm:${parentCrd}`);
			if (!existingParentNode && !newNodes.some((node) => node.id === parentNodeId)) {
				newNodes.push(
					isParentIndividual ?
						{ id: parentNodeId, label: `CRD ${parentCrd}`, group: 'individual', crd: parentCrd, stub: true }
					:	{
							id: parentNodeId,
							label: orphan.firmName || `Firm ${parentCrd}`,
							group: 'firm',
							firmId: parentCrd,
							firmStatus: orphan.firmStatus || orphan.status || orphan.registrationStatus || null,
						},
				);
			}
			const candidateLink = {
				source: parentNodeId,
				target: firmNodeId,
				relationship: isControlPositionText(orphan.position) ? 'officer' : 'employed_by',
			};
			const hasLayoutLink = layoutLinks.some((link) => getLinkIdentityKey(link) === getLinkIdentityKey(candidateLink));
			if (!hasLayoutLink) newLinks.push(candidateLink);
		}
		if (!newNodes.length && !newLinks.length) return;
		appendFetched(newNodes, newLinks);
		mergeIntoGraphData(newNodes, newLinks);
		return;
	}

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

	const dedupedNodes = mergeGraphNodesForAppend([], newNodes);
	const dedupedLinks = dedupeGraphLinksByIdentity(newLinks, dedupedNodes.idRewriteMap);

	if (!dedupedNodes.nodes.length && !dedupedLinks.length) {
		applyGraphDerivedNodeMetrics(layoutNodes, layoutLinks);
		rerenderGraphNodesByIds([firmNodeId]);
		refreshGraphColors();
		return;
	}
	appendFetched(dedupedNodes.nodes, dedupedLinks);
	mergeIntoGraphData(dedupedNodes.nodes, dedupedLinks);
}

const firmConnectionsRequestCache = new Map<string, Promise<void>>();

/**
 * Lazy-load current/previous employment connections for a firm and expose them for the
 * sidebar detail panel only — clicking a firm node in the graph no longer auto-reveals
 * these as graph nodes/links (see isFirmControlOnlyExpansionLink), but the sidebar's
 * Current/Previous Connections cards still show them and remain clickable (they route
 * to/inject the target node on demand via the existing fg-node-link click handler).
 */
async function ensureFirmConnections(firmNode: any) {
	if (!firmNode || firmNode.group !== 'firm') return;
	const match = String(firmNode.id || '').match(/^(?:firm[:_])?(\d+)$/);
	if (!match) return;
	const firmId = match[1];
	if (firmNode._connectionsLoaded) return;

	const existingRequest = firmConnectionsRequestCache.get(firmId);
	if (existingRequest) {
		await existingRequest;
		return;
	}

	const requestPromise = (async () => {
		try {
			const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
			const timer = controller ? window.setTimeout(() => controller.abort(), 12000) : 0;
			const res = await fetch(`${BASE}/api/finra/firm/${encodeURIComponent(firmId)}/connections`, {
				signal: controller?.signal,
			});
			if (timer) window.clearTimeout(timer);
			if (res.ok) {
				const payload = await res.json();
				if (payload?.found !== false) {
					// Sidebar-display only: store the raw lists on the node for renderFirmDetail to
					// render as Current/Previous Connections cards. Do NOT inject nodes/links into
					// the live graph canvas here — that's the expensive part we removed for performance.
					firmNode.currentConnections = Array.isArray(payload.currentConnections) ? payload.currentConnections : [];
					firmNode.previousConnections = Array.isArray(payload.previousConnections) ? payload.previousConnections : [];
					firmNode._connectionsLoaded = true;
				}
			}
		} catch (error) {
			// timeout / offline — leave _connectionsLoaded unset so a future call can retry.
			console.warn(`ensureFirmConnections failed for ${firmId}:`, error);
		}
	})();

	firmConnectionsRequestCache.set(firmId, requestPromise);
	try {
		await requestPromise;
	} finally {
		if (firmConnectionsRequestCache.get(firmId) === requestPromise) {
			firmConnectionsRequestCache.delete(firmId);
		}
	}
}

// Fetch firm detail from the server (which checks local cache first, then FINRA API).
// Merges the response into the firm node so renderFirmDetail can display rich data.
async function ensureFirmDetail(firmNode) {
	if (!firmNode || firmNode.group !== 'firm') return;

	// Support both "firm:12345", legacy "firm_12345", and bare numeric ids
	const match = firmNode.id.match(/^(?:firm[:_])?(\d+)$/);
	if (!match) return;
	const firmId = match[1];

	if (firmNode._detailMissing) return;
	if (firmNode._detailLoaded && firmNode._detailValidated === true) return;

	const existingRequest = firmDetailRequestCache.get(firmId);
	if (existingRequest) {
		await existingRequest;
		return;
	}

	const requestPromise = (async () => {
		try {
			let detail = null;
			let mergedApplied = false;
			const applyMergedFirmNodeFields = (fn) => {
				if (!fn || typeof fn !== 'object') return;
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
				if (Array.isArray(fn.currentConnections)) firmNode.currentConnections = fn.currentConnections;
				if (Array.isArray(fn.previousConnections)) firmNode.previousConnections = fn.previousConnections;
			};
			const hasUsableFirmDetail = (payload) => {
				if (!payload || typeof payload !== 'object' || payload.found === false) return false;
				return Boolean(
					payload.basicInformation ||
						payload.firmName ||
						payload.name ||
						payload.firmStatus ||
						payload.bcScope ||
						payload.officeAddress ||
						(Array.isArray(payload.directOwners) && payload.directOwners.length) ||
						(Array.isArray(payload.disclosures) && payload.disclosures.length),
				);
			};

			// Fast merged Form BD payload only. Do not request includeConnections=1 —
			// that blocks sidebar paint on getFirmConnectionsFromGraph (employee roster).
			try {
				const localRes = await fetch(`${BASE}/api/finra/merged/firm/${encodeURIComponent(firmId)}`);
				if (localRes.ok) {
					const merged = await localRes.json();
					const fn = merged?.finraNode || merged?.merged;
					if (merged?.found !== false && fn) {
						applyMergedFirmNodeFields(fn);
						detail = unwrapDetailPayload(fn) || fn;
						mergedApplied = hasUsableFirmDetail(detail) || Boolean(fn.firmStatus || fn.firmName || fn.directOwners);
					}
				}
			} catch {
				// local lookup failed — fall through to live API
			}

			if (!hasUsableFirmDetail(detail)) {
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
			}

			// Scraped-only reference record (e.g. an employer entry scraped directly from an
			// individual's page, with no independent, searchable BrokerCheck/IAPD firm record).
			if (detail && detail.orphan && typeof detail.orphan === 'object') {
				const orphan = detail.orphan;
				firmNode.orphan = orphan;
				firmNode.stub = true;
				firmNode.hasFinraData = false;
				firmNode.hasSecData = false;
				const preferredFirmName = String(orphan.firmName || '').trim();
				if (preferredFirmName && (isGenericOrPlaceholderLabel(firmNode.label, 'firm') || preferredFirmName.length > String(firmNode.label || '').length)) {
					firmNode.label = preferredFirmName;
					firmNode.firmName = preferredFirmName;
				}
				syncFirmConnectionsFromDetail(firmNode, detail);
				firmNode._detailLoaded = true;
				firmNode._detailValidated = true;
				return;
			}

			if (!detail || detail.found === false || (!detail.basicInformation && !detail.firmName && !detail.name)) {
				console.info(`Local API missing data for firm ${firmId}; skipping direct browser fallback to external APIs to avoid CORS/rate-limit failures.`);
			}

			if (!detail || (detail.found === false && !detail.basicInformation && !detail.firmName)) {
				if (mergedApplied) {
					syncFirmConnectionsFromDetail(firmNode, detail || {});
					firmNode._detailLoaded = true;
					firmNode._detailMissing = false;
					firmNode._detailValidated = true;
					if (selectedId === firmNode.id) renderSidebar(firmNode);
					void ensureFirmConnections(firmNode);
					return;
				}
				firmNode._detailMissing = true;
				firmNode._detailValidated = true;
				console.debug(`Firm ${firmId} not found`);
				return;
			}

			const bi = detail?.basicInformation || {};
			const preferredFirmName = String(bi.firmName || detail?.firmName || detail?.name || '').trim();
			if (preferredFirmName && (isGenericOrPlaceholderLabel(firmNode.label, 'firm') || preferredFirmName.length > String(firmNode.label || '').length)) {
				firmNode.label = preferredFirmName;
			}
			if (preferredFirmName) {
				firmNode.firmName = preferredFirmName;
				if (!firmNode.basicInformation) firmNode.basicInformation = {};
				if (!firmNode.basicInformation.firmName) firmNode.basicInformation.firmName = preferredFirmName;
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
			// If FINRA explicitly reports no firm data, persist suppression so
			// sidebar links self-correct during normal browsing.
			if (detail.hasFinraData === false) {
				const suppressed = new Set<string>(Array.isArray(firmNode.suppressedExternalLinks) ? firmNode.suppressedExternalLinks : []);
				suppressed.add('finra');
				firmNode.suppressedExternalLinks = Array.from(suppressed);
			} else if (detail.hasFinraData === true && Array.isArray(firmNode.suppressedExternalLinks)) {
				firmNode.suppressedExternalLinks = firmNode.suppressedExternalLinks.filter(
					(entry: any) =>
						String(entry || '')
							.trim()
							.toLowerCase() !== 'finra',
				);
			}
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

			// Always set directOwners (even to []) once we have a validated detail response, so
			// the graph knows a firm with zero Form BD owners has nothing left to reveal instead
			// of perpetually looking like it might still have undiscovered control connections.
			if (Array.isArray(detail.directOwners)) {
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
			firmNode._detailMissing = false;
			firmNode._detailValidated = true;
			logDetailLoadDebug(`Firm detail loaded for ID ${firmId}: ${firmNode.disclosures?.length || 0} disclosures, ${firmNode.directOwners?.length || 0} owners`);
			if (selectedId === firmNode.id) renderSidebar(firmNode);

			// Employment connections load async and re-paint the sidebar when they arrive.
			void ensureFirmConnections(firmNode).then(() => {
				if (selectedId === firmNode.id) {
					renderSidebar(firmNode);
				}
			});
		} catch (err) {
			console.error(`Error fetching firm detail for ${firmId}:`, err);
		}
	})();

	firmDetailRequestCache.set(firmId, requestPromise);
	try {
		await requestPromise;
	} finally {
		if (firmDetailRequestCache.get(firmId) === requestPromise) {
			firmDetailRequestCache.delete(firmId);
		}
	}
}

export function releasePinnedSelectedNodeAnchor(nodeId, nodes = layoutNodes) {
	if (!nodeId || !Array.isArray(nodes)) return false;
	let released = false;
	nodes.forEach((node) => {
		if (!node || String(node.id) !== String(nodeId)) return;
		if (node.fx != null || node.fy != null) {
			node.fx = null;
			node.fy = null;
			released = true;
		}
	});
	return released;
}

function anchorNode(node) {
	if (!node || !Number.isFinite(node.x) || !Number.isFinite(node.y)) return;
	node.fx = node.x;
	node.fy = node.y;
	if (simulation) {
		simulation.alphaTarget(0.05).restart();
	}
}

/**
 * Server-expand only safe IDs during multi-wave walks.
 * Never auto-expand firm neighborhoods unless that firm is the node the user clicked —
 * firm:7691 (Merrill) alone is ~2500 people at 1 hop and floods the canvas.
 */
function filterIdsSafeForServerExpand(nodeIds: string[], clickedNodeId?: string | null) {
	const clicked = String(clickedNodeId || '').trim();
	return nodeIds.filter((id) => {
		const normalized = String(id || '').trim();
		if (!normalized) return false;
		// Never server-expand firms. `/api/finra/expand/firm:*` returns employment
		// rosters; firm clicks should only reveal Form BD Direct Owners & Executive Officers.
		if (normalized.startsWith('firm:') || normalized.startsWith('entity:')) return false;
		if (normalized === clicked) return true;
		if (normalized.startsWith('person:')) return true;
		return false;
	});
}

function limitExpansionPayload(payload: { nodes?: any[]; links?: any[]; meta?: any }, options: { maxNeighbors?: number; rootId?: string | null } = {}) {
	const maxNeighbors = Math.max(1, Number(options.maxNeighbors) || MAX_AUTO_REVEAL_NEIGHBORS_PER_EXPAND);
	const rootId = String(options.rootId || '').trim();
	const nodes = Array.isArray(payload?.nodes) ? payload.nodes : [];
	const links = Array.isArray(payload?.links) ? payload.links : [];
	if (!nodes.length) return { nodes: [], links: [], meta: payload?.meta || {} };

	const rootNodes = rootId ? nodes.filter((n) => String(n?.id || '') === rootId) : [];
	const otherNodes = rootId ? nodes.filter((n) => String(n?.id || '') !== rootId) : nodes.slice();
	if (otherNodes.length <= maxNeighbors) {
		return { nodes, links, meta: payload?.meta || {} };
	}

	const keptOthers = otherNodes.slice(0, maxNeighbors);
	const keptIds = new Set<string>([...rootNodes, ...keptOthers].map((n) => String(n?.id || '')).filter(Boolean));
	return {
		nodes: [...rootNodes, ...keptOthers],
		links: links.filter((link) => {
			const s = String(link?.source?.id ?? link?.source ?? '').trim();
			const t = String(link?.target?.id ?? link?.target ?? '').trim();
			return keptIds.has(s) && keptIds.has(t);
		}),
		meta: {
			...(payload?.meta || {}),
			truncated: true,
			truncatedFrom: otherNodes.length,
			truncatedTo: maxNeighbors,
		},
	};
}

async function fetchExpansionDataForNodeIds(
	nodeIds: string[] = [],
	hops: number | 'all' = getDefaultExpansionHops(),
	options: {
		strictHops?: boolean;
		clickedNodeId?: string | null;
		/** When true (default), drop firm IDs that are not the click target before calling the server. */
		safeFirmExpand?: boolean;
		maxNeighbors?: number;
	} = {},
) {
	const { strictHops = false, clickedNodeId = null, safeFirmExpand = true, maxNeighbors = MAX_AUTO_REVEAL_NEIGHBORS_PER_EXPAND } = options;
	const rawIds = Array.from(new Set<string>(nodeIds.filter(Boolean)));
	const uniqueIds = safeFirmExpand ? filterIdsSafeForServerExpand(rawIds, clickedNodeId) : rawIds;
	if (!uniqueIds.length) return { nodes: [], links: [], meta: {} };
	const normalizedHops = normalizeHighlightHops(hops);

	// Batch IDs into chunks to avoid hitting URL length limits
	const BATCH_SIZE = 100;
	const results = [];

	for (let i = 0; i < uniqueIds.length; i += BATCH_SIZE) {
		const chunk = uniqueIds.slice(i, i + BATCH_SIZE);
		const primaryId = chunk[0];
		const otherIds = chunk.slice(1);

		const url = makeApiUrl(`/api/finra/expand/${encodeURIComponent(primaryId)}`);
		url.searchParams.set('hops', String(normalizedHops));
		if (strictHops) {
			url.searchParams.set('strict', '1');
		}
		if (otherIds.length > 0) {
			url.searchParams.set('ids', otherIds.join(','));
		}
		const requestCacheKey = url.toString();

		try {
			let requestPromise = expansionRequestCache.get(requestCacheKey);
			if (!requestPromise) {
				requestPromise = fetch(requestCacheKey).then(async (response) => {
					if (!response.ok) {
						throw new Error(`HTTP ${response.status}`);
					}
					return response.json();
				});
				expansionRequestCache.set(requestCacheKey, requestPromise);
			}
			const data = await requestPromise;
			if (expansionRequestCache.get(requestCacheKey) === requestPromise) {
				expansionRequestCache.delete(requestCacheKey);
			}
			results.push({ status: 'fulfilled', value: data });
		} catch (err) {
			expansionRequestCache.delete(requestCacheKey);
			results.push({ status: 'rejected', reason: err });
		}
	}

	const mergedNodes = [];
	const mergedLinks = [];
	const seenNodeIds = new Set<string>();
	const seenLinkKeys = new Set<string>();

	results.forEach((result: any) => {
		if (result.status !== 'fulfilled' || !result.value) return;
		(result.value.nodes || []).forEach((n) => {
			if (!seenNodeIds.has(n.id)) {
				seenNodeIds.add(n.id);
				mergedNodes.push(n);
			}
		});
		(result.value.links || []).forEach((l) => {
			const s = l.source?.id ?? l.source;
			const t = l.target?.id ?? l.target;
			const k = `${s}|${t}`;
			if (!seenLinkKeys.has(k)) {
				seenLinkKeys.add(k);
				mergedLinks.push(l);
			}
		});
	});

	// Cap mega-neighborhoods (e.g. Merrill Lynch 1-hop ≈ 2500 people) so a single expand stays usable.
	return limitExpansionPayload({ nodes: mergedNodes, links: mergedLinks }, { maxNeighbors: maxNeighbors, rootId: clickedNodeId || uniqueIds[0] || null });
}

export function shouldHydrateExpansionFrontierNodeDetail(node, options: { includeFirmDetails?: boolean } = {}) {
	if (!node || typeof node !== 'object') return false;
	const { includeFirmDetails = false } = options;
	if (node.group === 'individual') return true;
	if (node.group === 'firm') return includeFirmDetails;
	return false;
}

async function hydrateExpansionFrontierNodes(
	nodeIds: string[] = [],
	options: {
		includeFirmDetails?: boolean;
		/** Default false: label/detail only. True only when the user opened that node. */
		injectEmploymentGraph?: boolean;
	} = {},
) {
	const uniqueIds = Array.from(new Set(nodeIds.filter(Boolean)));
	if (!uniqueIds.length) return [];
	const { includeFirmDetails = false, injectEmploymentGraph = false } = options;

	const hydratedIds = new Set<string>();
	for (let index = 0; index < uniqueIds.length; index += NON_GRAY_DETAIL_BATCH_SIZE) {
		const chunk = uniqueIds.slice(index, index + NON_GRAY_DETAIL_BATCH_SIZE);
		const results = await Promise.allSettled(
			chunk.map(async (nodeId) => {
				const liveNode = layoutNodes?.find((node) => node.id === nodeId) || graphData?.nodes?.find((node) => node.id === nodeId);
				if (!liveNode) return null;
				if (!shouldHydrateExpansionFrontierNodeDetail(liveNode, { includeFirmDetails })) return null;
				if (liveNode.group === 'individual') {
					await ensureIndividualDetail(liveNode, {
						allowOwnerEvidenceFirmFetch: includeFirmDetails,
						// Never inject hop-2 employers while walking an expansion frontier.
						injectEmploymentGraph: injectEmploymentGraph === true,
					});
				} else if (liveNode.group === 'firm') {
					// Detail only — do not fan out firm employment connections during expansion.
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

function revealIncidentRenderedLinks(clickedNode, linkFilter: ((link: any) => boolean) | null = null) {
	if (!clickedNode?.id || !graphData || !layoutNodes || !layoutLinks) return 0;
	const renderedIds = new Set(layoutNodes.map((node) => node.id));
	const clickedId = clickedNode.id;
	const nextLinks = [];
	for (const link of graphData.links || []) {
		if (typeof linkFilter === 'function' && !linkFilter(link)) continue;
		const sourceId = link.source?.id ?? link.source;
		const targetId = link.target?.id ?? link.target;
		if (sourceId !== clickedId && targetId !== clickedId) continue;
		if (!renderedIds.has(sourceId) || !renderedIds.has(targetId)) continue;
		const alreadyHas = layoutLinks.some((existing) => {
			const existingSourceId = existing.source?.id ?? existing.source;
			const existingTargetId = existing.target?.id ?? existing.target;
			if (getLinkIdentityKey(existing) === getLinkIdentityKey(link)) return true;
			return (existingSourceId === sourceId && existingTargetId === targetId) || (existingSourceId === targetId && existingTargetId === sourceId);
		});
		if (alreadyHas) continue;
		nextLinks.push({ ...link });
	}
	if (!nextLinks.length) return 0;
	layoutLinks.push(...resolveLinkEndpoints(nextLinks, layoutNodes));
	neighborMap = buildNeighborMap(layoutNodes, layoutLinks);
	refreshLayeredLinkSelections({ enterDuration: 220 });
	linkSel = selectRenderedLinkLines();
	rerenderGraphNodesByIds(getImpactedNodeIds([], nextLinks));
	reapplySelectionState();
	refreshGraphColors();
	return nextLinks.length;
}

function revealPersonEmploymentNeighbors(personNode) {
	if (!personNode?.id || personNode.group !== 'individual' || !graphData || !layoutNodes) return;
	const employmentFirmIds = new Set<string>();
	for (const employment of flattenEmploymentRecords(personNode)) {
		const firmNodeId = resolveEmploymentConnectionFirmNodeId(employment);
		if (firmNodeId) employmentFirmIds.add(firmNodeId);
	}
	for (const link of graphData.links || []) {
		if (!isAutoExpansionLink(link) && !isPreviousEmploymentLink(link)) continue;
		const sourceId = String(link.source?.id ?? link.source ?? '').trim();
		const targetId = String(link.target?.id ?? link.target ?? '').trim();
		if (sourceId === personNode.id && targetId) employmentFirmIds.add(targetId);
		if (targetId === personNode.id && sourceId) employmentFirmIds.add(sourceId);
	}
	const renderedIds = new Set(layoutNodes.map((node) => node.id));
	const hiddenIds = Array.from(employmentFirmIds).filter((id) => id && !renderedIds.has(id));
	if (hiddenIds.length) {
		revealNeighbors(personNode, 'all', {
			linkFilter: (link) => isAutoExpansionLink(link) || isPreviousEmploymentLink(link),
			restrictToIds: new Set(hiddenIds),
			markSelected: true,
		});
	}
	revealIncidentRenderedLinks(personNode, (link) => isAutoExpansionLink(link) || isPreviousEmploymentLink(link));
}

async function expandNodeThroughNonGrayHops(clickedNode, hops: number | 'all' = getDefaultExpansionHops()) {
	if (!clickedNode?.id || !graphData) return;

	const runId = ++nonGrayExpandRunId;
	lastExpandOriginNode = clickedNode;
	const normalizedHops = normalizeHighlightHops(hops);
	const maxHops = normalizedHops === 'all' ? 100 : Math.max(1, Number(normalizedHops) || 1);
	const revealTiming = getNodeExpansionRevealTiming(layoutNodes?.length || 0, { isUserInitiated: true });
	// Firms only reveal Form BD "controls" connections on click — employment/registration
	// history and other relationship types stay hidden (dashboard-only, see ensureFirmConnections).
	const expansionLinkFilter = clickedNode.group === 'firm' ? isFirmControlOnlyExpansionLink : isAutoExpansionLink;

	if (clickedNode.group === 'individual') {
		await ensureIndividualDetail(clickedNode, {
			allowOwnerEvidenceFirmFetch: true,
			injectEmploymentGraph: true,
		});
		if (runId !== nonGrayExpandRunId) return;
		revealPersonEmploymentNeighbors(clickedNode);
	} else if (clickedNode.group === 'firm') {
		// Owners/officers come from Form BD detail, not the employment expand API.
		await ensureFirmDetail(clickedNode);
		if (runId !== nonGrayExpandRunId) return;
		revealIncidentRenderedLinks(clickedNode, expansionLinkFilter);
	}

	const visitedIds = new Set([clickedNode.id]);
	let currentWaveIds = [clickedNode.id];

	for (let wave = 1; wave <= maxHops; wave++) {
		if (runId !== nonGrayExpandRunId) return;

		// Pass 1: Reveal already-known neighbors in graphData
		const fullAdj = getFullAdjacencyMap();
		const waveFoundIds = [];
		const renderedIds = new Set((layoutNodes || []).map((node) => node.id));

		currentWaveIds.forEach((fId) => {
			// If this is NOT the root node, and it is already dense, skip expanding FROM it
			// for auto-expansion waves to prevent exponential graph explosions.
			// We only allow "dense expansion" for the actual node the user clicked.
			if (fId !== clickedNode.id && getDirectAutoExpansionNeighborCount({ id: fId }) > AUTO_EXPANSION_DIRECT_NEIGHBOR_LIMIT) {
				return;
			}

			(fullAdj.get(fId) || []).forEach(({ nodeId, link }) => {
				if (!expansionLinkFilter(link)) return;
				if (visitedIds.has(nodeId)) return;
				visitedIds.add(nodeId);
				waveFoundIds.push(nodeId);
			});
		});

		const uniqueWaveFoundIds = Array.from(new Set(waveFoundIds));
		const hiddenIds = uniqueWaveFoundIds.filter((id) => !renderedIds.has(id));

		if (hiddenIds.length) {
			revealNeighbors(clickedNode, 'all', {
				linkFilter: expansionLinkFilter,
				restrictToIds: new Set(hiddenIds),
				markSelected: true,
			});
			if (runId !== nonGrayExpandRunId) return;
			spreadNeighbors(clickedNode, new Set(hiddenIds), { duration: revealTiming.animationMs });
		} else if (wave === 1) {
			revealIncidentRenderedLinks(clickedNode, expansionLinkFilter);
		}

		// Pass 2: Fetch 1-hop neighbors for this wave only. Detail hydration must not inject
		// further graph relations (that would leak hop N+1 employers into the canvas).
		const hydrationPromise = hydrateExpansionFrontierNodes(currentWaveIds, {
			includeFirmDetails: false,
			injectEmploymentGraph: false,
		});
		// Never server-expand firm IDs (employment rosters). Person clicks still expand 1 hop.
		const expansionPromise = fetchExpansionDataForNodeIds(currentWaveIds, 1, {
			strictHops: true,
			clickedNodeId: clickedNode.id,
			safeFirmExpand: true,
			maxNeighbors: MAX_AUTO_REVEAL_NEIGHBORS_PER_EXPAND,
		});
		await Promise.all([
			hydrationPromise,
			expansionPromise.then(async (expansion) => {
				const filteredExpansion = filterRevealableGraphPayload(expansion, expansionLinkFilter);
				if (filteredExpansion.nodes.length || filteredExpansion.links.length) {
					mergeIntoGraphData(filteredExpansion.nodes, filteredExpansion.links);
				}
			}),
		]);

		if (runId !== nonGrayExpandRunId) return;

		// Pass 3: Reveal any newly discovered neighbors after fetch
		const postFetchAdj = getFullAdjacencyMap();
		const newlyFoundIds = [];
		const postRenderedIds = new Set((layoutNodes || []).map((node) => node.id));

		currentWaveIds.forEach((fId) => {
			// Prevent "dense bridges" after fetch as well
			if (fId !== clickedNode.id && getDirectAutoExpansionNeighborCount({ id: fId }) > AUTO_EXPANSION_DIRECT_NEIGHBOR_LIMIT) {
				return;
			}

			(postFetchAdj.get(fId) || []).forEach(({ nodeId, link }) => {
				if (!expansionLinkFilter(link)) return;
				if (visitedIds.has(nodeId)) return;
				visitedIds.add(nodeId);
				newlyFoundIds.push(nodeId);
			});
		});

		const uniqueNewlyFoundIds = Array.from(new Set(newlyFoundIds));
		const hiddenAfterFetchIds = uniqueNewlyFoundIds.filter((id) => !postRenderedIds.has(id));

		if (hiddenAfterFetchIds.length) {
			revealNeighbors(clickedNode, 'all', {
				linkFilter: expansionLinkFilter,
				restrictToIds: new Set(hiddenAfterFetchIds),
				markSelected: true,
			});
			if (runId !== nonGrayExpandRunId) return;
			spreadNeighbors(clickedNode, new Set(hiddenAfterFetchIds), { duration: revealTiming.animationMs });
		} else if (wave === 1) {
			revealIncidentRenderedLinks(clickedNode, expansionLinkFilter);
		}

		const nextWaveIds = Array.from(new Set([...uniqueWaveFoundIds, ...uniqueNewlyFoundIds]));
		if (nextWaveIds.length === 0) break;

		if (hiddenIds.length || hiddenAfterFetchIds.length) {
			await delay(revealTiming.delayMs);
			if (runId !== nonGrayExpandRunId) return;
		}

		currentWaveIds = nextWaveIds;
	}

	// Final hydration: labels/scopes only — never inject employment graphs on leaf nodes
	// (that was revealing "past direct connections" when a firm was clicked).
	if (currentWaveIds.length && runId === nonGrayExpandRunId) {
		await hydrateExpansionFrontierNodes(currentWaveIds, { includeFirmDetails: false, injectEmploymentGraph: false });
	}

	refreshTraceState({ deferMs: 120 });
	try {
		saveSession();
	} catch (e) {
		/* ignore */
	}
}

export function getNodeExpansionRevealTiming(currentNodeCount = layoutNodes?.length || 0, options: { isUserInitiated?: boolean } = {}) {
	const { isUserInitiated = false } = options;
	const nodeCount = Math.max(0, Number(currentNodeCount) || 0);
	const isLargeGraph = nodeCount > 800;
	const isVeryLargeGraph = nodeCount > 2200;

	if (isUserInitiated) {
		return {
			delayMs:
				isVeryLargeGraph ? 40
				: isLargeGraph ? 20
				: 0,
			animationMs:
				isVeryLargeGraph ? 220
				: isLargeGraph ? 160
				: 110,
		};
	}

	return {
		delayMs:
			isVeryLargeGraph ? 70
			: isLargeGraph ? 35
			: 16,
		animationMs:
			isVeryLargeGraph ? 320
			: isLargeGraph ? 220
			: 160,
	};
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

function isGenericOrPlaceholderLabel(label, group) {
	const text = String(label || '').trim();
	if (!text) return true;
	if (/^node\s+/i.test(text)) return true;
	return isPlaceholderExpansionLabel(text, group);
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
	const currentLabel = String(node.label || '').trim();
	const isNodeIdPlaceholder = node.id && currentLabel.toLowerCase() === `node ${String(node.id).toLowerCase()}`;

	if (node.group === 'individual') {
		const personName = normalizePersonLabel(
			[basic.firstName, basic.middleName, basic.lastName].filter(Boolean).join(' ') ||
				firstMeaningfulText(basic.name, node.name, node.legalName, node.personName, node.displayName, getSourceBackedIndividualName(node)),
		);
		if (personName && (isPlaceholderExpansionLabel(node.label, 'individual') || isNodeIdPlaceholder || personName.length >= currentLabel.length)) {
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
		if (firmName && isGenericOrPlaceholderLabel(firmName, 'firm')) {
			return currentLabel && !isGenericOrPlaceholderLabel(currentLabel, 'firm') ? currentLabel : firstMeaningfulText(currentLabel);
		}
		if (firmName && (isGenericOrPlaceholderLabel(node.label, 'firm') || isNodeIdPlaceholder || firmName.length >= currentLabel.length)) {
			return firmName;
		}
	}
	return firstMeaningfulText(node.label, basic.name, node.name, node.legalName, node.organizationName, node.displayName);
}

function clipFirmLabelAtWord(label, maxChars = 44) {
	const text = formatNodeLabel(label, 'firm');
	if (!text || text.length <= maxChars) return text;
	const clipped = text.slice(0, maxChars + 1);
	const lastBoundary = Math.max(clipped.lastIndexOf(' '), clipped.lastIndexOf('/'), clipped.lastIndexOf('-'));
	if (lastBoundary > Math.floor(maxChars * 0.6)) {
		return clipped.slice(0, lastBoundary).trim();
	}
	return text.slice(0, maxChars).trim();
}

function getRenderedNodeLabel(node, { skipTruncation = false }: { skipTruncation?: boolean } = {}) {
	const preferredLabel = getPreferredNodeLabel(node);
	if (!preferredLabel) return '';
	const isNodeIdLabel = /^Node\s+/i.test(preferredLabel);
	if (!isNodeIdLabel && isPlaceholderExpansionLabel(preferredLabel, node?.group)) return '';
	if (node?.group === 'firm') {
		const fullLabel = formatNodeLabel(preferredLabel, 'firm');
		return !isNodeIdLabel && isPlaceholderExpansionLabel(fullLabel, node?.group) ? '' : fullLabel;
	}
	const formattedLabel = formatNodeLabel(preferredLabel, node?.group);
	return !isNodeIdLabel && isPlaceholderExpansionLabel(formattedLabel, node?.group) ? '' : formattedLabel;
}

function normalizeNodeLabelInPlace(node) {
	if (!node || typeof node !== 'object') return node;
	// Attempt to hydrate from a small persistent client-side label cache so
	// labels survive full page refreshes and slow network fallbacks. Cache is
	// keyed by node.id and stores { label, ts } where ts is epoch ms.
	try {
		if (typeof window !== 'undefined' && window.localStorage) {
			const raw = window.localStorage.getItem('finra_node_label_cache');
			if (raw) {
				const map = JSON.parse(raw || '{}');
				const entry = map[node.id];
				if (entry && entry.label) {
					// Respect cached label only when current node lacks a
					// meaningful label to avoid clobbering freshly-fetched
					// authoritative names.
					const currentLabel = String(node.label || '').trim();
					if (isGenericOrPlaceholderLabel(currentLabel, node.group)) {
						node.label = entry.label;
						if (entry.firmName && (node.group === 'firm' || String(node.id || '').startsWith('firm:'))) {
							node.firmName = entry.firmName;
							if (!node.basicInformation) node.basicInformation = {};
							if (!node.basicInformation.firmName) node.basicInformation.firmName = entry.firmName;
						}
					}
				}
			}
		}
	} catch (e) {
		// ignore cache errors
	}
	const preferredLabel = getPreferredNodeLabel(node);
	if (preferredLabel && !isGenericOrPlaceholderLabel(preferredLabel, node.group)) {
		try {
			if (typeof window !== 'undefined' && window.localStorage && node.id) {
				const key = 'finra_node_label_cache';
				const raw = window.localStorage.getItem(key) || '{}';
				const map = JSON.parse(raw || '{}');
				map[node.id] = {
					label: preferredLabel,
					firmName: node.group === 'firm' ? preferredLabel : undefined,
					ts: Date.now(),
				};
				const TTL = 1000 * 60 * 60 * 24 * 14;
				for (const k of Object.keys(map)) {
					try {
						if (!map[k] || typeof map[k].ts !== 'number' || Date.now() - map[k].ts > TTL) delete map[k];
					} catch {
						delete map[k];
					}
				}
				window.localStorage.setItem(key, JSON.stringify(map));
			}
		} catch (e) {
			// ignore cache write errors
		}
		if (preferredLabel !== node.label) node.label = preferredLabel;
		if (node.group === 'firm') {
			node.firmName = preferredLabel;
			if (!node.basicInformation) node.basicInformation = {};
			node.basicInformation.firmName = preferredLabel;
		}
		return node;
	}

	// If no preferred label exists, avoid leaving the node without any
	// visible label. Numeric-only or placeholder-only labels are treated as
	// placeholders and will be hidden. Use a neutral fallback that doesn't
	// match placeholder patterns so the label remains visible after refresh.
	const currentLabel = String(node.label || '').trim();
	const hasLabel = Boolean(currentLabel && !isPlaceholderExpansionLabel(currentLabel, node.group));
	if (!hasLabel) {
		const idText = String(node.id == null ? '' : node.id).trim();
		if (idText) {
			// "Node <id>" avoids matching the placeholder regexes (e.g.
			// "Person 123" / "Firm 123") while still providing a
			// readable identifier for freshly-added or stub nodes.
			node.label = `Node ${idText}`;
		}
	}
	return node;
}

function normalizeNodeLabelsInPlace(nodes = []) {
	(nodes || []).forEach((node) => {
		normalizeNodeLabelInPlace(node);
	});
	return nodes;
}

export { isNodeInactive, loadPersistedSidebarViewMode, loadSelectionLogBoldPreference, normalizeNodeLabelInPlace, upsertSelectionLogEntry };

function mergeExpansionNodeIntoExistingNode(targetNodeId, incomingNode) {
	if (!targetNodeId || !incomingNode) return;
	const targets = [layoutNodes?.find((node) => node.id === targetNodeId), graphData?.nodes?.find((node) => node.id === targetNodeId)].filter(Boolean);
	const incomingLabel = getExpansionNodeMatchLabel(incomingNode);

	targets.forEach((targetNode) => {
		Object.entries(incomingNode).forEach(([key, value]) => {
			if (key === 'id' || key.startsWith('_') || value == null) return;
			if (key === 'label') {
				if (
					incomingLabel &&
					!isGenericOrPlaceholderLabel(incomingLabel, targetNode.group) &&
					(isGenericOrPlaceholderLabel(targetNode.label, targetNode.group) || String(incomingLabel).length > String(targetNode.label || '').length)
				) {
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
	const renderedNodeById = new Map<string, any>((layoutNodes || []).map((node) => [String(node.id), node]));
	const renderedIds = new Set(renderedNodeById.keys());
	const nodeById = new Map<string, any>((nodes || []).map((node) => [String(node.id), node]));
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
	const fetched = await fetchExpansionDataForNodeIds([clickedNodeId], hops, {
		strictHops: true,
		clickedNodeId,
		// Never server-expand firms (employment rosters). Firm opens use Form BD owners only.
		safeFirmExpand: true,
		maxNeighbors: MAX_AUTO_REVEAL_NEIGHBORS_PER_EXPAND,
	});
	const normalized = matchExistingOnly ? normalizeExpansionPayloadToRenderedMatches(clickedNodeId, fetched.nodes, fetched.links) : fetched;
	if (normalized.nodes.length || normalized.links.length) {
		mergeIntoGraphData(normalized.nodes, normalized.links);
	}
	return normalized;
}

async function materializeRouteSelectionNeighborhood(node, hops: number = getDefaultExpansionHops()) {
	if (!node?.id) return;

	const normalizedHops = Math.max(1, Number(normalizeHighlightHops(hops)) || 1);
	markUserInitiatedGraphExpansion();
	anchorNode(node);
	lastExpandOriginNode = node;

	try {
		if (node.group === 'individual') {
			await ensureIndividualDetail(node, { allowOwnerEvidenceFirmFetch: true });
		} else if (node.group === 'firm') {
			await ensureFirmDetail(node);
		}
	} catch (error) {
		console.warn('Failed to hydrate route-selected node neighborhood:', error);
	}

	try {
		// Cap graph-expand Redis work so deep links remain responsive on a shared Redis instance.
		await Promise.race([ensureExpansionDataForNode(node.id, normalizedHops), new Promise<void>((resolve) => setTimeout(() => resolve(), 4000))]);
	} catch (error) {
		console.warn('Failed to fetch route-selected neighborhood from server:', error);
	}

	// Firms only auto-reveal Form BD "controls" connections (see isFirmControlOnlyExpansionLink);
	// employment/registration history is dashboard-only now for performance.
	revealNeighbors(node, normalizedHops, {
		linkFilter: node.group === 'firm' ? isFirmControlOnlyExpansionLink : isAutoExpansionLink,
		markSelected: true,
	});

	// Re-paint sidebar after neighborhood + owner links land (avoids empty connections until hard refresh).
	if (node.group === 'firm') {
		try {
			await ensureFirmConnections(node);
		} catch {
			/* ignore */
		}
	}
	if (selectedId === node.id) {
		renderSidebar(node);
	}

	refreshTraceState({ deferMs: 120 });
	try {
		saveSession();
	} catch (error) {
		/* ignore */
	}
}

export function handleNodeKeyboardActivation(event, d, activateNode = handleNodeOpen) {
	const isActivationKey = event?.key === 'Enter' || event?.key === ' ' || event?.key === 'Spacebar' || event?.code === 'Enter' || event?.code === 'Space';
	if (!isActivationKey || !d?.id) return false;
	event.preventDefault?.();
	event.stopPropagation?.();
	if (typeof activateNode === 'function') {
		activateNode(event, d);
	}
	return true;
}

// Temporarily fixes (fx/fy) every already-settled node NOT in `allowedMovingIds`
// to its current position, so a simulation reheat only lets the clicked node
// and/or newly revealed neighbors move. Without this, restarting the shared
// force simulation nudges every node on screen (via charge/link/collision
// forces), which makes already-stable connections — including highlighted
// "controls" lines — appear to float across the whole canvas before settling
// back into roughly the same layout. Returns the list of nodes it froze so
// they can be released again once the reheat window ends.
function freezeSettledNodesExcept(allowedMovingIds: Set<any>) {
	if (!Array.isArray(layoutNodes)) return [];
	const frozen = [];
	for (const n of layoutNodes) {
		if (allowedMovingIds.has(n.id)) continue;
		if (n.fx == null && n.fy == null) {
			n.fx = n.x;
			n.fy = n.y;
			frozen.push(n);
		}
	}
	return frozen;
}

function releaseFrozenNodes(frozenNodes) {
	(frozenNodes || []).forEach((n) => {
		n.fx = null;
		n.fy = null;
	});
}

function pinNodeAndReleaseOthers(pinnedNode) {
	if (!pinnedNode?.id || !Array.isArray(layoutNodes)) return;

	// Release every other node's fixed position so the shared force simulation is free
	// to re-settle the whole graph around the newly clicked/pinned node, instead of only
	// letting the clicked node (and any freshly revealed neighbors) move.
	for (const n of layoutNodes) {
		if (n.id === pinnedNode.id) {
			n.fx = n.x;
			n.fy = n.y;
		} else {
			n.fx = null;
			n.fy = null;
		}
	}

	if (simulation) {
		if (nodePinReleaseTimer) {
			clearTimeout(nodePinReleaseTimer);
			nodePinReleaseTimer = null;
		}
		simulation.alphaTarget(0.15).restart();
		nodePinReleaseTimer = window.setTimeout(() => {
			simulation.alphaTarget(0);
			nodePinReleaseTimer = null;
		}, 300);
	}
}

export async function handleNodeOpen(event, d) {
	event.stopPropagation();
	pinNodeAndReleaseOthers(d);
	openNodeWithExpansion(d);
}

export function shouldAutoRevealNodeConnections(node) {
	// Firms must also auto-reveal: employment edges often live only in reverse indexes /
	// /connections payloads, not the mono session graph. Returning false left firm nodes
	// detail-only after the binary/primed cache update.
	return Boolean(node?.group);
}

export function shouldAutoExpandRouteSelection(targetNodeId: string | null | undefined, currentSelectedId: string | null | undefined) {
	const normalizedTargetNodeId = String(targetNodeId || '').trim();
	if (!normalizedTargetNodeId) return false;
	return normalizedTargetNodeId !== String(currentSelectedId || '').trim();
}

export function getAutoExpansionHopsForNode(node, requestedHops = getDefaultClickExpansionHops()) {
	const normalizedHops = normalizeHighlightHops(requestedHops);
	if (normalizedHops === 'all') return normalizedHops;
	// Clicks always expand exactly the requested hop count (default 1). Never bump dense
	// firms/people to 2 hops — that revealed nodes past current direct connections.
	return Math.max(1, Number(normalizedHops) || 1);
}

const nodeExpansionQueue: Array<{
	node: any;
	options: {
		focus?: boolean;
		pulse?: boolean;
		focusDuration?: number;
	};
}> = [];
let isProcessingNodeExpansion = false;
const NODE_EXPANSION_COOLDOWN_MS = 80; // Keep the interaction loop responsive on low-powered machines.
const NODE_EXPANSION_DEFER_MS = 24;
const pendingNodeExpansionIds = new Set<string>();

export function scheduleNodeExpansion(
	node: any,
	options: {
		focus?: boolean;
		pulse?: boolean;
		focusDuration?: number;
	} = {},
	runner: (nodeArg: any, taskOptions: any) => Promise<void> | void = enqueueNodeExpansion,
) {
	const nodeId = node?.id != null ? String(node.id) : '';
	if (!nodeId || pendingNodeExpansionIds.has(nodeId)) return null;
	pendingNodeExpansionIds.add(nodeId);

	const runTask = () => {
		if (!pendingNodeExpansionIds.has(nodeId)) return;
		void Promise.resolve(runner(node, options)).finally(() => {
			pendingNodeExpansionIds.delete(nodeId);
		});
	};

	const delayMs = (layoutNodes?.length || 0) > 250 ? NODE_EXPANSION_DEFER_MS : 0;
	if (typeof window !== 'undefined' && typeof window.setTimeout === 'function') {
		window.setTimeout(runTask, delayMs);
	} else {
		runTask();
	}

	return { cancel: () => pendingNodeExpansionIds.delete(nodeId) };
}

async function enqueueNodeExpansion(node: any, options: any = {}) {
	nodeExpansionQueue.push({ node, options });
	if (isProcessingNodeExpansion) return;

	isProcessingNodeExpansion = true;
	try {
		while (nodeExpansionQueue.length > 0) {
			const task = nodeExpansionQueue.shift();
			if (task) {
				try {
					await openNodeWithExpansionTask(task.node, task.options);
					if (nodeExpansionQueue.length > 0) {
						await new Promise((resolve) => setTimeout(resolve, NODE_EXPANSION_COOLDOWN_MS));
					}
				} catch (e) {
					console.error('Sequenced node expansion failed:', e);
				}
			}
		}
	} finally {
		isProcessingNodeExpansion = false;
	}
}

function openNodeWithExpansion(
	d,
	options: {
		focus?: boolean;
		pulse?: boolean;
		focusDuration?: number;
	} = {},
) {
	if (!d?.id) return;

	selectNode(d, {
		skipAutoExpand: true,
		focus: options.focus,
		pulse: options.pulse,
		focusDuration: options.focusDuration,
	});

	scheduleNodeExpansion(d, options, enqueueNodeExpansion);
}

async function openNodeWithExpansionTask(
	d,
	options: {
		focus?: boolean;
		pulse?: boolean;
		focusDuration?: number;
	} = {},
) {
	const { focus = false, pulse = false, focusDuration = 300 } = options;
	const clickExpansionHops = getAutoExpansionHopsForNode(d);
	markUserInitiatedGraphExpansion();
	anchorNode(d);
	lastExpandOriginNode = d;
	const shouldReapplySelection = !selectedId || String(selectedId) === String(d?.id || '');
	if (shouldReapplySelection) {
		selectNode(d, {
			skipAutoExpand: true,
			focus,
			pulse,
			focusDuration,
		});
	}

	try {
		if (shouldAutoRevealNodeConnections(d)) {
			await expandNodeThroughNonGrayHops(d, clickExpansionHops);
		} else {
			if (d.group === 'firm') {
				await ensureFirmDetail(d);
			}
			const fetched = await ensureExpansionDataForNode(d.id, clickExpansionHops);
			if (fetched && (fetched.nodes?.length || fetched.links?.length)) {
				revealNeighbors(d, clickExpansionHops, {
					linkFilter: isAutoExpansionLink,
					markSelected: true,
				});
			}
			if (selectedId === d.id) {
				renderSidebar(d);
			}
		}
	} catch (err) {
		console.error('Node expansion failed:', err);
		refreshTraceState({ deferMs: 120 });
	}
	void fetchCacheStats();
}

function selectNode(
	d,
	options: {
		persist?: boolean;
		skipProfileSync?: boolean;
		skipAutoExpand?: boolean;
		skipLog?: boolean;
		focus?: boolean;
		pulse?: boolean;
		focusDuration?: number; // Default is 300ms
		syncRoute?: boolean;
		preserveRestoreTimer?: boolean;
	} = {},
) {
	lastArrowNavCoord = null;
	stopSearchPulseLoop();
	updateFocusReadout(null);
	const {
		persist = true,
		skipProfileSync = false,
		skipAutoExpand = false,
		skipLog = false,
		focus = false,
		pulse = false,
		focusDuration = 300,
		syncRoute = true,
		// Route-driven auto-selection (e.g. landing on /firm/<id> after a full page
		// reload from the dashboard's "Graph" back-link) sets this so it doesn't
		// cancel a pending saved-session restore timer; restoreHighlightStateFromSession
		// merges this node's selection into the fuller restored highlight set instead.
		preserveRestoreTimer = false,
	} = options;

	// Clear any previous transient locator pulse immediately so the blue ring can
	// move cleanly to the newly selected node.
	stopNodePulseLoop();
	if (selectionRestoreTimer && !preserveRestoreTimer) {
		clearTimeout(selectionRestoreTimer);
		selectionRestoreTimer = null;
	}

	if (selectedId && String(selectedId) !== String(d?.id || '')) {
		releasePinnedSelectedNodeAnchor(selectedId);
	}

	// Accumulate highlight roots: each selection stays lit (node + 1-hop neighbors/links)
	// alongside prior selections. Clear Highlight resets the set. Force 1 hop on click
	// even if runtime selection hops were raised (sliders are currently hidden).
	upsertHighlightedSelection(d.id, 1, { replace: false });
	selectedId = d.id;
	visitedNodeIds.add(d.id);
	if (syncRoute) {
		emitSelectedNodeRoute(d.id);
	}
	if (!skipLog) {
		addToSelectionLog(d);
	}
	refreshTraceState();
	renderSidebar(d);
	if (focus) {
		focusNodeById(d.id, { duration: focusDuration, pulse });
	}
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

	// Intentionally do not pan/zoom the viewport on selection. The selected node
	// is located via a persistent blue ring plus a short pulse instead.
	// Always show blue location ring after selection. Use any requested pulse duration
	// provided by route requests (e.g. sidebar links), otherwise default to 4000ms.
	const defaultPulseMs = 4000;
	const finalPulseMs = typeof pendingRoutePulseDuration === 'number' && Number.isFinite(pendingRoutePulseDuration) ? pendingRoutePulseDuration : defaultPulseMs;
	// Clear consumed pending pulse value so it doesn't affect subsequent selections
	pendingRoutePulseDuration = null;
	pulseNodeHighlightById(d.id, { duration: finalPulseMs });

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

	let expansionPromise = Promise.resolve();
	if (!skipAutoExpand) {
		const clickExpansionHops = getAutoExpansionHopsForNode(d);
		markUserInitiatedGraphExpansion();
		anchorNode(d);
		lastExpandOriginNode = d;
		expansionPromise = (
			shouldAutoRevealNodeConnections(d) ?
				expandNodeThroughNonGrayHops(d, clickExpansionHops)
			:	ensureExpansionDataForNode(d.id, clickExpansionHops).then((fetched) => {
					if (fetched && (fetched.nodes?.length || fetched.links?.length)) {
						revealNeighbors(d, clickExpansionHops, {
							linkFilter: isAutoExpansionLink,
							markSelected: true,
						});
					}
				}))
			.then(() => {
				// Always re-render firm/person sidebar after neighbors arrive — previously only the
				// non-auto-reveal path did this, so Current/Previous Connections stayed empty until hard refresh.
				if (selectedId === d.id) {
					renderSidebar(d);
				}
			})
			.finally(() => {
				refreshTraceState({ deferMs: 120 });
				try {
					saveSession();
				} catch (e) {
					/* ignore */
				}
			});
		void fetchCacheStats();
	}

	return expansionPromise;
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

	const liveNodeById = new Map<string, any>((layoutNodes || []).map((node) => [String(node.id), node]));
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
// Bring any hidden neighbors (present in graphData but not yet rendered) into
// the live graph without a full re-render.
function revealNeighbors(
	clickedNode,
	hops: number | 'all' = getDefaultExpansionHops(),
	options: {
		linkFilter?: ((link: any) => boolean) | null;
		restrictToIds?: Set<string> | null;
		markSelected?: boolean;
	} = {},
) {
	if (!graphData || !layoutNodes || !layoutLinks || !nodeGroup || !linkGroup) return;
	const { linkFilter = null, restrictToIds = null, markSelected = false } = options;

	const renderedIds = new Set(layoutNodes.map((n) => n.id));

	// Use cached adjacency from the full graph data
	const fullAdj = getFullAdjacencyMap();
	const candidateLinks = (graphData.links || []).filter((link) => (typeof linkFilter === 'function' ? linkFilter(link) : true));

	// BFS to collect ids up to `hops` away; hops === 'all' means unlimited
	const dist = new Map<string, number>();
	const q: string[] = [clickedNode.id];
	dist.set(clickedNode.id, 0);
	for (let i = 0; i < q.length; i++) {
		const id = q[i];
		const d = dist.get(id);
		if (hops !== 'all' && d >= hops) continue;

		const neighbors = fullAdj.get(id) || [];
		neighbors.forEach(({ nodeId: nid, link }) => {
			if (typeof linkFilter === 'function' && !linkFilter(link)) return;
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
	const revealBatches = (() => {
		const plan = getLargeNodeRevealBatchPlan(hiddenIds.length, layoutNodes.length);
		if (!plan.shouldBatch || !hiddenIds.length) return [hiddenIds];
		const batches = [];
		for (let index = 0; index < hiddenIds.length; index += plan.batchSize) {
			batches.push(hiddenIds.slice(index, index + plan.batchSize));
		}
		return batches;
	})();

	let activeRenderedIds = new Set(renderedIds);
	const revealNextBatch = (batchIndex = 0) => {
		const renderBatch = () => {
			const batchHiddenIds = revealBatches[Math.min(batchIndex, revealBatches.length - 1)] || [];
			const batchNodes =
				batchHiddenIds.length ?
					placeNodesNearConnections(
						clickedNode,
						graphData.nodes.filter((n) => batchHiddenIds.includes(n.id)),
						candidateLinks,
						dist,
					)
				:	[];
			const existingNodeIds = new Set((Array.isArray(layoutNodes) ? layoutNodes : []).map((node) => node.id));
			const mergeResult = mergeIncomingNodesIntoExistingNodes(layoutNodes, batchNodes);
			const newRenderNodes = mergeResult.nodes.filter((node) => !existingNodeIds.has(node.id));
			layoutNodes = mergeResult.nodes;
			activeRenderedIds = new Set(layoutNodes.map((node) => node.id));
			const batchNodeIds = new Set(newRenderNodes.map((n) => n.id));
			const batchLinks = rewriteLinksForNodeIdMap(
				candidateLinks
					.filter((link) => {
						const srcId = link.source?.id ?? link.source;
						const tgtId = link.target?.id ?? link.target;
						if (!srcId || !tgtId) return false;
						const srcRendered = activeRenderedIds.has(srcId);
						const tgtRendered = activeRenderedIds.has(tgtId);
						if (!srcRendered && !batchNodeIds.has(srcId)) return false;
						if (!tgtRendered && !batchNodeIds.has(tgtId)) return false;
						const alreadyHas = layoutLinks.some((el) => {
							const es = el.source?.id ?? el.source;
							const et = el.target?.id ?? el.target;
							return es === srcId && et === tgtId;
						});
						return !alreadyHas;
					})
					.map((link) => ({ ...link })),
				mergeResult.idRewriteMap,
			);

			if (markSelected && clickedNode?.id && batchIndex === 0) {
				visitedNodeIds.add(clickedNode.id);
				markNodeSelected(layoutNodes.find((node) => node.id === clickedNode.id) || clickedNode, { persist: false });
				reapplySelectionState();
				refreshGraphColors();
			}

			if (batchNodes.length === 0 && batchLinks.length === 0) {
				if (batchIndex < revealBatches.length - 1) {
					const plan = getLargeNodeRevealBatchPlan(hiddenIds.length, layoutNodes.length);
					setTimeout(
						() => {
							if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
								window.requestAnimationFrame(() => revealNextBatch(batchIndex + 1));
							} else {
								revealNextBatch(batchIndex + 1);
							}
						},
						revealBatches.length > 1 ? Math.max(16, plan.batchDelayMs) : 0,
					);
				} else if (markSelected && clickedNode) {
					reapplySelectionState();
					try {
						if (typeof window !== 'undefined') {
							if (selectedId) {
								window.dispatchEvent(new CustomEvent(ROUTE_NODE_REQUEST_EVENT, { detail: { nodeId: selectedId } }));
							}
						}
					} catch (e) {
						/* ignore */
					}
					refreshGraphColors();
					try {
						saveSession();
					} catch (e) {
						/* ignore */
					}
				}
				return;
			}

			layoutLinks.push(...batchLinks);
			resolveLinkEndpoints(layoutLinks, layoutNodes);
			applyGraphDerivedNodeMetrics(layoutNodes, layoutLinks);

			newRenderNodes.forEach((node) => {
				activeRenderedIds.add(node.id);
			});

			const individuals = batchNodes
				.filter((n) => n.group === 'individual')
				.map((n) => Number(String(n.id).split(':').pop()))
				.filter(Number.isFinite);
			const firms = batchNodes
				.filter((n) => n.group === 'firm')
				.map((n) => Number(String(n.id).split(':').pop()))
				.filter(Number.isFinite);
			if (individuals.length || firms.length) {
				syncProfileSelection({ individuals, firms });
			}

			neighborMap = buildNeighborMap(layoutNodes, layoutLinks);

			if (graphData && batchIndex === 0) updateSubsetInfo(layoutNodes.length, graphData.nodes.length);

			refreshLayeredLinkSelections({ enterDuration: batchIndex === 0 ? 220 : 90 });

			const allNodes = nodeGroup.selectAll('g.fg-node').data(layoutNodes, (d) => d.id);
			const enteredNodes = allNodes.enter().append('g').attr('class', 'fg-node').attr('opacity', 0).call(fluidDrag()).on('click', handleNodeOpen).call(bindHoverAndFocus);

			if (batchIndex === 0) {
				enteredNodes.transition().duration(220).ease(d3.easeCubicOut).attr('opacity', 1);
			} else {
				enteredNodes.attr('opacity', 1);
			}
			nodeSel = nodeGroup.selectAll('g.fg-node');
			linkSel = selectRenderedLinkLines();
			rerenderGraphNodesByIds(getImpactedNodeIds(batchNodes, batchLinks));
			reapplySelectionState();

			refreshGraphColors();
			if (activeFindQuery) refreshFindMatches(activeFindQuery, { preserveActiveMatch: true });
			refreshTraceState();

			let _revealTick = 0;
			bindSimulationTickHandler(simulation, () => {
				_revealTick++;
				if (layoutNodes.length > 1000 && simulation.alpha() > 0.05 && _revealTick % 10 !== 0) return;
				if (layoutNodes.length > 300 && simulation.alpha() > 0.1 && _revealTick % 4 !== 0) return;

				scheduleGraphTickPositions(linkSel, nodeSel, arrowSel);
			});

			refreshSoftLocationGroupingForces(layoutNodes);
			simulation.nodes(layoutNodes);
			simulation.force('link').links(layoutLinks);
			simulation.force('collision').radius((d) => getNodeCollisionRadius(d, layoutNodes.length));

			simulation.alpha(getIncrementalRestartAlpha(layoutNodes.length, batchNodes.length)).restart();

			if (batchIndex < revealBatches.length - 1) {
				const plan = getLargeNodeRevealBatchPlan(hiddenIds.length, layoutNodes.length);
				setTimeout(
					() => {
						if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
							window.requestAnimationFrame(() => revealNextBatch(batchIndex + 1));
						} else {
							revealNextBatch(batchIndex + 1);
						}
					},
					revealBatches.length > 1 ? Math.max(16, plan.batchDelayMs) : 0,
				);
				return;
			}

			// Final batch finished! If the graph is huge, use WASM to compute final positions instantly!
			if (layoutNodes.length > 500) {
				simulation.stop();
				const main = document.getElementById('fg-main');
				const W = main ? main.clientWidth : 800;
				const H = main ? main.clientHeight : 600;
				const nodesPayload = layoutNodes.map((n) => ({ id: n.id, x: n.x, y: n.y, group: n.group, _deg: n._deg }));
				const linksPayload = layoutLinks.map((l) => ({ source: l.source?.id || l.source, target: l.target?.id || l.target }));
				import('@/lib/graphLayoutWorker').then((mod) => {
					const createWorker = mod.default || mod.createGraphLayoutWorker;
					if (typeof createWorker === 'function') {
						const { compute } = createWorker();
						compute(nodesPayload, linksPayload, W, H)
							.then((positions) => {
								if (Array.isArray(positions)) {
									const posMap = new Map(positions.map((p) => [String(p.id), p]));
									for (const ln of layoutNodes) {
										const p = posMap.get(String(ln.id));
										if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
											ln.x = p.x;
											ln.y = p.y;
										}
									}
									animateToWasmPositions(2500); // Animate smoothly using D3 transitions directly
								}
							})
							.catch((e) => console.error('WASM compute failed', e));
					}
				});
			}

			try {
				saveSession();
			} catch (e) {
				/* ignore */
			}
		};

		if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
			window.requestAnimationFrame(renderBatch);
		} else {
			renderBatch();
		}
	};

	revealNextBatch(0);
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
	// #fg-short-detail no longer exists in the current sidebar markup (replaced by
	// .fg-sb-title), but document.title updates must still happen regardless of
	// whether that legacy element is present.
	const el = document.getElementById('fg-short-detail');
	if (!d) {
		if (el) el.textContent = '';
		try {
			if (typeof window !== 'undefined') {
				document.title = '';
			}
		} catch {}
		return;
	}
	const id = d?.crd || d?.firmId || d?.id || '';
	const type = d?.group ? String(d.group).toUpperCase() : 'NODE';
	const label = getPreferredNodeLabel(d) || 'Selected node';
	const suffix = id ? ` • ${id}` : '';
	if (el) el.textContent = `${type}: ${label}${suffix}`;
	try {
		if (typeof window !== 'undefined') {
			const idLabel = id ? ` / CRD# ${id}` : '';
			document.title = `${label}${idLabel}`;
		}
	} catch {}
}

function clearHighlights() {
	// Clear line/hop emphasis only. Keep selectedId + persistentSelectedIds so every
	// node the user has already selected/expanded retains selected chrome.
	disableAllTraceModes();
	if (!nodeSel) return;
	clearFetchStatus();
	if (selectionRestoreTimer) {
		clearTimeout(selectionRestoreTimer);
		selectionRestoreTimer = null;
	}
	stopNodePulseLoop();
	hoveredNodeId = null;
	focusedNodeId = null;
	highlightedSelections = [];
	clearFindMatches();
	// While Log Bold is on, every selection-log individual normally acts as a highlight
	// root (computeHighlightState), which would otherwise make Clear Highlight a no-op.
	// Suppress that behavior here (without disabling Log Bold itself) so lines/hops
	// actually reset. The suppression now persists across subsequent selections/hover/
	// focus so newly selected nodes highlight only themselves; it only lifts when the
	// user explicitly re-enables Log Bold via the toggle action.
	logBoldHighlightRootsSuppressed = true;
	// Ensure active selection remains in the durable selected set.
	if (selectedId) rememberPersistentSelection(selectedId);
	reapplySelectionState();
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

	const hasNormalHighlights = state.linkKeys.size > 0;

	if (!hasNormalHighlights && !isTraceMode && !isTraceLogMode) {
		const selectionLinkEmphasis = getSelectionLinkEmphasis();
		// restore default appearance (both attributes and inline styles)
		linkSel
			.style('filter', null)
			.style('stroke-opacity', null)
			.style('opacity', null)
			.attr('stroke', (d) => getLinkColor(d))
			.attr('stroke-opacity', (d) => getSelectionLinkOpacity(d, selectionLinkEmphasis))
			.attr('data-fg-base-stroke-width', (d) => {
				const isGrayLine = hasInactiveEndpoint(d) || isPreviousEmploymentLink(d) || isForcedGrayConnectionLink(d);
				const highlightedStrokeWidth =
					isGrayLine ? 1.05
					: isControlRelationship(d) ? 1.9
					: usesCurrentEmploymentStyling(d) ? 1.85
					: 1.4;
				return String(highlightedStrokeWidth * selectionLinkEmphasis.strokeWidthScale);
			})
			.attr('stroke-width', (d) => {
				const isGrayLine = hasInactiveEndpoint(d) || isPreviousEmploymentLink(d) || isForcedGrayConnectionLink(d);
				const highlightedStrokeWidth =
					isGrayLine ? 1.05
					: isControlRelationship(d) ? 1.9
					: usesCurrentEmploymentStyling(d) ? 1.85
					: 1.4;
				const baseWidth = highlightedStrokeWidth * selectionLinkEmphasis.strokeWidthScale;
				return getScaledLinkStrokeWidth(baseWidth);
			})
			.style('--fg-link-width', (d) => {
				const isGrayLine = hasInactiveEndpoint(d) || isPreviousEmploymentLink(d) || isForcedGrayConnectionLink(d);
				const highlightedStrokeWidth =
					isGrayLine ? 1.05
					: isControlRelationship(d) ? 1.9
					: usesCurrentEmploymentStyling(d) ? 1.85
					: 1.4;
				const baseWidth = highlightedStrokeWidth * selectionLinkEmphasis.strokeWidthScale;
				return `${getScaledLinkStrokeWidth(baseWidth)}px`;
			})
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

		const isGrayLine = hasInactiveEndpoint(d) || isPreviousEmploymentLink(d) || isForcedGrayConnectionLink(d);

		if (isTraceShortest || isTraceLongest || isTraceLog) {
			sel.style('filter', null).style('opacity', null).style('stroke-opacity', null).attr('stroke-opacity', 1);
			// CSS classes handle the stroke and width
			return;
		}

		if (hasNormalHighlights) {
			if (connected) {
				sel.classed('fg-link--depth-active', true);
				const highlightedStrokeWidth =
					isGrayLine ? 1.05
					: isControlRelationship(d) ?
						connectedToRoot ? 1.9
						:	1.55
					: usesCurrentEmploymentStyling(d) ?
						connectedToRoot ? 1.85
						:	1.5
					: connectedToRoot ? 1.4
					: 1.15;
				const activeStrokeOpacity = getSelectionLinkOpacity(d, selectionLinkEmphasis, { connected: true });
				sel
					.style('filter', selectionLinkEmphasis.showActiveFilter ? null : 'none')
					.style('opacity', null)
					.style('stroke-opacity', null)
					.attr('stroke', getLinkHighlightColor(d))
					.attr('stroke-opacity', activeStrokeOpacity)
					.attr('data-fg-base-stroke-width', `${highlightedStrokeWidth * selectionLinkEmphasis.strokeWidthScale}`)
					.attr('stroke-width', getScaledLinkStrokeWidth(highlightedStrokeWidth * selectionLinkEmphasis.strokeWidthScale))
					.style('--fg-link-width', `${getScaledLinkStrokeWidth(highlightedStrokeWidth * selectionLinkEmphasis.strokeWidthScale)}px`);
			} else {
				sel.classed('fg-link--depth-recessed', true);
				const recessedLinkOpacity = isGrayLine ? 0.58 : 0.56;
				const recessedStrokeOpacity = isGrayLine ? 0.64 : 0.46;
				const recessedStrokeWidth = isGrayLine ? 0.65 : 0.82;
				sel
					.style('filter', null)
					.style('opacity', recessedLinkOpacity)
					.style('stroke-opacity', null)
					.attr('stroke', getLinkColor(d))
					.attr('stroke-opacity', recessedStrokeOpacity)
					.attr('data-fg-base-stroke-width', `${recessedStrokeWidth}`)
					.attr('stroke-width', getScaledLinkStrokeWidth(recessedStrokeWidth))
					.style('--fg-link-width', `${getScaledLinkStrokeWidth(recessedStrokeWidth)}px`);
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
				.attr('data-fg-base-stroke-width', String(getLinkBaseWidth(d)))
				.attr('stroke-width', getScaledLinkStrokeWidth(getLinkBaseWidth(d)))
				.style('--fg-link-width', getLinkWidthPx(d));
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
	if (!layoutNodes || !layoutLinks || !nodeSel || !linkSel || !simulation) return;
	if (spreadAnimId) {
		cancelAnimationFrame(spreadAnimId);
		spreadAnimId = null;
	}
	if (spreadReleaseTimer) {
		clearTimeout(spreadReleaseTimer);
		spreadReleaseTimer = null;
	}
	if (activeSpreadFrozenNodes.length) {
		releaseFrozenNodes(activeSpreadFrozenNodes);
		activeSpreadFrozenNodes = [];
	}

	const { duration = 240 } = options;

	// Find all direct neighbor IDs using the cached adjacency map.
	const neighborIdSet =
		neighborIds instanceof Set ? new Set(neighborIds)
		: Array.isArray(neighborIds) ? new Set(neighborIds)
		: getNeighborIds(clickedNode.id);
	if (neighborIdSet.size === 0) return;

	// For performance, we can skip the animation and just update positions.
	// The user is OK with reduced animation. Freeze every already-settled node
	// first so this reheat only lets the clicked node and the newly revealed
	// neighbors move — otherwise the whole graph (and its highlighted "controls"
	// lines) visibly floats around before re-settling.
	const allowedMoving = new Set(neighborIdSet);
	allowedMoving.add(clickedNode.id);
	const frozen = freezeSettledNodesExcept(allowedMoving);
	activeSpreadFrozenNodes = frozen;
	simulation.alpha(0.1).restart();
	spreadReleaseTimer = setTimeout(() => {
		simulation.stop();
		releaseFrozenNodes(activeSpreadFrozenNodes);
		activeSpreadFrozenNodes = [];
		spreadReleaseTimer = null;
	}, 300);
	return;

	// The animation code below is being bypassed for performance.
	const nodeById = new Map<string, any>(layoutNodes.map((d) => [String(d.id), d]));

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
		nodeSel.filter((d) => neighborIdSet.has(d.id)).attr('transform', (d) => `translate(${Number.isFinite(d.x) ? d.x : 0},${Number.isFinite(d.y) ? d.y : 0})`);

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
	const { duration = 440, pulse = false } = options;
	try {
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
		svgSel.transition().duration(duration).ease(d3.easeCubicInOut).call(zoomBehavior.transform, d3.zoomIdentity.translate(tx, ty).scale(k));

		// transient highlight: enlarge circle briefly
		try {
			nodeSel
				.filter((n) => n.id === id)
				.select('circle')
				.transition()
				.duration(320)
				.ease(d3.easeCubicOut)
				.attr('r', (n) => (n._vizHalf || 6) * 1.6)
				.transition()
				.duration(360)
				.ease(d3.easeCubicInOut)
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

function focusNodesInMainArea(nodeIds, { duration = 720, maxScale = 1.1 }: { duration?: number; maxScale?: number } = {}) {
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
			svgSel.transition().duration(duration).ease(d3.easeCubicInOut).call(zoomBehavior.transform, target);
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
	if (typeof window !== 'undefined' && typeof window.innerWidth === 'number') {
		return window.innerWidth <= 900;
	}
	// Fallback: treat as desktop if window is not available
	return false;
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

				<div class="fg-log-drawer-actions-row fg-log-drawer-actions-row--secondary">
					<button
						data-fg-selection-log-action="copy-all"
						class="fg-ghost-btn fg-btn-sm"
						type="button"
						title="Copy all entries">
						Copy All
					</button>
					<button
						data-fg-selection-log-action="copy-link"
						class="fg-ghost-btn fg-btn-sm"
						type="button"
						title="Copy a shareable link to the logged nodes">
						Copy Link
					</button>
				</div>
				<div class="fg-log-drawer-actions-row fg-log-drawer-actions-row--tertiary">
					<button
						data-fg-selection-log-action="clear"
						class="fg-ghost-btn fg-btn-sm"
						type="button"
						title="Clear log">
						Clear
					</button>
					<button
						data-fg-selection-log-action="edit"
						class="fg-ghost-btn fg-btn-sm"
						type="button"
						title="Edit selection log entries">
						Edit
					</button>
				</div>
				<div class="fg-log-drawer-actions-row">
					<input type="text" class="fg-selection-log-filter" placeholder="Filter log..." value="${selectionLogFilterText.replace(/"/g, '&quot;')}" style="width: 100%; padding: 4px 8px; border: 1px solid var(--fg-border); border-radius: 4px; background: var(--fg-bg-secondary); color: var(--fg-text);" />
				</div>
			</div>
			<div id="fg-sidebar-selection-log-list" class="fg-selection-log-list fg-selection-log-list--sidebar">
			</div>
			<div id="fg-sidebar-selection-log-templates" class="fg-selection-log-templates-host"></div>
		</div>
	`;
}

// Applies the "Filter connections…" search term to a rendered connections
// scope: hides non-matching cards (data-fg-filter-text) and collapses section
// titles/timelines left with no visible cards. Shared by the live 'input'
// listener and renderSidebar() (so a persisted query re-applies after a
// re-render triggered by selecting a different node).
function applyConnectionsFilterToScope(scope: HTMLElement, tags: string[], liveText: string) {
	const previewUnfiltered = shouldPreviewUnfilteredConnections({
		focused: sidebarConnectionsFilterFocused,
		liveText,
		justCommitted: sidebarConnectionsFilterJustCommitted,
	});
	const active =
		sidebarConnectionsFilterEnabled &&
		!previewUnfiltered &&
		!(sidebarConnectionsFilterFocused && String(liveText || '').trim()) &&
		tags.length > 0;
	const cards = scope.querySelectorAll<HTMLElement>('[data-fg-filter-text]');
	cards.forEach((card) => {
		const text = card.getAttribute('data-fg-filter-text') || '';
		card.classList.toggle('fg-filter-hidden', active && !matchesFilterTags(text, tags, liveText));
	});
	// Hide section titles/timelines that have no visible cards left
	const sections = scope.querySelectorAll<HTMLElement>('[data-fg-connections-section]');
	sections.forEach((titleEl) => {
		const timelineEl = titleEl.nextElementSibling as HTMLElement | null;
		if (!timelineEl || !timelineEl.classList.contains('fg-timeline')) return;
		const visibleCount = timelineEl.querySelectorAll('[data-fg-filter-text]:not(.fg-filter-hidden)').length;
		const shouldHide = active && visibleCount === 0;
		titleEl.classList.toggle('fg-filter-hidden', shouldHide);
		timelineEl.classList.toggle('fg-filter-hidden', shouldHide);
	});
}

// Renders the tag chips + live-text input for the sidebar's "Filter connections…" row,
// mirroring the dashboard's FilterTagsInput (src/app/dashboard/page.tsx) so both surfaces
// share the same look/behavior and the same underlying localStorage state (./filterTags.ts).
function renderConnectionsFilterTagsHtml() {
	const chips = sidebarConnectionsFilterTags
		.map(
			(tag) =>
				`<span class="fg-filter-tag-chip" style="display:inline-flex;align-items:center;gap:4px;padding:3px 6px 3px 8px;border-radius:12px;background:rgba(59,130,246,0.18);border:1px solid rgba(59,130,246,0.45);color:var(--fg-text);font-size:11px;font-weight:600;white-space:nowrap;">${esc(
					tag,
				)}<button type="button" class="fg-filter-tag-remove" data-fg-filter-tag="${esc(tag).replace(/"/g, '&quot;')}" aria-label="Remove filter tag ${esc(
					tag,
				)}" style="display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border:none;border-radius:50%;background:transparent;color:inherit;cursor:pointer;font-size:11px;line-height:1;padding:0;">×</button></span>`,
		)
		.join('');
	return `<div style="display:flex;flex-wrap:wrap;align-items:center;gap:8px;width:100%;">
		<label class="fg-filter-enabled-label" style="display:inline-flex;align-items:center;gap:4px;flex:0 0 auto;font-size:11px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;color:var(--fg-text);cursor:pointer;white-space:nowrap;">
			<input type="checkbox" class="fg-filter-enabled" ${sidebarConnectionsFilterEnabled ? 'checked' : ''} aria-label="Apply filter tags" />
			Tags
		</label>
		<div class="fg-filter-tags-wrap" style="display:flex;flex-wrap:wrap;align-items:center;gap:6px;flex:1 1 160px;min-width:140px;padding:4px 6px;border:1px solid var(--fg-border);border-radius:6px;background:var(--fg-bg-secondary);${sidebarConnectionsFilterEnabled ? '' : 'opacity:0.55;'}">
		${chips}
		<input type="text" class="fg-connections-filter" placeholder="${sidebarConnectionsFilterTags.length ? 'Add another filter…' : 'Filter connections…'}" value="${sidebarConnectionsFilterQuery.replace(/"/g, '&quot;')}" style="flex:1 1 120px;min-width:120px;border:none;outline:none;background:transparent;color:var(--fg-text);font-size:12px;padding:4px;" />
		</div>
	</div>`;
}

function renderSidebar(d) {
	const el = document.getElementById('fg-sidebar-inner');
	const side = document.getElementById('fg-sidebar');
	if (!el || !side) {
		return;
	}
	// Support rendering a minimal default sidebar when no node is selected.
	if (!d) {
		sidebarSelectedNode = null;
		if (sidebarViewMode === 'none') {
			sidebarViewMode = loadPersistedSidebarViewMode();
		}
		const preserveExpandedState = sidebarViewMode !== 'none';
		el.innerHTML = renderNoSelectionSidebar();
		if (sidebarViewMode === 'log') {
			const body = el.querySelector('.fg-sb-body');
			if (body) {
				body.outerHTML = renderSidebarSelectionLogBody();
			}
		}
		if (side) side.classList.remove('hidden');
		document.getElementById('fg-sidebar-backdrop')?.classList.remove('hidden');
		if (side) side.dataset.displayedId = '';
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
			// no short detail to update when no selection
		} catch (e) {
			/* no-op */
		}
		try {
			if (side) side.dataset.renderedByClient = '1';
			if (typeof window !== 'undefined') (window as any).__FG_SIDEBAR_RENDERED = true;
		} catch (e) {
			/* ignore */
		}
		openSidebarToggles();
		return;
	}
	const previousDisplayedId = side?.dataset.displayedId || '';
	sidebarSelectedNode = d;
	// Ensure known connection floor is computed and persisted for this node so its
	// visual size is correct on first render (getKnownNodeConnectionFloor will
	// write to localStorage when appropriate).
	try {
		getKnownNodeConnectionFloor(d);
	} catch {}
	if (previousDisplayedId !== (d?.id || '')) {
		sidebarSourceToggle = 'finra';
	}
	if (sidebarViewMode === 'none') {
		sidebarViewMode = loadPersistedSidebarViewMode();
	}
	const preserveExpandedState = sidebarViewMode !== 'none';
	el.innerHTML =
		d.group === 'firm' ? renderFirmDetail(d)
		: d.group === 'entity' ? renderEntityDetail(d)
		: renderPersonDetail(d);
	// Re-apply the persisted connections filter (tags + live text), since the freshly rendered
	// cards above start fully visible regardless of any earlier filtering.
	if (sidebarConnectionsFilterQuery || sidebarConnectionsFilterTags.length > 0) {
		el.querySelectorAll<HTMLElement>('.fg-connections-filter-scope').forEach((scope) => {
			applyConnectionsFilterToScope(scope, sidebarConnectionsFilterTags, sidebarConnectionsFilterQuery);
		});
	}
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

	// mark that the sidebar was rendered by client-side code so automated tests
	// can wait for hydration before asserting on DOM contents
	try {
		if (side) side.dataset.renderedByClient = '1';
		// eslint-disable-next-line no-undef
		if (typeof window !== 'undefined') (window as any).__FG_SIDEBAR_RENDERED = true;
	} catch (e) {
		/* ignore */
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
	if (hasAnyItems(detail?.disclosures)) return true;
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

function renderSourceToggle() {
	return `
		<div class="fg-source-toggle">
			<button type="button" class="fg-source-toggle-btn${sidebarSourceToggle === 'finra' ? ' active' : ''}" data-source="finra">
				FINRA
			</button>
			<button type="button" class="fg-source-toggle-btn${sidebarSourceToggle === 'sec' ? ' active' : ''}" data-source="sec">
				SEC
			</button>
		</div>
	`;
}

function renderNoSelectionSidebar() {
	return `
		<div class="fg-sb-header no-selection">
			<div class="fg-sb-title-row">
				<div class="fg-sb-title"></div>
			</div>
			<div class="fg-sb-title-actions fg-sb-title-actions--below-tags">
				${renderSidebarSelectionLogToggle()}
			</div>
		</div>
		<div class="fg-sb-body fg-sb-body--none"></div>
	`;
}

// ── Person detail ────────────────────────────────────────────────────────────
function renderPersonDetail(d: any) {
	const bi = d.basicInformation || {};
	const hasFinraPage = hasIndividualFinraPresence(d);
	const hasSecPage = hasIndividualSecPresence(d);
	const showFinra = hasFinraPage;
	const showSec = hasSecPage;
	const showSecReferences = hasSecPage;
	const links = (graphData?.links || []).filter((l: any) => (l.source?.id || l.source) === d.id || (l.target?.id || l.target) === d.id);
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
	const scopeBadgesHtml = [
		showFinra ? formatDomainScopeBadge(finraScopeText, 'finra', 'FINRA') : null,
		showSec ? formatDomainScopeBadge(secScopeText, 'sec', 'SEC AdvisorInfo') : null,
	]
		.filter(Boolean)
		.join(' ');

	// ── All disclosures (BC + IA) ─────────────────────────────────────────────
	// Deduplicate: for each (type, date) pair keep the entry with the most content.
	// A blank duplicate (same type, no date/detail/resolution) is dropped when a
	// richer entry with the same type already exists.
	const disclosureSourceLabel =
		showSec && !showFinra ? 'SEC AdvisorInfo'
		: showFinra && !showSec ? 'FINRA'
		: 'FINRA';
	const _rawDisclosures = [
		...(d.disclosures || []).map((dis) => ({
			...dis,
			_sourceLabel: dis?._sourceLabel || disclosureSourceLabel,
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
		const branchOfficeLocations = Array.isArray(emp?.branchOfficeLocations) ? emp.branchOfficeLocations : [];
		const bo =
			branchOfficeLocations.find(
				(office) =>
					String(office?.locatedAtFlag || '')
						.trim()
						.toUpperCase() === 'Y',
			) ||
			branchOfficeLocations[0] ||
			null;
		const officeAddress =
			typeof emp?.officeAddress === 'object' && emp.officeAddress ? emp.officeAddress
			: typeof bo?.officeAddress === 'object' && bo?.officeAddress ? bo.officeAddress
			: null;
		const city = emp.city || bo?.city || officeAddress?.city || '';
		const state = emp.state || bo?.state || officeAddress?.state || '';
		const street1 = emp.street1 || bo?.street1 || officeAddress?.street1 || officeAddress?.address1 || '';
		const street2 = emp.street2 || bo?.street2 || officeAddress?.street2 || officeAddress?.address2 || '';
		const zip = emp.zipCode || emp.postalCode || bo?.zipCode || bo?.postalCode || officeAddress?.zipCode || officeAddress?.postalCode || '';
		const loc = formatLocationText([city, state].filter(Boolean).join(', '));
		const addr = formatLocationText([street1, street2, city, state, zip].filter(Boolean).join(', '));
		return {
			firmName: emp.firmName || emp.legalName || emp.organizationName || emp.name || '',
			firmId: emp.firmId,
			bdSecNumber: emp.bdSECNumber,
			iaSECNumber: emp.iaSECNumber,
			start: emp.registrationBeginDate || emp.startDate || emp.effectiveDate || emp.fromDate || emp.date || '',
			end: emp.registrationEndDate || emp.endDate || emp.toDate || null,
			isCurrent: isCurrent || !(emp.registrationEndDate || emp.endDate || emp.toDate),
			employmentStatus: emp.employmentStatus || emp.registrationStatus || emp.status || emp.currentStatus || '',
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
		const branchOfficeLocations = Array.isArray(emp?.branchOfficeLocations) ? emp.branchOfficeLocations : [];
		const office =
			branchOfficeLocations.find(
				(entry) =>
					String(entry?.locatedAtFlag || '')
						.trim()
						.toUpperCase() === 'Y',
			) ||
			branchOfficeLocations[0] ||
			null;
		const officeObj =
			typeof emp?.officeAddress === 'object' && emp.officeAddress ? emp.officeAddress
			: typeof office?.officeAddress === 'object' && office?.officeAddress ? office.officeAddress
			: null;
		const officeAddress =
			office ?
				formatLocationText(
					[
						emp.street1 || office.street1 || officeObj?.street1 || officeObj?.address1,
						emp.street2 || office.street2 || officeObj?.street2 || officeObj?.address2,
						emp.city || office.city || officeObj?.city,
						emp.state || office.state || officeObj?.state,
						emp.zipCode || emp.postalCode || office.zipCode || office.postalCode || officeObj?.zipCode || officeObj?.postalCode,
					]
						.filter(Boolean)
						.join(', '),
				)
			:	'';
		const cityState = formatLocationText([emp.city || office?.city || officeObj?.city || '', emp.state || office?.state || officeObj?.state || ''].filter(Boolean).join(', '));
		return {
			role,
			firmId: emp.firmId,
			firmName: emp.firmName || emp.legalName || emp.organizationName || emp.name || '',
			start: emp.registrationBeginDate || emp.startDate || emp.effectiveDate || emp.fromDate || emp.date || '',
			end: emp.registrationEndDate || emp.endDate || emp.toDate || null,
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
		...(showSec ? (d.currentIAEmployments || []).map((emp) => regToEntry(emp, 'IA', true)) : []),
		...(showFinra ? (d.currentEmployments || []).map((emp) => regToEntry(emp, 'B', true)) : []),
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
		.filter((role) =>
			role === 'B' ? showFinra
			: role === 'IA' ? showSec
			: true,
		)
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
		...(showSec ? (d.previousIAEmployments || []).map((emp) => regToEntry(emp, 'IA', false)) : []),
		...(showFinra ? (d.previousEmployments || []).map((emp) => regToEntry(emp, 'B', false)) : []),
	]).sort((a, b) => compareCurrentFirstByDates(a, b, { dateKeys: ['end', 'start'] }));

	const hasStoredEmps = d.currentEmployments?.length || d.previousEmployments?.length || d.currentIAEmployments?.length || d.previousIAEmployments?.length;

	let empEntries = [];
	if (hasStoredEmps) {
		empEntries = [
			...(showFinra ? d.currentEmployments || [] : []).map((e) => empToEntry(e, true)),
			...(showSec ? d.currentIAEmployments || [] : []).map((e) => empToEntry(e, true)),
			...(showFinra ? d.previousEmployments || [] : []).map((e) => empToEntry(e, false)),
			...(showSec ? d.previousIAEmployments || [] : []).map((e) => empToEntry(e, false)),
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
				firmId: firmNode?.firmId || l.firmId || null,
				start: l.startDate || '',
				end: l.endDate || null,
				isCurrent: !l.endDate,
				iaOnly: false,
				addr: firmNode?.officeAddress || l.officeAddress || l.address || d.orphanOfficeAddress || d.orphanMailingAddress || null,
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
	const allExams = [...(d.stateExamCategory || []), ...(d.principalExamCategory || []), ...(d.productExamCategory || [])]
		.filter((ex) => {
			const isIa = /^ia$/i.test(ex.examScope || '');
			if (isIa) return showSec;
			return showFinra;
		})
		.sort((a, b) => compareCurrentFirstByDates(a, b, { currentKey: '__never', dateKeys: ['examTakenDate'] }));

	// ── Registered states (raw objects with scope) ─────────────────────────────
	const regStates = (Array.isArray(d.registeredStates) ? d.registeredStates.filter(Boolean) : []).filter((s) => {
		const scope = typeof s === 'object' ? s.regScope || '' : '';
		const isIa = /^ia$/i.test(String(scope).trim());
		if (isIa) return showSec;
		return showFinra;
	});
	const licenseCount =
		regStates.length || (showFinra ? d.registrationCount?.approvedStateRegistrationCount || 0 : 0) + (showSec ? d.registrationCount?.approvedIAStateRegistrationCount || 0 : 0);

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

		// If all detail fields are blank, show only a link to the PDF details page
		const hasAnyDetail = Boolean(
			initiatedBy ||
			allegs ||
			resolution ||
			sanctionText ||
			settlementAmt ||
			sanctionBadges.length ||
			comments.length ||
			docketFDA ||
			docketAAO ||
			arbDocket ||
			extraDetailRows.length,
		);
		if (!hasAnyDetail) {
			// Try to get CRD from the disclosure or parent node
			const crd = dis.crd || dis.individualId || dis.personId || '';
			const pdfUrl = crd ? `https://files.brokercheck.finra.org/individual/individual_${encodeURIComponent(crd)}.pdf` : null;
			return pdfUrl ?
					`<div class="fg-disclosure fg-disclosure--nodetail"><a class="fg-ext-link bc" href="${pdfUrl}" target="_blank" rel="noopener noreferrer">View full disclosure details (PDF)</a></div>`
				:	'';
		}
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

	// Only show links if the data is present for each source
	const brokerCheckSummaryUrl = crd && hasFinraPage ? `https://brokercheck.finra.org/individual/summary/${encodeURIComponent(crd)}` : null;
	const brokerCheckReportUrl = crd && hasFinraPage ? `https://files.brokercheck.finra.org/individual/individual_${encodeURIComponent(crd)}.pdf` : null;
	const secSummaryUrl = crd && hasSecPage ? `https://adviserinfo.sec.gov/individual/summary/${encodeURIComponent(crd)}` : null;
	const parentFirmSummaryLinks = buildParentFirmSummaryLinks(d, currentEmploymentEntries);
	const parentFirmSummaryLinksFiltered = (parentFirmSummaryLinks || []).filter((link: any) => {
		const fid = link?.firmId || (typeof link?.href === 'string' ? String(link.href).split('/').pop() : null);
		const rawFirmId =
			fid ?
				String(fid)
					.replace(/^firm[:_]/, '')
					.replace(/^node[:_]/, '')
					.trim()
			:	'';
		const firmNode = graphData?.nodes?.find((n: any) => {
			const nid = String(n?.firmId || n?.id || '')
				.replace(/^firm[:_]/, '')
				.replace(/^node[:_]/, '')
				.trim();
			return nid && rawFirmId && nid === rawFirmId;
		});
		if (link.className === 'bc') {
			// Only surface parent FINRA links when the parent firm node exists locally
			// and indicates FINRA presence.
			if (firmNode) return hasFirmFinraPresence(firmNode);
			return false;
		}
		if (link.className === 'sec') {
			// Only surface parent SEC links when the parent firm node exists locally
			// and indicates SEC presence.
			if (firmNode) return hasFirmSecPresence(firmNode);
			return false;
		}
		return true;
	});
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
				${showFinra && brokerCheckSummaryUrl ? `<a class="fg-ext-link bc" href="${brokerCheckSummaryUrl}" target="_blank" rel="noopener noreferrer">&#x2197; FINRA Summary</a>` : ''}
				${showFinra && brokerCheckReportUrl ? `<a class="fg-ext-link bc" href="${brokerCheckReportUrl}" target="_blank" rel="noopener noreferrer">&#x2197; FINRA Detailed Report (PDF)</a>` : ''}
				${showSec && secSummaryUrl ? `<a class="fg-ext-link sec" href="${secSummaryUrl}" target="_blank" rel="noopener noreferrer">&#x2197; SEC AdvisorInfo Summary</a>` : ''}
				${parentFirmSummaryLinksFiltered.map((link) => `<a class="fg-ext-link ${link.className}" href="${esc(link.href)}" target="_blank" rel="noopener noreferrer">&#x2197; ${esc(link.label)}</a>`).join('')}
			</div>
		<div class="fg-sb-copy-below-links">

      ${bi.individualId ? row('CRD', `<code>${bi.individualId}</code>`) : ''}
		${row('ID source check', esc(formatNodeSourceTruthSummary(d)))}
      ${d.orphanPosition ? row('Position', esc(String(d.orphanPosition))) : ''}
      ${d.orphanFirmName ? row('Affiliated Firm', esc(String(d.orphanFirmName))) : ''}
      ${d.orphanParentCrd ? row('Parent Firm CRD', `<button type="button" class="fg-crd-link" data-crd="${esc(String(d.orphanParentCrd))}" data-crd-type="${d.orphanParentType === 'individual' ? 'individual' : 'firm'}">Firm #${esc(String(d.orphanParentCrd))}</button>`) : ''}
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
        ${showFinra && d.registrationCount.approvedFinraRegistrationCount != null ? row('FINRA Registrations', esc(String(d.registrationCount.approvedFinraRegistrationCount))) : ''}
        ${showFinra && d.registrationCount.approvedSRORegistrationCount != null ? row('SRO Registrations', esc(String(d.registrationCount.approvedSRORegistrationCount))) : ''}
		${showFinra && d.registrationCount.approvedStateRegistrationCount != null ? row('State Broker Lic.', esc(String(d.registrationCount.approvedStateRegistrationCount))) : ''}
        ${showSec && d.registrationCount.approvedIAStateRegistrationCount != null ? row('State (IA) Lic.', esc(String(d.registrationCount.approvedIAStateRegistrationCount))) : ''}
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
						const datesHtml = `<span class="fg-tl-dates">${esc(e.start || '–')} → ${esc(e.end || 'present')}</span>`;
						const detailHtml = detailLine ? `<span class="fg-tl-loc">${esc(detailLine)}</span>` : '';
						const scopeHtml = scopeTags.length ? `<span class="fg-tl-loc" style="color:var(--text-m)">${esc(scopeTags.join(' · '))}</span>` : '';
						const secHtml = showSecReferences && e.bdSecNumber ? ` <small>SEC#${esc(String(e.bdSecNumber))}</small>` : '';
						if (e.firmId) {
							return `<button type="button" class="fg-tl-entry active-pos fg-card-clickable fg-crd-link" data-crd="${esc(e.firmId)}" data-crd-type="firm">${esc(e.firmName)}${secHtml}${datesHtml}${detailHtml}${scopeHtml}</button>`;
						}
						return `<button type="button" class="fg-tl-entry active-pos fg-card-clickable" data-search-query="${esc(e.firmName)}">${esc(e.firmName)}${secHtml}${datesHtml}${detailHtml}${scopeHtml}</button>`;
					})
					.join('')}
            </div>`
				:	''
			}

      ${
				previousEmploymentEntries.length ?
					`<div class="fg-section-title fg-section-title--sticky">Previous Employment (${previousEmploymentEntries.length})</div>
				    <div class="fg-timeline fg-timeline--previous">
			  ${previousEmploymentEntries
					.map((e) => {
						const cls = `fg-tl-entry${e.isCurrent ? ' active-pos' : ''}`;
						const detailLine = getEmploymentDetailLine(e);
						const scopeTags = getEmploymentScopeTags(e);
						const datesHtml = `<span class="fg-tl-dates">${esc(e.start || '–')} → ${esc(e.end || 'present')}</span>`;
						const detailHtml = detailLine ? `<span class="fg-tl-loc">${esc(detailLine)}</span>` : '';
						const scopeHtml = scopeTags.length ? `<span class="fg-tl-loc" style="color:var(--text-m)">${esc(scopeTags.join(' · '))}</span>` : '';
						const expelledHtml = e.expelledDate ? `<span class="fg-badge inactive">Expelled ${esc(e.expelledDate)}</span>` : '';
						const secHtml = showSecReferences && e.bdSecNumber ? ` <small>SEC#${esc(e.bdSecNumber)}</small>` : '';
						if (e.firmId) {
							return `<button type="button" class="${cls} fg-card-clickable fg-crd-link" data-crd="${esc(e.firmId)}" data-crd-type="firm">${esc(e.firmName)}${secHtml}${datesHtml}${detailHtml}${scopeHtml}${expelledHtml}</button>`;
						}
						return `<button type="button" class="${cls} fg-card-clickable" data-search-query="${esc(e.firmName)}">${esc(e.firmName)}${secHtml}${datesHtml}${detailHtml}${scopeHtml}${expelledHtml}</button>`;
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
					.map((reg) => {
						const roleFirm = `${renderRegistrationRole(reg.role)} ${esc(reg.firmName)}`;
						const crdHtml = reg.firmId ? ` (CRD#${esc(String(reg.firmId))})` : '';
						const locHtml =
							reg.officeAddress ? `<span class="fg-tl-loc">${esc(reg.officeAddress)}</span>`
							: reg.cityState ? `<span class="fg-tl-loc">${esc(reg.cityState)}</span>`
							: '';
						const datesHtml = reg.start ? `<span class="fg-tl-dates">Registered since ${esc(reg.start)}</span>` : '';
						if (reg.firmId) {
							return `<button type="button" class="fg-tl-entry active-pos fg-card-clickable fg-crd-link" data-crd="${esc(reg.firmId)}" data-crd-type="firm"><span class="fg-tl-firm">${roleFirm}${crdHtml}</span>${locHtml}${datesHtml}</button>`;
						}
						return `<button type="button" class="fg-tl-entry active-pos fg-card-clickable" data-search-query="${esc(reg.firmName)}"><span class="fg-tl-firm">${roleFirm}${crdHtml}</span>${locHtml}${datesHtml}</button>`;
					})
					.join('')}
            </div>`
				:	''
			}

      ${
				previousRegistrations.length ?
					`<div class="fg-section-title fg-section-title--sticky">Previous Registrations</div>
				    <div class="fg-timeline fg-timeline--previous">
			  ${previousRegistrations
					.map((reg) => {
						const crdHtml = reg.firmId ? ` (CRD#${esc(String(reg.firmId))})` : '';
						const locHtml =
							reg.officeAddress ? `<span class="fg-tl-loc">${esc(reg.officeAddress)}</span>`
							: reg.cityState ? `<span class="fg-tl-loc">${esc(reg.cityState)}</span>`
							: '';
						const datesHtml = `<span class="fg-tl-dates">${esc(reg.start || '–')} → ${esc(reg.end || 'present')}</span>`;
						if (reg.firmId) {
							return `<button type="button" class="fg-tl-entry fg-card-clickable fg-crd-link" data-crd="${esc(reg.firmId)}" data-crd-type="firm">${esc(reg.firmName)}${crdHtml}${locHtml}${datesHtml}</button>`;
						}
						return `<button type="button" class="fg-tl-entry fg-card-clickable" data-search-query="${esc(reg.firmName)}">${esc(reg.firmName)}${crdHtml}${locHtml}${datesHtml}</button>`;
					})
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
									const status = sro.status ? ` <span class="fg-badge fg-sro-status-badge ${/approved/i.test(sro.status) ? 'active' : 'inactive'}">${esc(sro.status)}</span>` : '';
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
								let endDate = l.endDate || l.registrationEndDate || l.toDate || employmentMatch?.end || null;

								if (!endDate && firmNode) {
									const isTerminated = /inactive|terminated|revoked|suspended|withdrawn|ceased/i.test(String(firmNode.firmStatus || firmNode.basicInformation?.firmStatus || ''));
									if (isTerminated) {
										endDate = firmNode.firmStatusDate || firmNode.basicInformation?.firmStatusDate || 'Terminated';
									}
								}

								const dateRange = startDate ? `${esc(startDate)} → ${esc(endDate || 'present')}` : null;
								const location =
									l.location ||
									employmentMatch?.loc ||
									(l.city || l.officeCity || l.state || l.officeState ? [l.city || l.officeCity, l.state || l.officeState].filter(Boolean).join(', ') : null);
								const controlFirmId = firmNode?.firmId || l.firmId || employmentMatch?.firmId || null;
								const controlFirmIdStr = controlFirmId ? String(controlFirmId).trim() : '';
								const entryBody = `<span class="fg-tl-firm fg-control-card__firm">${esc(firmNode?.label || l.firmName || employmentMatch?.firmName || l.name || l.organizationName || l.legalName || '')}${secNumber ? ` <small>SEC#${esc(String(secNumber))}</small>` : ''}</span>
		        ${dateRange ? `<span class="fg-tl-dates fg-control-card__date"><strong>${dateRange}</strong></span>` : ''}
		        ${firmStatus ? `<span class="fg-tl-status fg-control-card__status"><strong>${esc(firmStatus)}</strong></span>` : ''}
		        ${l.position ? `<span class="fg-tl-loc fg-control-card__position"><strong>${esc(l.position)}</strong></span>` : ''}
		        ${location ? `<span class="fg-tl-loc fg-control-card__location">${esc(location)}</span>` : ''}
		        ${firmAddress ? `<span class="fg-tl-loc fg-control-card__address">${esc(firmAddress)}</span>` : ''}`;
								if (controlFirmIdStr) {
									return `<button type="button" class="fg-tl-entry fg-control-card__entry fg-card-clickable fg-crd-link active-pos" data-crd="${esc(controlFirmIdStr)}" data-crd-type="firm">${entryBody}</button>`;
								}
								const searchName = firmNode?.label || l.firmName || employmentMatch?.firmName || l.name || l.organizationName || l.legalName || '';
								return `<button type="button" class="fg-tl-entry fg-control-card__entry fg-card-clickable active-pos" data-search-query="${esc(searchName)}">${entryBody}</button>`;
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

function formatFirmConnectionDateText(startDate: string, endDate: string, isCurrent: boolean) {
	if (startDate && endDate) return `${startDate} → ${endDate}`;
	if (startDate) return isCurrent ? `Since ${startDate}` : `Started ${startDate}`;
	if (endDate) return `Until ${endDate}`;
	return '';
}

function parseDateStringToTime(value: any) {
	const raw = String(value || '').trim();
	if (!raw) return Number.NEGATIVE_INFINITY;
	if (/present/i.test(raw)) return Number.POSITIVE_INFINITY;
	// MM/DD/YYYY
	const mdy = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
	if (mdy) {
		return Date.UTC(Number(mdy[3]), Number(mdy[1]) - 1, Number(mdy[2]));
	}
	// MM/YYYY
	const my = raw.match(/^(\d{1,2})\/(\d{4})$/);
	if (my) {
		return Date.UTC(Number(my[2]), Number(my[1]) - 1, 1);
	}
	// YYYY
	const y = raw.match(/^(\d{4})$/);
	if (y) {
		return Date.UTC(Number(y[1]), 0, 1);
	}
	const parsed = Date.parse(raw);
	return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function compareConnectionEntries(a: any, b: any) {
	const endA = parseDateStringToTime(a.maxEndDate);
	const endB = parseDateStringToTime(b.maxEndDate);
	if (endA !== endB) {
		return endB - endA;
	}
	const startA = parseDateStringToTime(a.maxStartDate);
	const startB = parseDateStringToTime(b.maxStartDate);
	if (startA !== startB) {
		return startB - startA;
	}
	return String(a.label).localeCompare(String(b.label));
}

export function collectFirmConnectionEntries({
	firmNode,
	layoutNodes: liveLayoutNodes = [],
	graphNodes = [],
	layoutLinks: liveLayoutLinks = [],
	graphLinks = [],
}: {
	firmNode: any;
	layoutNodes?: any[];
	graphNodes?: any[];
	layoutLinks?: any[];
	graphLinks?: any[];
}) {
	const firmNodeId = String(firmNode?.id || '').trim();
	if (!firmNodeId) return [];

	const owners = Array.isArray(firmNode?.directOwners) ? firmNode.directOwners : [];
	const nodeLookup = new Map<string, any>();
	liveLayoutNodes.forEach((node) => {
		if (node?.id) nodeLookup.set(String(node.id), node);
	});
	graphNodes.forEach((node) => {
		if (node?.id && !nodeLookup.has(String(node.id))) nodeLookup.set(String(node.id), node);
	});

	const directOwnerByCrd = new Map<string, any>();
	owners.forEach((owner) => {
		const ownerCrd = String(owner?.crdNumber || owner?.crd || owner?.personId || '').trim();
		if (ownerCrd) directOwnerByCrd.set(ownerCrd, owner);
	});

	const entriesById = new Map<
		string,
		{
			id: string;
			label: string;
			group: string;
			crd: string;
			relationshipLabels: Set<string>;
			positions: Set<string>;
			dateTexts: Set<string>;
			sortOrder: number;
			address: string;
			maxStartDate: string;
			maxEndDate: string;
		}
	>();

	const allLinks = [...liveLayoutLinks, ...graphLinks];
	allLinks.forEach((link) => {
		const sourceId = String(link?.source?.id ?? link?.source ?? '').trim();
		const targetId = String(link?.target?.id ?? link?.target ?? '').trim();
		if (!sourceId || !targetId) return;
		if (sourceId !== firmNodeId && targetId !== firmNodeId) return;

		const otherId = sourceId === firmNodeId ? targetId : sourceId;
		if (!otherId) return;

		const otherNode = nodeLookup.get(otherId) || null;
		const otherGroup = String(
			otherNode?.group ||
				(otherId.startsWith('person:') ? 'individual'
				: otherId.startsWith('entity:') ? 'entity'
				: otherId.startsWith('firm:') ? 'firm'
				: ''),
		).trim();
		if (!otherGroup) return;

		const otherCrd = otherGroup === 'individual' ? String(otherNode?.crd || otherId.replace(/^(?:person[:_])?/, '')).trim() : '';
		let relationshipLabel = '';
		let position = '';
		let dateText = '';
		let sortOrder = 4;
		let isCurrentConnection = false;
		let linkStartDate = '';
		let linkEndDate = '';

		if (link.relationship === 'controls') {
			const controlOwner = (otherCrd && directOwnerByCrd.get(otherCrd)) || null;
			const controlStartDate = String(link?.startDate || link?.registrationBeginDate || link?.fromDate || link?.effectiveDate || link?.date || '').trim();
			const controlEndDate = String(link?.endDate || link?.registrationEndDate || link?.toDate || '').trim();
			isCurrentConnection = Boolean(controlOwner) || !controlEndDate;
			relationshipLabel = isCurrentConnection ? 'Control' : 'Former control';
			position = String(controlOwner?.position || link?.position || link?.title || link?.role || '').trim();
			dateText = formatFirmConnectionDateText(controlStartDate, controlEndDate, isCurrentConnection);
			sortOrder = isCurrentConnection ? 1 : 3;
			linkStartDate = controlStartDate;
			linkEndDate = isCurrentConnection ? 'present' : controlEndDate;
		} else if (link.relationship === 'employed_by') {
			const sourceNode = (typeof link?.source === 'object' && link.source) || nodeLookup.get(sourceId) || null;
			const targetFirmId = String(firmNode?.firmId || firmNodeId.replace(/^(?:firm[:_])?/, '')).trim();
			const currentEmployments = [
				...(Array.isArray(sourceNode?.currentEmployments) ? sourceNode.currentEmployments : []),
				...(Array.isArray(sourceNode?.currentIAEmployments) ? sourceNode.currentIAEmployments : []),
			];
			const previousEmployments = [
				...(Array.isArray(sourceNode?.previousEmployments) ? sourceNode.previousEmployments : []),
				...(Array.isArray(sourceNode?.previousIAEmployments) ? sourceNode.previousIAEmployments : []),
			];

			if (link?.isCurrent !== undefined) {
				isCurrentConnection = Boolean(link.isCurrent);
			} else if (targetFirmId && currentEmployments.some((employment) => String(employment?.firmId || employment?.firm_id || '').trim() === targetFirmId)) {
				isCurrentConnection = true;
			} else if (targetFirmId && previousEmployments.some((employment) => String(employment?.firmId || employment?.firm_id || '').trim() === targetFirmId)) {
				isCurrentConnection = false;
			} else {
				const linkEndDate = String(link?.endDate || link?.registrationEndDate || link?.toDate || '').trim();
				isCurrentConnection = !linkEndDate;
			}

			const startDate = String(link?.startDate || link?.registrationBeginDate || link?.fromDate || link?.effectiveDate || '').trim();
			const endDate = String(link?.endDate || link?.registrationEndDate || link?.toDate || '').trim();
			relationshipLabel = isCurrentConnection ? 'Current registration' : 'Previous registration';
			dateText = formatFirmConnectionDateText(startDate, endDate, isCurrentConnection);
			sortOrder = isCurrentConnection ? 0 : 2;
			linkStartDate = startDate;
			linkEndDate = isCurrentConnection ? 'present' : endDate;
		} else {
			const rawRelationship = String(link?.relationship || '').trim();
			relationshipLabel = rawRelationship ? rawRelationship.replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase()) : 'Connected';
			const startDate = String(link?.startDate || link?.registrationBeginDate || link?.fromDate || link?.effectiveDate || '').trim();
			const endDate = String(link?.endDate || link?.registrationEndDate || link?.toDate || '').trim();
			isCurrentConnection = !endDate;
			dateText = formatFirmConnectionDateText(startDate, endDate, isCurrentConnection);
			linkStartDate = startDate;
			linkEndDate = isCurrentConnection ? 'present' : endDate;
		}

		if (!relationshipLabel) return;

		let address = '';
		if (otherGroup === 'firm') {
			address =
				otherNode?.officeAddress ||
				otherNode?.address ||
				link?.officeAddress ||
				link?.address ||
				[link?.street1, link?.street2, link?.city, link?.state, link?.postalCode, link?.zipCode, link?.zip, link?.country].filter(Boolean).join(', ');
		} else if (otherGroup === 'individual') {
			// Find matching employment on otherNode
			const targetFirmId = String(firmNode?.firmId || firmNodeId.replace(/^(?:firm[:_])?/, '')).trim();
			const employments = [
				...(Array.isArray(otherNode?.currentEmployments) ? otherNode.currentEmployments : []),
				...(Array.isArray(otherNode?.currentIAEmployments) ? otherNode.currentIAEmployments : []),
				...(Array.isArray(otherNode?.previousEmployments) ? otherNode.previousEmployments : []),
				...(Array.isArray(otherNode?.previousIAEmployments) ? otherNode.previousIAEmployments : []),
			];
			const match = employments.find((emp) => String(emp?.firmId || emp?.firm_id || '').trim() === targetFirmId);
			if (match) {
				const office = match.branchOfficeLocations?.[0];
				const street1 = match.street1 || office?.street1 || '';
				const street2 = match.street2 || office?.street2 || '';
				const city = match.city || office?.city || '';
				const state = match.state || office?.state || '';
				const zip = match.zipCode || office?.zipCode || '';
				address = [street1, street2, city, state, zip].filter(Boolean).join(', ');
			}
			if (!address) {
				address =
					otherNode?.primaryOffice?.address ||
					otherNode?.officeAddress ||
					otherNode?.address ||
					link?.officeAddress ||
					link?.address ||
					[link?.street1, link?.street2, link?.city, link?.state, link?.postalCode, link?.zipCode, link?.zip, link?.country].filter(Boolean).join(', ') ||
					link?.location ||
					link?.cityState ||
					'';
			}
		}

		address = formatLocationText(address);

		const label = String(getPreferredNodeLabel(otherNode) || otherNode?.label || link?.legalName || link?.name || link?.personName || otherId).trim() || otherId;
		const existingEntry = entriesById.get(otherId) || {
			id: otherId,
			label,
			group: otherGroup,
			crd: otherCrd,
			relationshipLabels: new Set<string>(),
			positions: new Set<string>(),
			dateTexts: new Set<string>(),
			sortOrder,
			address: '',
			maxStartDate: '',
			maxEndDate: '',
		};

		existingEntry.label = existingEntry.label || label;
		existingEntry.sortOrder = Math.min(existingEntry.sortOrder, sortOrder);
		existingEntry.relationshipLabels.add(relationshipLabel);
		if (position) existingEntry.positions.add(position);
		if (dateText) existingEntry.dateTexts.add(dateText);
		if (address && (!existingEntry.address || address.length > existingEntry.address.length)) {
			existingEntry.address = address;
		}

		if (linkStartDate) {
			if (!existingEntry.maxStartDate || parseDateStringToTime(linkStartDate) > parseDateStringToTime(existingEntry.maxStartDate)) {
				existingEntry.maxStartDate = linkStartDate;
			}
		}
		if (linkEndDate) {
			if (!existingEntry.maxEndDate || parseDateStringToTime(linkEndDate) > parseDateStringToTime(existingEntry.maxEndDate)) {
				existingEntry.maxEndDate = linkEndDate;
			}
		}

		entriesById.set(otherId, existingEntry);
	});

	return Array.from(entriesById.values()).map((entry) => ({
		id: entry.id,
		label: entry.label,
		group: entry.group,
		crd: entry.crd,
		relationshipLabels: Array.from(entry.relationshipLabels),
		positions: Array.from(entry.positions),
		dateTexts: Array.from(entry.dateTexts),
		sortOrder: entry.sortOrder,
		address: entry.address || null,
		maxStartDate: entry.maxStartDate,
		maxEndDate: entry.maxEndDate,
	}));
}

// ── Firm detail ──────────────────────────────────────────────────────────────
function renderFirmDetail(d: any) {
	// Scraped-only reference record (e.g. an employer entry scraped directly from an
	// individual's BrokerCheck page, with no independent FINRA/SEC firm record).
	if (d.orphan && typeof d.orphan === 'object') {
		const orphan = d.orphan;
		const parentCrd = orphan.parentCrd ? String(orphan.parentCrd).trim() : '';
		const parentType = String(orphan.parentType || 'individual')
			.trim()
			.toLowerCase();
		const parentUrl = parentCrd ? `https://brokercheck.finra.org/${parentType === 'firm' ? 'firm' : 'individual'}/summary/${encodeURIComponent(parentCrd)}` : null;
		function orphanRow(label: string, value: unknown) {
			const text = String(value || '').trim();
			if (!text) return '';
			return `<div class='fg-detail-row'><span class='fg-detail-label'>${esc(label)}</span><span class='fg-detail-value'>${esc(text)}</span></div>`;
		}
		return `
    <div class='fg-sb-header firm'>
      <div class='fg-sb-title'>${esc(String(d.label || orphan.firmName || ''))}</div>
      <div class='fg-sb-badges'>
        <span class='fg-badge inactive' title='No live FINRA/SEC record — scraped reference only'>No live CRD — scraped reference only</span>
      </div>
    </div>
    <div class='fg-sb-body fg-sb-body--firm'>
      ${parentUrl ? `<div class='fg-ext-links'><a class='fg-ext-link bc' href='${parentUrl}' target='_blank' rel='noopener noreferrer'>&#x2197; ${parentType === 'firm' ? 'Parent Firm' : 'Source Individual'} Summary</a></div>` : ''}
      ${orphanRow('Firm', orphan.firmName)}
      ${orphanRow('Office Address', orphan.officeAddress)}
      ${orphanRow('Mailing Address', orphan.mailingAddress)}
      ${orphanRow('Phone', orphan.phone)}
    </div>`;
	}

	const owners = d.directOwners || [];
	const disclosures = d.disclosures || [];
	const ownerCrdSet = new Set(owners.map((o: any) => String(o?.crdNumber || o?.crd || o?.personId || '').trim()).filter(Boolean));
	const ownerNameSet = new Set(
		owners
			.map((o: any) =>
				String(o?.legalName || o?.name || '')
					.trim()
					.toLowerCase(),
			)
			.filter(Boolean),
	);

	const graphDerivedConnections =
		ENABLE_GRAPH_DERIVED_CONNECTIONS ?
			collectFirmConnectionEntries({
				firmNode: d,
				layoutNodes,
				graphNodes: graphData?.nodes || [],
				layoutLinks,
				graphLinks: graphData?.links || [],
			})
		:	[];
	if (!ENABLE_GRAPH_DERIVED_CONNECTIONS) {
		// keep a trace during development so operators can see why sidebar is empty
		// of graph-derived connections for debugging
		try {
			console.debug('[finra-graph] graph-derived connections disabled by NEXT_PUBLIC_ENABLE_GRAPH_DERIVED_CONNECTIONS');
		} catch (e) {
			/* ignore */
		}
	}

	// Merge server/search-hydrated employment connections (ensureFirmConnections) so the sidebar
	// does not wait on a hard refresh when the canvas still has sparse links.
	const serverConnectionEntries: any[] = [];
	const pushServerEntry = (entry: any, isCurrent: boolean) => {
		const firmId = String(entry?.firmId || '').trim();
		const personId = String(entry?.individualId || entry?.crd || '').trim();
		if (firmId && !personId) {
			serverConnectionEntries.push({
				id: `firm:${firmId}`,
				label: String(entry?.name || `Firm ${firmId}`).trim(),
				group: 'firm',
				crd: firmId,
				relationshipLabels: [entry?.relationship || (isCurrent ? 'Associated firm' : 'Previously associated firm')],
				positions: [],
				dateTexts: [],
				sortOrder: isCurrent ? 1 : 3,
				address: null,
				maxStartDate: entry?.startDate || '',
				maxEndDate: entry?.endDate || (isCurrent ? 'present' : ''),
			});
			return;
		}
		const crd = personId;
		if (!crd) return;
		serverConnectionEntries.push({
			id: `person:${crd}`,
			label: normalizePersonLabel(entry?.name || `Person ${crd}`),
			group: 'individual',
			crd,
			relationshipLabels: [isCurrent ? 'Current registration' : 'Previous registration'],
			positions: [],
			dateTexts: [],
			sortOrder: isCurrent ? 0 : 2,
			address: null,
			maxStartDate: entry?.startDate || '',
			maxEndDate: entry?.endDate || (isCurrent ? 'present' : ''),
		});
	};
	for (const entry of Array.isArray(d.currentConnections) ? d.currentConnections : []) pushServerEntry(entry, true);
	for (const entry of Array.isArray(d.previousConnections) ? d.previousConnections : []) pushServerEntry(entry, false);

	const rawConnectionsById = new Map<string, any>();
	for (const conn of graphDerivedConnections) {
		if (conn?.id) rawConnectionsById.set(String(conn.id), conn);
	}
	for (const conn of serverConnectionEntries) {
		const existing = rawConnectionsById.get(String(conn.id));
		if (!existing) {
			rawConnectionsById.set(String(conn.id), conn);
			continue;
		}
		for (const label of conn.relationshipLabels || []) existing.relationshipLabels.push(label);
		existing.sortOrder = Math.min(existing.sortOrder ?? 4, conn.sortOrder ?? 4);
		if (!existing.label && conn.label) existing.label = conn.label;
	}
	const rawConnections = Array.from(rawConnectionsById.values());

	const connections = rawConnections
		.filter((conn) => {
			// Filter out individuals (employees and individual control positions)
			if (conn.group === 'individual') return false;

			const labels = (conn.relationshipLabels || []).map((r: string) => String(r).toLowerCase());
			// Name-search associated firms belong in Current/Previous Connections.
			if (labels.some((r) => r.includes('associated firm'))) return false;

			// Filter out control relationships
			const hasControl = conn.relationshipLabels.some((r) => r.toLowerCase().includes('control'));
			if (hasControl) return false;

			// Filter out registration/employment relationships
			const hasEmployment = conn.relationshipLabels.some((r) => r.toLowerCase().includes('registration') || r.toLowerCase().includes('employed'));
			if (hasEmployment) return false;

			// Filter out by CRD or name match in Form BD owners list
			const connCrd = String(conn.crd || conn.id || '')
				.replace(/^(?:person|firm|entity)[:_]/, '')
				.trim();
			if (connCrd && ownerCrdSet.has(connCrd)) return false;

			const connName = String(conn.label || '')
				.trim()
				.toLowerCase();
			if (connName && ownerNameSet.has(connName)) return false;

			return true;
		})
		.sort(compareConnectionEntries);

	const controlConnections = rawConnections
		.filter((conn) => {
			if (conn.group !== 'individual') return false;
			return conn.relationshipLabels.some((r) => r.toLowerCase().includes('control'));
		})
		.sort(compareConnectionEntries);

	const previousConnections = rawConnections
		.filter((conn) => {
			if (conn.group !== 'individual' && conn.group !== 'firm') return false;
			const isControl = conn.relationshipLabels.some((r) => r.toLowerCase().includes('control'));
			if (isControl) return false;
			return conn.sortOrder === 2 || conn.sortOrder === 3 || conn.relationshipLabels.some((r) => r.includes('Previous') || r.includes('Former'));
		})
		.sort(compareConnectionEntries);

	const currentConnections = rawConnections
		.filter((conn) => {
			if (conn.group !== 'individual' && conn.group !== 'firm') return false;
			const isControl = conn.relationshipLabels.some((r) => r.toLowerCase().includes('control'));
			if (isControl) return false;
			return !previousConnections.includes(conn);
		})
		.sort(compareConnectionEntries);

	const renderedCrdSet = new Set(controlConnections.map((c) => String(c.crd || '').trim()).filter(Boolean));
	const renderedNameSet = new Set(
		controlConnections
			.map((c) =>
				String(c.label || '')
					.trim()
					.toLowerCase(),
			)
			.filter(Boolean),
	);

	const staticOwnersToRender = owners.filter((o) => {
		const oCrd = String(o.crdNumber || o.crd || o.personId || '').trim();
		if (oCrd && renderedCrdSet.has(oCrd)) return false;
		const oName = String(o.legalName || o.name || '')
			.trim()
			.toLowerCase();
		if (oName && renderedNameSet.has(oName)) return false;
		return true;
	});
	const hasFinraPage = hasFirmFinraPresence(d);
	const hasSecPage = hasFirmSecPresence(d);
	const showFinra = hasFinraPage;
	const showSec = hasSecPage;

	function parseFirmSortDateValue(value: any) {
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

	function compareFirmDatesDesc(a: any, b: any, dateKeys: string[] = []) {
		for (const key of dateKeys) {
			const diff = parseFirmSortDateValue(b?.[key]) - parseFirmSortDateValue(a?.[key]);
			if (diff !== 0) return diff;
		}
		return String(a?.brochureName || a?.type || a?.disclosureType || '').localeCompare(String(b?.brochureName || b?.type || b?.disclosureType || ''));
	}

	const registrationStatusEntries = Array.isArray(d.registrationStatus) ? d.registrationStatus.filter((entry: any) => entry && typeof entry === 'object') : [];
	const primaryRegistrationStatusEntry =
		registrationStatusEntries.find((entry: any) => /sec/i.test(String(entry?.secJurisdiction || entry?.jurisdiction || entry?.state || entry?.name || ''))) ||
		registrationStatusEntries[0] ||
		null;
	const registrationStatusText =
		primaryRegistrationStatusEntry ?
			String(primaryRegistrationStatusEntry.status || primaryRegistrationStatusEntry.registrationStatus || primaryRegistrationStatusEntry.regStatus || '').trim()
		:	'';
	const firmStatusText = d.firmStatus && !Array.isArray(d.firmStatus) && typeof d.firmStatus !== 'object' ? String(d.firmStatus).trim() : registrationStatusText;
	const statusDate =
		d.firmStatusDate ||
		(primaryRegistrationStatusEntry ?
			String(
				primaryRegistrationStatusEntry.effectiveDate ||
					primaryRegistrationStatusEntry.effectiveDateText ||
					primaryRegistrationStatusEntry.effective ||
					primaryRegistrationStatusEntry.date ||
					'',
			).trim()
		:	'');
	const statusText = firmStatusText ? capitalize(firmStatusText.toLowerCase()) : '';
	const statusIsActive = firmStatusText ? /\bactive\b|\bapproved\b/i.test(firmStatusText) : false;
	const statusIsTerminated = firmStatusText ? /terminated|inactive|revoked|suspended/i.test(firmStatusText) : false;
	const statusClass =
		statusIsActive ? 'active'
		: statusIsTerminated ? 'terminated'
		: 'inactive';
	const hasSecRegistrationBadge = registrationStatusEntries.some((entry: any) =>
		/sec/i.test(String(entry?.secJurisdiction || entry?.jurisdiction || entry?.state || entry?.name || '')),
	);
	const displayStatusText = hasSecRegistrationBadge && firmStatusText ? `SEC ${statusText}` : statusText;
	const statusBadge = firmStatusText ? `<span class="fg-badge ${statusClass}">${esc(displayStatusText)}${statusDate ? ` ${statusDate}` : ''}</span>` : '';
	const legacyBadge = d.isLegacy === 'Y' ? `<span class="fg-badge inactive">PR Previously Registered Brokerage Firm</span>` : '';
	const scopeBadge =
		showFinra && d.bcScope ?
			`<span class="fg-badge ${/\b(active|approved)\b/i.test(String(d.bcScope || '').trim()) ? 'active' : 'inactive'}">${esc(capitalize(String(d.bcScope || '').toLowerCase()))}</span>`
		:	'';

	const sros = Array.isArray(d.selfRegulatoryOrgs) && d.selfRegulatoryOrgs.length ? safeJoinImpl(d.selfRegulatoryOrgs) : 'N/A';
	const states = Array.isArray(d.activeStates) && d.activeStates.length ? safeJoinImpl(d.activeStates) : 'N/A';

	const firmId = d.firmId || String(d.id).replace(/^firm[:_]/, '');
	const brokerCheckReportUrl = firmId ? `https://files.brokercheck.finra.org/firm/firm_${encodeURIComponent(firmId)}.pdf` : null;
	const normalizeSecFirmId = (value: string | number | null | undefined) => {
		const raw = String(value || '').trim();
		if (!raw) return '';
		if (/^8-\d+$/i.test(raw)) return raw;
		if (/^\d+$/.test(raw)) return `8-${raw}`;
		return raw;
	};
	const secFirmId = normalizeSecFirmId(d.iaSecNumber || d.bdSecNumber || d.bdSECNumber || d.basicInformation?.iaSECNumber || d.basicInformation?.bdSECNumber);
	const crdSecCrdHtml = firmId ? `CRD#: ${esc(String(firmId))}` : null;
	const crdSecSecHtml = secFirmId ? `SEC#: ${esc(secFirmId)}` : null;
	const crdSec = [crdSecCrdHtml, crdSecSecHtml].filter(Boolean).join(' / ');
	const secSummaryUrl = firmId ? `https://adviserinfo.sec.gov/firm/summary/${encodeURIComponent(firmId)}` : null;
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

				return d.secDocumentLinks.map((link: any) => {
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
	function renderRegistrationStatusRows() {
		const entries = Array.isArray(d.registrationStatus) ? d.registrationStatus.filter((entry: any) => entry && typeof entry === 'object') : [];
		const fallbackEntries =
			entries.length ? entries
			: d.firmStatus ? [{ secJurisdiction: 'SEC', status: d.firmStatus, effectiveDate: d.firmStatusDate }]
			: [];
		if (!fallbackEntries.length) return '';
		return `
			<div class="fg-section-title fg-section-title--sticky">Registration Status</div>
			${fallbackEntries
				.map((entry: any) => {
					const jurisdiction = String(entry.secJurisdiction || entry.jurisdiction || entry.state || entry.name || 'SEC').trim() || 'SEC';
					const status = String(entry.status || entry.registrationStatus || entry.regStatus || '').trim();
					const effectiveDate = String(entry.effectiveDate || entry.effectiveDateText || entry.effective || entry.date || '').trim();
					return `
						<div class="fg-detail-row">
							<span class="fg-label">SEC / Jurisdiction</span>
							<span>${esc(jurisdiction)}</span>
						</div>
						<div class="fg-detail-row">
							<span class="fg-label">Registration Status</span>
							<span>${status ? esc(status) : '–'}</span>
						</div>
						<div class="fg-detail-row">
							<span class="fg-label">Effective Date</span>
							<span>${effectiveDate ? esc(effectiveDate) : '–'}</span>
						</div>`;
				})
				.join('')}`;
	}
	const disclosureTotal =
		Number.isFinite(Number(d.disclosureCount)) ? Number(d.disclosureCount) : disclosures.reduce((sum, dis) => sum + Number(dis?.count ?? dis?.disclosureCount ?? 0), 0);
	const disclosureLabel = disclosureTotal === 1 ? 'Disclosure' : 'Disclosures';
	const disclosureBadge = (showFinra || showSec) && disclosureTotal > 0 ? `<span class="fg-badge inactive">${disclosureLabel} ${esc(String(disclosureTotal))}</span>` : '';
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
			${
				showFinra ?
					`
			<div class="fg-firm-summary__role">
				<span class="fg-firm-summary__role-icon fg-firm-summary__role-icon--broker" aria-hidden="true">B</span>
				<div class="fg-firm-summary__role-copy">
					<div class="fg-firm-summary__role-title">${esc(finraSummaryLabel)}</div>
				</div>
			</div>`
				:	''
			}
			${
				showSec && hasSecPage ?
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
					${d.otherNames?.length ? `<div class="fg-firm-summary__aliases">${escImpl(d.otherNames.map((n) => formatOtherNameImpl(n, true)).join(', '))}</div>` : ''}
					${crdSec ? `<div class="fg-firm-summary__crd">${crdSec}</div>` : ''}
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
				${showFinra && hasFinraPage && firmId ? `<a class="fg-ext-link bc" href="https://brokercheck.finra.org/firm/summary/${encodeURIComponent(firmId)}" target="_blank" rel="noopener noreferrer">&#x2197; FINRA Summary</a>` : ''}
				${
					showSec && hasSecPage && Array.isArray(secDocumentLinks) && secDocumentLinks.length > 0 ?
						secDocumentLinks
							.filter((link) => link?.href)
							.map((link) => `<a class="fg-ext-link sec" href="${esc(link.href)}" target="_blank" rel="noopener noreferrer">&#x2197; ${esc(link.label)}</a>`)
							.join('')
					:	''
				}
			</div>
			<div class="fg-sb-copy-below-links">
      ${showSec && secSummaryDescription ? `<div class="fg-section-title fg-section-title--sticky">SEC summary</div><p class="fg-sb-note">${esc(secSummaryDescription)}</p>` : ''}
			${showFinra && d.isLegacy === 'Y' ? `<p class="fg-sb-note">Not currently registered as broker. FINRA contains only limited information about this firm.</p>` : ''}
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
			${showSec ? renderRegistrationStatusRows() : ''}
			${showFinra && d.districtName ? row('FINRA District', esc(d.districtName)) : ''}
			${showFinra ? row('Company Type', esc(d.firmType || 'N/A')) : ''}
			${showFinra ? row('Self-Regulatory Orgs', esc(sros)) : ''}
			${
				showFinra ?
					row(
						'U.S. States &amp; Territories',
						states !== 'N/A' ? esc(states)
						: d.activeStates?.length ? `${d.activeStates.length} states/territories`
						: 'N/A',
					)
				:	''
			}
      ${row('Regulator', esc(d.regulator || '–'))}
      ${
				controlConnections.length || (showFinra && staticOwnersToRender.length) ?
					`
        <div class="fg-section-title fg-section-title--sticky">Form BD — Direct Owners &amp; Executive Officers (${controlConnections.length + (showFinra ? staticOwnersToRender.length : 0)})</div>
		<div class="fg-timeline">
			${controlConnections
				.map((connection) => {
					const displaySecondary = connection.crd ? ` <small>CRD#${esc(connection.crd)}</small>` : '';
					const relHtml =
						connection.relationshipLabels.length || connection.positions.length ?
							`<span class="fg-tl-loc"><strong>${esc([connection.relationshipLabels.join(', '), ...connection.positions].filter(Boolean).join(' · '))}</strong></span>`
						:	'';
					const datesHtml = connection.dateTexts.length ? `<span class="fg-tl-dates">${esc(Array.from(connection.dateTexts).join(', '))}</span>` : '';
					const addrHtml = connection.address ? `<span class="fg-tl-loc fg-control-card__address">${esc(connection.address)}</span>` : '';
					return `<button type="button" class="fg-tl-entry active-pos fg-card-clickable fg-node-link" data-node-id="${esc(connection.id)}">
						<span class="fg-tl-firm">${esc(connection.label)}${displaySecondary}</span>
						${relHtml}
						${datesHtml}
						${addrHtml}
					</button>`;
				})
				.join('')}
			${
				showFinra ?
					staticOwnersToRender
						.map((o) => {
							const nameHtml = `<span class="fg-owner-name">${esc(o.legalName || '')}</span>`;
							const posHtml = `<span class="fg-owner-pos">${esc(o.position || '')}</span>`;
							if (o.crdNumber) {
								return `
						<button type="button" class="fg-owner-row fg-card-clickable fg-crd-link" data-crd="${esc(o.crdNumber)}" data-crd-type="person" title="View person ${esc(o.crdNumber)}">
							${nameHtml}
							${posHtml}
						</button>
						`;
							}
							return `
					<div class="fg-owner-row fg-owner-row--static">
						${nameHtml}
						${posHtml}
					</div>
					`;
						})
						.join('')
				:	''
			}
		</div>
		`
				:	''
			}

			<div class="fg-section-title fg-section-title--sticky">General Information</div>
      ${row('Established in', d.formedState ? `${esc(d.formedState)}${d.formedDate ? ' since ' + d.formedDate : ''}` : '–')}
      ${row('Type', esc(d.firmType || '–'))}
      ${row('Fiscal Year End', esc(d.fiscalYearEnd || '–'))}
      ${
				showSec && sortedBrochures.length ?
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
				(showFinra || showSec) && (disclosures.length || disclosureTotal > 0 || hasAffiliateDisclosureSummary) ?
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
								showFinra ?
									`<div class="fg-dis-row">For details of these disclosures as well as disclosures involving non-registered affiliated entities refer to the Detailed Report${brokerCheckReportUrl ? ` <a class="fg-ext-link bc" href="${brokerCheckReportUrl}" target="_blank" rel="noopener noreferrer">&#x2197; FINRA Detailed Report (PDF)</a>` : ''}. For disclosures involving registered affiliated entities visit the BrokerCheck page for those firms.</div>`
								: secSummaryUrl ? `<div class="fg-dis-row">For disclosure details, open the SEC AdvisorInfo Summary for this firm.</div>`
								: ''
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
				connections.length || currentConnections.length || previousConnections.length ?
					`<div class="fg-connections-filter-row fg-connections-filter-row--sticky" style="margin: 8px 0;">
						${renderConnectionsFilterTagsHtml()}
					</div>`
				:	''
			}
			<div class="fg-connections-filter-scope" data-fg-connections-filter-scope="firm-detail">
			${
				connections.length ?
					`<div class="fg-section-title" data-fg-connections-section>Connected Nodes (${connections.length})</div>
					<div class="fg-timeline">
						${connections
							.map((connection) => {
								const displaySecondary =
									connection.group === 'firm' ?
										(() => {
											const connectedFirmId = String(connection.id || '')
												.replace(/^(?:firm[:_])?/, '')
												.trim();
											return connectedFirmId ? ` <small>CRD#${esc(connectedFirmId)}</small>` : '';
										})()
									:	'';
								const relHtml =
									connection.relationshipLabels.length || connection.positions.length ?
										`<span class="fg-tl-loc"><strong>${esc([connection.relationshipLabels.join(', '), ...connection.positions].filter(Boolean).join(' · '))}</strong></span>`
									:	'';
								const datesHtml = connection.dateTexts.length ? `<span class="fg-tl-dates">${esc(Array.from(connection.dateTexts).join(', '))}</span>` : '';
								const addrHtml = connection.address ? `<span class="fg-tl-loc fg-control-card__address">${esc(connection.address)}</span>` : '';
								return `<button type="button" class="fg-tl-entry active-pos fg-card-clickable fg-node-link" data-node-id="${esc(connection.id)}" data-fg-filter-text="${esc(String(connection.label || '').toLowerCase())} ${esc(String(connection.crd || '').toLowerCase())}">
									<span class="fg-tl-firm">${esc(connection.label)}${displaySecondary}</span>
									${relHtml}
									${datesHtml}
									${addrHtml}
								</button>`;
							})
							.join('')}
					</div>`
				:	''
			}
			${
				currentConnections.length ?
					`<div class="fg-section-title" data-fg-connections-section>Current Connections (${currentConnections.length})</div>
					<div class="fg-timeline">
						${currentConnections
							.map((connection) => {
								const displaySecondary = connection.crd ? ` <small>CRD#${esc(connection.crd)}</small>` : '';
								const relHtml =
									connection.relationshipLabels.length || connection.positions.length ?
										`<span class="fg-tl-loc"><strong>${esc([connection.relationshipLabels.join(', '), ...connection.positions].filter(Boolean).join(' · '))}</strong></span>`
									:	'';
								const datesHtml = connection.dateTexts.length ? `<span class="fg-tl-dates">${esc(Array.from(connection.dateTexts).join(', '))}</span>` : '';
								const addrHtml = connection.address ? `<span class="fg-tl-loc fg-control-card__address">${esc(connection.address)}</span>` : '';
								return `<button type="button" class="fg-tl-entry active-pos fg-card-clickable fg-node-link" data-node-id="${esc(connection.id)}" data-fg-filter-text="${esc(String(connection.label || '').toLowerCase())} ${esc(String(connection.crd || '').toLowerCase())}">
									<span class="fg-tl-firm">${esc(connection.label)}${displaySecondary}</span>
									${relHtml}
									${datesHtml}
									${addrHtml}
								</button>`;
							})
							.join('')}
					</div>`
				:	''
			}
			${
				previousConnections.length ?
					`<div class="fg-section-title" data-fg-connections-section>Previous Connections (${previousConnections.length})</div>
					<div class="fg-timeline fg-timeline--previous">
						${previousConnections
							.map((connection) => {
								const displaySecondary = connection.crd ? ` <small>CRD#${esc(connection.crd)}</small>` : '';
								const relHtml =
									connection.relationshipLabels.length || connection.positions.length ?
										`<span class="fg-tl-loc"><strong>${esc([connection.relationshipLabels.join(', '), ...connection.positions].filter(Boolean).join(' · '))}</strong></span>`
									:	'';
								const datesHtml = connection.dateTexts.length ? `<span class="fg-tl-dates">${esc(Array.from(connection.dateTexts).join(', '))}</span>` : '';
								const addrHtml = connection.address ? `<span class="fg-tl-loc fg-control-card__address">${esc(connection.address)}</span>` : '';
								return `<button type="button" class="fg-tl-entry fg-card-clickable fg-node-link" data-node-id="${esc(connection.id)}" data-fg-filter-text="${esc(String(connection.label || '').toLowerCase())} ${esc(String(connection.crd || '').toLowerCase())}">
									<span class="fg-tl-firm">${esc(connection.label)}${displaySecondary}</span>
									${relHtml}
									${datesHtml}
									${addrHtml}
								</button>`;
							})
							.join('')}
					</div>`
				:	''
			}
			</div>
    </div>
  `;
}

function renderFirmNameWithCrd(name: string, maybeId: any) {
	const raw = String(maybeId || '').trim();
	if (!raw) return `<span class="fg-tl-firm">${esc(name)}</span>`;
	const crdMatch = raw.replace(/^firm[:_]/, '');
	if (/^\d+$/.test(crdMatch)) {
		return `<button class="fg-crd-link" data-crd="${esc(crdMatch)}" data-crd-type="firm">${esc(name)}</button>`;
	}
	return `<span class="fg-tl-firm">${esc(name)}</span>`;
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
			shape: 'circle',
			label: 'Individual',
		},
		{
			color: 'var(--color-highlight-controls)',
			shape: 'circle',
			label: 'Control-position individual',
		},
		{
			color: GRAPH_COLORS.nodeInactive,
			shape: 'circle-inactive',
			label: 'Inactive node',
			opacity: 0.82,
		},
		{
			color: 'var(--color-node-stub)',
			shape: 'circle-s',
			label: 'Stub (Form BD only)',
			opacity: 0.85,
		},
		{ color: 'var(--c-firm)', shape: 'rect', label: 'Firm' },
		{ color: 'var(--c-entity)', shape: 'diamond', label: 'Entity' },
		{ color: GRAPH_COLORS.lineEmployedBy, shape: 'line', label: 'Current emp/reg' },
		{ color: GRAPH_COLORS.linePreviousEmployment, shape: 'line-dashed', label: 'Previous emp/reg' },
		{ color: GRAPH_COLORS.lineControls, shape: 'line', label: 'Controls relationship' },
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
				svg = `<svg width="16" height="4"><line x1="0" y1="2" x2="16" y2="2" stroke="${color}" stroke-width="0.4" stroke-dasharray="3 4"/></svg>`;
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
	const W = main?.clientWidth || 800;
	const H = main?.clientHeight || 600;
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

function formatNodeLabel(str, group?: 'individual' | 'firm' | string) {
	return formatNodeLabelImpl(str, group);
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
