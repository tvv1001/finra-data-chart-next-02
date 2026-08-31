import re

with open('src/app/dashboard/page.tsx', 'r') as f:
    code = f.read()

# Replace FINRA with FINRA/SEC
# Wait, let's just insert the header

header_html = """		<div className={styles.page}>
			<header className="fg-header">
				<div className="fg-header-bar">
					<div className="fg-header-brand">
						<h1 className="fg-title" style={{ fontSize: '14px' }}>FINRA/SEC</h1>
					</div>
					<div className="fg-header-controls"></div>
					<div className="fg-header-right-controls" style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
						<button
							type='button'
							className={styles.rightPaneToggle}
							onClick={() => setNewCrdsOpen((open) => !open)}
							aria-expanded={newCrdsOpen}>
							{newCrdsOpen ? 'Hide Panel' : 'new CRDs'}
						</button>
						<Link
							href={graphHref}
							onClick={handleGraphBackClick}
							className="fg-ghost-btn"
                            style={{ textDecoration: 'none' }}>
							Graph
						</Link>
					</div>
				</div>
			</header>
			<div className={`${styles.layout} ${!newCrdsOpen ? styles.layoutRightHidden : ''}`}>"""

code = code.replace("""		<div className={styles.page}>\n			<div className={`${styles.layout} ${!newCrdsOpen ? styles.layoutRightHidden : ''}`}>""", header_html)

# Also remove the backLinkOutsideRow from where it currently is in the right pane!
to_remove = """					<div className={styles.backLinkOutsideRow}>
						<Link
							href={graphHref}
							onClick={handleGraphBackClick}
							className={styles.backLink}>
							← Graph
						</Link>
						<button
							type='button'
							className={styles.rightPaneToggle}
							onClick={() => setNewCrdsOpen((open) => !open)}
							aria-expanded={newCrdsOpen}>
							{newCrdsOpen ? 'Hide' : 'Show'}
						</button>
					</div>"""

code = code.replace(to_remove, "")

with open('src/app/dashboard/page.tsx', 'w') as f:
    f.write(code)

print("Replaced dashboard layout")
