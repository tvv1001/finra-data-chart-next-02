'use client';

import { useEffect, useRef, useState } from 'react';

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

function hideSelectionLog() {
	const panel = document.getElementById('fg-selection-log');
	if (!panel) return;
	const isPinned = panel.dataset.pinned === 'true';
	if (isPinned) return;
	panel.classList.add('hidden');
}

export default function FinraGraph() {
	const mountedRef = useRef(false);
	const appRef = useRef<HTMLDivElement | null>(null);
	const [isMounted, setIsMounted] = useState(false);

	useEffect(() => {
		setIsMounted(true);
	}, []);

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
		const handleDocumentClickCapture = (event: MouseEvent) => {
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

		const handleEscapeKey = (event: KeyboardEvent) => {
			if (event.key !== 'Escape') return;
			hideSidebar();
		};

		document.addEventListener('click', handleDocumentClickCapture, true);
		document.addEventListener('keydown', handleEscapeKey);

		return () => {
			document.removeEventListener('click', handleDocumentClickCapture, true);
			document.removeEventListener('keydown', handleEscapeKey);
		};
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
			init(combinedD3);
		});
	}, [isMounted]);

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
										placeholder='Fetch: firm, person, CRD/SEC#'
										autoComplete='off'
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
							id='fg-sidebar-pin-toggle'
							className='fg-sidebar-action-btn fg-sidebar-action-btn--pin'
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
							<span className='fg-sidebar-action-label'>Pin</span>
						</button>
						<button
							id='fg-focus-btn'
							className='fg-sidebar-action-btn fg-sidebar-action-btn--secondary'
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
					</div>
					<div className='fg-sidebar-mobile-actions'>
						<button
							type='button'
							data-fg-trace-mode-button='sidebar-mobile'
							className='fg-ghost-btn'
							title='Toggle path tracing mode'>
							Trace Mode
						</button>
						<button
							type='button'
							data-fg-action='clear-highlights'
							className='fg-ghost-btn'
							title='Clear selected highlights'>
							Clear Highlight
						</button>
						<button
							type='button'
							data-fg-action='clear-session'
							className='fg-danger-btn'
							title='Clear saved session and reload fresh'>
							Reset Session
						</button>
						<details className='fg-mobile-legend-tooltip'>
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
								<li>Selecting a firm will only show it's employees, while selecting a person will show all their associated firms and connections.</li>
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
