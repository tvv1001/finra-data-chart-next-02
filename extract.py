import re
from bs4 import BeautifulSoup
import tinycss2

html = open('scratch_html.html').read()
soup = BeautifulSoup(html, 'html.parser')

# Find the elements we care about
banner = soup.find(class_='current-crd-banner')
workspace = soup.find(class_='record-workspace-wrapper')

classes = set()
for el in banner.find_all(class_=True):
    classes.update(el['class'])
classes.update(banner['class'])

for el in workspace.find_all(class_=True):
    classes.update(el['class'])
classes.update(workspace['class'])

css = open('scratch_styles.css').read()
rules = tinycss2.parse_stylesheet(css)

extracted_rules = []

for rule in rules:
    if rule.type == 'error':
        continue
    if rule.type == 'qualified-rule':
        # Get selector text
        selector = ''.join([t.serialize() for t in rule.prelude]).strip()
        # Does the selector use any of our classes?
        # A simple check:
        used = False
        for c in classes:
            if f".{c}" in selector:
                used = True
                break
        if used:
            # Serialize the whole rule
            extracted_rules.append(''.join([t.serialize() for t in rule.prelude]) + '{' + ''.join([t.serialize() for t in rule.content]) + '}')
    elif rule.type == 'at-rule':
        pass

with open('src/app/globals.css', 'a') as f:
    f.write('\n\n/* Extracted from scratch_styles.css */\n')
    f.write('\n'.join(extracted_rules))

print("Done extracting", len(extracted_rules), "rules")
