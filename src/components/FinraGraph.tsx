'use client';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';

import ThemeToggle from '@/components/ThemeToggle';
import { buildNodeRouteHref, buildNodeRoutePath, parseNodeIdFromPathname } from '@/lib/node-route';

const MOBILE_TOUCH_SLOP_PX = 12;
const MOBILE_TOUCH_CLICK_SUPPRESSION_MS = 250;
const ROUTE_NODE_REQUEST_EVENT = 'finra:route-node-request';
const SELECTED_NODE_ROUTE_EVENT = 'finra:selected-node-route';

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

export default function FinraGraph() {
	const mountedRef = useRef(false);
	const appRef = useRef<HTMLDivElement | null>(null);
	const wasGraphEmptyRef = useRef<boolean | null>(null);
	const [isMounted, setIsMounted] = useState(false);
	const [graphReady, setGraphReady] = useState(false);
	const [browserPathname, setBrowserPathname] = useState('');
	const router = useRouter();
	const pathname = usePathname();
	const searchParams = useSearchParams();
	const routeNodeId = useMemo(() => parseNodeIdFromPathname(browserPathname || pathname), [browserPathname, pathname]);
	const searchSuffix = useMemo(() => {
		const suffix = searchParams.toString();
		return suffix ? `?${suffix}` : '';
	}, [searchParams]);

	// Delegate click handler for CRD links in sidebar
	useEffect(() => {
		if (!isMounted) return;
		const sidebar = document.getElementById('fg-sidebar-inner');
		if (!sidebar) return;
		const handler = (e: MouseEvent) => {
			const target = e.target as HTMLElement;
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
				// When routing to a node from the sidebar link, request a 5s pulse highlight
				window.dispatchEvent(new CustomEvent('finra:route-node-request', { detail: { nodeId, pulseDuration: 5000 } }));
			}

			// If the firm name is rendered as plain text (no CRD button), allow
			// clicking the firm name to trigger a search-by-name route resolution.
			const firmNameEl = target.closest('.fg-tl-firm') as HTMLElement | null;
			if (!crdBtn && firmNameEl) {
				const name = (firmNameEl.textContent || '').trim();
				if (name) {
					e.preventDefault();
					e.stopPropagation();
					// When routing by clicking a firm name in the sidebar, request a 5s pulse highlight
					window.dispatchEvent(new CustomEvent('finra:route-node-request', { detail: { searchQuery: name, pulseDuration: 5000 } }));
				}
			}
		};
		sidebar.addEventListener('click', handler);
		return () => sidebar.removeEventListener('click', handler);
	}, [isMounted]);

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
			if (!sidebar || sidebar.classList.contains('hidden')) return;
			const target = event.target as Node | null;
			const mobileMenuToggle = document.getElementById('fg-mobile-menu-toggle');
			const graphNode = target instanceof Element ? target.closest('.fg-node') : null;

			if (target && sidebar.contains(target)) return;
			if (target && bottomStatus?.contains(target)) return;
			if (graphNode) return;
			if (target && (!mobileMenuToggle || !mobileMenuToggle.contains(target))) {
				hideSidebar();
			}
		};

		const handleDocumentFocusIn = (event: FocusEvent) => {
			closeOpenLegendTooltip(event.target);
		};

		const handleEscapeKey = (event: KeyboardEvent) => {
			if (event.key !== 'Escape') return;
			const openLegend = document.querySelector<HTMLDetailsElement>('.fg-mobile-legend-tooltip[open]');
			if (openLegend) {
				openLegend.open = false;
				return;
			}
			hideSidebar();
		};

		document.addEventListener('click', handleDocumentClickCapture, true);
		document.addEventListener('focusin', handleDocumentFocusIn, true);
		document.addEventListener('keydown', handleEscapeKey);

		return () => {
			document.removeEventListener('click', handleDocumentClickCapture, true);
			document.removeEventListener('focusin', handleDocumentFocusIn, true);
			document.removeEventListener('keydown', handleEscapeKey);
		};
	}, [isMounted]);

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
			const displayedId = document.getElementById('fg-sidebar')?.dataset?.displayedId || '';
			if (displayedId === routeNodeId || attempts >= 6) return;
			attempts += 1;
			window.dispatchEvent(
				new CustomEvent(ROUTE_NODE_REQUEST_EVENT, {
					detail: {
						nodeId: routeNodeId,
					},
				}),
			);
			retryTimer = window.setTimeout(requestRouteNodeSelection, 350);
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
		return null;
	}

	return (
		<div
			id='finra-app'
			ref={appRef}
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
										id='fg-fetch-input'
										className='fg-fetch-input'
										type='search'
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
									id='fg-fetch-remote'
									className='fg-btn-primary fg-action-btn'
									title='Fetch matching nodes from the server'>
									Fetch Nodes
								</button>
							</div>
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
				</div>
			</header>

			<div className='fg-body'>
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
							<button
								id='btn-selection-log-trace'
								data-fg-selection-log-action='trace'
								className='fg-ghost-btn fg-btn-sm'
								type='button'
								title='Trace path between all logged nodes'>
								Trace with Log
							</button>
							<button
								id='btn-selection-log-copy-all'
								data-fg-selection-log-action='copy-all'
								className='fg-ghost-btn fg-btn-sm'
								type='button'
								title='Copy all entries'>
								Copy All
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
					<div
						id='fg-selection-log-list'
						className='fg-selection-log-list'>
						<p className='fg-log-empty'>No nodes selected yet.</p>
					</div>
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
