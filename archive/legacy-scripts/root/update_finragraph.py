import re

with open('src/components/FinraGraph.tsx', 'r') as f:
    content = f.read()

# 1. Update localStorage and default state
state_block_old = "const [isSidebarToolsOpen, setIsSidebarToolsOpen] = useState(false);"
state_block_new = """const [isSidebarToolsOpen, setIsSidebarToolsOpen] = useState(true);

	useEffect(() => {
		const stored = localStorage.getItem('finra_sidebar_tools_open');
		if (stored !== null) {
			setIsSidebarToolsOpen(stored === 'true');
		}
	}, []);

	const toggleSidebarTools = () => {
		const newState = !isSidebarToolsOpen;
		setIsSidebarToolsOpen(newState);
		localStorage.setItem('finra_sidebar_tools_open', String(newState));
	};"""
content = content.replace(state_block_old, state_block_new)

# Replace the onClick handler
content = content.replace("onClick={() => setIsSidebarToolsOpen(!isSidebarToolsOpen)}", "onClick={toggleSidebarTools}")

# 2. Extract Pin and ThemeToggle, simplify toggle style
sidebar_toolbar_old = """					<div className='fg-sidebar-toolbar-header' style={{ padding: '8px 8px 0', display: 'flex' }}>
						<button
							type='button'
							className={`fg-sb-toggle-btn ${isSidebarToolsOpen ? 'is-active' : ''}`}
							onClick={toggleSidebarTools}
							title={isSidebarToolsOpen ? 'Hide tools' : 'Show tools'}
							style={{ width: '100%', justifyContent: 'space-between', padding: '6px 12px', background: 'rgba(255, 255, 255, 0.96)', border: '1px solid rgba(15, 23, 42, 0.18)', borderRadius: '6px', boxShadow: '0 2px 6px rgba(15, 23, 42, 0.06)' }}>
							<span className='fg-sb-toggle-btn__label' style={{ fontWeight: 600 }}>Graph Tools</span>
							<span className='fg-sb-toggle-btn__chevron' aria-hidden='true' style={{ transform: isSidebarToolsOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s ease' }}>▾</span>
						</button>
					</div>"""

sidebar_toolbar_new = """					<div className='fg-sidebar-toolbar-header' style={{ padding: '8px 8px 0', display: 'flex', gap: '4px', alignItems: 'center' }}>
						<button
							type='button'
							className={`fg-sb-toggle-btn ${isSidebarToolsOpen ? 'is-active' : ''}`}
							onClick={toggleSidebarTools}
							title={isSidebarToolsOpen ? 'Hide tools' : 'Show tools'}
							style={{ flex: 1, justifyContent: 'space-between', padding: '6px 12px', background: 'transparent', border: 'none', borderRadius: '6px', color: 'var(--fg-text)' }}>
							<span className='fg-sb-toggle-btn__label' style={{ fontWeight: 600 }}>Graph Tools</span>
							<span className='fg-sb-toggle-btn__chevron' aria-hidden='true' style={{ transform: isSidebarToolsOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s ease' }}>▾</span>
						</button>
						<button
							id='fg-sidebar-pin-toggle'
							className='fg-sidebar-action-btn fg-sidebar-action-btn--pin fg-sidebar-action-btn--icon-only'
							type='button'
							onClick={toggleSidebarPin}
							title='Pin panel open'
							aria-label='Pin panel open'
							aria-pressed='false'
							data-pinned='false'
							style={{ background: 'transparent', border: 'none', padding: '6px', color: 'var(--fg-text)' }}>
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
						<ThemeToggle />
					</div>"""

content = content.replace(sidebar_toolbar_old, sidebar_toolbar_new)

# Remove old Pin button
pin_btn_regex = r"<button[^>]*id='fg-sidebar-pin-toggle'[\s\S]*?</button>"
content = re.sub(pin_btn_regex, "", content, count=1)  # Only remove the first one in the actions list

# Remove old ThemeToggle
content = content.replace("<ThemeToggle />", "", 1) # First occurrence is the old one

# Now add Clear Labels and Clear Others to the .fg-sidebar-actions
clear_buttons_html = """						<div className='fg-clear-labels-control' style={{ width: '100%' }}>
							<button
								id='btn-sidebar-clear-labels'
								data-fg-selection-log-action='clear-labels-menu'
								className='fg-sidebar-action-btn fg-sidebar-action-btn--secondary fg-clear-labels-control__toggle'
								type='button'
								aria-expanded='false'
								title='Choose whether to clear all large labels or only people labels'
								style={{ width: '100%', justifyContent: 'center' }}>
								Clear Labels
							</button>
							<div
								className='fg-clear-labels-control__menu'
								role='menu'
								hidden>
								<button
									data-fg-selection-log-action='clear-labels'
									data-fg-clear-labels-scope='all'
									className='fg-ghost-btn fg-btn-sm'
									type='button'
									role='menuitem'
									hidden
									title='Shrink all currently enlarged labels'>
									All labels
								</button>
								<button
									data-fg-selection-log-action='clear-labels'
									data-fg-clear-labels-scope='people'
									className='fg-ghost-btn fg-btn-sm'
									type='button'
									role='menuitem'
									hidden
									title='Shrink only enlarged people labels'>
									People only
								</button>
							</div>
						</div>
						<button
							id='btn-sidebar-clear-others'
							data-fg-selection-log-action='clear-others'
							className='fg-sidebar-action-btn fg-sidebar-action-btn--secondary'
							type='button'
							title='Keep logged nodes and any intermediaries connecting them'>
							Clear Others
						</button>"""

content = content.replace("<button\n\t\t\t\t\t\t\tdata-fg-action='clear-session'", f"{clear_buttons_html}\n\t\t\t\t\t\t<button\n\t\t\t\t\t\t\tdata-fg-action='clear-session'")

# Remove from log drawer
log_drawer_clear_labels_regex = r"<div className='fg-clear-labels-control'>[\s\S]*?</div>\s*</div>"
content = re.sub(log_drawer_clear_labels_regex, "", content)

# Remove clear others from log drawer
log_drawer_clear_others_regex = r"<button[^>]*id='btn-selection-log-clear-others'[\s\S]*?</button>"
content = re.sub(log_drawer_clear_others_regex, "", content)

with open('src/components/FinraGraph.tsx', 'w') as f:
    f.write(content)

print("Updated FinraGraph.tsx")
