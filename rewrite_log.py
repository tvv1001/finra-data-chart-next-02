import re

def update_actions(filepath, is_tsx):
    with open(filepath, 'r') as f:
        content = f.read()

    # Find the start of fg-log-drawer-actions
    if is_tsx:
        start_pattern = r"<div className='fg-log-drawer-actions'>"
        end_pattern = r"<div className='fg-log-drawer-actions-row'>"
    else:
        start_pattern = r'<div class="fg-log-drawer-actions">'
        end_pattern = r'<div class="fg-log-drawer-actions-row">'

    match_start = re.search(start_pattern, content)
    match_end = re.search(end_pattern, content[match_start.end():])

    start_idx = match_start.end()
    end_idx = match_start.end() + match_end.start()

    if is_tsx:
        new_actions = """
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
							</div>
							"""
    else:
        new_actions = """
				<div class="fg-log-drawer-actions-row fg-log-drawer-actions-row--primary">
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
				</div>
				"""

    content = content[:start_idx] + new_actions + content[end_idx:]
    with open(filepath, 'w') as f:
        f.write(content)

update_actions('src/components/FinraGraph.tsx', True)
update_actions('src/lib/finra-graph.ts', False)
print("Done rewriting logs")
