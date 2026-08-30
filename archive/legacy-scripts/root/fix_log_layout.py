import re

# Update FinraGraph.tsx
with open('src/components/FinraGraph.tsx', 'r') as f:
    content = f.read()

old_actions_finragraph = """							<div className='fg-log-drawer-actions-row fg-log-drawer-actions-row--primary'>
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
									id='btn-selection-log-copy-link'
									data-fg-selection-log-action='copy-link'
									className='fg-ghost-btn fg-btn-sm'
									type='button'
									title='Copy a shareable link to the logged nodes'>
									Copy Link
								</button>
								<button
									id='btn-selection-log-edit'
									data-fg-selection-log-action='edit'
									className='fg-ghost-btn fg-btn-sm'
									type='button'
									title='Edit selection log entries'>
									Edit
								</button>
							</div>
							<div className='fg-log-drawer-actions-row fg-log-drawer-actions-row--tertiary'>
								<button
									id='btn-selection-log-clear'
									data-fg-selection-log-action='clear'
									className='fg-ghost-btn fg-btn-sm'
									type='button'
									title='Clear log'>
									Clear
								</button>

							</div>"""

new_actions_finragraph = """							<div className='fg-log-drawer-actions-row fg-log-drawer-actions-row--primary'>
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
									id='btn-selection-log-copy-link'
									data-fg-selection-log-action='copy-link'
									className='fg-ghost-btn fg-btn-sm'
									type='button'
									title='Copy a shareable link to the logged nodes'>
									Copy Link
								</button>
							</div>
							<div className='fg-log-drawer-actions-row fg-log-drawer-actions-row--tertiary'>
								<button
									id='btn-selection-log-clear'
									data-fg-selection-log-action='clear'
									className='fg-ghost-btn fg-btn-sm'
									type='button'
									title='Clear log'>
									Clear
								</button>
								<button
									id='btn-selection-log-edit'
									data-fg-selection-log-action='edit'
									className='fg-ghost-btn fg-btn-sm'
									type='button'
									title='Edit selection log entries'>
									Edit
								</button>
							</div>"""

content = content.replace(old_actions_finragraph, new_actions_finragraph)

with open('src/components/FinraGraph.tsx', 'w') as f:
    f.write(content)

# Update finra-graph.ts
with open('src/lib/finra-graph.ts', 'r') as f:
    content = f.read()

old_actions_finra_ts = """				<div class="fg-log-drawer-actions-row fg-log-drawer-actions-row--primary">
					<button
						data-fg-selection-log-action="copy-link"
						class="fg-ghost-btn fg-btn-sm"
						type="button"
						title="Copy a shareable link to the logged nodes">
						Copy Link
					</button>
					<button
						data-fg-selection-log-action="trace"
						class="fg-ghost-btn fg-btn-sm"
						type="button"
						title="Trace path between all logged nodes">
						Trace with Log
					</button>
					<button
						data-fg-selection-log-action="edit"
						class="fg-ghost-btn fg-btn-sm"
						type="button"
						title="Edit selection log entries">
						Edit
					</button>
				</div>
				<div class="fg-log-drawer-actions-row fg-log-drawer-actions-row--secondary">
					<button
						data-fg-selection-log-action="toggle-bold"
						class="fg-ghost-btn fg-btn-sm"
						type="button"
						title="Make log entries larger and bolder">
						Log Bold
					</button>
					
					<button
						data-fg-selection-log-action="copy-all"
						class="fg-ghost-btn fg-btn-sm"
						type="button"
						title="Copy all entries">
						Copy All
					</button>
				</div>
				<div class="fg-log-drawer-actions-row fg-log-drawer-actions-row--tertiary">
					<button
						data-fg-selection-log-action="clear"
						class="fg-ghost-btn fg-btn-sm"
						type="button"
						title="Clear log">
						Clear
					</button>
					
				</div>"""

new_actions_finra_ts = """				<div class="fg-log-drawer-actions-row fg-log-drawer-actions-row--primary">
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
				</div>
				<div class="fg-log-drawer-actions-row fg-log-drawer-actions-row--secondary">
					<button
						data-fg-selection-log-action="copy-all"
						class="fg-ghost-btn fg-btn-sm"
						type="button"
						title="Copy all entries">
						Copy All
					</button>
					<button
						data-fg-selection-log-action="copy-link"
						class="fg-ghost-btn fg-btn-sm"
						type="button"
						title="Copy a shareable link to the logged nodes">
						Copy Link
					</button>
				</div>
				<div class="fg-log-drawer-actions-row fg-log-drawer-actions-row--tertiary">
					<button
						data-fg-selection-log-action="clear"
						class="fg-ghost-btn fg-btn-sm"
						type="button"
						title="Clear log">
						Clear
					</button>
					<button
						data-fg-selection-log-action="edit"
						class="fg-ghost-btn fg-btn-sm"
						type="button"
						title="Edit selection log entries">
						Edit
					</button>
				</div>"""

content = content.replace(old_actions_finra_ts, new_actions_finra_ts)

with open('src/lib/finra-graph.ts', 'w') as f:
    f.write(content)

print("Done replacing layouts")
