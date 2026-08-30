import re

with open('src/app/dashboard/page.tsx', 'r') as f:
    content = f.read()

start = content.find('{hasCurrentRecord && (')
end = content.find('</section>\n\t\t\t\t<aside className={styles.rightPane}>')
print(content[start:start+1000])
