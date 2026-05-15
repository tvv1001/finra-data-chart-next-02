'use client';

import { useEffect, useRef, useState } from 'react';

function hideSidebar() {
	document.getElementById('fg-sidebar')?.classList.add('hidden');
	document.getElementById('fg-sidebar-backdrop')?.classList.add('hidden');
}

function hideSelectionLog() {
	document.getElementById('fg-selection-log')?.classList.add('hidden');
}

export default function FinraGraph() {
	const mountedRef = useRef(false);
	const appRef = useRef<HTMLDivElement | null>(null);
	const [isMounted, setIsMounted] = useState(false);

	useEffect(() => {
		setIsMounted(true);
	}, []);

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
		const handleDocumentClickCapture = (event: MouseEvent) => {
			const sidebar = document.getElementById('fg-sidebar');
			const logPanel = document.getElementById('fg-selection-log');
			const target = event.target as Node | null;

			if (sidebar && !sidebar.classList.contains('hidden')) {
				if (target && !sidebar.contains(target)) {
					hideSidebar();
				}
			}

			if (logPanel && !logPanel.classList.contains('hidden')) {
				const toggleBtn = document.getElementById('fg-selection-log-toggle');
				if (target && !logPanel.contains(target) && (!toggleBtn || !toggleBtn.contains(target))) {
					hideSelectionLog();
				}
			}
		};

		const handleEscapeKey = (event: KeyboardEvent) => {
			if (event.key !== 'Escape') return;
			hideSidebar();
			hideSelectionLog();
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

		Promise.all([import('d3'), import('d3-force'), import('@/lib/finra-graph')]).then(
			([d3Module, d3ForceModule, { init }]) => {
				const combinedD3 = { ...d3Module, ...d3ForceModule };
				(window as any).d3 = combinedD3;
				init(combinedD3);
			},
		);
	}, [isMounted]);

	if (!isMounted) {
		return null;
	}

	return (
		<div
			id="finra-app"
			ref={appRef}
			data-sidebar-open="false"
			data-graph-empty="false">
			<header className="fg-header">
				<div className="fg-header-bar">
					<div className="fg-header-brand">
						<h1 className="fg-title">FINRA</h1>
					</div>

					<div
						id="fg-header-controls"
						className="fg-header-controls">
						<div className="fg-fetch-status">
							<div className="fg-fetch">
								<input
									id="fg-fetch-input"
									className="fg-fetch-input"
									type="search"
									placeholder="Fetch: firm, person, CRD/SEC#"
									autoComplete="off"
								/>
								<button
									id="fg-fetch-remote"
									className="fg-btn-primary fg-action-btn"
									title="Fetch matching nodes from the server">
									Fetch Nodes
								</button>
								<div className="fg-toolbar-group fg-toolbar-status fg-toolbar-status--top">
									<span
										id="fg-subset-info"
										className="fg-subset-info"></span>
								</div>
							</div>

							<div className="fg-toolbar-group fg-toolbar-actions">
								<button
									id="fg-trace-mode"
									className="fg-ghost-btn"
									title="Toggle path tracing mode">
									Trace Mode
								</button>
								<button
									id="fg-refresh-layout"
									data-fg-action="refresh-layout"
									className="fg-ghost-btn"
									title="Re-run the graph layout">
									↺ Reflow Layout
								</button>
								<button
									id="fg-clear-highlights"
									data-fg-action="clear-highlights"
									className="fg-ghost-btn"
									title="Clear selected highlights">
									Clear Highlight
								</button>
								<button
									id="fg-clear-session"
									data-fg-action="clear-session"
									className="fg-danger-btn"
									title="Clear saved session and reload fresh">
									Reset Session
								</button>
							</div>
						</div>
					</div>
				</div>
			</header>

			<div className="fg-body">
				<div
					id="fg-sidebar-backdrop"
					className="fg-sidebar-backdrop hidden"
					aria-hidden="true"></div>

				{/* Selection log drawer */}
				<aside
					id="fg-selection-log"
					className="fg-selection-log hidden">
					<div className="fg-log-drawer-header">
						<h3>Selection Log</h3>
						<div className="fg-log-drawer-actions">
							<button
								id="btn-selection-log-trace"
								className="fg-ghost-btn fg-btn-sm"
								title="Trace path between all logged nodes">
								Trace with Log
							</button>
							<button
								id="btn-selection-log-copy-all"
								className="fg-ghost-btn fg-btn-sm"
								title="Copy all entries">
								Copy All
							</button>
							<button
								id="btn-selection-log-clear"
								className="fg-ghost-btn fg-btn-sm"
								title="Clear log">
								Clear
							</button>
							<button
								id="btn-selection-log-close"
								className="fg-log-close">
								✕
							</button>
						</div>
					</div>
					<div
						id="fg-selection-log-list"
						className="fg-selection-log-list">
						<p className="fg-log-empty">No nodes selected yet.</p>
					</div>
				</aside>

				{/* Detail sidebar */}
				<aside
					id="fg-sidebar"
					className="fg-sidebar hidden">
					<div className="fg-sidebar-actions">
						<button
							className="fg-sidebar-action-btn fg-sidebar-action-btn--primary"
							type="button"
							onClick={hideSidebar}
							title="Close details panel"
							aria-label="Close details panel">
							<span className="fg-sidebar-action-label">Close</span>
							<span
								className="fg-sidebar-action-icon fg-sidebar-action-icon--trailing"
								aria-hidden="true">
								✕
							</span>
						</button>
						<button
							id="fg-focus-btn"
							className="fg-sidebar-action-btn fg-sidebar-action-btn--secondary"
							title="Focus on this node"
							aria-label="Center on this node">
							<span className="fg-sidebar-action-label">Center</span>
							<span
								className="fg-sidebar-action-icon fg-sidebar-action-icon--trailing"
								aria-hidden="true">
								<svg
									viewBox="0 0 16 16"
									fill="none"
									focusable="false">
									<circle
										cx="8"
										cy="8"
										r="2.75"
										stroke="currentColor"
										strokeWidth="1.4"
									/>
									<path
										d="M8 1.75V4"
										stroke="currentColor"
										strokeWidth="1.4"
										strokeLinecap="round"
									/>
									<path
										d="M8 12V14.25"
										stroke="currentColor"
										strokeWidth="1.4"
										strokeLinecap="round"
									/>
									<path
										d="M1.75 8H4"
										stroke="currentColor"
										strokeWidth="1.4"
										strokeLinecap="round"
									/>
									<path
										d="M12 8H14.25"
										stroke="currentColor"
										strokeWidth="1.4"
										strokeLinecap="round"
									/>
								</svg>
							</span>
						</button>
						<button
							type="button"
							data-fg-action="refresh-layout"
							className="fg-sidebar-action-btn fg-sidebar-action-btn--secondary fg-sidebar-action-btn--mobile-only"
							title="Re-run the graph layout"
							aria-label="Reflow layout">
							<span className="fg-sidebar-action-label">Refresh</span>
							<span
								className="fg-sidebar-action-icon fg-sidebar-action-icon--trailing"
								aria-hidden="true">
								↺
							</span>
						</button>
					</div>
					<div className="fg-sidebar-mobile-actions">
						<button
							type="button"
							data-fg-action="clear-highlights"
							className="fg-ghost-btn"
							title="Clear selected highlights">
							Clear Highlight
						</button>
						<button
							type="button"
							data-fg-action="clear-session"
							className="fg-danger-btn"
							title="Clear saved session and reload fresh">
							Reset Session
						</button>
					</div>
					<div
						id="fg-sidebar-inner"
						className="fg-sidebar-inner">
						<p className="fg-hint">Click a node to inspect it.</p>
					</div>
				</aside>

				<main
					className="fg-main"
					id="fg-main">
					<svg id="fg-svg"></svg>
					<div
						id="fg-legend"
						className="fg-legend"></div>
					<button
						id="fg-selection-log-toggle"
						className="fg-selection-log-floating-toggle"
						title="View selected nodes log">
						<svg
							viewBox="0 0 16 16"
							fill="currentColor"
							width="16"
							height="16">
							<path d="M0 1.75C0 .784.784 0 1.75 0h12.5C15.216 0 16 .784 16 1.75v12.5A1.75 1.75 0 0 1 14.25 16H1.75A1.75 1.75 0 0 1 0 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25V1.75a.25.25 0 0 0-.25-.25Zm2.5 8.5a.75.75 0 0 1 .75-.75h7a.75.75 0 0 1 0 1.5h-7a.75.75 0 0 1-.75-.75Zm0-3.5a.75.75 0 0 1 .75-.75h7a.75.75 0 0 1 0 1.5h-7a.75.75 0 0 1-.75-.75Zm0-3.5a.75.75 0 0 1 .75-.75h7a.75.75 0 0 1 0 1.5h-7a.75.75 0 0 1-.75-.75Z"></path>
						</svg>
						<span>Log</span>
					</button>
					<div
						id="fg-empty"
						className="fg-empty hidden">
						<p>Search for a firm, person, CRD, or SEC# to begin.</p>
					</div>
				</main>
			</div>

			<div
				id="fg-log-panel"
				className="fg-log-panel hidden">
				<div className="fg-log-header">
					<span>Scraper Output</span>
					<button
						id="btn-log-close"
						className="fg-log-close">
						✕
					</button>
				</div>
				<pre
					id="fg-log-body"
					className="fg-log-body"></pre>
			</div>

			<div
				id="fg-bottom-status"
				className="fg-bottom-status"
				aria-live="polite"></div>
		</div>
	);

}
