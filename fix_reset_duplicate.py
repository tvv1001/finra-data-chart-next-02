with open('src/components/FinraGraph.tsx', 'r') as f:
    content = f.read()

# We need to find the Reset Session that is immediately before </div>\n\t\t\t\t\t<div className={`fg-sidebar-toolbar-content
# This is the one in the header

header_reset = """						<button
							type='button'
							data-fg-action='clear-session'
							className='fg-danger-btn'
							title='Clear saved session and reload fresh'>
							Reset Session
						</button>
						
					</div>
					<div className={`fg-sidebar-toolbar-content ${isSidebarToolsOpen ? '' : 'hidden'}`}>"""

fixed_header = """						
					</div>
					<div className={`fg-sidebar-toolbar-content ${isSidebarToolsOpen ? '' : 'hidden'}`}>"""

content = content.replace(header_reset, fixed_header)

with open('src/components/FinraGraph.tsx', 'w') as f:
    f.write(content)

print("Fixed duplicate reset button")
