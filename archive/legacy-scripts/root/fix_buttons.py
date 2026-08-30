import re

# Update FinraGraph.tsx
with open('src/components/FinraGraph.tsx', 'r') as f:
    content = f.read()

# Swap Log Bold and Trace Mode in FinraGraph.tsx
old_primary_row = """							<div className='fg-log-drawer-actions-row fg-log-drawer-actions-row--primary'>
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
							</div>"""

new_primary_row = """							<div className='fg-log-drawer-actions-row fg-log-drawer-actions-row--primary'>
						        <button
							        type='button'
							        data-fg-trace-mode-button='sidebar-mobile'
							        className='fg-ghost-btn fg-btn-sm'
							        title='Toggle path tracing mode'>
							        Trace Mode
						        </button>
								<button
									id='btn-selection-log-trace'
									data-fg-selection-log-action='trace'
									className='fg-ghost-btn fg-btn-sm'
									type='button'
									title='Trace path between all logged nodes'>
									Trace with Log
								</button>
							</div>"""

content = content.replace(old_primary_row, new_primary_row)

old_trace_mode_btn = """						<button
							type='button'
							data-fg-trace-mode-button='sidebar-mobile'
							className='fg-ghost-btn'
							title='Toggle path tracing mode'>
							Trace Mode
						</button>"""

new_log_bold_btn = """						<button
							type='button'
							data-fg-selection-log-action='toggle-bold'
							className='fg-ghost-btn'
							title='Make log entries larger and bolder'>
							Log Bold
						</button>"""

content = content.replace(old_trace_mode_btn, new_log_bold_btn)

# Move Reset Session to the right of Center button
reset_session_btn = """						<button
							type='button'
							data-fg-action='clear-session'
							className='fg-danger-btn'
							title='Clear saved session and reload fresh'>
							Reset Session
						</button>"""

content = content.replace(reset_session_btn, "") # Remove from old location

# Find center button end
center_btn_end = "</svg>\n\t\t\t\t\t\t\t</span>\n\t\t\t\t\t\t</button>"
content = content.replace(center_btn_end, center_btn_end + "\n" + reset_session_btn)

with open('src/components/FinraGraph.tsx', 'w') as f:
    f.write(content)

# Now finra-graph.ts
with open('src/lib/finra-graph.ts', 'r') as f:
    content = f.read()

old_primary_ts = """				<div class="fg-log-drawer-actions-row fg-log-drawer-actions-row--primary">
					<button
						data-fg-selection-log-action="toggle-bold"
						class="fg-ghost-btn fg-btn-sm"
						type="button"
						title="Make log entries larger and bolder">
						Log Bold
					</button>
					<button
						data-fg-selection-log-action="trace"
						class="fg-ghost-btn fg-btn-sm"
						type="button"
						title="Trace path between all logged nodes">
						Trace with Log
					</button>
				</div>"""

new_primary_ts = """				<div class="fg-log-drawer-actions-row fg-log-drawer-actions-row--primary">
					<button
						data-fg-trace-mode-button="sidebar-log"
						class="fg-ghost-btn fg-btn-sm"
						type="button"
						title="Toggle path tracing mode">
						Trace Mode
					</button>
					<button
						data-fg-selection-log-action="trace"
						class="fg-ghost-btn fg-btn-sm"
						type="button"
						title="Trace path between all logged nodes">
						Trace with Log
					</button>
				</div>"""

content = content.replace(old_primary_ts, new_primary_ts)

with open('src/lib/finra-graph.ts', 'w') as f:
    f.write(content)

print("Done moving buttons")
