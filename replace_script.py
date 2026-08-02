import re

with open('src/app/dashboard/page.tsx', 'r') as f:
    content = f.read()

# We want to replace the whole centerPane content starting from {hasCurrentRecord && ( up to </section>

start = content.find('{hasCurrentRecord && (\n\t\t\t\t\t\t\t\t<>\n\t\t\t\t\t\t\t\t\t<div className={styles.recordHeaderRow}>')
end_marker = '</section>\n\t\t\t\t\t<aside className={`'
end = content.find(end_marker)

if start == -1 or end == -1:
    print("Could not find start or end")
    print(start, end)
    exit(1)

# Create the new content
# We will read from a file we create.
new_content = open('new_content.tsx', 'r').read()

final_content = content[:start] + new_content + content[end:]

with open('src/app/dashboard/page.tsx', 'w') as f:
    f.write(final_content)

print("Done replacing.")
