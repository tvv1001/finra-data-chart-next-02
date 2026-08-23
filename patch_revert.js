const fs = require('fs');
let code = fs.readFileSync('src/lib/finra-graph.ts', 'utf8');
code = code.replace(/function getRefreshLayoutDurationMs\(nodeCount = layoutNodes\?\.length \|\| 0\) \{\n\t\/\*.*\n\treturn 3000;\n\treturn 3000;\n\treturn 3000;\n\}/g, '');
code = code.replace(`function getRefreshLayoutDurationMs(nodeCount = layoutNodes?.length || 0) {
	if (nodeCount > 1000) return 3000;
	if (nodeCount > 300) return 3000;
	return 3000;
}`, `function getRefreshLayoutDurationMs(nodeCount = layoutNodes?.length || 0) {
	if (nodeCount > 1000) return 1100;
	if (nodeCount > 300) return 1300;
	return 1500;
}`);
code = code.replace('const refreshDurationMs = Math.max(', 'const refreshDurationMs = Math.min(');
fs.writeFileSync('src/lib/finra-graph.ts', code);
