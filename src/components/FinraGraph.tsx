'use client';

import { useEffect, useRef } from 'react';

function hideSidebar() {
	document.getElementById('fg-sidebar')?.classList.add('hidden');
	document.getElementById('fg-sidebar-backdrop')?.classList.add('hidden');
}

export default function FinraGraph() {
	const mountedRef = useRef(false);

	// If a saved session exists with a selected node or highlights, show the
	// sidebar on initial load so the UI matches the persisted production view.
	useEffect(() => {
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
	}, []);

	useEffect(() => {
		const handleDocumentClickCapture = (event: MouseEvent) => {
			const sidebar = document.getElementById('fg-sidebar');
			if (!sidebar || sidebar.classList.contains('hidden')) return;
			const target = event.target as Node | null;
			if (target && sidebar.contains(target)) return;
			hideSidebar();
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
	}, []);

	useEffect(() => {
		if (mountedRef.current) return;
		mountedRef.current = true;

		Promise.all([import('d3'), import('d3-force'), import('@/lib/finra-graph')]).then(([d3Module, d3ForceModule, { init }]) => {
			const combinedD3 = { ...d3Module, ...d3ForceModule };
			(window as any).d3 = combinedD3;
			init(combinedD3);
		});
	}, []);

	return (
		<div id='finra-app'>
			<header className='fg-header'>
				<div className='fg-header-bar'>
					<h1 className='fg-title'>
						FINRA <span className='fg-title-accent'>Network</span>
					</h1>

					<div className='fg-fetch-status'>
						<div className='fg-fetch'>
							<input
								id='fg-fetch-input'
								className='fg-fetch-input'
								type='search'
								placeholder='Fetch: name, CRD or firm id…'
								autoComplete='off'
							/>
							<button
								id='fg-fetch-remote'
								className='fg-btn-primary fg-action-btn'
								title='Fetch matching nodes from the server'>
								Fetch Nodes
							</button>
						</div>
						<div className='fg-toolbar-group fg-toolbar-status'>
							<span
								id='fg-subset-info'
								className='fg-subset-info'></span>
						</div>
					</div>

					<div className='fg-toolbar-group fg-toolbar-actions'>
						<button
							id='fg-refresh-layout'
							className='fg-ghost-btn'
							title='Re-run the graph layout'>
							↺ Reflow Layout
						</button>
						<button
							id='fg-clear-highlights'
							className='fg-ghost-btn'
							title='Clear selected highlights'>
							Clear Highlight
						</button>
						<button
							id='fg-clear-session'
							className='fg-danger-btn'
							title='Clear saved session and reload fresh'>
							Reset Session
						</button>
					</div>
				</div>
			</header>

			<div className='fg-body'>
				<div
					id='fg-sidebar-backdrop'
					className='fg-sidebar-backdrop hidden'
					aria-hidden='true'></div>

				{/* Detail sidebar */}
				<aside
					id='fg-sidebar'
					className='fg-sidebar hidden'>
					<div className='fg-sidebar-actions'>
						<button
							id='fg-focus-btn'
							className='fg-sidebar-action-btn fg-sidebar-action-btn--secondary'
							title='Focus on this node'>
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
							className='fg-sidebar-action-btn fg-sidebar-action-btn--primary'
							type='button'
							onClick={hideSidebar}>
							<span className='fg-sidebar-action-label'>Close</span>
							<span
								className='fg-sidebar-action-icon fg-sidebar-action-icon--trailing'
								aria-hidden='true'>
								✕
							</span>
						</button>
					</div>
					<div
						id='fg-sidebar-inner'
						className='fg-sidebar-inner'>
						<p className='fg-hint'>Click a node to inspect it.</p>
					</div>
				</aside>

				{/* Undo rotation and revert to original styling */}
				{/* Graph canvas */}
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
						<p>Search for a firm, person, CRD, or SEC# to begin.</p>
						<p>Use the Fetch box above to look up a name, firm, CRD, or SEC#.</p>
					</div>
				</main>
			</div>

			{/* Scraper log panel */}
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
