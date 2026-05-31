import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';

const OUT = path.resolve(process.cwd(), 'test-results', 'repro-logs.json');

test('repro: reset -> search beaton -> click person:4240769', async ({ page }) => {
	const collected: any = { console: [], responses: [], errors: [] };
	page.on('console', (msg) => collected.console.push({ type: msg.type(), text: msg.text() }));
	page.on('pageerror', (err) => collected.errors.push({ message: err.message, stack: err.stack }));
	page.on('response', (res) => {
		try {
			const url = res.url();
			if (url.includes('/api/finra/')) {
				collected.responses.push({ url, status: res.status() });
			}
		} catch (e) {}
	});

	await page.goto('http://localhost:4444', { waitUntil: 'domcontentloaded' });

	// Reset if available
	try {
		const reset = page.getByRole('button', { name: /Reset Session/i });
		if ((await reset.count()) > 0) await reset.first().click();
	} catch (e) {}

	// Fill searchbox (accessible name seen in UI)
	try {
		const sb = page.getByRole('searchbox', { name: /firm, person, CRD\/SEC#/i });
		if ((await sb.count()) > 0) {
			await sb.first().fill('beaton');
		} else {
			const inp = page.locator('input').first();
			if ((await inp.count()) > 0) await inp.fill('beaton');
		}
	} catch (e) {
		try {
			await page.locator('input').first().fill('beaton');
		} catch (e) {}
	}

	// Click Fetch Nodes
	try {
		const btn = page.getByRole('button', { name: /Fetch Nodes/i });
		if ((await btn.count()) > 0) await btn.first().click();
	} catch (e) {
		try {
			await page.locator('button:has-text("Fetch Nodes")').first().click();
		} catch (e) {}
	}

	await page.waitForTimeout(2000);

	// If a suggestion list appears, click the matching person entry (exact label seen in site)
	try {
		const suggestion = page.locator('text=Daniel Stewart Beaton').first();
		if ((await suggestion.count()) > 0) {
			await suggestion.click({ force: true });
			await page.waitForTimeout(1200);
		}
	} catch (e) {}

	// Try click node
	try {
		const nodeSel = '[data-id="person:4240769"]';
		const loc = page.locator(nodeSel).first();
		if ((await loc.count()) > 0) {
			await loc.click({ force: true });
		} else {
			// try text-based click
			const byText = page.locator('text=Beaton').first();
			if ((await byText.count()) > 0) await byText.click({ force: true });
		}
	} catch (e) {}

	await page.waitForTimeout(2000);

	// Ensure output dir
	try {
		fs.mkdirSync(path.dirname(OUT), { recursive: true });
	} catch (e) {}
	fs.writeFileSync(OUT, JSON.stringify(collected, null, 2));

	// simple assert so Playwright reports a passing test
	expect(true).toBeTruthy();
});
