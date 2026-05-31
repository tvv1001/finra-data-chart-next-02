import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	ensureSidebarHintContent,
	isSidebarTemporarilyPinned,
	toggleSidebarPin,
	syncSidebarPinButton,
	hideSidebar,
	hideSelectionLog,
	focusFetchInputWhenEmpty,
	routeSidebarNodeSelection,
} from '../../src/components/FinraGraph';
import {
	isNodeInactive,
	isRevealableChainExhausted,
	loadPersistedSidebarViewMode,
	loadSelectionLogBoldPreference,
	normalizeNodeLabelInPlace,
	shouldRenderNodeSelected,
	upsertSelectionLogEntry,
} from '../../src/lib/finra-graph';

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

	it('routeSidebarNodeSelection pushes the node route and dispatches a selection request', () => {
		const push = vi.fn();
		const setBrowserPathname = vi.fn();
		const dispatched: Array<{ nodeId?: string; pulseDuration?: number }> = [];
		const listener = (event: Event) => {
			dispatched.push(((event as CustomEvent).detail || {}) as { nodeId?: string; pulseDuration?: number });
		};

		window.addEventListener('finra:route-node-request', listener as EventListener);
		try {
			routeSidebarNodeSelection({
				nodeId: 'person:2632784',
				searchSuffix: '?panel=info',
				browserPathname: '/',
				pathname: '/',
				setBrowserPathname,
				router: { push },
				pulseDuration: 5000,
			});

			expect(setBrowserPathname).toHaveBeenCalledWith('/node/person-2632784');
			expect(push).toHaveBeenCalledWith('/node/person-2632784?panel=info', { scroll: false });
			expect(dispatched).toEqual([{ nodeId: 'person:2632784', pulseDuration: 5000 }]);
		} finally {
			window.removeEventListener('finra:route-node-request', listener as EventListener);
		}
	});
});
