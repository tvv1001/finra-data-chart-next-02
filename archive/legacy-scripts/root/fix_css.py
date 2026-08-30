import re

with open('src/app/dashboard/dashboard.module.css', 'r') as f:
    css = f.read()

# Replace the absolute positioning in .backLinkOutsideRow
old_css = """.backLinkOutsideRow {
	display: flex;
	justify-content: flex-end;
	padding: 0;
	position: absolute;
	top: 12px;
	right: 12px;
}"""

new_css = """.backLinkOutsideRow {
	display: flex;
	justify-content: flex-end;
	padding: 12px 12px 4px 12px;
	gap: 8px;
}"""

css = css.replace(old_css, new_css)

with open('src/app/dashboard/dashboard.module.css', 'w') as f:
    f.write(css)

print("Done replacing .backLinkOutsideRow")
