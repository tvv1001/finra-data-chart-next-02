/* eslint-disable @typescript-eslint/no-explicit-any */
const ROUTE_NODE_REQUEST_EVENT = 'finra:route-node-request';
const SELECTED_NODE_ROUTE_EVENT = 'finra:selected-node-route';
const GRAPH_API_PATH = '/api/finra/graph';
const MAX_NODES = 400;
const MAX_LINKS = 900;

let pixiApp: any = null;
let linkLayer: any = null;
let nodeLayer: any = null;
let simulation: any = null;
let graphNodes: any[] = [];
let graphLinks: any[] = [];
let nodeSprites = new Map<string, any>();
let selectedNodeId: string | null = null;
let selectedNodeIds = new Set<string>();
let activeDrag: {
	sprite: any;
	node: any;
	offsetX: number;
	offsetY: number;
	moved: boolean;
} | null = null;
let routeNodeListener: ((event: Event) => void) | null = null;
let stopAnimationListener: ((event: Event) => void) | null = null;
let PixiCore: any = null;
// Track new nodes for blue ring highlight
let newNodeIds = new Set<string>();

const groupColors: Record<string, number> = {
	individual: 0x4a90e2,
	firm: 0xffa500,
	entity: 0x3ccf8e,
	unknown: 0x999999,
};

function getNodeColor(node: any) {
	return groupColors[node?.group] ?? groupColors.unknown;
}

function getNodeRadius(node: any) {
	return node?.group === 'firm' ? 10 : 7;
}

function getNodeLabel(node: any) {
	return String(node?.label || node?.name || node?.id || '');
}

async function fetchGraphData() {
	const response = await fetch(`${GRAPH_API_PATH}?limit=${MAX_NODES}`);
	if (!response.ok) {
		throw new Error(`Failed to load graph data: ${response.status}`);
	}
	const graph = await response.json();
	const rawNodes = Array.isArray(graph.nodes) ? graph.nodes : [];
	const rawLinks = Array.isArray(graph.links) ? graph.links : [];
	const nodes = rawNodes.slice(0, MAX_NODES).map((node: any) => ({ ...node }));
	const ids = new Set(nodes.map((node) => String(node.id)));
	const links = rawLinks
		.filter((link: any) => ids.has(String(link.source)) && ids.has(String(link.target)))
		.slice(0, MAX_LINKS)
		.map((link: any) => ({ ...link }));
	return { nodes, links };
}

function getCanvasElement() {
	return document.getElementById('fg-canvas') as HTMLCanvasElement | null;
}

function beginNodeDrag(sprite: any, node: any, event: any) {
	const localPos = sprite.parent.toLocal(event.data.global);
	activeDrag = {
		sprite,
		node,
		offsetX: localPos.x - sprite.x,
		offsetY: localPos.y - sprite.y,
		moved: false,
	};
	if (typeof node.x === 'number' && typeof node.y === 'number') {
		node.fx = node.x;
		node.fy = node.y;
	}

	if (Array.isArray(graphLinks)) {
		const neighborIds = new Set<string>();
		for (const link of graphLinks) {
			const sourceId = String(link.source?.id ?? link.source);
			const targetId = String(link.target?.id ?? link.target);
			if (sourceId === String(node.id)) neighborIds.add(targetId);
			if (targetId === String(node.id)) neighborIds.add(sourceId);
		}
		for (const neighbor of graphNodes) {
			if (neighborIds.has(String(neighbor.id))) {
				neighbor.fx = null;
				neighbor.fy = null;
			}
		}
	}

	if (simulation) {
		simulation.alphaTarget(0.3).restart();
	}
	sprite.alpha = 0.85;
}

function dragNode(event: any) {
	if (!activeDrag) return;
	const sprite = activeDrag.sprite;
	const node = activeDrag.node;
	const localPos = sprite.parent.toLocal(event.data.global);
	const newX = localPos.x - activeDrag.offsetX;
	const newY = localPos.y - activeDrag.offsetY;
	const prevX = node.fx ?? node.x ?? 0;
	const prevY = node.fy ?? node.y ?? 0;
	const dx = newX - prevX;
	const dy = newY - prevY;
	activeDrag.moved = activeDrag.moved || Math.hypot(dx, dy) > 1;

	sprite.position.set(newX, newY);
	node.x = newX;
	node.y = newY;
	node.fx = newX;
	node.fy = newY;

	if (Array.isArray(graphLinks)) {
		for (const link of graphLinks) {
			const sourceId = String(link.source?.id ?? link.source);
			if (sourceId === String(node.id)) {
				const child = graphNodes.find((n) => String(n.id) === String(link.target?.id ?? link.target));
				if (child && child.fx == null && child.fy == null) {
					child.x = (child.x ?? 0) + dx;
					child.y = (child.y ?? 0) + dy;
				}
			}
		}
	}
}

function endNodeDrag() {
	if (!activeDrag) return;
	activeDrag.sprite.alpha = 1;
	activeDrag.node.fx = null;
	activeDrag.node.fy = null;
	if (simulation) {
		simulation.alphaTarget(0).restart();
	}
	activeDrag = null;
}

function buildNodeGraphics(node: any) {
	const radius = getNodeRadius(node);
	const Graphic = PixiCore?.Graphics;
	const Circle = PixiCore?.Circle;
	if (!Graphic || !Circle) {
		throw new Error('Pixi core classes are not initialized');
	}

	const graphic = new Graphic();
	graphic.interactive = true;
	graphic.buttonMode = true;
	graphic.hitArea = new Circle(0, 0, radius + 2);
	graphic.cursor = 'pointer';

	graphic.on('pointerdown', (event: any) => {
		const originalEvent = event?.data?.originalEvent as Event | undefined;
		if (originalEvent && typeof originalEvent.stopPropagation === 'function') {
			originalEvent.stopPropagation();
			originalEvent.preventDefault?.();
		}
		selectNode(node.id);
		beginNodeDrag(graphic, node, event);
	});
	graphic.on('pointermove', (event: any) => {
		dragNode(event);
	});
	graphic.on('pointerup', (event: any) => {
		const originalEvent = event?.data?.originalEvent as Event | undefined;
		if (originalEvent && typeof originalEvent.stopPropagation === 'function') {
			originalEvent.stopPropagation();
			originalEvent.preventDefault?.();
		}
		endNodeDrag();
	});
	graphic.on('pointerupoutside', () => {
		endNodeDrag();
	});
	graphic.on('pointercancel', () => {
		endNodeDrag();
	});

	renderNodeGraphic(graphic, node, selectedNodeIds.has(String(node.id)));
	return graphic;
}

function renderNodeGraphic(graphic: any, node: any, selected: boolean) {
	const radius = getNodeRadius(node);
	const color = selected ? 0xffdc64 : getNodeColor(node);
	graphic.clear();
	// Blue ring highlight for new nodes (same as center, no pulse)
	const isNew = newNodeIds.has(String(node.id));
	if (isNew) {
		// Use a blue ring, 3px, color #2196f3 (0x2196f3)
		graphic.lineStyle(3, 0x2196f3, 1);
		graphic.drawCircle(0, 0, radius + 4);
	}
	// Normal node
	graphic.beginFill(color);
	graphic.lineStyle(2, selected ? 0xffe399 : 0x222222, selected ? 1 : 0.65);
	graphic.drawCircle(0, 0, radius);
	graphic.endFill();
}

function drawFrame() {
	if (!pixiApp || !linkLayer || !nodeLayer) return;
	linkLayer.clear();
	linkLayer.lineStyle(1.4, 0xb0b0b0, 0.62);

	for (const link of graphLinks) {
		const source = link.source;
		const target = link.target;
		if (!source || !target || typeof source.x !== 'number' || typeof target.x !== 'number') continue;
		linkLayer.moveTo(source.x, source.y);
		linkLayer.lineTo(target.x, target.y);
	}

	for (const node of graphNodes) {
		const sprite = nodeSprites.get(String(node.id));
		if (!sprite) continue;
		sprite.x = node.x ?? 0;
		sprite.y = node.y ?? 0;
	}
}

function updateNodeStyles() {
	for (const node of graphNodes) {
		const sprite = nodeSprites.get(String(node.id));
		if (!sprite) continue;
		renderNodeGraphic(sprite, node, selectedNodeIds.has(String(node.id)));
	}
}
(window as any).updateNodeStyles = updateNodeStyles;

function selectNode(nodeId: string) {
	selectedNodeId = nodeId;
	selectedNodeIds.add(nodeId);
	updateNodeStyles();
	window.dispatchEvent(new CustomEvent(SELECTED_NODE_ROUTE_EVENT, { detail: { nodeId } }));
	centerOnNode(nodeId);
}

function centerOnNode(nodeId: string) {
	if (!pixiApp) return;
	const node = graphNodes.find((entry) => String(entry.id) === nodeId);
	if (!node || typeof node.x !== 'number' || typeof node.y !== 'number') return;

	const width = pixiApp.renderer.width;
	const height = pixiApp.renderer.height;
	pixiApp.stage.position.set(width / 2 - node.x, height / 2 - node.y);
}

function installRouteListener() {
	if (routeNodeListener) return;

	routeNodeListener = (event: Event) => {
		const detail = (event as CustomEvent<{ nodeId?: string }>).detail || {};
		const nodeId = String(detail.nodeId || '').trim();
		if (!nodeId) return;
		selectNode(nodeId);
	};

	window.addEventListener(ROUTE_NODE_REQUEST_EVENT, routeNodeListener as EventListener);
}

function teardownRouteListener() {
	if (!routeNodeListener) return;
	window.removeEventListener(ROUTE_NODE_REQUEST_EVENT, routeNodeListener as EventListener);
	routeNodeListener = null;
}

function installStopAnimationListener() {
	if (stopAnimationListener) return;

	stopAnimationListener = () => {
		if (simulation) {
			simulation.stop();
		}
	};

	window.addEventListener('pointerdown', stopAnimationListener, true);
	window.addEventListener('click', stopAnimationListener, true);
}

function teardownStopAnimationListener() {
	if (!stopAnimationListener) return;
	window.removeEventListener('pointerdown', stopAnimationListener, true);
	window.removeEventListener('click', stopAnimationListener, true);
	stopAnimationListener = null;
}

async function createCanvasRenderer(pixi: any) {
	const canvas = getCanvasElement();
	if (!canvas) return;

	const parentElement = canvas.parentElement || document.body;
	if (pixiApp) {
		pixiApp.destroy(true, { children: true, texture: true, baseTexture: true });
	}

	(window as any).__FINRA_PIXI_MODULE = pixi;
	const Application = pixi.Application || pixi.default?.Application;
	const Graphics = pixi.Graphics || pixi.default?.Graphics;
	const Container = pixi.Container || pixi.default?.Container;
	const Circle = pixi.Circle || pixi.default?.Circle;
	const Ticker = pixi.Ticker || pixi.default?.Ticker;

	if (!Application || !Graphics || !Container || !Circle) {
		throw new Error('Failed to initialize Pixi renderer: missing core classes.');
	}

	pixiApp = new Application();
	await pixiApp.init({
		view: canvas,
		resizeTo: parentElement,
		backgroundAlpha: 0,
		antialias: false,
		powerPreference: 'high-performance',
	});

	linkLayer = new Graphics();
	nodeLayer = new Container();
	pixiApp.stage.addChild(linkLayer);
	pixiApp.stage.addChild(nodeLayer);

	PixiCore = { Application, Graphics, Container, Circle, Ticker };

	(window as any).__FINRA_PIXI_APP = pixiApp;
	(window as any).__FINRA_GRAPH_NODES = graphNodes;
	(window as any).__FINRA_GRAPH_LINKS = graphLinks;

	for (const node of graphNodes) {
		const sprite = buildNodeGraphics(node);
		nodeLayer.addChild(sprite);
		nodeSprites.set(String(node.id), sprite);
	}

	const ticker = pixiApp.ticker ?? (Ticker ? Ticker.shared : null);
	if (!ticker) {
		throw new Error('Failed to initialize Pixi renderer: ticker is unavailable.');
	}

	ticker.add(() => {
		drawFrame();
	});

	if (typeof ticker.start === 'function') {
		ticker.start();
	}

	drawFrame();
	if (pixiApp.renderer && typeof pixiApp.renderer.render === 'function') {
		pixiApp.renderer.render(pixiApp.stage);
	}
}

export async function init(_d3: any, options: { initialRouteNodeId?: string | null } = {}) {
	if (typeof window === 'undefined') return;

	const initialRouteNodeId = String(options.initialRouteNodeId || '').trim() || null;
	const PIXI = await import('pixi.js');
	const data = await fetchGraphData();
	graphNodes = data.nodes;
	graphLinks = data.links;

	// Mark all loaded nodes as new
	newNodeIds = new Set(graphNodes.map((n) => String(n.id)));

	const nodeIndex = new Map(graphNodes.map((node) => [String(node.id), node]));
	graphLinks.forEach((link) => {
		const sourceId = String(link.source || link.sourceId || '');
		const targetId = String(link.target || link.targetId || '');
		link.source = nodeIndex.get(sourceId) || { id: sourceId, x: 0, y: 0 };
		link.target = nodeIndex.get(targetId) || { id: targetId, x: 0, y: 0 };
	});

	await createCanvasRenderer(PIXI);

	const canvas = getCanvasElement();
	const width = canvas?.clientWidth || 800;
	const height = canvas?.clientHeight || 600;

	graphNodes.forEach((node) => {
		Object.assign(node, {
			x: width / 2 + (Math.random() - 0.5) * 80,
			y: height / 2 + (Math.random() - 0.5) * 80,
		});
	});

	simulation = _d3
		.forceSimulation(graphNodes)
		.force(
			'link',
			_d3
				.forceLink(graphLinks)
				.id((d: any) => d.id)
				.distance(70)
				.strength(0.75),
		)
		.force('charge', _d3.forceManyBody().strength(-150).theta(0.9))
		.force('center', _d3.forceCenter(width / 2, height / 2))
		.force(
			'collision',
			_d3
				.forceCollide()
				.radius((d: any) => getNodeRadius(d) + 2)
				.strength(1),
		)
		.velocityDecay(0.72)
		.alphaDecay(0.05)
		.on('tick', drawFrame)
		.on('end', drawFrame);

	installRouteListener();
	installStopAnimationListener();

	// Add canvas click handler to clear new node highlights
	const clearNewNodeHighlight = (e: MouseEvent) => {
		// Only clear if click is on canvas, not on a node
		const canvas = getCanvasElement();
		if (canvas && e.target === canvas) {
			if (newNodeIds.size > 0) {
				newNodeIds.clear();
				updateNodeStyles();
			}
		}
	};
	window.addEventListener('click', clearNewNodeHighlight, true);

	if (initialRouteNodeId) {
		selectNode(initialRouteNodeId);
	}
}

export function destroy() {
	if (simulation) {
		simulation.stop();
		simulation = null;
	}
	if (pixiApp) {
		pixiApp.destroy(true, { children: true, texture: true, baseTexture: true });
		pixiApp = null;
	}
	nodeSprites.clear();
	graphNodes = [];
	graphLinks = [];
	teardownRouteListener();
	teardownStopAnimationListener();
}
