/* d3-force worker
 * Loads d3-force from CDN and runs a simulation in the worker thread.
 * Expects messages: {type:'init', nodes, links, width, height}, {type:'start'},{type:'stop'},{type:'updateNodes', positions:[]}
 */
(function () {
	// Attempt to load d3-force UMD build
	try {
		importScripts('https://cdn.jsdelivr.net/npm/d3-force@3/dist/d3-force.min.js');
	} catch (e) {
		// If CDN load failed, worker will fall back to simple internal sim if needed
		// but we surface the error to the main thread
		postMessage({ type: 'error', message: 'Failed to import d3-force', error: String(e) });
	}

	let nodes = [];
	let links = [];
	let width = 800;
	let height = 600;
	let sim = null;

	function startSim() {
		if (typeof d3 === 'undefined' || !d3.forceSimulation) {
			postMessage({ type: 'error', message: 'd3-force not available' });
			return;
		}
		if (sim) sim.stop();
		sim = d3
			.forceSimulation(nodes)
			.force(
				'link',
				d3
					.forceLink(links)
					.id((d) => d.id)
					.distance(70)
					.strength(0.8),
			)
			.force('charge', d3.forceManyBody().strength(-60))
			.force('center', d3.forceCenter(width / 2, height / 2))
			.alphaDecay(0.02)
			.on('tick', () => {
				postMessage({ type: 'tick', nodes: nodes.map((n) => ({ id: n.id, x: n.x, y: n.y })) });
			});
		sim.alpha(1).restart();
	}

	onmessage = function (ev) {
		const m = ev.data || {};
		if (m.type === 'init') {
			width = m.width || width;
			height = m.height || height;
			nodes = (m.nodes || []).map((n) => ({ id: n.id, x: n.x || width / 2, y: n.y || height / 2 }));
			// links may be objects with source/target ids
			links = (m.links || []).map((l) => ({ source: l.source, target: l.target }));
			postMessage({ type: 'ready' });
		} else if (m.type === 'start') {
			startSim();
		} else if (m.type === 'stop') {
			if (sim) sim.stop();
		} else if (m.type === 'updateNodes' && Array.isArray(m.positions)) {
			for (const p of m.positions) {
				const n = nodes.find((x) => String(x.id) === String(p.id));
				if (n) {
					n.x = p.x;
					n.y = p.y;
				}
			}
		}
	};
})();
(() => {
	function U(t, e) {
		var n,
			i = 1;
		(t == null && (t = 0), e == null && (e = 0));
		function r() {
			var o,
				s = n.length,
				c,
				v = 0,
				a = 0;
			for (o = 0; o < s; ++o) ((c = n[o]), (v += c.x), (a += c.y));
			for (v = (v / s - t) * i, a = (a / s - e) * i, o = 0; o < s; ++o) ((c = n[o]), (c.x -= v), (c.y -= a));
		}
		return (
			(r.initialize = function (o) {
				n = o;
			}),
			(r.x = function (o) {
				return arguments.length ? ((t = +o), r) : t;
			}),
			(r.y = function (o) {
				return arguments.length ? ((e = +o), r) : e;
			}),
			(r.strength = function (o) {
				return arguments.length ? ((i = +o), r) : i;
			}),
			r
		);
	}
	function it(t) {
		let e = +this._x.call(null, t),
			n = +this._y.call(null, t);
		return ot(this.cover(e, n), e, n, t);
	}
	function ot(t, e, n, i) {
		if (isNaN(e) || isNaN(n)) return t;
		var r,
			o = t._root,
			s = { data: i },
			c = t._x0,
			v = t._y0,
			a = t._x1,
			g = t._y1,
			d,
			y,
			l,
			m,
			u,
			f,
			h,
			p;
		if (!o) return ((t._root = s), t);
		for (; o.length; )
			if (((u = e >= (d = (c + a) / 2)) ? (c = d) : (a = d), (f = n >= (y = (v + g) / 2)) ? (v = y) : (g = y), (r = o), !(o = o[(h = (f << 1) | u)]))) return ((r[h] = s), t);
		if (((l = +t._x.call(null, o.data)), (m = +t._y.call(null, o.data)), e === l && n === m)) return ((s.next = o), r ? (r[h] = s) : (t._root = s), t);
		do ((r = r ? (r[h] = new Array(4)) : (t._root = new Array(4))), (u = e >= (d = (c + a) / 2)) ? (c = d) : (a = d), (f = n >= (y = (v + g) / 2)) ? (v = y) : (g = y));
		while ((h = (f << 1) | u) === (p = ((m >= y) << 1) | (l >= d)));
		return ((r[p] = o), (r[h] = s), t);
	}
	function ft(t) {
		var e,
			n,
			i = t.length,
			r,
			o,
			s = new Array(i),
			c = new Array(i),
			v = 1 / 0,
			a = 1 / 0,
			g = -1 / 0,
			d = -1 / 0;
		for (n = 0; n < i; ++n)
			isNaN((r = +this._x.call(null, (e = t[n])))) ||
				isNaN((o = +this._y.call(null, e))) ||
				((s[n] = r), (c[n] = o), r < v && (v = r), r > g && (g = r), o < a && (a = o), o > d && (d = o));
		if (v > g || a > d) return this;
		for (this.cover(v, a).cover(g, d), n = 0; n < i; ++n) ot(this, s[n], c[n], t[n]);
		return this;
	}
	function at(t, e) {
		if (isNaN((t = +t)) || isNaN((e = +e))) return this;
		var n = this._x0,
			i = this._y0,
			r = this._x1,
			o = this._y1;
		if (isNaN(n)) ((r = (n = Math.floor(t)) + 1), (o = (i = Math.floor(e)) + 1));
		else {
			for (var s = r - n || 1, c = this._root, v, a; n > t || t >= r || i > e || e >= o; )
				switch (((a = ((e < i) << 1) | (t < n)), (v = new Array(4)), (v[a] = c), (c = v), (s *= 2), a)) {
					case 0:
						((r = n + s), (o = i + s));
						break;
					case 1:
						((n = r - s), (o = i + s));
						break;
					case 2:
						((r = n + s), (i = o - s));
						break;
					case 3:
						((n = r - s), (i = o - s));
						break;
				}
			this._root && this._root.length && (this._root = c);
		}
		return ((this._x0 = n), (this._y0 = i), (this._x1 = r), (this._y1 = o), this);
	}
	function ut() {
		var t = [];
		return (
			this.visit(function (e) {
				if (!e.length)
					do t.push(e.data);
					while ((e = e.next));
			}),
			t
		);
	}
	function st(t) {
		return (
			arguments.length ? this.cover(+t[0][0], +t[0][1]).cover(+t[1][0], +t[1][1])
			: isNaN(this._x0) ? void 0
			: [
					[this._x0, this._y0],
					[this._x1, this._y1],
				]
		);
	}
	function A(t, e, n, i, r) {
		((this.node = t), (this.x0 = e), (this.y0 = n), (this.x1 = i), (this.y1 = r));
	}
	function lt(t, e, n) {
		var i,
			r = this._x0,
			o = this._y0,
			s,
			c,
			v,
			a,
			g = this._x1,
			d = this._y1,
			y = [],
			l = this._root,
			m,
			u;
		for (l && y.push(new A(l, r, o, g, d)), n == null ? (n = 1 / 0) : ((r = t - n), (o = e - n), (g = t + n), (d = e + n), (n *= n)); (m = y.pop()); )
			if (!(!(l = m.node) || (s = m.x0) > g || (c = m.y0) > d || (v = m.x1) < r || (a = m.y1) < o))
				if (l.length) {
					var f = (s + v) / 2,
						h = (c + a) / 2;
					(y.push(new A(l[3], f, h, v, a), new A(l[2], s, h, f, a), new A(l[1], f, c, v, h), new A(l[0], s, c, f, h)),
						(u = ((e >= h) << 1) | (t >= f)) && ((m = y[y.length - 1]), (y[y.length - 1] = y[y.length - 1 - u]), (y[y.length - 1 - u] = m)));
				} else {
					var p = t - +this._x.call(null, l.data),
						_ = e - +this._y.call(null, l.data),
						x = p * p + _ * _;
					if (x < n) {
						var w = Math.sqrt((n = x));
						((r = t - w), (o = e - w), (g = t + w), (d = e + w), (i = l.data));
					}
				}
		return i;
	}
	function ht(t) {
		if (isNaN((g = +this._x.call(null, t))) || isNaN((d = +this._y.call(null, t)))) return this;
		var e,
			n = this._root,
			i,
			r,
			o,
			s = this._x0,
			c = this._y0,
			v = this._x1,
			a = this._y1,
			g,
			d,
			y,
			l,
			m,
			u,
			f,
			h;
		if (!n) return this;
		if (n.length)
			for (;;) {
				if (((m = g >= (y = (s + v) / 2)) ? (s = y) : (v = y), (u = d >= (l = (c + a) / 2)) ? (c = l) : (a = l), (e = n), !(n = n[(f = (u << 1) | m)]))) return this;
				if (!n.length) break;
				(e[(f + 1) & 3] || e[(f + 2) & 3] || e[(f + 3) & 3]) && ((i = e), (h = f));
			}
		for (; n.data !== t; ) if (((r = n), !(n = n.next))) return this;
		return (
			(o = n.next) && delete n.next,
			r ? (o ? (r.next = o) : delete r.next, this)
			: e ? (o ? (e[f] = o) : delete e[f], (n = e[0] || e[1] || e[2] || e[3]) && n === (e[3] || e[2] || e[1] || e[0]) && !n.length && (i ? (i[h] = n) : (this._root = n)), this)
			: ((this._root = o), this)
		);
	}
	function ct(t) {
		for (var e = 0, n = t.length; e < n; ++e) this.remove(t[e]);
		return this;
	}
	function pt() {
		return this._root;
	}
	function xt() {
		var t = 0;
		return (
			this.visit(function (e) {
				if (!e.length)
					do ++t;
					while ((e = e.next));
			}),
			t
		);
	}
	function gt(t) {
		var e = [],
			n,
			i = this._root,
			r,
			o,
			s,
			c,
			v;
		for (i && e.push(new A(i, this._x0, this._y0, this._x1, this._y1)); (n = e.pop()); )
			if (!t((i = n.node), (o = n.x0), (s = n.y0), (c = n.x1), (v = n.y1)) && i.length) {
				var a = (o + c) / 2,
					g = (s + v) / 2;
				((r = i[3]) && e.push(new A(r, a, g, c, v)),
					(r = i[2]) && e.push(new A(r, o, g, a, v)),
					(r = i[1]) && e.push(new A(r, a, s, c, g)),
					(r = i[0]) && e.push(new A(r, o, s, a, g)));
			}
		return this;
	}
	function yt(t) {
		var e = [],
			n = [],
			i;
		for (this._root && e.push(new A(this._root, this._x0, this._y0, this._x1, this._y1)); (i = e.pop()); ) {
			var r = i.node;
			if (r.length) {
				var o,
					s = i.x0,
					c = i.y0,
					v = i.x1,
					a = i.y1,
					g = (s + v) / 2,
					d = (c + a) / 2;
				((o = r[0]) && e.push(new A(o, s, c, g, d)),
					(o = r[1]) && e.push(new A(o, g, c, v, d)),
					(o = r[2]) && e.push(new A(o, s, d, g, a)),
					(o = r[3]) && e.push(new A(o, g, d, v, a)));
			}
			n.push(i);
		}
		for (; (i = n.pop()); ) t(i.node, i.x0, i.y0, i.x1, i.y1);
		return this;
	}
	function vt(t) {
		return t[0];
	}
	function mt(t) {
		return arguments.length ? ((this._x = t), this) : this._x;
	}
	function dt(t) {
		return t[1];
	}
	function _t(t) {
		return arguments.length ? ((this._y = t), this) : this._y;
	}
	function F(t, e, n) {
		var i = new V(e == null ? vt : e, n == null ? dt : n, NaN, NaN, NaN, NaN);
		return t == null ? i : i.addAll(t);
	}
	function V(t, e, n, i, r, o) {
		((this._x = t), (this._y = e), (this._x0 = n), (this._y0 = i), (this._x1 = r), (this._y1 = o), (this._root = void 0));
	}
	function wt(t) {
		for (var e = { data: t.data }, n = e; (t = t.next); ) n = n.next = { data: t.data };
		return e;
	}
	var j = (F.prototype = V.prototype);
	j.copy = function () {
		var t = new V(this._x, this._y, this._x0, this._y0, this._x1, this._y1),
			e = this._root,
			n,
			i;
		if (!e) return t;
		if (!e.length) return ((t._root = wt(e)), t);
		for (n = [{ source: e, target: (t._root = new Array(4)) }]; (e = n.pop()); )
			for (var r = 0; r < 4; ++r) (i = e.source[r]) && (i.length ? n.push({ source: i, target: (e.target[r] = new Array(4)) }) : (e.target[r] = wt(i)));
		return t;
	};
	j.add = it;
	j.addAll = ft;
	j.cover = at;
	j.data = ut;
	j.extent = st;
	j.find = lt;
	j.remove = ht;
	j.removeAll = ct;
	j.root = pt;
	j.size = xt;
	j.visit = gt;
	j.visitAfter = yt;
	j.x = mt;
	j.y = _t;
	function T(t) {
		return function () {
			return t;
		};
	}
	function E(t) {
		return (t() - 0.5) * 1e-6;
	}
	function bt(t) {
		return t.x + t.vx;
	}
	function Ft(t) {
		return t.y + t.vy;
	}
	function W(t) {
		var e,
			n,
			i,
			r = 1,
			o = 1;
		typeof t != 'function' && (t = T(t == null ? 1 : +t));
		function s() {
			for (var a, g = e.length, d, y, l, m, u, f, h = 0; h < o; ++h)
				for (d = F(e, bt, Ft).visitAfter(c), a = 0; a < g; ++a) ((y = e[a]), (u = n[y.index]), (f = u * u), (l = y.x + y.vx), (m = y.y + y.vy), d.visit(p));
			function p(_, x, w, I, z) {
				var N = _.data,
					D = _.r,
					M = u + D;
				if (N) {
					if (N.index > y.index) {
						var k = l - N.x - N.vx,
							b = m - N.y - N.vy,
							S = k * k + b * b;
						S < M * M &&
							(k === 0 && ((k = E(i)), (S += k * k)),
							b === 0 && ((b = E(i)), (S += b * b)),
							(S = ((M - (S = Math.sqrt(S))) / S) * r),
							(y.vx += (k *= S) * (M = (D *= D) / (f + D))),
							(y.vy += (b *= S) * M),
							(N.vx -= k * (M = 1 - M)),
							(N.vy -= b * M));
					}
					return;
				}
				return x > l + M || I < l - M || w > m + M || z < m - M;
			}
		}
		function c(a) {
			if (a.data) return (a.r = n[a.data.index]);
			for (var g = (a.r = 0); g < 4; ++g) a[g] && a[g].r > a.r && (a.r = a[g].r);
		}
		function v() {
			if (e) {
				var a,
					g = e.length,
					d;
				for (n = new Array(g), a = 0; a < g; ++a) ((d = e[a]), (n[d.index] = +t(d, a, e)));
			}
		}
		return (
			(s.initialize = function (a, g) {
				((e = a), (i = g), v());
			}),
			(s.iterations = function (a) {
				return arguments.length ? ((o = +a), s) : o;
			}),
			(s.strength = function (a) {
				return arguments.length ? ((r = +a), s) : r;
			}),
			(s.radius = function (a) {
				return arguments.length ? ((t = typeof a == 'function' ? a : T(+a)), v(), s) : t;
			}),
			s
		);
	}
	function Pt(t) {
		return t.index;
	}
	function Nt(t, e) {
		var n = t.get(e);
		if (!n) throw new Error('node not found: ' + e);
		return n;
	}
	function Z(t) {
		var e = Pt,
			n = d,
			i,
			r = T(30),
			o,
			s,
			c,
			v,
			a,
			g = 1;
		t == null && (t = []);
		function d(f) {
			return 1 / Math.min(c[f.source.index], c[f.target.index]);
		}
		function y(f) {
			for (var h = 0, p = t.length; h < g; ++h)
				for (var _ = 0, x, w, I, z, N, D, M; _ < p; ++_)
					((x = t[_]),
						(w = x.source),
						(I = x.target),
						(z = I.x + I.vx - w.x - w.vx || E(a)),
						(N = I.y + I.vy - w.y - w.vy || E(a)),
						(D = Math.sqrt(z * z + N * N)),
						(D = ((D - o[_]) / D) * f * i[_]),
						(z *= D),
						(N *= D),
						(I.vx -= z * (M = v[_])),
						(I.vy -= N * M),
						(w.vx += z * (M = 1 - M)),
						(w.vy += N * M));
		}
		function l() {
			if (s) {
				var f,
					h = s.length,
					p = t.length,
					_ = new Map(s.map((w, I) => [e(w, I, s), w])),
					x;
				for (f = 0, c = new Array(h); f < p; ++f)
					((x = t[f]),
						(x.index = f),
						typeof x.source != 'object' && (x.source = Nt(_, x.source)),
						typeof x.target != 'object' && (x.target = Nt(_, x.target)),
						(c[x.source.index] = (c[x.source.index] || 0) + 1),
						(c[x.target.index] = (c[x.target.index] || 0) + 1));
				for (f = 0, v = new Array(p); f < p; ++f) ((x = t[f]), (v[f] = c[x.source.index] / (c[x.source.index] + c[x.target.index])));
				((i = new Array(p)), m(), (o = new Array(p)), u());
			}
		}
		function m() {
			if (s) for (var f = 0, h = t.length; f < h; ++f) i[f] = +n(t[f], f, t);
		}
		function u() {
			if (s) for (var f = 0, h = t.length; f < h; ++f) o[f] = +r(t[f], f, t);
		}
		return (
			(y.initialize = function (f, h) {
				((s = f), (a = h), l());
			}),
			(y.links = function (f) {
				return arguments.length ? ((t = f), l(), y) : t;
			}),
			(y.id = function (f) {
				return arguments.length ? ((e = f), y) : e;
			}),
			(y.iterations = function (f) {
				return arguments.length ? ((g = +f), y) : g;
			}),
			(y.strength = function (f) {
				return arguments.length ? ((n = typeof f == 'function' ? f : T(+f)), m(), y) : n;
			}),
			(y.distance = function (f) {
				return arguments.length ? ((r = typeof f == 'function' ? f : T(+f)), u(), y) : r;
			}),
			y
		);
	}
	var Ct = { value: () => {} };
	function At() {
		for (var t = 0, e = arguments.length, n = {}, i; t < e; ++t) {
			if (!(i = arguments[t] + '') || i in n || /[\s.]/.test(i)) throw new Error('illegal type: ' + i);
			n[i] = [];
		}
		return new Y(n);
	}
	function Y(t) {
		this._ = t;
	}
	function Ot(t, e) {
		return t
			.trim()
			.split(/^|\s+/)
			.map(function (n) {
				var i = '',
					r = n.indexOf('.');
				if ((r >= 0 && ((i = n.slice(r + 1)), (n = n.slice(0, r))), n && !e.hasOwnProperty(n))) throw new Error('unknown type: ' + n);
				return { type: n, name: i };
			});
	}
	Y.prototype = At.prototype = {
		constructor: Y,
		on: function (t, e) {
			var n = this._,
				i = Ot(t + '', n),
				r,
				o = -1,
				s = i.length;
			if (arguments.length < 2) {
				for (; ++o < s; ) if ((r = (t = i[o]).type) && (r = Qt(n[r], t.name))) return r;
				return;
			}
			if (e != null && typeof e != 'function') throw new Error('invalid callback: ' + e);
			for (; ++o < s; )
				if ((r = (t = i[o]).type)) n[r] = Mt(n[r], t.name, e);
				else if (e == null) for (r in n) n[r] = Mt(n[r], t.name, null);
			return this;
		},
		copy: function () {
			var t = {},
				e = this._;
			for (var n in e) t[n] = e[n].slice();
			return new Y(t);
		},
		call: function (t, e) {
			if ((r = arguments.length - 2) > 0) for (var n = new Array(r), i = 0, r, o; i < r; ++i) n[i] = arguments[i + 2];
			if (!this._.hasOwnProperty(t)) throw new Error('unknown type: ' + t);
			for (o = this._[t], i = 0, r = o.length; i < r; ++i) o[i].value.apply(e, n);
		},
		apply: function (t, e, n) {
			if (!this._.hasOwnProperty(t)) throw new Error('unknown type: ' + t);
			for (var i = this._[t], r = 0, o = i.length; r < o; ++r) i[r].value.apply(e, n);
		},
	};
	function Qt(t, e) {
		for (var n = 0, i = t.length, r; n < i; ++n) if ((r = t[n]).name === e) return r.value;
	}
	function Mt(t, e, n) {
		for (var i = 0, r = t.length; i < r; ++i)
			if (t[i].name === e) {
				((t[i] = Ct), (t = t.slice(0, i).concat(t.slice(i + 1))));
				break;
			}
		return (n != null && t.push({ name: e, value: n }), t);
	}
	var $ = At;
	var C = 0,
		Q = 0,
		O = 0,
		jt = 1e3,
		R,
		B,
		H = 0,
		P = 0,
		G = 0,
		L = typeof performance == 'object' && performance.now ? performance : Date,
		zt =
			typeof window == 'object' && window.requestAnimationFrame ?
				window.requestAnimationFrame.bind(window)
			:	function (t) {
					setTimeout(t, 17);
				};
	function et() {
		return P || (zt(Bt), (P = L.now() + G));
	}
	function Bt() {
		P = 0;
	}
	function q() {
		this._call = this._time = this._next = null;
	}
	q.prototype = J.prototype = {
		constructor: q,
		restart: function (t, e, n) {
			if (typeof t != 'function') throw new TypeError('callback is not a function');
			((n = (n == null ? et() : +n) + (e == null ? 0 : +e)),
				!this._next && B !== this && (B ? (B._next = this) : (R = this), (B = this)),
				(this._call = t),
				(this._time = n),
				tt());
		},
		stop: function () {
			this._call && ((this._call = null), (this._time = 1 / 0), tt());
		},
	};
	function J(t, e, n) {
		var i = new q();
		return (i.restart(t, e, n), i);
	}
	function Dt() {
		(et(), ++C);
		for (var t = R, e; t; ) ((e = P - t._time) >= 0 && t._call.call(void 0, e), (t = t._next));
		--C;
	}
	function It() {
		((P = (H = L.now()) + G), (C = Q = 0));
		try {
			Dt();
		} finally {
			((C = 0), Xt(), (P = 0));
		}
	}
	function Lt() {
		var t = L.now(),
			e = t - H;
		e > jt && ((G -= e), (H = t));
	}
	function Xt() {
		for (var t, e = R, n, i = 1 / 0; e; ) e._call ? (i > e._time && (i = e._time), (t = e), (e = e._next)) : ((n = e._next), (e._next = null), (e = t ? (t._next = n) : (R = n)));
		((B = t), tt(i));
	}
	function tt(t) {
		if (!C) {
			Q && (Q = clearTimeout(Q));
			var e = t - P;
			e > 24 ? (t < 1 / 0 && (Q = setTimeout(It, t - L.now() - G)), O && (O = clearInterval(O))) : (O || ((H = L.now()), (O = setInterval(Lt, jt))), (C = 1), zt(It));
		}
	}
	function Et() {
		let t = 1;
		return () => (t = (1664525 * t + 1013904223) % 4294967296) / 4294967296;
	}
	function Tt(t) {
		return t.x;
	}
	function St(t) {
		return t.y;
	}
	var Yt = 10,
		Rt = Math.PI * (3 - Math.sqrt(5));
	function nt(t) {
		var e,
			n = 1,
			i = 0.001,
			r = 1 - Math.pow(i, 1 / 300),
			o = 0,
			s = 0.6,
			c = new Map(),
			v = J(d),
			a = $('tick', 'end'),
			g = Et();
		t == null && (t = []);
		function d() {
			(y(), a.call('tick', e), n < i && (v.stop(), a.call('end', e)));
		}
		function y(u) {
			var f,
				h = t.length,
				p;
			u === void 0 && (u = 1);
			for (var _ = 0; _ < u; ++_)
				for (
					n += (o - n) * r,
						c.forEach(function (x) {
							x(n);
						}),
						f = 0;
					f < h;
					++f
				)
					((p = t[f]), p.fx == null ? (p.x += p.vx *= s) : ((p.x = p.fx), (p.vx = 0)), p.fy == null ? (p.y += p.vy *= s) : ((p.y = p.fy), (p.vy = 0)));
			return e;
		}
		function l() {
			for (var u = 0, f = t.length, h; u < f; ++u) {
				if (((h = t[u]), (h.index = u), h.fx != null && (h.x = h.fx), h.fy != null && (h.y = h.fy), isNaN(h.x) || isNaN(h.y))) {
					var p = Yt * Math.sqrt(0.5 + u),
						_ = u * Rt;
					((h.x = p * Math.cos(_)), (h.y = p * Math.sin(_)));
				}
				(isNaN(h.vx) || isNaN(h.vy)) && (h.vx = h.vy = 0);
			}
		}
		function m(u) {
			return (u.initialize && u.initialize(t, g), u);
		}
		return (
			l(),
			(e = {
				tick: y,
				restart: function () {
					return (v.restart(d), e);
				},
				stop: function () {
					return (v.stop(), e);
				},
				nodes: function (u) {
					return arguments.length ? ((t = u), l(), c.forEach(m), e) : t;
				},
				alpha: function (u) {
					return arguments.length ? ((n = +u), e) : n;
				},
				alphaMin: function (u) {
					return arguments.length ? ((i = +u), e) : i;
				},
				alphaDecay: function (u) {
					return arguments.length ? ((r = +u), e) : +r;
				},
				alphaTarget: function (u) {
					return arguments.length ? ((o = +u), e) : o;
				},
				velocityDecay: function (u) {
					return arguments.length ? ((s = 1 - u), e) : 1 - s;
				},
				randomSource: function (u) {
					return arguments.length ? ((g = u), c.forEach(m), e) : g;
				},
				force: function (u, f) {
					return arguments.length > 1 ? (f == null ? c.delete(u) : c.set(u, m(f)), e) : c.get(u);
				},
				find: function (u, f, h) {
					var p = 0,
						_ = t.length,
						x,
						w,
						I,
						z,
						N;
					for (h == null ? (h = 1 / 0) : (h *= h), p = 0; p < _; ++p) ((z = t[p]), (x = u - z.x), (w = f - z.y), (I = x * x + w * w), I < h && ((N = z), (h = I)));
					return N;
				},
				on: function (u, f) {
					return arguments.length > 1 ? (a.on(u, f), e) : a.on(u);
				},
			})
		);
	}
	function rt() {
		var t,
			e,
			n,
			i,
			r = T(-30),
			o,
			s = 1,
			c = 1 / 0,
			v = 0.81;
		function a(l) {
			var m,
				u = t.length,
				f = F(t, Tt, St).visitAfter(d);
			for (i = l, m = 0; m < u; ++m) ((e = t[m]), f.visit(y));
		}
		function g() {
			if (t) {
				var l,
					m = t.length,
					u;
				for (o = new Array(m), l = 0; l < m; ++l) ((u = t[l]), (o[u.index] = +r(u, l, t)));
			}
		}
		function d(l) {
			var m = 0,
				u,
				f,
				h = 0,
				p,
				_,
				x;
			if (l.length) {
				for (p = _ = x = 0; x < 4; ++x) (u = l[x]) && (f = Math.abs(u.value)) && ((m += u.value), (h += f), (p += f * u.x), (_ += f * u.y));
				((l.x = p / h), (l.y = _ / h));
			} else {
				((u = l), (u.x = u.data.x), (u.y = u.data.y));
				do m += o[u.data.index];
				while ((u = u.next));
			}
			l.value = m;
		}
		function y(l, m, u, f) {
			if (!l.value) return !0;
			var h = l.x - e.x,
				p = l.y - e.y,
				_ = f - m,
				x = h * h + p * p;
			if ((_ * _) / v < x)
				return (
					x < c &&
						(h === 0 && ((h = E(n)), (x += h * h)),
						p === 0 && ((p = E(n)), (x += p * p)),
						x < s && (x = Math.sqrt(s * x)),
						(e.vx += (h * l.value * i) / x),
						(e.vy += (p * l.value * i) / x)),
					!0
				);
			if (l.length || x >= c) return;
			(l.data !== e || l.next) && (h === 0 && ((h = E(n)), (x += h * h)), p === 0 && ((p = E(n)), (x += p * p)), x < s && (x = Math.sqrt(s * x)));
			do l.data !== e && ((_ = (o[l.data.index] * i) / x), (e.vx += h * _), (e.vy += p * _));
			while ((l = l.next));
		}
		return (
			(a.initialize = function (l, m) {
				((t = l), (n = m), g());
			}),
			(a.strength = function (l) {
				return arguments.length ? ((r = typeof l == 'function' ? l : T(+l)), g(), a) : r;
			}),
			(a.distanceMin = function (l) {
				return arguments.length ? ((s = l * l), a) : Math.sqrt(s);
			}),
			(a.distanceMax = function (l) {
				return arguments.length ? ((c = l * l), a) : Math.sqrt(c);
			}),
			(a.theta = function (l) {
				return arguments.length ? ((v = l * l), a) : Math.sqrt(v);
			}),
			a
		);
	}
	var K = [],
		kt = [],
		X = null;
	function Ht() {
		return K.map(function (t) {
			return { id: t.id, x: t.x, y: t.y };
		});
	}
	onmessage = function (t) {
		let e = t.data || {};
		if (e.type === 'init') {
			((K = (e.nodes || []).map(function (r) {
				return { id: r.id, x: r.x || 0, y: r.y || 0 };
			})),
				(kt = (e.links || []).map(function (r) {
					return { source: r.source, target: r.target };
				})));
			let n = e.width || 800,
				i = e.height || 600;
			try {
				((X = nt(K)
					.force(
						'link',
						Z(kt)
							.id(function (r) {
								return r.id;
							})
							.distance(70)
							.strength(0.75),
					)
					.force('charge', rt().strength(-150).theta(0.9))
					.force('center', U(n / 2, i / 2))
					.force(
						'collision',
						W()
							.radius(function (r) {
								return (r.r || 7) + 2;
							})
							.strength(1),
					)
					.velocityDecay(0.72)
					.alphaDecay(0.05)
					.on('tick', function () {
						postMessage({ type: 'tick', nodes: Ht() });
					})),
					postMessage({ type: 'ready' }));
			} catch (r) {
				postMessage({ type: 'error', error: String(r) });
			}
		} else if (e.type === 'start') X && X.alpha(1).restart();
		else if (e.type === 'stop') X && X.stop();
		else if (e.type === 'updateNodes') {
			let n = e.positions || [];
			for (let i of n) {
				let r = K.find(function (o) {
					return String(o.id) === String(i.id);
				});
				r && ((r.x = i.x), (r.y = i.y));
			}
		}
	};
})();
