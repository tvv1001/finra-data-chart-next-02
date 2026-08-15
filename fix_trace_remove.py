import re

def remove_primary_row(filepath, is_tsx):
    with open(filepath, 'r') as f:
        content = f.read()

    if is_tsx:
        old_primary_row = """							<div className='fg-log-drawer-actions-row fg-log-drawer-actions-row--primary'>
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
    else:
        old_primary_row = """				<div class="fg-log-drawer-actions-row fg-log-drawer-actions-row--primary">
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

    if old_primary_row in content:
        content = content.replace(old_primary_row, "")
    else:
        print(f"Could not find exact string in {filepath}")
    
    with open(filepath, 'w') as f:
        f.write(content)

remove_primary_row('src/components/FinraGraph.tsx', True)
remove_primary_row('src/lib/finra-graph.ts', False)
print("Done removing primary row")
