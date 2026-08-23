const fs = require('fs');
let code = fs.readFileSync('src/lib/finra-graph.ts', 'utf8');

const injection = `
function animateToWasmPositions(duration = 2500) {
	if (simulation) simulation.stop();
	if (graphTickFrameId != null) {
		cancelAnimationFrame(graphTickFrameId);
		graphTickFrameId = null;
	}
	if (nodeSel) {
		nodeSel.transition().duration(duration).ease(d3.easeCubicOut)
			.attr('transform', d => \`translate(\${Number.isFinite(d.x) ? d.x : 0},\${Number.isFinite(d.y) ? d.y : 0})\`);
	}
	if (linkSel) {
		linkSel.transition().duration(duration).ease(d3.easeCubicOut)
			.attr('x1', d => (Number.isFinite(d.source?.x) ? d.source.x : 0))
			.attr('y1', d => (Number.isFinite(d.source?.y) ? d.source.y : 0))
			.attr('x2', d => (Number.isFinite(d.target?.x) ? d.target.x : 0))
			.attr('y2', d => (Number.isFinite(d.target?.y) ? d.target.y : 0));
	}
	if (arrowSel) {
		arrowSel.transition().duration(duration).ease(d3.easeCubicOut)
			.attr('x1', d => (Number.isFinite(d.source?.x) ? d.source.x : 0))
			.attr('y1', d => (Number.isFinite(d.source?.y) ? d.source.y : 0))
			.attr('x2', d => (Number.isFinite(d.target?.x) ? d.target.x : 0))
			.attr('y2', d => (Number.isFinite(d.target?.y) ? d.target.y : 0));
	}
}
`;

code = code.replace(
	'function updateGraphTickPositions(linkSelection, nodeSelection, arrowSelection) {',
	injection + '\nfunction updateGraphTickPositions(linkSelection, nodeSelection, arrowSelection) {'
);

fs.writeFileSync('src/lib/finra-graph.ts', code);
