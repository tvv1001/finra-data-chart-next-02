'use client';

import { useEffect, useRef } from 'react';

export default function FinraGraph() {
  const mountedRef = useRef(false);

  useEffect(() => {
    if (mountedRef.current) return;
    mountedRef.current = true;

    Promise.all([
      import('d3'),
      import('@/lib/finra-graph'),
    ]).then(([d3Module, { init }]) => {
      (window as any).d3 = d3Module;
      init(d3Module);
    });
  }, []);

  return (
    <div id="finra-app">
      <header className="fg-header">
        <div className="fg-header-top">
          <h1 className="fg-title">FINRA Network</h1>
          <div className="fg-toolbar">
            <span id="fg-meta-label" className="fg-meta"></span>
            <span id="fg-subset-info" className="fg-subset-info"></span>

            <div className="fg-search">
              <input
                id="fg-search"
                className="fg-search-input"
                type="search"
                placeholder="Filter: Search name, firm, CRD, SEC…"
                autoComplete="off"
              />
            </div>
            <div className="fg-fetch">
              <input
                id="fg-fetch-input"
                className="fg-fetch-input"
                type="search"
                placeholder="Fetch: query, CRD or firm id…"
                autoComplete="off"
              />
              <button
                id="fg-fetch-remote"
                className="fg-fetch-remote"
                title="Fetch from server"
              >
                Fetch
              </button>
              <button
                id="fg-clear-session"
                className="fg-clear-session"
                title="Clear saved session and reload fresh"
              >
                Clear session
              </button>
            </div>
          </div>
        </div>

        {/* Location search row */}
        <div className="fg-loc-row">
          {/* City / State search (individual) */}
          <div className="fg-loc-group">
            <label className="fg-loc-label">City / State</label>
            <input
              id="fg-loc-city"
              className="fg-loc-input"
              type="text"
              placeholder="City"
              autoComplete="off"
            />
            <button id="fg-loc-city-search" className="fg-loc-btn">
              Search People
            </button>
          </div>

          {/* Zip / radius search (firm) */}
          <div className="fg-loc-group">
            <label className="fg-loc-label">Zip / Radius</label>
            <input
              id="fg-loc-zip"
              className="fg-loc-input fg-loc-zip"
              type="text"
              maxLength={10}
              placeholder="ZIP code"
              autoComplete="off"
            />
            <div className="fg-loc-radius-wrap">
              <input
                id="fg-loc-radius"
                className="fg-loc-radius"
                type="range"
                min={1}
                max={100}
                defaultValue={25}
                step={1}
              />
              <span id="fg-loc-radius-val" className="fg-loc-radius-val">25 mi</span>
            </div>
            <button id="fg-loc-zip-search" className="fg-loc-btn">
              Search Firms
            </button>
          </div>

          <span id="fg-loc-status" className="fg-loc-status"></span>
        </div>
      </header>

      <div className="fg-body">
        {/* Detail sidebar */}
        <aside id="fg-sidebar" className="fg-sidebar hidden">
          <div id="fg-sidebar-inner" className="fg-sidebar-inner">
            <p className="fg-hint">Click a node to inspect it.</p>
          </div>
        </aside>

        {/* Graph canvas */}
        <main className="fg-main" id="fg-main">
          <svg id="fg-svg"></svg>
          <div id="fg-legend" className="fg-legend"></div>
          <div id="fg-empty" className="fg-empty hidden">
            <p>No graph built yet.</p>
          </div>
        </main>
      </div>

      {/* Scraper log panel */}
      <div id="fg-log-panel" className="fg-log-panel hidden">
        <div className="fg-log-header">
          <span>Scraper Output</span>
          <button id="btn-log-close" className="fg-log-close">✕</button>
        </div>
        <pre id="fg-log-body" className="fg-log-body"></pre>
      </div>
    </div>
  );
}
