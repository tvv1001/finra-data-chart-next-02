const fs = require('fs');
let code = fs.readFileSync('src/lib/finra-graph.ts', 'utf8');

const target1 = `								// force a render
								try {
									requestRender();
								} catch {}
								usedWasm = true;`;

const replacement1 = `								// force a render
								try {
									animateToWasmPositions(2500);
								} catch {}
								usedWasm = true;`;

code = code.replace(target1, replacement1);

const target2 = `								refreshNodeLayout(); // Animate gently into WASM positions`;
const replacement2 = `								animateToWasmPositions(2500); // Animate smoothly using D3 transitions directly`;

code = code.replace(target2, replacement2);

fs.writeFileSync('src/lib/finra-graph.ts', code);
