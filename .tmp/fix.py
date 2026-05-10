import sys

with open('.tmp/old-finra-graph.ts', 'r') as f:
    old_lines = f.readlines()

start_old = -1
end_old = -1
for i, line in enumerate(old_lines):
    if "return { nodes: newNodes, links: newLinks };" in line:
        start_old = i
    if "console.error('loadGraph:', err);" in line:
        end_old = i + 3 # including showEmpty(true); } }

extracted_block = old_lines[start_old:end_old]
extracted_text = "".join(extracted_block)

with open('src/lib/finra-graph.ts', 'r') as f:
    new_text = f.read()

bad_block_start = new_text.find("\tif (typeof appendFetched === 'function') appendFetched(newNodes, newLinks);\n\tmergeIntoGraphData(newNodes, newLinks);\n\tawait expandFetchedNodes(newNodes, 1);\n\tpersistToServer(newNodes, newLinks);\n}")
if bad_block_start != -1:
    bad_block_end = bad_block_start + len("\tif (typeof appendFetched === 'function') appendFetched(newNodes, newLinks);\n\tmergeIntoGraphData(newNodes, newLinks);\n\tawait expandFetchedNodes(newNodes, 1);\n\tpersistToServer(newNodes, newLinks);\n}")
    new_text = new_text[:bad_block_start] + extracted_text + new_text[bad_block_end:]
    with open('src/lib/finra-graph.ts', 'w') as f:
        f.write(new_text)
    print("Fixed main block")
else:
    print("Could not find bad block")
