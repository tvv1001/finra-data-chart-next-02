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
	getSelectionLinkOpacity,
	loadSelectionLogBoldPreference,
	mergeGraphNodesByIdentity,
	mergeIncomingNodesIntoExistingNodes,
	normalizeNodeLabelInPlace,
	rankFindNodeMatches,
	scheduleNodeExpansion,
	selectTextSearchHydrationTargets,
	shouldFetchFirmDetailForOwnerEvidence,
	shouldHydrateExpansionFrontierNodeDetail,
	shouldAutoExpandRouteSelection,
	shouldAutoRevealNodeConnections,
	shouldRenderNodeSelected,
	upsertSelectionLogEntry,
	isForcedGrayConnectionLink,
	clearSelectionState,
	buildSessionRenderGraphData,
	resolveLinkEndpoints,
} from '../../src/lib/finra-graph';
import { shouldRenderBlueNodeHighlight } from '../../src/lib/finra-graph-canvas';
import { DEFAULT_NODE_LABEL_FONT_SIZE_PX } from '../../src/lib/finra-graph-defaults';
import { applyIndividualDetail as applyIndividualDetailFromDetailUtils } from '../../src/lib/finra-graph/detailUtils';
import { buildParentFirmSummaryLinks } from '../../src/lib/finra-graph/externalLinks';
import { renderPersonDetail } from '../../src/lib/finra-graph/sidebar';
import { buildLargeGraphRenderPlan, getLargeGraphRenderBudget, getProgressiveLoadBudget } from '../../src/lib/large-graph-rendering';

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

	it('mergeGraphNodesByIdentity merges person nodes that share the same CRD', () => {
		const existing = [{ id: 'person:123', group: 'individual', crd: '123', label: 'CRD 123' } as any];
		const incoming = [{ id: 'person_123', group: 'individual', crd: '123', label: 'Ada Lovelace', basicInformation: { firstName: 'Ada' } } as any];

		const merged = mergeGraphNodesByIdentity(existing, incoming);

		expect(merged).toHaveLength(1);
		expect(merged[0].id).toBe('person:123');
		expect(merged[0].basicInformation.firstName).toBe('Ada');
	});

	it('mergeIncomingNodesIntoExistingNodes avoids appending a second copy for the same CRD', () => {
		const existing = [{ id: 'person:7803022', group: 'individual', crd: '7803022', label: 'CRD 7803022' } as any];
		const incoming = [{ id: 'person_7803022', group: 'individual', crd: '7803022', label: 'Megan Vogt Omoruyi', basicInformation: { firstName: 'Megan' } } as any];

		const result = mergeIncomingNodesIntoExistingNodes(existing, incoming);

		expect(result.nodes).toHaveLength(1);
		expect(result.added).toEqual([]);
		expect(result.nodes[0].label).toBe('Megan Vogt Omoruyi');
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

	it('keeps node label sizing stable for hover and selection feedback', () => {
		expect(getNodeLabelFontSize({ isSelected: true })).toBe(DEFAULT_NODE_LABEL_FONT_SIZE_PX);
		expect(getNodeLabelFontSize({ isHovered: true })).toBe(DEFAULT_NODE_LABEL_FONT_SIZE_PX);
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
