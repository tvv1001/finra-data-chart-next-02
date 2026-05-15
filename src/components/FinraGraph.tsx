'use client';

import { useEffect, useRef, useState } from 'react';

const SIDEBAR_PIN_STORAGE_KEY = 'finra_sidebar_pinned';

function ensureSidebarHintContent() {
	const inner = document.getElementById('fg-sidebar-inner');
	if (!inner) return;
	const hasRenderableContent = inner.children.length > 0 || Boolean(inner.textContent?.trim());
	if (!hasRenderableContent) {
		inner.innerHTML = `<p class="fg-hint">Click a node to inspect it.</p>`;
	}
}

function isSidebarPersistentlyPinned() {
	const sidebar = document.getElementById('fg-sidebar');
	if (sidebar?.dataset.persistentPinned === 'true') return true;
	return document.getElementById('finra-app')?.dataset.sidebarPinned === 'true';
}

function syncSidebarPinnedState(pinned: boolean, options: { persist?: boolean } = {}) {
	const { persist = true } = options;
	const app = document.getElementById('finra-app');
	const sidebar = document.getElementById('fg-sidebar');
	const backdrop = document.getElementById('fg-sidebar-backdrop');
	const pinButton = document.getElementById('fg-mobile-menu-pin-toggle');

	app?.setAttribute('data-sidebar-pinned', pinned ? 'true' : 'false');
	if (sidebar) {
		sidebar.dataset.persistentPinned = pinned ? 'true' : 'false';
		if (pinned) {
			sidebar.classList.remove('hidden');
			ensureSidebarHintContent();
		}
	}
	if (backdrop) {
		backdrop.dataset.persistentPinned = pinned ? 'true' : 'false';
		if (pinned) {
			backdrop.classList.remove('hidden');
		}
	}
	if (pinButton) {
		pinButton.classList.toggle('is-active', pinned);
		pinButton.setAttribute('aria-pressed', pinned ? 'true' : 'false');
		pinButton.setAttribute('title', pinned ? 'Unpin menu' : 'Pin menu open');
		pinButton.setAttribute('aria-label', pinned ? 'Unpin menu' : 'Pin menu open');
	}
	if (persist) {
		try {
			localStorage.setItem(SIDEBAR_PIN_STORAGE_KEY, pinned ? '1' : '0');
		} catch {
			// ignore storage errors
		}
	}
}

function isSidebarTemporarilyPinned() {
	const sidebar = document.getElementById('fg-sidebar');
	if (!sidebar || sidebar.classList.contains('hidden')) return false;
	const isExpanded = sidebar.dataset.mobileExpanded === 'true';
	const viewMode = sidebar.dataset.viewMode;
	return isExpanded && (viewMode === 'info' || viewMode === 'log');
}

function hideSidebar(options: { force?: boolean; clearPersistentPin?: boolean } = {}) {
	const { force = false, clearPersistentPin = false } = options;
	if (!force && isSidebarPersistentlyPinned()) return;
	if (!force && isSidebarTemporarilyPinned()) return;
	if (clearPersistentPin && isSidebarPersistentlyPinned()) {
		syncSidebarPinnedState(false);
	}
	document.getElementById('fg-sidebar')?.classList.add('hidden');
	document.getElementById('fg-sidebar-backdrop')?.classList.add('hidden');
}

function toggleMobileMenu() {
	const sidebar = document.getElementById('fg-sidebar');
	const backdrop = document.getElementById('fg-sidebar-backdrop');
	if (!sidebar) return;
	const isOpen = !sidebar.classList.contains('hidden');
	if (isOpen) {
		hideSidebar({ force: true, clearPersistentPin: true });
		return;
	}
	sidebar.classList.remove('hidden');
	backdrop?.classList.remove('hidden');
}

function toggleSidebarPin() {
	const nextPinned = !isSidebarPersistentlyPinned();
	syncSidebarPinnedState(nextPinned);
	if (nextPinned) {
		document.getElementById('fg-sidebar')?.classList.remove('hidden');
		document.getElementById('fg-sidebar-backdrop')?.classList.remove('hidden');
		ensureSidebarHintContent();
	}
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
		let pinned = false;
		try {
			pinned = localStorage.getItem(SIDEBAR_PIN_STORAGE_KEY) === '1';
		} catch {
			// ignore storage errors
		}
		syncSidebarPinnedState(pinned, { persist: false });
	}, [isMounted]);

	// If a saved session exists with a selected node or highlights, show the
	// sidebar on initial load so the UI matches the persisted production view.
	useEffect(() => {
		if (!isMounted) return;
		try {
			const raw = localStorage.getItem('finra_session');
			if (!raw) return;
			const parsed = JSON.parse(raw as string);
			const data = parsed && typeof parsed === 'object' && 'data' in parsed ? parsed.data : parsed;
			const hasSelection = data && !data.cleared && (data.selectedNodeId || (Array.isArray(data.highlightedNodes) && data.highlightedNodes.length));
			if (hasSelection) {
				document.getElementById('fg-sidebar')?.classList.remove('hidden');
				document.getElementById('fg-sidebar-backdrop')?.classList.remove('hidden');
			}
		} catch (e) {
			// ignore parse errors
		}
		if (isSidebarPersistentlyPinned()) {
			document.getElementById('fg-sidebar')?.classList.remove('hidden');
			document.getElementById('fg-sidebar-backdrop')?.classList.remove('hidden');
			ensureSidebarHintContent();
		}
	}, [isMounted]);

	useEffect(() => {
		if (!isMounted) return;
		const app = appRef.current;
		const sidebar = document.getElementById('fg-sidebar');
		const empty = document.getElementById('fg-empty');
		if (!app || !sidebar || !empty) return;

		const syncUiFlags = () => {
			const isSidebarOpen = !sidebar.classList.contains('hidden');
			app.dataset.sidebarOpen = isSidebarOpen ? 'true' : 'false';
			app.dataset.graphEmpty = empty.classList.contains('hidden') ? 'false' : 'true';
		};

		syncUiFlags();

		const observer = new MutationObserver(syncUiFlags);
		observer.observe(sidebar, { attributes: true, attributeFilter: ['class'] });
		observer.observe(empty, { attributes: true, attributeFilter: ['class'] });

		return () => {
			observer.disconnect();
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
			const target = event.target as Node | null;
			const mobileMenuToggle = document.getElementById('fg-mobile-menu-toggle');

			if (sidebar && !sidebar.classList.contains('hidden')) {
				if (target && !sidebar.contains(target) && (!mobileMenuToggle || !mobileMenuToggle.contains(target))) {
					hideSidebar();
				}
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
								<input
									id='fg-fetch-input'
									className='fg-fetch-input'
									type='search'
									placeholder='Fetch: firm, person, CRD/SEC#'
									autoComplete='off'
								/>
								<button
									id='fg-fetch-remote'
									className='fg-btn-primary fg-action-btn'
									title='Fetch matching nodes from the server'>
									Fetch Nodes
								</button>
								<div className='fg-toolbar-group fg-toolbar-status fg-toolbar-status--top'>
									<span
										id='fg-subset-info'
										className='fg-subset-info'></span>
								</div>
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
							<button
								id='fg-mobile-menu-pin-toggle'
								type='button'
								className='fg-mobile-menu-pin-toggle'
								onClick={toggleSidebarPin}
								title='Pin menu open'
								aria-label='Pin menu open'
								aria-pressed='false'>
								<span
									className='fg-mobile-menu-pin-toggle__icon'
									aria-hidden='true'>
									<svg
										viewBox='0 0 16 16'
										fill='none'
										focusable='false'>
										<path
											d='M5.25 2.25h5.5l-.85 3.1 1.9 1.9H4.2l1.9-1.9-.85-3.1Z'
											stroke='currentColor'
											strokeWidth='1.3'
											strokeLinejoin='round'
										/>
										<path
											d='M8 7.25v6.5'
											stroke='currentColor'
											strokeWidth='1.3'
											strokeLinecap='round'
										/>
										<path
											d='M6.45 13.75h3.1'
											stroke='currentColor'
											strokeWidth='1.3'
											strokeLinecap='round'
										/>
									</svg>
								</span>
							</button>

							<div className='fg-toolbar-group fg-toolbar-actions'>
								<button
									id='fg-trace-mode'
									className='fg-ghost-btn'
									title='Toggle path tracing mode'>
									Trace Mode
								</button>
								<button
									id='fg-refresh-layout'
									data-fg-action='refresh-layout'
									className='fg-ghost-btn'
									title='Re-run the graph layout'>
									↺ Reflow Layout
								</button>
								<button
									id='fg-clear-highlights'
									data-fg-action='clear-highlights'
									className='fg-ghost-btn'
									title='Clear selected highlights'>
									Clear Highlight
								</button>
								<button
									id='fg-clear-session'
									data-fg-action='clear-session'
									className='fg-danger-btn'
									title='Clear saved session and reload fresh'>
									Reset Session
								</button>
							</div>
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
								title='Trace path between all logged nodes'>
								Trace with Log
							</button>
							<button
								id='btn-selection-log-copy-all'
								data-fg-selection-log-action='copy-all'
								className='fg-ghost-btn fg-btn-sm'
								title='Copy all entries'>
								Copy All
							</button>
							<button
								id='btn-selection-log-clear'
								data-fg-selection-log-action='clear'
								className='fg-ghost-btn fg-btn-sm'
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
							className='fg-sidebar-action-btn fg-sidebar-action-btn--primary'
							type='button'
							onClick={() => hideSidebar({ force: true, clearPersistentPin: true })}
							title='Close details panel'
							aria-label='Close details panel'>
							<span className='fg-sidebar-action-label'>Close</span>
							<span
								className='fg-sidebar-action-icon fg-sidebar-action-icon--trailing'
								aria-hidden='true'>
								✕
							</span>
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

			<div
				id='fg-bottom-status'
				className='fg-bottom-status'
				aria-live='polite'></div>
		</div>
	);
}
