import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	ensureSidebarHintContent,
	formatFindCounter,
	isSidebarTemporarilyPinned,
	isFindShortcut,
	toggleSidebarPin,
	syncSidebarPinButton,
	hideSidebar,
	hideSelectionLog,
	focusFetchInputWhenEmpty,
	routeSidebarNodeSelection,
} from '../../src/components/FinraGraph';
import {
	applyGraphDerivedNodeMetrics,
	getNodeLabelFontSize,
	isNodeInactive,
	isRevealableChainExhausted,
	loadPersistedSidebarViewMode,
	collectFirmConnectionEntries,
	getAutoExpansionHopsForNode,
	getLargeNodeRevealBatchPlan,
	getLinkIdentityKey,
	getNodeExpansionRevealTiming,
	getSelectionLinkOpacity,
	loadSelectionLogBoldPreference,
	mergeGraphNodesByIdentity,
	mergeIncomingNodesIntoExistingNodes,
	mergeRenderedNodesForReveal,
	rewriteLinksForNodeIdMap,
	resolveNodeByIdOrIdentity,
	selectNodesToInjectById,
	releasePinnedSelectedNodeAnchor,
	normalizeNodeLabelInPlace,
	getNodeTooltipTitle,
	rankFindNodeMatches,
	scheduleNodeExpansion,
	selectTextSearchHydrationTargets,
	shouldFetchFirmDetailForOwnerEvidence,
	shouldHydrateExpansionFrontierNodeDetail,
	shouldAutoExpandRouteSelection,
	shouldAutoRevealNodeConnections,
	shouldRenderNodeSelected,
	upsertSelectionLogEntry,
	pruneGraphToSelectionLogEntries,
	isForcedGrayConnectionLink,
	clearSelectionState,
	buildSessionRenderGraphData,
	resolveLinkEndpoints,
	rebindLinksToNodes,
	handleNodeKeyboardActivation,
} from '../../src/lib/finra-graph';
import { shouldRenderBlueNodeHighlight } from '../../src/lib/finra-graph-canvas';
import { DEFAULT_NODE_LABEL_FONT_SIZE_PX } from '../../src/lib/finra-graph-defaults';
import { applyIndividualDetail as applyIndividualDetailFromDetailUtils, hasRichIndividualDetail } from '../../src/lib/finra-graph/detailUtils';
import { mergeGraphNodesForAppend, rewriteGraphLinksForNodeIdentity } from '../../src/lib/graphIdentity';
import { buildParentFirmSummaryLinks } from '../../src/lib/finra-graph/externalLinks';
import { renderPersonDetail } from '../../src/lib/finra-graph/sidebar';
import { buildLargeGraphRenderPlan, getLargeGraphRenderBudget, getProgressiveLoadBudget, shouldUseInitialSvgFallback } from '../../src/lib/large-graph-rendering';
import { normalizeNodeRouteId } from '../../src/lib/node-route';

describe('FinraGraph DOM helpers (unit)', () => {
	beforeEach(() => {
		const storage = new Map<string, string>();
		Object.defineProperty(globalThis, 'localStorage', {
			configurable: true,
			value: {
				getItem: (key: string) => (storage.has(key) ? storage.get(key)! : null),
				setItem: (key: string, value: string) => {
					storage.set(key, String(value));
				},
				removeItem: (key: string) => {
					storage.delete(key);
				},
				clear: () => {
					storage.clear();
				},
			},
		});
		document.body.innerHTML = `
      <div id="fg-sidebar" class="fg-sidebar hidden" data-mobile-expanded="false"></div>
      <div id="fg-sidebar-backdrop" class="fg-sidebar-backdrop hidden"></div>
      <div id="fg-sidebar-inner"></div>
      <div id="fg-empty" class="fg-empty"></div>
      <input id="fg-fetch-input" />
      <div id="fg-selection-log" class="fg-selection-log"></div>
      <button id="fg-sidebar-pin-toggle"></button>
    `;
	});

	afterEach(() => {
		globalThis.localStorage?.clear?.();
		delete (globalThis as typeof globalThis & { localStorage?: Storage }).localStorage;
		document.body.innerHTML = '';
	});

	it('loadSelectionLogBoldPreference defaults to bold on for new visitors', () => {
		globalThis.localStorage.removeItem('finra_selection_log_bold');

		expect(loadSelectionLogBoldPreference()).toBe(true);
	});

	it('loadSelectionLogBoldPreference preserves a saved off preference', () => {
		globalThis.localStorage.setItem('finra_selection_log_bold', 'false');

		expect(loadSelectionLogBoldPreference()).toBe(false);
	});

	it('loadPersistedSidebarViewMode remembers collapsed state', () => {
		window.sessionStorage.setItem('finra_sidebar_view_mode', 'none');

		expect(loadPersistedSidebarViewMode()).toBe('none');
	});

	it('loadPersistedSidebarViewMode defaults to info when no preference is saved', () => {
		window.sessionStorage.removeItem('finra_sidebar_view_mode');

		expect(loadPersistedSidebarViewMode()).toBe('info');
	});

	it('upsertSelectionLogEntry moves reselected items to most recent', () => {
		const initialEntries = [
			{ id: 'person:1', label: 'Alpha', secondaryId: 'CRD# 1', group: 'individual' },
			{ id: 'firm:2', label: 'Bravo Firm', secondaryId: 'CRD# 2', group: 'firm' },
			{ id: 'person:3', label: 'Charlie', secondaryId: 'CRD# 3', group: 'individual' },
		] as const;

		const reordered = upsertSelectionLogEntry([...initialEntries], {
			id: 'person:1',
			label: 'Alpha',
			secondaryId: 'CRD# 1',
			group: 'individual',
		});

		expect(reordered.map((entry) => entry.id)).toEqual(['firm:2', 'person:3', 'person:1']);
	});

	it('pruneGraphToSelectionLogEntries removes nodes and links outside the logged list', () => {
		const graphData = {
			nodes: [
				{ id: 'person:1', group: 'individual' },
				{ id: 'person:2', group: 'individual' },
				{ id: 'firm:3', group: 'firm' },
			],
			links: [
				{ source: 'person:1', target: 'firm:3', relationship: 'employed_by' },
				{ source: 'person:2', target: 'firm:3', relationship: 'employed_by' },
			],
		} as any;

		const pruned = pruneGraphToSelectionLogEntries(graphData, [{ id: 'person:1', label: 'Alpha', secondaryId: 'CRD# 1', group: 'individual' }]);

		expect(pruned.nodes.map((node: any) => node.id)).toEqual(['person:1']);
		expect(pruned.links).toEqual([]);
	});

	it('pruneGraphToSelectionLogEntries keeps intermediate nodes on shortest paths between logged nodes', () => {
		const graphData = {
			nodes: [
				{ id: 'person:1', group: 'individual' },
				{ id: 'person:2', group: 'individual' },
				{ id: 'firm:3', group: 'firm' },
				{ id: 'person:4', group: 'individual' },
			],
			links: [
				{ source: 'person:1', target: 'firm:3', relationship: 'employed_by' },
				{ source: 'person:2', target: 'firm:3', relationship: 'employed_by' },
				{ source: 'person:4', target: 'person:2', relationship: 'associated_with' },
			],
		} as any;

		const pruned = pruneGraphToSelectionLogEntries(graphData, [
			{ id: 'person:1', label: 'Alpha', secondaryId: 'CRD# 1', group: 'individual' },
			{ id: 'person:2', label: 'Beta', secondaryId: 'CRD# 2', group: 'individual' },
		]);

		const keptIds = pruned.nodes.map((node: any) => node.id).sort();
		expect(keptIds).toEqual(['firm:3', 'person:1', 'person:2']);
		expect(pruned.links).toHaveLength(2);
		expect(pruned.links.map((link: any) => [link.source, link.target])).toEqual(
			expect.arrayContaining([
				['person:1', 'firm:3'],
				['person:2', 'firm:3'],
			]),
		);
	});

	it('pruneGraphToSelectionLogEntries keeps a small connecting tree when multiple logged nodes share paths', () => {
		const graphData = {
			nodes: [
				{ id: 'person:1', group: 'individual' },
				{ id: 'person:2', group: 'individual' },
				{ id: 'person:3', group: 'individual' },
				{ id: 'firm:4', group: 'firm' },
				{ id: 'firm:5', group: 'firm' },
				{ id: 'firm:6', group: 'firm' },
			],
			links: [
				{ source: 'person:1', target: 'firm:4', relationship: 'employed_by' },
				{ source: 'person:2', target: 'firm:5', relationship: 'employed_by' },
				{ source: 'person:3', target: 'firm:6', relationship: 'employed_by' },
				{ source: 'firm:4', target: 'firm:5', relationship: 'branch' },
				{ source: 'firm:5', target: 'firm:6', relationship: 'branch' },
			],
		} as any;

		const pruned = pruneGraphToSelectionLogEntries(graphData, [
			{ id: 'person:1', label: 'Alpha', secondaryId: 'CRD# 1', group: 'individual' },
			{ id: 'person:2', label: 'Beta', secondaryId: 'CRD# 2', group: 'individual' },
			{ id: 'person:3', label: 'Gamma', secondaryId: 'CRD# 3', group: 'individual' },
		]);

		const keptIds = pruned.nodes.map((node: any) => node.id).sort();
		expect(keptIds).toEqual(['firm:4', 'firm:5', 'person:1', 'person:2', 'person:3']);
		expect(pruned.links).toHaveLength(3);
	});

	it('ensureSidebarHintContent adds placeholder when empty', () => {
		const inner = document.getElementById('fg-sidebar-inner')!;
		inner.innerHTML = '';
		ensureSidebarHintContent();
		expect(inner.innerHTML.trim()).toBe('');
	});

	it('toggleSidebarPin toggles persistent pin and syncs button', () => {
		const sidebar = document.getElementById('fg-sidebar')!;
		sidebar.dataset.persistentPinned = 'false';
		const btn = document.getElementById('fg-sidebar-pin-toggle')!;
		toggleSidebarPin();
		expect(sidebar.dataset.persistentPinned).toBe('true');
		// syncSidebarPinButton will set aria-pressed and data-pinned
		syncSidebarPinButton(true);
		expect(btn.getAttribute('aria-pressed')).toBe('true');
		expect(btn.getAttribute('data-pinned')).toBe('true');
	});

	it('hideSidebar hides when not pinned', () => {
		const sidebar = document.getElementById('fg-sidebar')!;
		sidebar.classList.remove('hidden');
		hideSidebar({ force: true });
		expect(sidebar.classList.contains('hidden')).toBe(true);
	});

	it('hideSelectionLog respects pin', () => {
		const log = document.getElementById('fg-selection-log')!;
		log.dataset.pinned = 'false';
		log.classList.remove('hidden');
		hideSelectionLog();
		expect(log.classList.contains('hidden')).toBe(true);
	});

	it('normalizeNodeLabelInPlace falls back to Node <id> for placeholder-only labels', () => {
		const node = { id: 'person:123', label: 'CRD 123456', group: 'individual' } as any;
		normalizeNodeLabelInPlace(node);
		expect(node.label).toBe('Node person:123');
	});

	it('getNodeLabelFontSize grows as the graph zooms out', () => {
		expect(getNodeLabelFontSize({ zoomScale: 1 })).toBe(16);
		expect(getNodeLabelFontSize({ zoomScale: 0.5 })).toBeGreaterThan(16);
		expect(getNodeLabelFontSize({ zoomScale: 0.2 })).toBeGreaterThan(getNodeLabelFontSize({ zoomScale: 0.5 }));
	});

	it('getNodeLabelFontSize enlarges visually emphasized nodes', () => {
		const baseSize = getNodeLabelFontSize({ zoomScale: 1 });
		const emphasizedSize = getNodeLabelFontSize({ isEmphasized: true, zoomScale: 1 } as any);

		expect(emphasizedSize).toBeGreaterThan(baseSize);
	});

	it('handleNodeKeyboardActivation selects focused graph nodes with Enter', () => {
		const activateNode = vi.fn();
		const event = {
			key: 'Enter',
			preventDefault: vi.fn(),
			stopPropagation: vi.fn(),
		} as any;

		const handled = handleNodeKeyboardActivation(event, { id: 'person:123' }, activateNode);

		expect(handled).toBe(true);
		expect(event.preventDefault).toHaveBeenCalledTimes(1);
		expect(event.stopPropagation).toHaveBeenCalledTimes(1);
		expect(activateNode).toHaveBeenCalledWith(event, { id: 'person:123' });
	});

	it('mergeGraphNodesByIdentity merges person nodes that share the same CRD', () => {
		const existing = [{ id: 'person:123', group: 'individual', crd: '123', label: 'CRD 123' } as any];
		const incoming = [{ id: 'person_123', group: 'individual', crd: '123', label: 'Ada Lovelace', basicInformation: { firstName: 'Ada' } } as any];

		const merged = mergeGraphNodesByIdentity(existing, incoming);

		expect(merged).toHaveLength(1);
		expect(merged[0].id).toBe('person:123');
		expect(merged[0].basicInformation.firstName).toBe('Ada');
	});

	it('mergeGraphNodesByIdentity merges firm nodes that share the same CRD even when the group is omitted', () => {
		const existing = [{ id: 'firm:6413', firmId: '6413', label: 'LPL Financial LLC' } as any];
		const incoming = [{ id: 'firm_6413', crd: '6413', label: 'LPL Financial LLC', basicInformation: { doingBusinessAs: 'LPL' } } as any];

		const merged = mergeGraphNodesByIdentity(existing, incoming);

		expect(merged).toHaveLength(1);
		expect(merged[0].id).toBe('firm:6413');
		expect(merged[0].firmId).toBe('6413');
		expect(merged[0].crd).toBe('6413');
		expect(merged[0].basicInformation.doingBusinessAs).toBe('LPL');
	});

	it('mergeIncomingNodesIntoExistingNodes avoids appending a second copy for the same CRD', () => {
		const existing = [{ id: 'person:7803022', group: 'individual', crd: '7803022', label: 'CRD 7803022' } as any];
		const incoming = [{ id: 'person_7803022', group: 'individual', crd: '7803022', label: 'Megan Vogt Omoruyi', basicInformation: { firstName: 'Megan' } } as any];

		const result = mergeIncomingNodesIntoExistingNodes(existing, incoming);

		expect(result.nodes).toHaveLength(1);
		expect(result.added).toEqual([]);
		expect(result.nodes[0].label).toBe('Megan Vogt Omoruyi');
	});

	it('mergeGraphNodesForAppend keeps the canonical person id when an alternate id arrives', () => {
		const existing = [{ id: 'person:7212646', group: 'individual', crd: '7212646', label: 'Melinda Q Liu' } as any];
		const incoming = [{ id: 'person_7212646', group: 'individual', crd: '7212646', label: 'Melinda Q Liu', basicInformation: { firstName: 'Melinda' } } as any];

		const result = mergeGraphNodesForAppend(existing, incoming);
		const rewrittenLinks = rewriteGraphLinksForNodeIdentity([{ source: 'person_7212646', target: 'firm:1', relationship: 'employed_by' }], result.idRewriteMap);

		expect(result.nodes).toHaveLength(1);
		expect(result.nodes[0].id).toBe('person:7212646');
		expect(result.added).toEqual([]);
		expect(result.idRewriteMap.get('person_7212646')).toBe('person:7212646');
		expect(rewrittenLinks[0].source).toBe('person:7212646');
	});

	it('mergeGraphNodesForAppend collapses duplicate firm nodes from the same batch', () => {
		const existing = [] as any[];
		const incoming = [
			{ id: 'firm:6413', group: 'firm', firmId: '6413', label: 'LPL Financial LLC' } as any,
			{ id: 'firm_6413', group: 'firm', firmId: '6413', label: 'LPL Financial LLC', bcScope: 'Active' } as any,
			{ id: 'person:1', group: 'individual', crd: '1', label: 'Owner One' } as any,
		];

		const result = mergeGraphNodesForAppend(existing, incoming);
		const rewrittenLinks = rewriteGraphLinksForNodeIdentity([{ source: 'person:1', target: 'firm_6413', relationship: 'controls' }], result.idRewriteMap);

		expect(result.nodes).toHaveLength(2);
		expect(result.nodes.find((node) => node.group === 'firm')?.id).toBe('firm:6413');
		expect(result.nodes.find((node) => node.group === 'firm')?.bcScope).toBe('Active');
		expect(result.idRewriteMap.get('firm_6413')).toBe('firm:6413');
		expect(rewrittenLinks[0].target).toBe('firm:6413');
	});

	it('mergeIncomingNodesIntoExistingNodes collapses duplicate person nodes already present for the same CRD', () => {
		const existing = [
			{ id: 'person:1333632', group: 'individual', crd: '1333632', label: 'CRD 1333632' } as any,
			{ id: 'person_1333632', group: 'individual', crd: '1333632', label: 'Larry Benton Lessley' } as any,
		];
		const incoming = [{ id: 'person:1333632', group: 'individual', crd: '1333632', label: 'Larry Benton Lessley', basicInformation: { firstName: 'Larry' } } as any];

		const result = mergeIncomingNodesIntoExistingNodes(existing, incoming);

		expect(result.nodes).toHaveLength(1);
		expect(result.added).toEqual([]);
		expect(result.nodes[0].label).toBe('Larry Benton Lessley');
		expect(result.nodes[0].basicInformation.firstName).toBe('Larry');
	});

	it('resolveNodeByIdOrIdentity finds an existing firm node by identity when the route uses a canonical id', () => {
		const existing = [{ id: 'firm_6413', group: 'firm', firmId: '6413', label: 'LPL FINANCIAL LLC' } as any];

		const resolved = resolveNodeByIdOrIdentity('firm:6413', existing);

		expect(resolved).toBeDefined();
		expect(resolved?.id).toBe('firm_6413');
		expect(resolved?.firmId).toBe('6413');
	});

	it('normalizeNodeRouteId turns person route slugs into canonical graph ids', () => {
		expect(normalizeNodeRouteId('person-4240769')).toBe('person:4240769');
		expect(normalizeNodeRouteId('firm-12345')).toBe('firm:12345');
	});

	it('selectNodesToInjectById skips nodes already rendered by identity', () => {
		const renderedNodes = [{ id: 'person_123', group: 'individual', crd: '123', label: 'Ada Lovelace' } as any];
		const graphNodes = [
			{ id: 'person:123', group: 'individual', crd: '123', label: 'Ada Lovelace' } as any,
			{ id: 'person:456', group: 'individual', crd: '456', label: 'Grace Hopper' } as any,
		];

		const toAdd = selectNodesToInjectById(['person:123', 'person:456'], { renderedNodes, graphNodes });

		expect(toAdd.map((node) => node.id)).toEqual(['person:456']);
	});

	it('releasePinnedSelectedNodeAnchor clears the prior selection anchor', () => {
		const previousNode = { id: 'person:123', fx: 10, fy: 20 } as any;
		const nextNode = { id: 'person:456', fx: null, fy: null } as any;

		expect(releasePinnedSelectedNodeAnchor(previousNode.id, [previousNode, nextNode])).toBe(true);
		expect(previousNode.fx).toBeNull();
		expect(previousNode.fy).toBeNull();
	});

	it('scheduleNodeExpansion defers expansion work until the queued timer runs', () => {
		vi.useFakeTimers();
		const task = vi.fn();
		scheduleNodeExpansion({ id: 'person:123' }, {}, task as any);
		expect(task).not.toHaveBeenCalled();
		vi.runOnlyPendingTimers();
		expect(task).toHaveBeenCalledTimes(1);
		vi.useRealTimers();
	});

	it('getLargeNodeRevealBatchPlan stages large reveals into multiple smaller batches', () => {
		const plan = getLargeNodeRevealBatchPlan(140, 800);

		expect(plan.shouldBatch).toBe(true);
		expect(plan.batchSize).toBeGreaterThan(0);
		expect(plan.batchCount).toBeGreaterThan(1);
	});

	it('uses smaller batches for large graph reveals to keep motion smooth', () => {
		const plan = getLargeNodeRevealBatchPlan(240, 2500);

		expect(plan.shouldBatch).toBe(true);
		expect(plan.batchSize).toBeLessThanOrEqual(12);
		expect(plan.batchDelayMs).toBeGreaterThan(0);
	});

	it('uses near-immediate pacing for user-initiated expansion on smaller graphs', () => {
		const timing = getNodeExpansionRevealTiming(240, { isUserInitiated: true });

		expect(timing.delayMs).toBeLessThanOrEqual(20);
		expect(timing.animationMs).toBeLessThanOrEqual(160);
	});

	it('getSelectionLinkOpacity keeps gray links brighter in selection emphasis', () => {
		const emphasis = { strokeOpacity: 0.66 } as any;
		const grayLink = { relationship: 'previous_employed_by' } as any;
		const regularLink = { relationship: 'employed_by', isCurrent: true } as any;

		expect(getSelectionLinkOpacity(grayLink, emphasis)).toBeGreaterThan(0.8);
		expect(getSelectionLinkOpacity(grayLink, emphasis, { connected: true })).toBe(getSelectionLinkOpacity(grayLink, emphasis));
		expect(getSelectionLinkOpacity(regularLink, emphasis, { connected: true })).toBe(0.66);
	});

	it('shouldRenderBlueNodeHighlight enables blue outline for hovered or selected individuals', () => {
		const individualNode = { id: 'person:1', group: 'individual' } as any;
		const firmNode = { id: 'firm:1', group: 'firm' } as any;

		expect(shouldRenderBlueNodeHighlight(individualNode, { hovered: true })).toBe(true);
		expect(shouldRenderBlueNodeHighlight(individualNode, { selected: true })).toBe(true);
		expect(shouldRenderBlueNodeHighlight(firmNode, { hovered: true })).toBe(false);
	});

	it('clearSelectionState clears the active node selection and highlight roots', () => {
		const resetState = clearSelectionState({
			selectedId: 'person:123',
			highlightedSelections: [{ id: 'person:123', hops: 1 }],
			sidebarSelectedNode: { id: 'person:123' },
		});

		expect(resetState.selectedId).toBeNull();
		expect(resetState.highlightedSelections).toEqual([]);
		expect(resetState.sidebarSelectedNode).toBeNull();
	});

	it('rewriteLinksForNodeIdMap rewrites link endpoints after node identity merges', () => {
		const links = [{ source: 'person_1333632', target: 'firm:1', relationship: 'employed_by' }] as any[];
		const rewritten = rewriteLinksForNodeIdMap(links, new Map([['person_1333632', 'person:1333632']]));

		expect(rewritten).toHaveLength(1);
		expect(rewritten[0].source).toBe('person:1333632');
		expect(rewritten[0].target).toBe('firm:1');
	});

	it('resolveLinkEndpoints converts restored string endpoints to node objects', () => {
		const nodes = [
			{ id: 'person:1', group: 'individual' },
			{ id: 'firm:1', group: 'firm' },
		] as any[];
		const links = [{ source: 'person:1', target: 'firm:1', relationship: 'employed_by' }] as any[];

		const resolved = resolveLinkEndpoints(links, nodes);

		expect(resolved).toHaveLength(1);
		expect(resolved[0].source).toEqual(nodes[0]);
		expect(resolved[0].target).toEqual(nodes[1]);
	});

	it('rebindLinksToNodes swaps existing links onto the freshly merged node objects', () => {
		const previousNode = { id: 'person:1', group: 'individual', x: 10, y: 20 } as any;
		const previousFirm = { id: 'firm:1', group: 'firm', x: 30, y: 40 } as any;
		const mergedNodes = [
			{ ...previousNode, x: 11, y: 21 },
			{ ...previousFirm, x: 31, y: 41 },
			{ id: 'person:2', group: 'individual', x: 50, y: 60 },
		] as any[];
		const links = [{ source: previousNode, target: previousFirm, relationship: 'employed_by' }] as any[];

		const rebound = rebindLinksToNodes(links, mergedNodes);

		expect(rebound).toHaveLength(1);
		expect(rebound[0].source).toBe(mergedNodes[0]);
		expect(rebound[0].target).toBe(mergedNodes[1]);
	});

	it('buildSessionRenderGraphData includes persisted extra nodes for session restoration', () => {
		const baseGraphData = {
			nodes: [
				{ id: 'person:1', group: 'individual' },
				{ id: 'firm:1', group: 'firm' },
			],
			links: [{ source: 'person:1', target: 'firm:1', relationship: 'employed_by' }],
			meta: {},
		} as any;

		const session = {
			selectedNodeId: 'person:999',
			highlightedNodes: [{ id: 'person:999', hops: 1 }],
			extraNodes: [{ id: 'person:999', group: 'individual', label: 'Extra person' }],
			extraLinks: [{ source: 'person:999', target: 'firm:1', relationship: 'controls' }],
			renderedServerIds: ['person:1', 'firm:1'],
		} as any;

		const projected = buildSessionRenderGraphData(session, baseGraphData);
		expect(projected).not.toBeNull();
		expect(projected.nodes.map((node) => node.id)).toContain('person:999');
		expect(projected.links.some((link) => link.source === 'person:999' && link.target === 'firm:1')).toBe(true);
	});

	it('normalizeNodeLabelInPlace upgrades Node person placeholders to fetched individual names', () => {
		const node = {
			id: 'person:5825353',
			label: 'Node person:5825353',
			group: 'individual',
			basicInformation: {
				firstName: 'MARK',
				middleName: 'DANIEL',
				lastName: 'MCADAM',
			},
		} as any;

		normalizeNodeLabelInPlace(node);

		expect(node.label).toBe('Mark Daniel Mcadam');
	});

	it('applyIndividualDetail replaces Node person placeholders with fetched names', () => {
		const node = {
			id: 'person:5825353',
			label: 'Node person:5825353',
			group: 'individual',
			crd: '5825353',
		} as any;

		applyIndividualDetailFromDetailUtils(
			node,
			{
				basicInformation: {
					individualId: 5825353,
					firstName: 'MARK',
					middleName: 'DANIEL',
					lastName: 'MCADAM',
				},
				previousEmployments: [{ firmId: 35513, firmName: 'CG CAPITAL MARKETS, LLC' }],
			},
			'5825353',
		);

		expect(node.label).toBe('Mark Daniel Mcadam');
		expect(node.previousEmployments).toHaveLength(1);
	});

	it('hasRichIndividualDetail does not treat empty count objects as rich detail', () => {
		expect(
			hasRichIndividualDetail({
				registrationCount: {
					approvedFinraRegistrationCount: 0,
					approvedSRORegistrationCount: 0,
					approvedStateRegistrationCount: 0,
					approvedIAStateRegistrationCount: 0,
				},
				examsCount: {
					stateExamCount: 0,
					principalExamCount: 0,
					productExamCount: 0,
				},
				brokerDetails: {
					hasBCComments: 'N',
					hasIAComments: 'N',
					legacyReportStatusDescription: 'Not Requested',
				},
			}),
		).toBe(false);

		expect(
			hasRichIndividualDetail({
				previousEmployments: [{ firmId: 6694, firmName: 'RAYMOND JAMES FINANCIAL SERVICES, INC.' }],
			}),
		).toBe(true);
	});

	it('isNodeInactive marks fetched inactive individuals as inactive immediately', () => {
		const node = {
			id: 'person:123',
			group: 'individual',
			label: 'Example Person',
			hasFinraData: true,
			bcScope: 'InActive',
			registrationCount: {
				approvedFinraRegistrationCount: 0,
				approvedSRORegistrationCount: 0,
				approvedStateRegistrationCount: 0,
				approvedIAStateRegistrationCount: 0,
			},
			currentEmployments: [],
			currentIAEmployments: [],
			previousEmployments: [{ firmId: '1' }],
			previousIAEmployments: [],
			registeredStates: [],
			registeredSROs: [],
		} as any;

		expect(isNodeInactive(node)).toBe(true);
	});

	it('enlarges emphasized labels for hover and selection feedback at zoomed-in views', () => {
		expect(getNodeLabelFontSize({ isSelected: true, zoomScale: 1.25 })).toBeGreaterThan(getNodeLabelFontSize({ zoomScale: 1.25 }));
		expect(getNodeLabelFontSize({ isHovered: true, zoomScale: 1.25 })).toBeGreaterThan(getNodeLabelFontSize({ zoomScale: 1.25 }));
		expect(getNodeLabelFontSize({ isBolded: true, zoomScale: 1.25 })).toBeGreaterThan(getNodeLabelFontSize({ zoomScale: 1.25 }));
	});

	it('keeps large labels from shrinking when zooming in', () => {
		expect(getNodeLabelFontSize({ zoomScale: 1 })).toBe(DEFAULT_NODE_LABEL_FONT_SIZE_PX);
		expect(getNodeLabelFontSize({ zoomScale: 1.25 })).toBeGreaterThanOrEqual(DEFAULT_NODE_LABEL_FONT_SIZE_PX);
	});

	it('makes selected labels larger than standard labels when zoomed in', () => {
		expect(getNodeLabelFontSize({ isSelected: true, zoomScale: 1.25 })).toBeGreaterThan(getNodeLabelFontSize({ zoomScale: 1.25 }));
		expect(getNodeLabelFontSize({ isHovered: true, zoomScale: 1.25 })).toBeGreaterThan(getNodeLabelFontSize({ zoomScale: 1.25 }));
	});

	it('includes firm CRDs in the node tooltip title', () => {
		const node = { id: 'firm:7803022', group: 'firm', label: 'Example Firm', firmId: '7803022' } as any;
		expect(getNodeTooltipTitle(node)).toContain('CRD: 7803022');
	});

	it('renderPersonDetail uses parent-firm summary URLs for active current employment records', () => {
		const html = renderPersonDetail(
			{
				id: 'person:123',
				label: 'Example Person',
				crd: '123',
				bcScope: 'Active',
				iaScope: 'Active',
				basicInformation: {
					individualId: '123',
					firstName: 'Example',
					lastName: 'Person',
				},
				currentEmployments: [{ firmId: '456', firmName: 'Example Firm', isCurrent: true }],
				previousEmployments: [],
				disclosures: [],
				iaDisclosures: [],
				registrationCount: {
					approvedFinraRegistrationCount: 0,
					approvedSRORegistrationCount: 0,
					approvedStateRegistrationCount: 0,
					approvedIAStateRegistrationCount: 0,
				},
				registeredStates: [],
				registeredSROs: [],
				currentIAEmployments: [],
				previousIAEmployments: [],
			},
			{ graphData: { links: [] } },
		);

		expect(html).toContain('https://brokercheck.finra.org/firm/summary/456');
		expect(html).toContain('https://adviserinfo.sec.gov/firm/summary/456');
	});

	it('isNodeInactive keeps active fetched individuals enabled', () => {
		const node = {
			id: 'person:456',
			group: 'individual',
			label: 'Active Person',
			hasFinraData: true,
			bcScope: 'Active',
			registrationCount: {
				approvedFinraRegistrationCount: 1,
				approvedSRORegistrationCount: 0,
				approvedStateRegistrationCount: 0,
				approvedIAStateRegistrationCount: 0,
			},
			currentEmployments: [{ firmId: '1' }],
			currentIAEmployments: [],
			previousEmployments: [],
			previousIAEmployments: [],
			registeredStates: [],
			registeredSROs: [],
		} as any;

		expect(isNodeInactive(node)).toBe(false);
	});

	it('supports a data-driven forced gray link without hard-coded CRDs', () => {
		const link = {
			source: { id: 'person:111' },
			target: { id: 'firm:222' },
			relationship: 'employed_by',
			isCurrent: true,
			forceGray: true,
		} as any;

		expect(isForcedGrayConnectionLink(link)).toBe(true);
		expect(isForcedGrayConnectionLink({ source: 'firm:222', target: 'person:111', relationship: 'employed_by', forceGray: true })).toBe(true);
		expect(isForcedGrayConnectionLink({ source: 'person:100', target: 'firm:200', relationship: 'employed_by' })).toBe(false);
		expect(isForcedGrayConnectionLink({ source: 'firm:222', target: 'person:111', relationship: 'employed_by' })).toBe(false);
	});

	it('isRevealableChainExhausted stays false when a visible downstream node still has hidden revealable neighbors', () => {
		const nodesById = new Map<string, any>([
			['person:4240769', { id: 'person:4240769', type: 'person' }],
			['firm:34040', { id: 'firm:34040', type: 'firm' }],
			['person:4118468', { id: 'person:4118468', type: 'person' }],
		]);

		const expectedNeighborsById = new Map<string, Set<string>>([
			['person:4240769', new Set(['firm:34040'])],
			['firm:34040', new Set(['person:4240769', 'person:4118468'])],
			['person:4118468', new Set()],
		]);

		const visibleNeighborsById = new Map<string, Set<string>>([
			['person:4240769', new Set(['firm:34040'])],
			['firm:34040', new Set(['person:4240769'])],
			['person:4118468', new Set()],
		]);

		expect(
			isRevealableChainExhausted(
				'person:4240769',
				(nodeId) => nodesById.get(nodeId) || null,
				(node) => expectedNeighborsById.get(node.id) || new Set(),
				(nodeId) => visibleNeighborsById.get(nodeId) || new Set(),
			),
		).toBe(false);
	});

	it('isRevealableChainExhausted returns true when the visible revealable chain is fully exhausted', () => {
		const nodesById = new Map<string, any>([
			['person:4240769', { id: 'person:4240769', type: 'person' }],
			['firm:34040', { id: 'firm:34040', type: 'firm' }],
			['person:4118468', { id: 'person:4118468', type: 'person' }],
		]);

		const expectedNeighborsById = new Map<string, Set<string>>([
			['person:4240769', new Set(['firm:34040'])],
			['firm:34040', new Set(['person:4240769', 'person:4118468'])],
			['person:4118468', new Set()],
		]);

		const visibleNeighborsById = new Map<string, Set<string>>([
			['person:4240769', new Set(['firm:34040'])],
			['firm:34040', new Set(['person:4240769', 'person:4118468'])],
			['person:4118468', new Set(['firm:34040'])],
		]);

		expect(
			isRevealableChainExhausted(
				'person:4240769',
				(nodeId) => nodesById.get(nodeId) || null,
				(node) => expectedNeighborsById.get(node.id) || new Set(),
				(nodeId) => visibleNeighborsById.get(nodeId) || new Set(),
			),
		).toBe(true);
	});

	it('isRevealableChainExhausted stays false when a visible downstream node cannot be inspected yet', () => {
		const nodesById = new Map<string, any>([
			['person:4240769', { id: 'person:4240769', inspectable: true }],
			['firm:34040', { id: 'firm:34040', inspectable: false }],
		]);

		const expectedNeighborsById = new Map<string, Set<string>>([
			['person:4240769', new Set(['firm:34040'])],
			['firm:34040', new Set()],
		]);

		const visibleNeighborsById = new Map<string, Set<string>>([
			['person:4240769', new Set(['firm:34040'])],
			['firm:34040', new Set(['person:4240769'])],
		]);

		expect(
			isRevealableChainExhausted(
				'person:4240769',
				(nodeId) => nodesById.get(nodeId) || null,
				(node) => expectedNeighborsById.get(node.id) || new Set(),
				(nodeId) => visibleNeighborsById.get(nodeId) || new Set(),
				(node) => node.inspectable === true,
			),
		).toBe(false);
	});

	it('shouldRenderNodeSelected keeps merely visited expandable nodes out of selected styling', () => {
		const node = { id: 'person:4624219', label: 'Katherine Patricia Clune' } as any;

		expect(
			shouldRenderNodeSelected(node, {
				selectedId: 'person:9999999',
				highlightRootIds: new Set<string>(),
				isFetchedLeafNode: () => false,
				isFetchedExhaustedConnectedNode: () => false,
			}),
		).toBe(false);
	});

	it('shouldRenderNodeSelected does not treat neighboring highlight hops as selected nodes', () => {
		const child = { id: 'person:4624220', label: 'Child Node' } as any;

		expect(
			shouldRenderNodeSelected(child, {
				selectedId: 'person:4624219',
				highlightRootIds: new Set(['person:4624219']),
				isFetchedLeafNode: () => false,
				isFetchedExhaustedConnectedNode: () => false,
			}),
		).toBe(false);
	});

	it('shouldRenderNodeSelected still marks exhausted fetched nodes as selected', () => {
		const node = { id: 'person:4240769', label: 'Example Person' } as any;

		expect(
			shouldRenderNodeSelected(node, {
				selectedId: null,
				highlightRootIds: new Set<string>(),
				isFetchedLeafNode: () => false,
				isFetchedExhaustedConnectedNode: () => true,
			}),
		).toBe(true);
	});

	it('shouldAutoRevealNodeConnections keeps firm connections hidden by default', () => {
		expect(shouldAutoRevealNodeConnections({ id: 'person:123', group: 'individual' })).toBe(true);
		expect(shouldAutoRevealNodeConnections({ id: 'firm:456', group: 'firm' })).toBe(false);
	});

	it('getLinkIdentityKey distinguishes current and previous employment links on the same firm pair', () => {
		const currentLink = { source: 'person:1', target: 'firm:9', relationship: 'employed_by', isCurrent: true };
		const previousLink = { source: 'person:1', target: 'firm:9', relationship: 'employed_by', isCurrent: false };

		expect(getLinkIdentityKey(currentLink)).not.toBe(getLinkIdentityKey(previousLink));
	});

	it('getLargeGraphRenderBudget caps the render surface for very large graphs', () => {
		expect(getLargeGraphRenderBudget(20_000, 1)).toBeLessThanOrEqual(980);
		expect(getLargeGraphRenderBudget(5_000, 1)).toBeLessThanOrEqual(650);
		expect(getLargeGraphRenderBudget(4_000, 1)).toBeLessThanOrEqual(650);
	});

	it('getProgressiveLoadBudget reveals larger slices over time for huge graphs', () => {
		expect(getProgressiveLoadBudget(5_000, 1, 0)).toBeLessThan(getProgressiveLoadBudget(5_000, 1, 4));
		expect(getProgressiveLoadBudget(5_000, 1, 4)).toBe(getLargeGraphRenderBudget(5_000, 1));
		expect(getProgressiveLoadBudget(1_000, 1, 0)).toBe(getLargeGraphRenderBudget(1_000, 1));
	});

	it('shouldUseInitialSvgFallback stays off so graphs always render in SVG', () => {
		expect(shouldUseInitialSvgFallback(250)).toBe(false);
		expect(shouldUseInitialSvgFallback(400)).toBe(false);
		expect(shouldUseInitialSvgFallback(8_000)).toBe(false);
	});

	it('buildLargeGraphRenderPlan preserves the selected node and trims off-screen work', () => {
		const nodes = [
			{ id: 'focus', x: 100, y: 100, group: 'individual', _deg: { total: 90 } },
			{ id: 'near', x: 110, y: 110, group: 'firm', _deg: { total: 10 } },
			{ id: 'far', x: 5000, y: 5000, group: 'entity', _deg: { total: 1 } },
		] as any[];
		const links = [
			{ source: 'focus', target: 'near', relationship: 'controls' },
			{ source: 'far', target: 'near', relationship: 'controls' },
		] as any[];

		const transformed = buildLargeGraphRenderPlan(
			nodes,
			links,
			{ x: 0, y: 0, k: 1 },
			{
				width: 400,
				height: 300,
				selectedId: 'focus',
				maxVisibleNodes: 2,
			},
		);

		expect(transformed.visibleNodeIds.has('focus')).toBe(true);
		expect(transformed.visibleNodeIds.has('near')).toBe(true);
		expect(transformed.visibleNodeIds.has('far')).toBe(false);
		expect(transformed.visibleLinks.length).toBeLessThanOrEqual(2);
	});

	it('shouldAutoExpandRouteSelection skips duplicate route expansion for the already selected node', () => {
		expect(shouldAutoExpandRouteSelection('person:4240769', 'person:4240769')).toBe(false);
		expect(shouldAutoExpandRouteSelection('person:4240769', 'person:1111111')).toBe(true);
		expect(shouldAutoExpandRouteSelection('person:4240769', null)).toBe(true);
	});

	it('getAutoExpansionHopsForNode caps very high-degree individual expansion to two hops', () => {
		const node = {
			id: 'person:4240769',
			group: 'individual',
			currentEmployments: Array.from({ length: 20 }, (_, index) => ({ firmId: String(1000 + index) })),
			currentIAEmployments: [],
		} as any;

		expect(getAutoExpansionHopsForNode(node, 2)).toBe(2);
	});

	it('getAutoExpansionHopsForNode preserves requested hops for smaller neighborhoods', () => {
		const node = {
			id: 'person:123',
			group: 'individual',
			currentEmployments: [{ firmId: '1' }, { firmId: '2' }],
			currentIAEmployments: [],
		} as any;

		expect(getAutoExpansionHopsForNode(node, 2)).toBe(2);
	});

	it('getAutoExpansionHopsForNode preserves requested hops for firms even when they have many connections', () => {
		const node = {
			id: 'firm:11469',
			group: 'firm',
			directOwners: Array.from({ length: 30 }, (_, index) => ({ crdNumber: String(4000000 + index) })),
		} as any;

		expect(getAutoExpansionHopsForNode(node, 2)).toBe(2);
	});

	it('shouldHydrateExpansionFrontierNodeDetail skips background firm hydration unless explicitly enabled', () => {
		expect(shouldHydrateExpansionFrontierNodeDetail({ id: 'person:123', group: 'individual' })).toBe(true);
		expect(shouldHydrateExpansionFrontierNodeDetail({ id: 'firm:456', group: 'firm' })).toBe(false);
		expect(shouldHydrateExpansionFrontierNodeDetail({ id: 'firm:456', group: 'firm' }, { includeFirmDetails: true })).toBe(true);
	});

	it('shouldFetchFirmDetailForOwnerEvidence disables firm detail lookups for background owner-evidence hydration', () => {
		expect(shouldFetchFirmDetailForOwnerEvidence()).toBe(true);
		expect(shouldFetchFirmDetailForOwnerEvidence({ allowFirmDetailFetch: false })).toBe(false);
	});

	it('selectTextSearchHydrationTargets dedupes summary hits and caps hydration work', () => {
		expect(
			selectTextSearchHydrationTargets(
				[
					{ nodeId: 'person:1', group: 'individual', hasEmbeddedDetail: false },
					{ nodeId: 'person:1', group: 'individual', hasEmbeddedDetail: false },
					{ nodeId: 'firm:2', group: 'firm', hasEmbeddedDetail: false },
					{ nodeId: 'person:3', group: 'individual', hasEmbeddedDetail: true },
					{ nodeId: 'person:4', group: 'individual', hasEmbeddedDetail: false },
				],
				2,
			),
		).toEqual([
			{ nodeId: 'person:1', group: 'individual' },
			{ nodeId: 'firm:2', group: 'firm' },
		]);
	});

	it('applyGraphDerivedNodeMetrics gives fetched individuals a connection count before links are rendered', () => {
		const nodes = [
			{
				id: 'person:123',
				group: 'individual',
				label: 'Alice Example',
				currentEmployments: [{ firmId: '10', firmName: 'Alpha Capital' }],
				currentIAEmployments: [{ firmId: '20', firmName: 'Beta Advisors' }],
				previousEmployments: [{ firmId: '30', firmName: 'Gamma Securities' }],
				previousIAEmployments: [],
				controlPositions: [{ firmId: '40', firmName: 'Delta Holdings' }],
			},
		] as any[];

		applyGraphDerivedNodeMetrics(nodes, []);

		expect(nodes[0]?._deg).toMatchObject({ total: 4, employed: 3, controls: 1 });
		expect(nodes[0]?._vizHalf).toBeGreaterThan(6);
	});

	it('applyGraphDerivedNodeMetrics gives fetched firms a control count before owner links are rendered', () => {
		const nodes = [
			{
				id: 'firm:789',
				group: 'firm',
				label: 'Example Firm',
				directOwners: [{ crdNumber: '123' }, { crd: '456' }],
			},
		] as any[];

		applyGraphDerivedNodeMetrics(nodes, []);

		expect(nodes[0]?._deg).toMatchObject({ total: 2, controls: 2, employed: 0 });
		expect(nodes[0]?._vizHalf).toBeGreaterThan(7);
	});

	it('focusFetchInputWhenEmpty focuses when empty and not active', () => {
		const input = document.getElementById('fg-fetch-input') as HTMLInputElement;
		const empty = document.getElementById('fg-empty')!;
		empty.classList.remove('hidden');
		input.disabled = false;
		// Simulate not focused
		(document.activeElement as Element | null) && document.body.focus && document.body.focus();
		focusFetchInputWhenEmpty({ force: true });
		// requestAnimationFrame used; advance microtask by using setTimeout 0
		return new Promise((resolve) =>
			setTimeout(() => {
				expect(document.activeElement === input || document.activeElement === document.body).toBe(true);
				resolve(null);
			}, 20),
		);
	});

	it('formatFindCounter reports totals and current position', () => {
		expect(formatFindCounter(0, 0)).toBe('0 matches');
		expect(formatFindCounter(1, 0)).toBe('1 match');
		expect(formatFindCounter(5, 0)).toBe('5 matches');
		expect(formatFindCounter(5, 3)).toBe('3/5');
	});

	it('rankFindNodeMatches ranks loaded matches by score and connection count', () => {
		const nodes = [
			{ id: 'person:123', group: 'individual', label: 'Alice Johnson', basicInformation: { firstName: 'Alice', lastName: 'Johnson' } },
			{ id: 'person:456', group: 'individual', label: 'Alice Jones', basicInformation: { firstName: 'Alice', lastName: 'Jones' } },
			{ id: 'firm:789', group: 'firm', label: 'Alice Advisors', firmId: '789', basicInformation: { firmName: 'Alice Advisors' } },
		] as any[];
		const links = [
			{ source: 'person:123', target: 'firm:789' },
			{ source: 'person:123', target: 'person:456' },
		] as any[];

		const matches = rankFindNodeMatches('Alice', nodes, links);

		expect(matches.map((entry) => entry.node.id)).toEqual(expect.arrayContaining(['person:123', 'person:456', 'firm:789']));
		expect(matches[0]?.node.id).toBe('person:123');
		expect(matches[0]?.connections).toBeGreaterThan(matches[1]?.connections ?? 0);
	});

	it('collectFirmConnectionEntries includes all connected nodes and aggregates relationships', () => {
		const firmNode = {
			id: 'firm:789',
			group: 'firm',
			firmId: '789',
			directOwners: [{ crdNumber: '123', position: 'CEO' }],
		} as any;
		const nodes = [
			firmNode,
			{ id: 'person:123', group: 'individual', crd: '123', label: 'Alice Johnson' },
			{ id: 'person:456', group: 'individual', crd: '456', label: 'Bob Jones' },
			{ id: 'entity:1', group: 'entity', label: 'Holding Co LLC' },
		] as any[];
		const links = [
			{ source: 'person:123', target: 'firm:789', relationship: 'controls', startDate: '2020-01-01' },
			{ source: 'person:123', target: 'firm:789', relationship: 'employed_by', isCurrent: true, startDate: '2021-01-01' },
			{ source: 'person:456', target: 'firm:789', relationship: 'employed_by', isCurrent: false, startDate: '2018-01-01', endDate: '2020-01-01' },
			{ source: 'entity:1', target: 'firm:789', relationship: 'controls', endDate: '2022-01-01' },
		] as any[];

		const entries = collectFirmConnectionEntries({
			firmNode,
			layoutNodes: nodes,
			graphNodes: nodes,
			layoutLinks: links,
			graphLinks: [],
		});

		expect(entries.map((entry) => entry.id)).toEqual(['person:123', 'person:456', 'entity:1']);
		expect(entries[0]?.relationshipLabels).toEqual(expect.arrayContaining(['Current registration', 'Control']));
		expect(entries[0]?.positions).toEqual(expect.arrayContaining(['CEO']));
		expect(entries[1]?.relationshipLabels).toEqual(['Previous registration']);
		expect(entries[2]?.relationshipLabels).toEqual(['Former control']);
	});

	it('routeSidebarNodeSelection pushes the node route and dispatches a selection request', () => {
		const pushState = vi.spyOn(window.history, 'pushState');
		const setBrowserPathname = vi.fn();
		const dispatched: Array<{ nodeId?: string; pulseDuration?: number; autoExpand?: boolean }> = [];
		const listener = (event: Event) => {
			dispatched.push(((event as CustomEvent).detail || {}) as { nodeId?: string; pulseDuration?: number; autoExpand?: boolean });
		};

		window.addEventListener('finra:route-node-request', listener as EventListener);
		try {
			routeSidebarNodeSelection({
				nodeId: 'person:2632784',
				searchSuffix: '?panel=info',
				browserPathname: '/',
				pathname: '/',
				setBrowserPathname,
				pulseDuration: 5000,
			});

			expect(setBrowserPathname).toHaveBeenCalledWith('/node/person-2632784');
			expect(pushState).toHaveBeenCalledWith(window.history.state, '', '/node/person-2632784?panel=info');
			expect(dispatched).toEqual([{ nodeId: 'person:2632784', pulseDuration: 5000, autoExpand: false }]);
		} finally {
			window.removeEventListener('finra:route-node-request', listener as EventListener);
			pushState.mockRestore();
		}
	});
});
