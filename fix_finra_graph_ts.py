import re

with open('src/lib/finra-graph.ts', 'r') as f:
    content = f.read()

# Remove old clear labels from finra-graph.ts
old_log_drawer_clear_labels = """					<div class="fg-clear-labels-control">
						<button
							data-fg-selection-log-action="clear-labels-menu"
							class="fg-ghost-btn fg-btn-sm fg-clear-labels-control__toggle"
							type="button"
							aria-expanded="false"
							title="Choose whether to clear all large labels or only people labels">
							Clear Labels
						</button>
						<div class="fg-clear-labels-control__menu" role="menu" hidden>
							<button
								data-fg-selection-log-action="clear-labels"
								data-fg-clear-labels-scope="all"
								class="fg-ghost-btn fg-btn-sm"
								type="button"
								role="menuitem"
								hidden
								title="Shrink all currently enlarged labels without clearing the log">
								All labels
							</button>
							<button
								data-fg-selection-log-action="clear-labels"
								data-fg-clear-labels-scope="people"
								class="fg-ghost-btn fg-btn-sm"
								type="button"
								role="menuitem"
								hidden
								title="Shrink only enlarged people labels without clearing the log">
								People only
							</button>
						</div>
					</div>"""
content = content.replace(old_log_drawer_clear_labels, "")

# Remove old clear others from finra-graph.ts
old_log_drawer_clear_others = """					<button
						data-fg-selection-log-action="clear-others"
						class="fg-ghost-btn fg-btn-sm"
						type="button"
						title="Keep logged nodes and any intermediaries connecting them">
						Clear Others
					</button>"""
content = content.replace(old_log_drawer_clear_others, "")

with open('src/lib/finra-graph.ts', 'w') as f:
    f.write(content)

print("Updated finra-graph.ts")
