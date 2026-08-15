import re

with open('src/lib/finra-graph.ts', 'r') as f:
    content = f.read()

start_pattern = r'<div class="fg-log-drawer-actions fg-log-drawer-actions--sidebar">'
end_pattern = r'<div class="fg-log-drawer-actions-row">'

match_start = re.search(start_pattern, content)
match_end = re.search(end_pattern, content[match_start.end():])

start_idx = match_start.end()
end_idx = match_start.end() + match_end.start()

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
with open('src/lib/finra-graph.ts', 'w') as f:
    f.write(content)

print("Done fixing finra-graph.ts")
