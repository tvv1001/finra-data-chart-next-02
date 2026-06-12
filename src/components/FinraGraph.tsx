'use client';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';

import ThemeToggle from './ThemeToggle';
import { buildNodeRouteHref, buildNodeRoutePath, parseNodeIdFromPathname } from '@/lib/node-route';
import { RUNTIME_CLICK_EXPANSION_HOPS, RUNTIME_EXPANSION_HOPS, RUNTIME_SELECTION_HOPS } from '@/lib/finra-graph-defaults';

const MOBILE_TOUCH_SLOP_PX = 12;
const MOBILE_TOUCH_CLICK_SUPPRESSION_MS = 250;
const LIVE_SEARCH_MIN_CHARS = 4;
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

function bindTouchDragClickSuppression(button: HTMLElement | null) {
	if (!button || button.dataset.touchGuardBound === 'true') return;
	button.dataset.touchGuardBound = 'true';

	let activePointerId: number | null = null;
	let startX = 0;
	let startY = 0;
	let suppressClickUntil = 0;

	const movedBeyondTouchSlop = (clientX: number, clientY: number) => Math.hypot(clientX - startX, clientY - startY) > MOBILE_TOUCH_SLOP_PX;
	const suppressNextClick = () => {
		suppressClickUntil = Date.now() + MOBILE_TOUCH_CLICK_SUPPRESSION_MS;
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
			// handleNodeOpen(event);
			if (Date.now() >= suppressClickUntil) return;
			event.preventDefault();
			event.stopPropagation();
		},
		true,
	);
}

function ensureSidebarHintContent() {
	const inner = document.getElementById('fg-sidebar-inner');
	if (!inner) return;
	const hasRenderableContent = inner.children.length > 0 || Boolean(inner.textContent?.trim());
	if (!hasRenderableContent) {
		inner.innerHTML = ` `;
	}
}

function isSidebarTemporarilyPinned() {
	const sidebar = document.getElementById('fg-sidebar');
	if (!sidebar || sidebar.classList.contains('hidden')) return false;
	const isExpanded = sidebar.dataset.mobileExpanded === 'true';
	const viewMode = sidebar.dataset.viewMode;
	return isExpanded && (viewMode === 'info' || viewMode === 'log');
}

function isSidebarPersistentlyPinned() {
	return document.getElementById('fg-sidebar')?.dataset.persistentPinned === 'true';
}

function syncSidebarPinButton(pinned: boolean) {
	const btn = document.getElementById('fg-sidebar-pin-toggle');
	if (!btn) return;
	btn.setAttribute('aria-pressed', String(pinned));
	btn.setAttribute('data-pinned', String(pinned));
	btn.title = pinned ? 'Unpin panel' : 'Pin panel open';
	btn.setAttribute('aria-label', pinned ? 'Unpin panel' : 'Pin panel open');
}

function toggleSidebarPin() {
	const sidebar = document.getElementById('fg-sidebar');
	if (!sidebar) return;
	const pinned = sidebar.dataset.persistentPinned !== 'true';
	sidebar.dataset.persistentPinned = String(pinned);
	try {
		localStorage.setItem('finra_sidebar_pinned', String(pinned));
	} catch {}
	syncSidebarPinButton(pinned);
}

function hideSidebar(options: { force?: boolean; clearPersistentPin?: boolean } = {}) {
	const { force = false } = options;
	if (!force && (isSidebarTemporarilyPinned() || isSidebarPersistentlyPinned())) return;
	document.getElementById('fg-sidebar')?.classList.add('hidden');
	document.getElementById('fg-sidebar-backdrop')?.classList.add('hidden');
}

function toggleMobileMenu() {
	const sidebar = document.getElementById('fg-sidebar');
	const backdrop = document.getElementById('fg-sidebar-backdrop');
	if (!sidebar) return;
	const isOpen = !sidebar.classList.contains('hidden');
	if (isOpen) {
		hideSidebar({ force: true });
		return;
	}
	sidebar.classList.remove('hidden');
	backdrop?.classList.remove('hidden');
}

function handleLegendTooltipBlur(event: React.FocusEvent<HTMLDetailsElement>) {
	const nextTarget = event.relatedTarget;
	if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
	event.currentTarget.open = false;
}

function hideSelectionLog() {
	const panel = document.getElementById('fg-selection-log');
	if (!panel) return;
	const isPinned = panel.dataset.pinned === 'true';
	if (isPinned) return;
	panel.classList.add('hidden');
}

function focusFetchInputWhenEmpty(options: { force?: boolean } = {}) {
	const { force = false } = options;
	const fetchInput = document.getElementById('fg-fetch-input') as HTMLInputElement | null;
	const empty = document.getElementById('fg-empty');
	if (!fetchInput || !empty || fetchInput.disabled || empty.classList.contains('hidden')) return;

	const activeElement = document.activeElement as HTMLElement | null;
	if (!force && activeElement && activeElement !== document.body && activeElement !== fetchInput) {
		return;
	}

	window.requestAnimationFrame(() => {
		if (empty.classList.contains('hidden') || document.activeElement === fetchInput) return;
		fetchInput.focus({ preventScroll: true });
	});
}

function routeSidebarNodeSelection({
	nodeId,
	searchSuffix,
	browserPathname,
	pathname,
	setBrowserPathname,
	router,
	pulseDuration = 5000,
	autoExpand = false,
}: {
	nodeId: string;
	searchSuffix: string;
	browserPathname: string;
	pathname: string;
	setBrowserPathname: (nextPath: string) => void;
	router: { push: (href: string, options?: { scroll?: boolean }) => void };
	pulseDuration?: number;
	autoExpand?: boolean;
}) {
	const nextHref = buildNodeRouteHref(nodeId, searchSuffix);
	const nextPath = buildNodeRoutePath(nodeId);
	const currentHref = `${browserPathname || pathname || '/'}${searchSuffix}`;
	if (nextHref !== currentHref) {
		setBrowserPathname(nextPath);
		router.push(nextHref, { scroll: false });
	}
	window.dispatchEvent(new CustomEvent('finra:route-node-request', { detail: { nodeId, pulseDuration, autoExpand } }));
}

function isFindShortcut(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'defaultPrevented'>) {
	return !event.defaultPrevented && !event.altKey && (event.ctrlKey || event.metaKey) && String(event.key || '').toLowerCase() === 'f';
}

function formatFindCounter(total: number, activeOrdinal = 0) {
	if (!total) return '0 matches';
	if (activeOrdinal > 0) return `${activeOrdinal}/${total}`;
	return `${total} match${total === 1 ? '' : 'es'}`;
}

export function shouldTriggerLiveSearch(query: string) {
	return query.trim().length >= LIVE_SEARCH_MIN_CHARS;
}

export default function FinraGraph() {
	const mountedRef = useRef(false);
	const appRef = useRef<HTMLDivElement | null>(null);
	const fetchInputRef = useRef<HTMLInputElement | null>(null);
	const findInputRef = useRef<HTMLInputElement | null>(null);
	const isFindBarOpenRef = useRef(false);
	const shouldRestoreFindBarAfterSidebarDismissRef = useRef(false);
	const wasGraphEmptyRef = useRef<boolean | null>(null);
	const [isMounted, setIsMounted] = useState(false);
	const [graphReady, setGraphReady] = useState(false);
	const [browserPathname, setBrowserPathname] = useState('');
	const [fetchQuery, setFetchQuery] = useState('');
	const [isFindBarOpen, setIsFindBarOpen] = useState(false);
	const [findQuery, setFindQuery] = useState('');
	const [findMatchState, setFindMatchState] = useState({ total: 0, activeOrdinal: 0 });
	const [activeFindNodeId, setActiveFindNodeId] = useState<string | null>(null);
	const [focusedFindNodeId, setFocusedFindNodeId] = useState<string | null>(null);
	const [isMobileSearchOpen, setIsMobileSearchOpen] = useState(false);
	const router = useRouter();
	const pathname = usePathname();
	const searchParams = useSearchParams();
	const routeNodeId = useMemo(() => parseNodeIdFromPathname(browserPathname || pathname), [browserPathname, pathname]);
	const findCounterText = useMemo(() => formatFindCounter(findMatchState.total, findMatchState.activeOrdinal), [findMatchState.activeOrdinal, findMatchState.total]);
	// const findSubmitText = activeFindNodeId || focusedFindNodeId ? 'Select' : 'Find';

	const findSubmitText = 'Select';
	const searchSuffix = useMemo(() => {
		const suffix = searchParams.toString();
		return suffix ? `?${suffix}` : '';
	}, [searchParams]);

	const handleFetchQueryChange = (event: ChangeEvent<HTMLInputElement>) => {
		const nextValue = event.target.value;
		setFetchQuery(nextValue);
		if (!isMobileSearchViewport() || !isMobileSearchOpen) return;
		if (shouldTriggerLiveSearch(nextValue)) {
			window.dispatchEvent(new CustomEvent(FIND_QUERY_EVENT, { detail: { query: nextValue } }));
			return;
		}
		window.dispatchEvent(new CustomEvent(FIND_CLOSE_EVENT, { detail: { clearQuery: true } }));
	};

	const isMobileSearchViewport = useCallback(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 900px)').matches, []);

	const focusFindInput = useCallback(() => {
		window.requestAnimationFrame(() => {
			const input = findInputRef.current;
			if (!input) return;
			input.focus({ preventScroll: true });
			input.select();
		});
	}, []);

	const openFindBar = useCallback(() => {
		if (isMobileSearchViewport()) {
			window.dispatchEvent(new CustomEvent(MOBILE_SIDEBAR_COLLAPSE_REQUEST_EVENT));
		}
		setIsFindBarOpen(true);
		focusFindInput();
	}, [focusFindInput, isMobileSearchViewport]);

	const reopenFindBarAfterSidebarDismiss = useCallback(() => {
		if (!shouldRestoreFindBarAfterSidebarDismissRef.current) return;
		if (!isMobileSearchViewport()) {
			shouldRestoreFindBarAfterSidebarDismissRef.current = false;
			return;
		}
		shouldRestoreFindBarAfterSidebarDismissRef.current = false;
		window.requestAnimationFrame(() => {
			openFindBar();
		});
	}, [isMobileSearchViewport, openFindBar]);

	const closeFindBar = useCallback(
		({ clearQuery = false, preserveMobileRestore = false }: { clearQuery?: boolean; preserveMobileRestore?: boolean } = {}) => {
			const input = findInputRef.current;
			if (input && document.activeElement === input) {
				input.blur();
				window.requestAnimationFrame(() => {
					if (appRef.current) {
						appRef.current.focus({ preventScroll: true });
					}
				});
			}
			setIsFindBarOpen(false);
			if (clearQuery) {
				setFindQuery('');
				setFindMatchState({ total: 0, activeOrdinal: 0 });
				setActiveFindNodeId(null);
				setFocusedFindNodeId(null);
				window.dispatchEvent(new CustomEvent(FIND_CLOSE_EVENT, { detail: { clearQuery: true } }));
				shouldRestoreFindBarAfterSidebarDismissRef.current = false;
				return;
			}
			setFocusedFindNodeId(activeFindNodeId);
			window.dispatchEvent(new CustomEvent(FIND_CLOSE_EVENT, { detail: { clearQuery: false } }));
			if (!preserveMobileRestore) {
				shouldRestoreFindBarAfterSidebarDismissRef.current = false;
			}
		},
		[activeFindNodeId],
	);

	const submitFindQuery = useCallback(() => {
		const query = findQuery.trim();
		if (!query) return;
		const nodeId = focusedFindNodeId || activeFindNodeId;
		if (nodeId) {
			const isMobileSidebar = typeof window !== 'undefined' && window.matchMedia('(max-width: 900px)').matches;
			if (isMobileSidebar) {
				shouldRestoreFindBarAfterSidebarDismissRef.current = true;
				closeFindBar({ clearQuery: false, preserveMobileRestore: true });
			} else {
				closeFindBar({ clearQuery: false });
			}
			routeSidebarNodeSelection({
				nodeId,
				searchSuffix,
				browserPathname,
				pathname,
				setBrowserPathname,
				router,
				pulseDuration: 5000,
				autoExpand: true,
			});
			return;
		}
		window.dispatchEvent(new CustomEvent(FIND_NEXT_EVENT, { detail: { query } }));
	}, [activeFindNodeId, browserPathname, closeFindBar, findQuery, focusedFindNodeId, pathname, router, searchSuffix]);

	const handleFindInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
		if (event.key === 'Enter') {
			event.preventDefault();
			submitFindQuery();

			return;
		}
		if (event.key === 'ArrowDown' || event.key === 'ArrowRight' || event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
			event.preventDefault();

			window.dispatchEvent(
				new CustomEvent(FIND_MOVE_EVENT, {
					detail: {
						direction: event.key,
						query: findQuery.trim(),
					},
				}),
			);
		}
	};

	const moveFindMatchByButton = (direction: 'ArrowLeft' | 'ArrowRight') => {
		const query = findQuery.trim();

		if (!query) return;
		window.dispatchEvent(
			new CustomEvent(FIND_MOVE_EVENT, {
				detail: { direction, query },
			}),
		);
	};

	useEffect(() => {
		isFindBarOpenRef.current = isFindBarOpen;
	}, [isFindBarOpen]);

	useEffect(() => {
		const input = fetchInputRef.current;
		if (!input) return;

		const syncFetchQuery = () => {
			setFetchQuery(input.value);
		};

		syncFetchQuery();
		input.addEventListener('input', syncFetchQuery);
		return () => {
			input.removeEventListener('input', syncFetchQuery);
		};
	}, [isMounted]);

	// Delegate click handler for CRD links in sidebar
	useEffect(() => {
		if (!isMounted) return;
		const sidebar = document.getElementById('fg-sidebar-inner');
		if (!sidebar) return;
		const handler = (e: MouseEvent) => {
			const target = e.target as HTMLElement;
			const nodeBtn = target.closest('[data-node-id]') as HTMLElement | null;
			if (nodeBtn && nodeBtn.dataset.nodeId) {
				e.preventDefault();
				e.stopPropagation();
				routeSidebarNodeSelection({
					nodeId: String(nodeBtn.dataset.nodeId || '').trim(),
					searchSuffix,
					browserPathname,
					pathname,
					setBrowserPathname,
					router,
					pulseDuration: 5000,
					autoExpand: true,
				});
				return;
			}
			const crdBtn = target.closest('.fg-crd-link') as HTMLElement | null;
			if (crdBtn && crdBtn.dataset.crd) {
				e.preventDefault();
				e.stopPropagation();
				const crd = String(crdBtn.dataset.crd || '').trim();
				const type = String(crdBtn.dataset.crdType || '').trim();
				let nodeId = crd;
				if (type) {
					nodeId = `${type}:${crd}`;
				} else if (/^\d+$/.test(crd)) {
					// Legacy behavior: assume numeric CRD clicked from employment means firm
					nodeId = `firm:${crd}`;
				}
				routeSidebarNodeSelection({
					nodeId,
					searchSuffix,
					browserPathname,
					pathname,
					setBrowserPathname,
					router,
					pulseDuration: 5000,
					autoExpand: true,
				});
				return;
			}

			// If the clicked row carries a data-search-query attribute (or a nearby firm span), use that to search-by-name
			const searchBtn = target.closest('[data-search-query]') as HTMLElement | null;
			if (searchBtn) {
				e.preventDefault();
				e.stopPropagation();
				const name = String(searchBtn.dataset.searchQuery || '').trim() || (searchBtn.textContent || '').trim();
				if (name) {
					window.dispatchEvent(new CustomEvent('finra:route-node-request', { detail: { searchQuery: name, pulseDuration: 5000 } }));
				}
				return;
			}

			// Fallback: legacy plain firm-name spans
			const firmNameEl = target.closest('.fg-tl-firm') as HTMLElement | null;
			if (firmNameEl) {
				const name = (firmNameEl.textContent || '').trim();
				if (name) {
					e.preventDefault();
					e.stopPropagation();
					window.dispatchEvent(new CustomEvent('finra:route-node-request', { detail: { searchQuery: name, pulseDuration: 5000 } }));
				}
			}
		};
		sidebar.addEventListener('click', handler);
		return () => sidebar.removeEventListener('click', handler);
	}, [browserPathname, isMounted, pathname, router, searchSuffix]);

	useEffect(() => {
		setIsMounted(true);
	}, []);

	useEffect(() => {
		if (!isMounted) return;
		const syncBrowserPathname = () => {
			setBrowserPathname(window.location.pathname);
		};

		syncBrowserPathname();
		window.addEventListener('popstate', syncBrowserPathname);
		return () => {
			window.removeEventListener('popstate', syncBrowserPathname);
		};
	}, [isMounted, pathname]);

	useEffect(() => {
		if (!isMounted) return;
	}, [isMounted]);

	useEffect(() => {
		if (!isMounted) return;
		const app = appRef.current;
		const sidebar = document.getElementById('fg-sidebar');
		const empty = document.getElementById('fg-empty');
		const bottomStatus = document.getElementById('fg-bottom-status') as HTMLButtonElement | null;
		if (!app || !sidebar || !empty) return;

		const landscapeMobileQuery = window.matchMedia('(max-width: 860px) and (orientation: landscape)');

		const syncUiFlags = () => {
			const isSidebarOpen = !sidebar.classList.contains('hidden');
			const isGraphEmpty = !empty.classList.contains('hidden');
			const shouldFocusFetchInput = isGraphEmpty && wasGraphEmptyRef.current !== true;
			const allowLegendToggle = landscapeMobileQuery.matches && !isGraphEmpty;
			app.dataset.sidebarOpen = isSidebarOpen ? 'true' : 'false';
			app.dataset.graphEmpty = isGraphEmpty ? 'true' : 'false';
			app.dataset.legendToggle = allowLegendToggle ? 'true' : 'false';
			if (!allowLegendToggle) {
				app.dataset.legendOpen = 'false';
			}
			if (bottomStatus) {
				bottomStatus.setAttribute('aria-expanded', app.dataset.legendOpen === 'true' ? 'true' : 'false');
			}
			wasGraphEmptyRef.current = isGraphEmpty;
			if (shouldFocusFetchInput) {
				focusFetchInputWhenEmpty({ force: true });
			}
		};

		const toggleLegend = () => {
			if (app.dataset.legendToggle !== 'true') return;
			app.dataset.legendOpen = app.dataset.legendOpen === 'true' ? 'false' : 'true';
			if (bottomStatus) {
				bottomStatus.setAttribute('aria-expanded', app.dataset.legendOpen === 'true' ? 'true' : 'false');
			}
		};

		syncUiFlags();

		const observer = new MutationObserver(syncUiFlags);
		observer.observe(sidebar, { attributes: true, attributeFilter: ['class'] });
		observer.observe(empty, { attributes: true, attributeFilter: ['class'] });
		landscapeMobileQuery.addEventListener('change', syncUiFlags);
		bottomStatus?.addEventListener('click', toggleLegend);

		return () => {
			observer.disconnect();
			landscapeMobileQuery.removeEventListener('change', syncUiFlags);
			bottomStatus?.removeEventListener('click', toggleLegend);
		};
	}, [isMounted]);

	useEffect(() => {
		if (!isMounted) return;
		const app = appRef.current;
		const fetchInput = document.getElementById('fg-fetch-input');
		if (!app || !fetchInput) return;
		app.dataset.mobileSearchOpen = isMobileSearchOpen ? 'true' : 'false';

		fetchInput.setAttribute('autocorrect', 'off');
		fetchInput.setAttribute('autocapitalize', 'off');
		fetchInput.setAttribute('data-gramm', 'false');
		(fetchInput as HTMLInputElement).spellcheck = false;

		const syncEmptyStateTarget = () => {
			const rect = fetchInput.getBoundingClientRect();
			app.style.setProperty('--fg-empty-target-center', `${rect.left + rect.width / 2}px`);
			app.style.setProperty('--fg-empty-target-right', `${Math.max(16, window.innerWidth - rect.right)}px`);
			app.style.setProperty('--fg-empty-target-bottom', `${rect.bottom}px`);
		};

		syncEmptyStateTarget();
		window.addEventListener('resize', syncEmptyStateTarget);

		return () => {
			window.removeEventListener('resize', syncEmptyStateTarget);
		};
	}, [isMounted]);

	useEffect(() => {
		if (!isMounted) return;
		const handleDocumentFindShortcut = (event: KeyboardEvent) => {
			if (!isFindShortcut(event)) return;
			event.preventDefault();
			event.stopPropagation();
			setIsFindBarOpen(true);
			focusFindInput();
		};

		document.addEventListener('keydown', handleDocumentFindShortcut);
		return () => {
			document.removeEventListener('keydown', handleDocumentFindShortcut);
		};
	}, [focusFindInput, isMounted]);

	useEffect(() => {
		if (!isMounted || !graphReady || !isFindBarOpen) return;
		const query = findQuery.trim();
		if (!query) {
			setFindMatchState({ total: 0, activeOrdinal: 0 });
			return;
		}
		window.dispatchEvent(new CustomEvent(FIND_QUERY_EVENT, { detail: { query } }));
	}, [findQuery, graphReady, isFindBarOpen, isMounted]);

	useEffect(() => {
		if (!isMounted) return;
		const handleFindState = (event: Event) => {
			const detail =
				(
					event as CustomEvent<{
						query?: string | null;
						total?: number | null;
						activeOrdinal?: number | null;
						activeNodeId?: string | null;
					}>
				).detail || {};
			setFindMatchState({
				total: Number(detail.total || 0),
				activeOrdinal: Number(detail.activeOrdinal || 0),
			});
			setActiveFindNodeId(detail.activeNodeId || null);
			setFocusedFindNodeId(detail.activeNodeId || null);
		};

		window.addEventListener(FIND_STATE_EVENT, handleFindState as EventListener);
		const handleMobileFindCloseRequest = () => {
			closeFindBar({ clearQuery: false, preserveMobileRestore: true });
		};
		window.addEventListener(MOBILE_FIND_CLOSE_REQUEST_EVENT, handleMobileFindCloseRequest as EventListener);
		return () => {
			window.removeEventListener(FIND_STATE_EVENT, handleFindState as EventListener);
			window.removeEventListener(MOBILE_FIND_CLOSE_REQUEST_EVENT, handleMobileFindCloseRequest as EventListener);
		};
	}, [closeFindBar, isMounted]);

	useEffect(() => {
		if (!isMounted) return;
		const handleSearchNavigation = (event: KeyboardEvent) => {
			if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
			if (isFindBarOpen) return;
			const target = event.target as Element | null;
			if (target?.closest('input,textarea,select') || (target instanceof HTMLElement && target.isContentEditable)) return;
			const nodeId = focusedFindNodeId || activeFindNodeId;

			if (event.key === 'Enter' && nodeId) {
				event.preventDefault();
				event.stopPropagation();

				routeSidebarNodeSelection({
					nodeId,
					searchSuffix,
					browserPathname,
					pathname,
					setBrowserPathname,
					router,
					autoExpand: true,
				});
				return;
			}

			if (event.key === 'ArrowDown' || event.key === 'ArrowRight' || event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
				event.preventDefault();
				event.stopPropagation();
				window.dispatchEvent(
					new CustomEvent(FIND_MOVE_EVENT, {
						detail: {
							direction: event.key,
							query: findQuery.trim(),
						},
					}),
				);
				return;
			}
		};

		document.addEventListener('keydown', handleSearchNavigation);
		return () => {
			document.removeEventListener('keydown', handleSearchNavigation);
		};
	}, [activeFindNodeId, browserPathname, findQuery, focusedFindNodeId, isFindBarOpen, isMounted, pathname, router, searchSuffix]);

	useEffect(() => {
		if (!isMounted) return;
		const closeOpenLegendTooltip = (target: EventTarget | null) => {
			const openLegend = document.querySelector<HTMLDetailsElement>('.fg-mobile-legend-tooltip[open]');
			if (!openLegend) return;
			if (target instanceof Node && openLegend.contains(target)) return;
			openLegend.open = false;
		};

		const handleDocumentClickCapture = (event: MouseEvent) => {
			closeOpenLegendTooltip(event.target);

			const sidebar = document.getElementById('fg-sidebar');
			const bottomStatus = document.getElementById('fg-bottom-status');
			const findBar = document.getElementById('fg-find-header');
			const findToggle = document.getElementById('fg-find-toggle');
			const target = event.target as Node | null;
			const mobileMenuToggle = document.getElementById('fg-mobile-menu-toggle');
			const graphNode = target instanceof Element ? target.closest('.fg-node') : null;

			if (isFindBarOpenRef.current && findBar && target && !findBar.contains(target) && (!findToggle || !findToggle.contains(target))) {
				closeFindBar({ clearQuery: false });
			}

			if (!sidebar || sidebar.classList.contains('hidden')) return;
			if (target && sidebar.contains(target)) return;
			if (target && bottomStatus?.contains(target)) return;
			if (graphNode) return;
			if (target && (!mobileMenuToggle || !mobileMenuToggle.contains(target))) {
				hideSidebar();
				reopenFindBarAfterSidebarDismiss();
			}
		};

		const handleDocumentFocusIn = (event: FocusEvent) => {
			closeOpenLegendTooltip(event.target);

			const findBar = document.getElementById('fg-find-header');
			const findToggle = document.getElementById('fg-find-toggle');
			const target = event.target as Node | null;
			if (isFindBarOpenRef.current && findBar && target && !findBar.contains(target) && (!findToggle || !findToggle.contains(target))) {
				closeFindBar({ clearQuery: false });
			}
		};

		const handleEscapeKey = (event: KeyboardEvent) => {
			if (event.key !== 'Escape') return;
			if (isFindBarOpenRef.current) {
				event.preventDefault();
				closeFindBar();
				return;
			}
			const openLegend = document.querySelector<HTMLDetailsElement>('.fg-mobile-legend-tooltip[open]');
			if (openLegend) {
				openLegend.open = false;
				return;
			}
			hideSidebar();
			reopenFindBarAfterSidebarDismiss();
		};
		document.addEventListener('click', handleDocumentClickCapture, true);
		document.addEventListener('focusin', handleDocumentFocusIn, true);
		document.addEventListener('keydown', handleEscapeKey);

		return () => {
			document.removeEventListener('click', handleDocumentClickCapture, true);
			document.removeEventListener('focusin', handleDocumentFocusIn, true);
			document.removeEventListener('keydown', handleEscapeKey);
		};
	}, [closeFindBar, isMounted, reopenFindBarAfterSidebarDismiss]);

	useEffect(() => {
		if (!isMounted) return;

		const handleSelectedNodeRoute = (event: Event) => {
			const detail = (event as CustomEvent<{ nodeId?: string | null; replace?: boolean }>).detail || {};
			const nextHref = buildNodeRouteHref(detail.nodeId ?? null, searchSuffix);
			const nextPath = buildNodeRoutePath(detail.nodeId ?? null);
			const currentHref = `${browserPathname || pathname || '/'}${searchSuffix}`;
			if (nextHref === currentHref) return;
			setBrowserPathname(nextPath);
			if (detail.replace) {
				router.replace(nextHref, { scroll: false });
				return;
			}
			router.push(nextHref, { scroll: false });
		};

		window.addEventListener(SELECTED_NODE_ROUTE_EVENT, handleSelectedNodeRoute as EventListener);
		return () => {
			window.removeEventListener(SELECTED_NODE_ROUTE_EVENT, handleSelectedNodeRoute as EventListener);
		};
	}, [browserPathname, isMounted, pathname, router, searchSuffix]);

	useEffect(() => {
		if (!isMounted || !graphReady) return;
		window.dispatchEvent(
			new CustomEvent(ROUTE_NODE_REQUEST_EVENT, {
				detail: {
					nodeId: routeNodeId,
					autoExpand: true,
					forceAutoExpand: true,
				},
			}),
		);
	}, [graphReady, isMounted, routeNodeId]);

	useEffect(() => {
		if (!isMounted || !graphReady || !routeNodeId) return;

		let cancelled = false;
		let attempts = 0;
		let retryTimer: number | null = null;

		const requestRouteNodeSelection = () => {
			if (cancelled) return;
			const sidebar = document.getElementById('fg-sidebar');
			const displayedId = sidebar?.dataset?.displayedId || '';
			const inFlightId = sidebar?.dataset?.inFlightId || '';

			if (displayedId === routeNodeId || inFlightId === routeNodeId || attempts >= 6) return;
			attempts += 1;
			window.dispatchEvent(
				new CustomEvent(ROUTE_NODE_REQUEST_EVENT, {
					detail: {
						nodeId: routeNodeId,
						autoExpand: true,
						forceAutoExpand: true,
					},
				}),
			);
			retryTimer = window.setTimeout(requestRouteNodeSelection, 500);
		};

		retryTimer = window.setTimeout(requestRouteNodeSelection, 150);
		return () => {
			cancelled = true;
			if (retryTimer) {
				window.clearTimeout(retryTimer);
			}
		};
	}, [graphReady, isMounted, routeNodeId]);

	useEffect(() => {
		if (!isMounted) return;
		bindTouchDragClickSuppression(document.getElementById('fg-mobile-menu-toggle'));
		bindTouchDragClickSuppression(document.getElementById('fg-sidebar-pin-toggle'));
	}, [isMounted]);

	useEffect(() => {
		if (!isMounted || mountedRef.current) return;
		mountedRef.current = true;

		try {
			const pinned = localStorage.getItem('finra_sidebar_pinned') === 'true';
			if (pinned) {
				const sidebar = document.getElementById('fg-sidebar');
				if (sidebar) sidebar.dataset.persistentPinned = 'true';
				syncSidebarPinButton(true);
			}
		} catch {}

		Promise.all([import('d3'), import('d3-force'), import('@/lib/finra-graph')]).then(([d3Module, d3ForceModule, { init }]) => {
			const combinedD3 = { ...d3Module, ...d3ForceModule };
			(window as any).d3 = combinedD3;
			init(combinedD3, {
				initialRouteNodeId: routeNodeId,
			});
			setGraphReady(true);
		});
	}, [isMounted, routeNodeId]);

	if (!isMounted) {
		return (
			<div
				id='finra-app'
				className='fg-app-loading'>
				<header className='fg-header'>
					<div className='fg-header-bar'>
						<div className='fg-header-brand'>
							<h1 className='fg-title'>FINRA</h1>
						</div>
					</div>
				</header>
				<main className='fg-main fg-loading-main'>
					<div className='fg-empty-card'>
						<p className='fg-empty-eyebrow'>Loading graph…</p>
					</div>
				</main>
			</div>
		);
	}

	return (
		<div
			id='finra-app'
			ref={appRef}
			tabIndex={-1}
			data-sidebar-open='false'
			data-sidebar-pinned='false'
			data-legend-open='false'
			data-graph-empty='false'>
			<header className='fg-header'>
				<div className='fg-header-bar'>
					<div className='fg-header-brand'>
						<h1 className='fg-title'>FINRA</h1>
					</div>

					<div
						id='fg-header-controls'
						className='fg-header-controls'>
						<div className='fg-fetch-status'>
							<div className='fg-fetch'>
								<div className='fg-fetch-field'>
									<input
										ref={fetchInputRef}
										id='fg-fetch-input'
										className='fg-fetch-input'
										type='search'
										onChange={handleFetchQueryChange}
										placeholder='firm, person, CRD/SEC#'
										autoComplete='off'
										autoCorrect='off'
										autoCapitalize='off'
										spellCheck={false}
										data-gramm='false'
									/>
									<div className='fg-toolbar-group fg-toolbar-status fg-toolbar-status--top'>
										<span
											id='fg-subset-info'
											className='fg-subset-info'></span>
										<button
											id='fg-subset-info-pin'
											type='button'
											className='fg-subset-info-pin'
											title='Dismiss status'
											aria-label='Dismiss status'
											aria-pressed='false'>
											<span
												className='fg-subset-info-pin__icon'
												aria-hidden='true'>
												<span className='fg-subset-info-pin__bar fg-subset-info-pin__bar--one' />
												<span className='fg-subset-info-pin__bar fg-subset-info-pin__bar--two' />
											</span>
										</button>
									</div>
								</div>
								<button
									id='fg-database-search'
									className='fg-btn-primary fg-action-btn'
									title='Search all records in the local database'>
									Search Database
								</button>
							</div>
						</div>
					</div>

					<div
						id='fg-focus-readout'
						className='fg-focus-readout'></div>

					{/* <div
						id='fg-hop-controls'
						className='fg-hop-controls'
						style={{ display: 'flex', gap: '8px', alignItems: 'center', padding: '0 12px' }}>
						<label style={{ fontSize: '12px', fontWeight: 500 }}>Hops (1-5):</label>
						<div style={{ display: 'flex', gap: '6px' }}>
							<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px' }}>
								<select
									id='fg-expansion-hops'
									defaultValue={String(RUNTIME_EXPANSION_HOPS)}
									style={{ width: '60px', height: '24px' }}
									title='Expansion hops (API initial load)'
									onChange={(e) => {
										const val = parseInt(e.target.value, 10);
										const cur = (window as any).getRuntimeHopDefaults?.() || { expansion: 1, click: 3, selection: 3 };
										(window as any).setRuntimeHopDefaults?.(val, cur.click, cur.selection);
									}}
								>
									<option value='1'>1</option>
									<option value='2'>2</option>
									<option value='3'>3</option>
									<option value='4'>4</option>
									<option value='5'>5</option>
								</select>
								<span style={{ fontSize: '10px' }}>Exp</span>
							</div>
							<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px' }}>
								<select
									id='fg-click-hops'
									defaultValue={String(RUNTIME_CLICK_EXPANSION_HOPS)}
									style={{ width: '60px', height: '24px' }}
									title='Click expansion hops'
									onChange={(e) => {
										const val = parseInt(e.target.value, 10);
										const cur = (window as any).getRuntimeHopDefaults?.() || { expansion: 1, click: 3, selection: 3 };
										(window as any).setRuntimeHopDefaults?.(cur.expansion, val, cur.selection);
									}}
								>
									<option value='1'>1</option>
									<option value='2'>2</option>
									<option value='3'>3</option>
									<option value='4'>4</option>
									<option value='5'>5</option>
								</select>
								<span style={{ fontSize: '10px' }}>Click</span>
							</div>
							<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px' }}>
								<select
									id='fg-selection-hops'
									defaultValue={String(RUNTIME_SELECTION_HOPS)}
									style={{ width: '60px', height: '24px' }}
									title='Selection hops'
									onChange={(e) => {
										const val = parseInt(e.target.value, 10);
										const cur = (window as any).getRuntimeHopDefaults?.() || { expansion: 1, click: 3, selection: 3 };
										(window as any).setRuntimeHopDefaults?.(cur.expansion, cur.click, val);
									}}
								>
									<option value='1'>1</option>
									<option value='2'>2</option>
									<option value='3'>3</option>
									<option value='4'>4</option>
									<option value='5'>5</option>
								</select>
								<span style={{ fontSize: '10px' }}>Sel</span>
							</div>
						</div>
					</div> */}

					<div className='fg-header-right-controls'>
						<button
							id='fg-find-toggle'
							type='button'
							className={`fg-btn-secondary fg-find-toggle${isFindBarOpen || isMobileSearchOpen ? ' active' : ''}`}
							onClick={() => {
								if (isMobileSearchViewport()) {
									const nextOpen = !isMobileSearchOpen;
									setIsMobileSearchOpen(nextOpen);
									if (nextOpen) {
										hideSidebar({ force: true });
										window.requestAnimationFrame(() => {
											const input = document.getElementById('fg-fetch-input') as HTMLInputElement | null;
											if (input) {
												input.focus({ preventScroll: true });
												input.select();
											}
										});
									} else {
										window.dispatchEvent(new CustomEvent(FIND_CLOSE_EVENT, { detail: { clearQuery: false } }));
									}
								} else if (isFindBarOpen) {
									closeFindBar({ clearQuery: false });
								} else {
									setIsFindBarOpen(true);
								}
							}}
							title='Find in graph (Ctrl+F)'
							aria-label='Find in graph'
							aria-pressed={isFindBarOpen || isMobileSearchOpen}
							aria-expanded={isMobileSearchOpen}>
							<span className='fg-find-toggle__icon'>🔍</span>
						</button>

						<button
							id='fg-mobile-menu-toggle'
							type='button'
							className='fg-mobile-menu-toggle'
							onClick={toggleMobileMenu}
							title='Toggle menu'
							aria-label='Toggle menu'>
							<span
								className='fg-mobile-menu-toggle__icon'
								aria-hidden='true'>
								<span className='fg-mobile-menu-toggle__bar'></span>
								<span className='fg-mobile-menu-toggle__bar'></span>
								<span className='fg-mobile-menu-toggle__bar'></span>
							</span>
						</button>
					</div>
				</div>
			</header>

			<div className='fg-body'>
				<div
					id='fg-find-header'
					className={`fg-find-header${isFindBarOpen ? '' : ' hidden'}`}
					aria-hidden={!isFindBarOpen}
					inert={!isFindBarOpen}>
					<form
						className='fg-find-header__form'
						onSubmit={(event) => {
							event.preventDefault();
							submitFindQuery();
						}}>
						<div className='fg-find-header__field-group'>
							<input
								ref={findInputRef}
								id='fg-find-input'
								className='fg-search-input fg-find-input'
								type='search'
								value={findQuery}
								onChange={(event) => setFindQuery(event.target.value)}
								onKeyDown={handleFindInputKeyDown}
								placeholder='Find in graph…'
								autoComplete='off'
								autoCorrect='off'
								autoCapitalize='off'
								spellCheck={false}
								data-gramm='false'
							/>
							<span
								id='fg-find-counter'
								className='fg-find-counter'
								aria-live='polite'>
								{findCounterText}
							</span>
						</div>
						<div className='fg-find-header__actions'>
							<button
								type='button'
								className='fg-ghost-btn fg-find-arrow'
								onClick={() => moveFindMatchByButton('ArrowLeft')}
								aria-label='Previous match'>
								←
							</button>
							<button
								type='button'
								className='fg-ghost-btn fg-find-arrow'
								onClick={() => moveFindMatchByButton('ArrowRight')}
								aria-label='Next match'>
								→
							</button>
						</div>
					</form>
				</div>

				<div
					id='fg-sidebar-backdrop'
					className='fg-sidebar-backdrop hidden'
					aria-hidden='true'></div>

				{/* Selection log drawer */}
				<aside
					id='fg-selection-log'
					className='fg-selection-log hidden'>
					<div className='fg-log-drawer-header'>
						<h3>Selection Log</h3>
						<div className='fg-log-drawer-actions'>
							<div className='fg-log-drawer-actions-row fg-log-drawer-actions-row--primary'>
								<button
									data-fg-selection-log-action='toggle-bold'
									className='fg-ghost-btn fg-btn-sm'
									type='button'
									title='Make log entries larger and bolder'>
									Log Bold
								</button>
								<button
									id='btn-selection-log-trace'
									data-fg-selection-log-action='trace'
									className='fg-ghost-btn fg-btn-sm'
									type='button'
									title='Trace path between all logged nodes'>
									Trace with Log
								</button>
							</div>
							<div className='fg-log-drawer-actions-row fg-log-drawer-actions-row--secondary'>
								<button
									id='btn-selection-log-copy-all'
									data-fg-selection-log-action='copy-all'
									className='fg-ghost-btn fg-btn-sm'
									type='button'
									title='Copy all entries'>
									Copy All
								</button>
								<button
									id='btn-selection-log-edit'
									data-fg-selection-log-action='edit'
									className='fg-ghost-btn fg-btn-sm'
									type='button'
									title='Edit selection log entries'>
									Edit
								</button>
								<button
									id='btn-selection-log-clear'
									data-fg-selection-log-action='clear'
									className='fg-ghost-btn fg-btn-sm'
									type='button'
									title='Clear log'>
									Clear
								</button>
							</div>
						</div>
					</div>
					<div
						id='fg-selection-log-list'
						className='fg-selection-log-list'></div>
				</aside>

				{/* Detail sidebar */}
				<aside
					id='fg-sidebar'
					className='fg-sidebar hidden'>
					<div className='fg-sidebar-actions'>
						<button
							type='button'
							data-fg-action='refresh-layout'
							className='fg-sidebar-action-btn fg-sidebar-action-btn--secondary fg-sidebar-action-btn--mobile-only'
							title='Re-run the graph layout'
							aria-label='Reflow layout'>
							<span className='fg-sidebar-action-label'>Refresh</span>
							<span
								className='fg-sidebar-action-icon fg-sidebar-action-icon--trailing'
								aria-hidden='true'>
								↺
							</span>
						</button>

						<button
							type='button'
							data-fg-trace-mode-button='sidebar-mobile'
							className='fg-ghost-btn'
							title='Toggle path tracing mode'>
							Trace Mode
						</button>
						<button
							type='button'
							data-fg-action='clear-session'
							className='fg-danger-btn'
							title='Clear saved session and reload fresh'>
							Reset Session
						</button>
						<button
							id='fg-sidebar-pin-toggle'
							className='fg-sidebar-action-btn fg-sidebar-action-btn--pin fg-sidebar-action-btn--icon-only'
							type='button'
							onClick={toggleSidebarPin}
							title='Pin panel open'
							aria-label='Pin panel open'
							aria-pressed='false'
							data-pinned='false'>
							<span
								className='fg-sidebar-action-icon'
								aria-hidden='true'>
								<svg
									viewBox='0 0 16 16'
									fill='none'
									xmlns='http://www.w3.org/2000/svg'>
									<path
										d='M9.5 1.5L14.5 6.5L10.5 10.5L9 9L7 11H5L3 13L3 11L5 9H3L3.5 7L7 7L5.5 5.5L9.5 1.5Z'
										stroke='currentColor'
										strokeWidth='1.2'
										strokeLinejoin='round'
									/>
								</svg>
							</span>
						</button>
					</div>
					<div className='fg-sidebar-mobile-actions'>
						<button
							type='button'
							data-fg-action='clear-highlights'
							className='fg-ghost-btn'
							title='Clear selected highlights'>
							Clear Highlight
						</button>
						<button
							id='fg-focus-btn'
							className='fg-sidebar-action-btn fg-sidebar-action-btn--secondary'
							type='button'
							title='Focus on this node'
							aria-label='Center on this node'>
							<span className='fg-sidebar-action-label'>Center</span>
							<span
								className='fg-sidebar-action-icon fg-sidebar-action-icon--trailing'
								aria-hidden='true'>
								<svg
									viewBox='0 0 16 16'
									fill='none'
									focusable='false'>
									<circle
										cx='8'
										cy='8'
										r='2.75'
										stroke='currentColor'
										strokeWidth='1.4'
									/>
									<path
										d='M8 1.75V4'
										stroke='currentColor'
										strokeWidth='1.4'
										strokeLinecap='round'
									/>
									<path
										d='M8 12V14.25'
										stroke='currentColor'
										strokeWidth='1.4'
										strokeLinecap='round'
									/>
									<path
										d='M1.75 8H4'
										stroke='currentColor'
										strokeWidth='1.4'
										strokeLinecap='round'
									/>
									<path
										d='M12 8H14.25'
										stroke='currentColor'
										strokeWidth='1.4'
										strokeLinecap='round'
									/>
								</svg>
							</span>
						</button>

						<details
							className='fg-mobile-legend-tooltip'
							onBlur={handleLegendTooltipBlur}>
							<summary
								className='fg-mobile-legend-tooltip__toggle'
								title='Show legend'>
								Legend
							</summary>
							<div className='fg-mobile-legend-tooltip__panel'>
								<div
									id='fg-mobile-legend'
									className='fg-mobile-legend'></div>
							</div>
						</details>
						<ThemeToggle />
					</div>

					<div
						id='fg-sidebar-inner'
						className='fg-sidebar-inner'>
						{/* <p className='fg-hint'>Click a node to inspect it.</p> */}
					</div>
				</aside>

				<main
					className='fg-main'
					id='fg-main'>
					<svg id='fg-svg'></svg>
					<div
						id='fg-legend'
						className='fg-legend'></div>
					<div
						id='fg-empty'
						className='fg-empty hidden'>
						<div className='fg-empty-card'>
							<div
								className='fg-empty-card__arrow'
								aria-hidden='true'>
								<span className='fg-empty-card__arrow-line'></span>
								<span className='fg-empty-card__arrow-head'></span>
							</div>
							<p className='fg-empty-eyebrow'>First time here?</p>
							<h2 className='fg-empty-title'>Start with the search field above.</h2>
							<ul className='fg-empty-steps'>
								<li>Selecting a firm will only show its employees, while selecting a person will show all their associated firms and connections.</li>
							</ul>
						</div>
					</div>
				</main>
			</div>

			<div
				id='fg-log-panel'
				className='fg-log-panel hidden'>
				<div className='fg-log-header'>
					<span>Scraper Output</span>
					<button
						id='btn-log-close'
						className='fg-log-close'>
						✕
					</button>
				</div>
				<pre
					id='fg-log-body'
					className='fg-log-body'></pre>
			</div>

			<button
				id='fg-bottom-status'
				className='fg-bottom-status'
				type='button'
				aria-live='polite'
				aria-expanded='false'>
				<span
					id='fg-bottom-status-text'
					className='fg-bottom-status__text'></span>
				<span
					className='fg-bottom-status__indicator'
					aria-hidden='true'></span>
			</button>
		</div>
	);
}

// Export helpers for unit testing (DOM-only, no browser binaries required)
export {
	bindTouchDragClickSuppression,
	ensureSidebarHintContent,
	isSidebarTemporarilyPinned,
	isSidebarPersistentlyPinned,
	syncSidebarPinButton,
	toggleSidebarPin,
	hideSidebar,
	toggleMobileMenu,
	handleLegendTooltipBlur,
	hideSelectionLog,
	focusFetchInputWhenEmpty,
	routeSidebarNodeSelection,
	isFindShortcut,
	formatFindCounter,
};
