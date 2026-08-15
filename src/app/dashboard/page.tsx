'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { buildJsonDisplayTree, coerceStructuredValue, normalizeRenderablePayload, renderJsonForDisplay } from '../../lib/dashboard-json';
import { resolveMainRecordTitle } from '../../lib/dashboard-record-title';
import { getRecordDisplayName } from '../../lib/recordDisplay';
import { formatOtherName } from '@/lib/finra-graph/formatters';
import { buildPersonName, formatEntityName, formatFirmName, formatPersonName } from '@/lib/nameFormat';
import { hasFirmSourceCoverage, hasIndividualSourceCoverage } from '@/lib/sourceTruth';
import VectorLoader from '@/components/VectorLoader';
import styles from './dashboard.module.css';

type DashboardAction = 'fetch-crds' | 'list-new-crds';

type ApiResponse = {
	ok: boolean;
	error?: string;
	[key: string]: unknown;
};

type SearchResult = Record<string, any>;

type SearchResultSource = 'finra' | 'sec';

type SearchResultCard = {
	id: string;
	label: string;
	scope: string;
	address: string;
	detail: string;
	source: SearchResultSource;
	entity: 'individual' | 'firm';
	payload: SearchResult;
};

type QueueCardSourceEntry = {
	source: SearchResultSource;
	status: 'ok' | 'skipped' | 'error' | 'unknown';
	error?: string;
	skipReason?: string;
};

type QueueCard = {
	id: string;
	entity: 'individual' | 'firm';
	files: number;
	sources: QueueCardSourceEntry[];
	since?: string;
	kind?: 'recent';
	name?: string | null;
	statusText?: string | null;
	memberSince?: string | null;
	savedRecordCount?: number;
	updatedExistingRecordCount?: number;
	updatedExistingSourceCount?: number;
	skippedSourceCount?: number;
	trueErrorCount?: number;
};

type QueueRunItem = {
	query: string;
	status: 'queued' | 'running' | 'complete' | 'nomatch' | 'error';
	elapsedSec: number;
	message?: string;
	newRec?: number;
	updatedRec?: number;
	errRec?: number;
};

type UrlSelectionInput = {
	entity: 'individual' | 'firm';
	id: string;
	source: SearchResultSource;
	availableSources?: SearchResultSource[];
};

export function parseDashboardSelectionFromUrl(urlString: string): UrlSelectionInput | null {
	try {
		const url = new URL(urlString, 'http://localhost');
		const params = url.searchParams;

		const normalizeSelectionId = (value: unknown) => {
			const text = String(value || '').trim();
			if (!text) return '';
			if (/^\d{1,10}$/.test(text)) return text;
			const extracted = extractNumericCrdsFromText(text)[0] || '';
			if (extracted) return extracted;
			const loose = text.match(/\b(\d{1,10})\b/);
			return loose?.[1] || '';
		};

		const pathMatch = /^\/dashboard\/(individual|firm)\/([^/?#]+)\/?$/i.exec(url.pathname);
		if (pathMatch) {
			const entity: 'individual' | 'firm' = pathMatch[1].toLowerCase() === 'firm' ? 'firm' : 'individual';
			const id = normalizeSelectionId(decodeURIComponent(pathMatch[2]));
			if (!id) return null;

			const sourceParam = String(params.get('source') || '')
				.trim()
				.toLowerCase();
			const source: SearchResultSource = sourceParam === 'sec' ? 'sec' : 'finra';
			const availableSources: SearchResultSource[] = [];
			if (params.get('finra') === '1') availableSources.push('finra');
			if (params.get('sec') === '1') availableSources.push('sec');
			if (!availableSources.includes(source)) availableSources.push(source);

			return {
				entity,
				id,
				source,
				availableSources,
			};
		}

		const firmId = normalizeSelectionId(params.get('CRD_firm'));
		const individualId = normalizeSelectionId(params.get('CRD_individual'));
		const id = firmId || individualId;
		if (!id) return null;

		const sourceParam = String(params.get('source') || '')
			.trim()
			.toLowerCase();
		const source: SearchResultSource = sourceParam === 'sec' ? 'sec' : 'finra';
		const availableSources: SearchResultSource[] = [];
		if (params.get('finra') === '1') availableSources.push('finra');
		if (params.get('sec') === '1') availableSources.push('sec');
		if (!availableSources.includes(source)) availableSources.push(source);

		return {
			entity: firmId ? 'firm' : 'individual',
			id,
			source,
			availableSources,
		};
	} catch {
		return null;
	}
}

function extractNumericCrdsFromText(text: string): string[] {
	const raw = String(text || '').trim();
	if (!raw) return [];

	const directMatches = Array.from(raw.matchAll(/(?:^|[\s:;#-])(?:crd|crd\s*#|crd\s*id|individual\s*crd|firm\s*crd|individual\s*id|firm\s*id|id)\s*[:#-]?\s*(\d{1,10})/gi));
	if (directMatches.length) {
		return directMatches.map((match) => match[1]).filter(Boolean);
	}

	const fallbackMatches = Array.from(raw.matchAll(/\b(?:crd|crd\s*#|crd\s*id|individual\s*crd|firm\s*crd|individual\s*id|firm\s*id)\b[^0-9]{0,10}(\d{1,10})\b/gi));
	if (fallbackMatches.length) {
		return fallbackMatches.map((match) => match[1]).filter(Boolean);
	}

	return [];
}

function buildGraphHrefForEntity(entity: 'individual' | 'firm' | null | undefined, id: string | null | undefined) {
	const normalizedId = normalizeCrd(id);
	if (!normalizedId) return null;
	if (entity === 'firm') return `/firm/${encodeURIComponent(normalizedId)}`;
	if (entity === 'individual') return `/individual/${encodeURIComponent(normalizedId)}`;
	return null;
}

function getLatestGraphHrefFromHistory(entries: LocalHistoryEntry[]) {
	if (!Array.isArray(entries) || entries.length === 0) return null;
	const sorted = entries.slice().sort((left, right) => new Date(right.lastVisitedAt || right.fetchedAt).getTime() - new Date(left.lastVisitedAt || left.fetchedAt).getTime());
	for (const entry of sorted) {
		const href = buildGraphHrefForEntity(entry.entity, entry.id);
		if (href) return href;
	}
	return null;
}

function parseQueueQueries(input: string) {
	const HEADER_REGEX =
		/^(crd|crd\s*#|crd\s*number|crd\s*id|individual\s*crd|firm\s*crd|individual\s*id|firm\s*id|id|crd_number|crd_id|individual_id|firm_id|individual_crd|firm_crd|representative\s*crd|rep\s*crd|name|individual\s*name|firm\s*name|representative\s*name|rep\s*name)$/i;
	const PREFIX_NUMERIC_REGEX = /^(?:crd|crd\s*#|crd\s*id|individual\s*crd|firm\s*crd|individual\s*crd\s*:|firm\s*crd\s*:)\s*(\d{1,10})$/i;

	const rawTokens = input
		.split(/[\n\r,;\t]+/g)
		.map((value) => value.trim())
		.filter(Boolean);

	const processedTokens: string[] = [];
	for (const rawToken of rawTokens) {
		if (HEADER_REGEX.test(rawToken)) {
			continue;
		}

		const extractedCrds = extractNumericCrdsFromText(rawToken);
		if (extractedCrds.length) {
			processedTokens.push(...extractedCrds);
			continue;
		}

		const prefixMatch = rawToken.match(PREFIX_NUMERIC_REGEX);
		if (prefixMatch) {
			processedTokens.push(prefixMatch[1]);
			continue;
		}

		if (/^[\d\s]+$/.test(rawToken) && /\s/.test(rawToken)) {
			const parts = rawToken
				.split(/\s+/)
				.map((v) => v.trim())
				.filter(Boolean);
			processedTokens.push(...parts);
		} else {
			processedTokens.push(rawToken);
		}
	}

	return Array.from(new Set(processedTokens));
}

export function buildQueueRunItems(queries: string[]) {
	return queries
		.map((query) => query.trim())
		.filter(Boolean)
		.map((query) => ({ query, status: 'queued' as const, elapsedSec: 0 }));
}

export function createQueueTerminalLogId(kind: string, index: number, step: number) {
	return `queue:${kind}:${index}:${step}`;
}

export function computeQueryFetchCounts(resolution: Array<{ query?: string; crds?: string[] }>, fetchedItems: Array<{ crd?: string; status?: string }>) {
	const counts = new Map<string, number>();

	for (const entry of resolution) {
		const query = String(entry?.query || '').trim();
		if (!query) continue;

		const crdSet = new Set((Array.isArray(entry?.crds) ? entry.crds : []).map((value) => String(value || '').trim()).filter(Boolean));

		const addedCount = fetchedItems.filter((item) => crdSet.has(String(item?.crd || '').trim()) && String(item?.status || '') === 'ok').length;
		counts.set(query, addedCount);
	}

	return Object.fromEntries(counts.entries());
}

export function computeQuerySaveStats(
	resolution: Array<{ query?: string; crds?: string[] }>,
	fetchedItems: Array<{ crd?: string; type?: string; status?: string; cardKey?: string; newSourceSaved?: boolean; newRecordSaved?: boolean }>,
) {
	const stats = new Map<
		string,
		{
			fetchedCount: number;
			skippedCount: number;
			savedSourceCount: number;
			savedRecordCount: number;
			updatedExistingSourceCount: number;
			updatedExistingRecordCount: number;
			errorCount: number;
		}
	>();

	for (const entry of resolution) {
		const query = String(entry?.query || '').trim();
		if (!query) continue;

		const crdSet = new Set((Array.isArray(entry?.crds) ? entry.crds : []).map((value) => String(value || '').trim()).filter(Boolean));
		const matchingItems = fetchedItems.filter((item) => crdSet.has(String(item?.crd || '').trim()));
		const savedRecordKeys = new Set(
			matchingItems
				.filter((item) => item?.newRecordSaved === true)
				.map((item) => String(item?.cardKey || `${String(item?.type || 'individual')}:${String(item?.crd || '').trim()}`)),
		);
		const updatedExistingRecordKeys = new Set(
			matchingItems
				.filter((item) => item?.newSourceSaved === true && item?.newRecordSaved !== true)
				.map((item) => String(item?.cardKey || `${String(item?.type || 'individual')}:${String(item?.crd || '').trim()}`)),
		);

		stats.set(query, {
			fetchedCount: matchingItems.filter((item) => String(item?.status || '') === 'ok').length,
			skippedCount: matchingItems.filter((item) => String(item?.status || '') === 'skipped').length,
			savedSourceCount: matchingItems.filter((item) => item?.newSourceSaved === true).length,
			savedRecordCount: savedRecordKeys.size,
			updatedExistingSourceCount: matchingItems.filter((item) => item?.newSourceSaved === true && item?.newRecordSaved !== true).length,
			updatedExistingRecordCount: updatedExistingRecordKeys.size,
			errorCount: matchingItems.filter((item) => String(item?.status || '') === 'error').length,
		});
	}

	return Object.fromEntries(stats.entries());
}

export function describeQuerySaveChange(stats?: { savedRecordCount?: number; updatedExistingRecordCount?: number; updatedExistingSourceCount?: number }) {
	const newRecordCount = Number(stats?.savedRecordCount || 0);
	const updatedExistingRecordCount = Number(stats?.updatedExistingRecordCount || 0);
	const updatedExistingSourceCount = Number(stats?.updatedExistingSourceCount || 0);

	if (newRecordCount > 0 && updatedExistingRecordCount > 0) {
		return `${newRecordCount} new CRD${newRecordCount === 1 ? '' : 's'} • ${updatedExistingRecordCount} existing CRD${updatedExistingRecordCount === 1 ? '' : 's'} gained ${updatedExistingSourceCount} new source${updatedExistingSourceCount === 1 ? '' : 's'}`;
	}

	if (newRecordCount > 0) {
		return `${newRecordCount} new CRD${newRecordCount === 1 ? '' : 's'}`;
	}

	if (updatedExistingRecordCount > 0) {
		return `${updatedExistingRecordCount} existing CRD${updatedExistingRecordCount === 1 ? '' : 's'} gained ${updatedExistingSourceCount} new source${updatedExistingSourceCount === 1 ? '' : 's'}`;
	}

	return 'no new data saved';
}

export function shouldShowQueueCardError(card: { sources?: Array<{ source?: string; status?: string; error?: string; skipReason?: string }> }) {
	return Array.isArray(card.sources) && card.sources.some((entry) => String(entry?.status || '') === 'error');
}

export function shouldShowQueueCardSkipped(card: { sources?: Array<{ source?: string; status?: string; error?: string; skipReason?: string }> }) {
	return Array.isArray(card.sources) && !shouldShowQueueCardError(card) && card.sources.some((entry) => String(entry?.status || '') === 'skipped');
}

export function describeDashboardRequestFailure(options: { status?: number; contentType?: string | null; bodyText?: string; errorMessage?: string; elapsedSec?: number }) {
	const status = Number(options.status || 0);
	const contentType = String(options.contentType || '').toLowerCase();
	const bodyText = String(options.bodyText || '');
	const errorMessage = String(options.errorMessage || '');
	const elapsedSec = Math.max(0, Number(options.elapsedSec || 0));
	const combined = `${bodyText}\n${errorMessage}`.toLowerCase();
	if (combined.includes('aborted without reason') || combined.includes('request aborted') || combined.includes('aborterror')) {
		return 'Queue request was cancelled by the browser timeout. The crawl may still be running; please wait a bit longer and try again.';
	}
	const timeoutLike =
		status === 408 ||
		status === 504 ||
		status === 524 ||
		combined.includes('timed out') ||
		combined.includes('timeout') ||
		combined.includes('function invocation') ||
		combined.includes('gateway') ||
		combined.includes('body exceeded');

	if (timeoutLike) {
		return `Queue likely timed out after ${elapsedSec || 30}s. Try fewer names or rerun in smaller chunks.`;
	}

	if (status >= 500 && !contentType.includes('application/json')) {
		return 'Queue failed before the dashboard received JSON. The server likely returned an HTML or gateway error page.';
	}

	if (status >= 400 && bodyText.trim()) {
		return bodyText.trim().slice(0, 240);
	}

	return errorMessage || 'Queue request failed.';
}

export function buildQueueCardsFromFetchResults(items: any[]): QueueCard[] {
	const map = new Map<string, QueueCard>();
	for (const item of items) {
		const id = String(item?.crd || '').trim();
		const source = String(item?.source || '')
			.trim()
			.toLowerCase() as SearchResultSource;
		const entity =
			(
				String(item?.type || '')
					.trim()
					.toLowerCase() === 'firm'
			) ?
				'firm'
			:	'individual';
		if (!/^\d{1,10}$/.test(id)) continue;
		if (source !== 'finra' && source !== 'sec') continue;

		const key = `${entity}:${id}`;
		const existing = map.get(key) || {
			id,
			entity,
			files: 0,
			sources: [],
		};

		existing.files += 1;
		const nextSource: QueueCardSourceEntry = {
			source,
			status:
				item?.status === 'error' ? 'error'
				: item?.status === 'skipped' ? 'skipped'
				: item?.status === 'ok' ? 'ok'
				: 'unknown',
			error: item?.error ? String(item.error) : undefined,
			skipReason: item?.skipReason ? String(item.skipReason) : undefined,
		};

		const sourceIndex = existing.sources.findIndex((entry) => entry.source === source);
		if (sourceIndex >= 0) existing.sources[sourceIndex] = nextSource;
		else existing.sources.push(nextSource);

		map.set(key, existing);
	}

	return Array.from(map.values());
}

function normalizePayloadForCleanView(payload: unknown) {
	if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;

	const obj = payload as Record<string, any>;
	if (Array.isArray(obj?.hits?.hits) && obj.hits.hits.length) {
		const source = obj.hits.hits[0]?._source ?? obj.hits.hits[0];
		if (source && typeof source === 'object') {
			return normalizeRenderablePayload(source);
		}
	}

	return normalizeRenderablePayload(obj);
}

function extractEntityDetailFromPayload(payload: any, entity: 'individual' | 'firm', crd: string) {
	if (!payload || typeof payload !== 'object') return null;

	// Handle nested Elasticsearch response structure (hits.hits[0]._source)
	let data = payload;
	if (Array.isArray(payload?.hits?.hits) && payload.hits.hits.length > 0) {
		data = payload.hits.hits[0]?._source || {};
	}

	// Normalize payload structure - handle raw API responses with content/iacontent wrappers
	let normalized = data;
	if (typeof data.content === 'string') {
		try {
			normalized = JSON.parse(data.content);
		} catch {
			// If parse fails, continue with the original data
		}
	}
	if (typeof data.iacontent === 'string') {
		try {
			normalized = { ...normalized, ...JSON.parse(data.iacontent) };
		} catch {
			// If parse fails, continue with the current normalized data
		}
	}

	// For individuals
	if (entity === 'individual') {
		const firstName = normalized.bc?.firstName || normalized.ia?.firstName || normalized.basicInformation?.firstName || '';
		const lastName = normalized.bc?.lastName || normalized.ia?.lastName || normalized.basicInformation?.lastName || '';
		const name =
			[firstName, lastName].filter(Boolean).join(' ').trim() ||
			normalized.fullName ||
			normalized.individualName ||
			normalized.orphan?.name ||
			normalized.name ||
			normalized.basicInformation?.fullName ||
			normalized.basicInformation?.individualName ||
			'';
		const bcScope = normalized.bc?.bcScope || normalized.basicInformation?.bcScope || 'N/A';
		const iaScope = normalized.ia?.iaScope || normalized.basicInformation?.iaScope || 'N/A';

		return {
			id: crd,
			entity,
			name: name || `Individual ${crd}`,
			status: [bcScope, iaScope].filter((s) => s && s !== 'N/A').join(' • ') || 'No status',
		};
	}

	// For firms
	if (entity === 'firm') {
		const legalName =
			normalized.legalName ||
			normalized.basicInformation?.legalName ||
			normalized.basicInformation?.firmName ||
			normalized.basicInformation?.iaFirmName ||
			normalized.orphan?.firmName ||
			normalized.orphan?.name ||
			normalized.firmName ||
			normalized.iaFirmName ||
			'';
		const doingBusinessAs = normalized.doingBusinessAs || normalized.basicInformation?.doingBusinessAs || normalized.dba || normalized.basicInformation?.dba || '';
		const name = legalName || doingBusinessAs || `Firm ${crd}`;

		return {
			id: crd,
			entity,
			name,
			status: 'Firm',
		};
	}

	return null;
}

function inferEntityTypeFromNewCrd(item: { type?: string; scopes?: string[] }): 'individual' | 'firm' {
	const typeText = String(item?.type || '')
		.trim()
		.toLowerCase();
	const scopesText = Array.isArray(item?.scopes) ? item.scopes.join(' ').toLowerCase() : '';
	const combined = `${typeText} ${scopesText}`;
	if (combined.includes('firm') || combined.includes('company') || combined.includes('organization') || combined.includes('org')) {
		return 'firm';
	}
	return 'individual';
}

function buildReadableSummaryRows(payload: Record<string, any>) {
	const rows: Array<{ label: string; value: string }> = [];
	const push = (label: string, raw: unknown) => {
		if (raw == null) return;
		const value = String(raw).trim();
		if (!value || value === 'N/A' || value === 'null' || value === 'undefined') return;
		rows.push({ label, value });
	};

	push('Name', payload.name || payload.fullName || payload.legalName || payload.basicInformation?.legalName);
	push('Status', payload.status || payload.registrationStatus || payload.bcScope || payload.iaScope || payload.basicInformation?.bcScope || payload.basicInformation?.iaScope);
	push('City', payload.city || payload.town || payload.mailingAddress?.city || payload.businessAddress?.city);
	push('State', payload.state || payload.mailingAddress?.state || payload.businessAddress?.state);
	push('Country', payload.country || payload.mailingAddress?.country || payload.businessAddress?.country);
	push('SEC', payload.iaSecNumber || payload.secNumber || payload.basicInformation?.iaSecNumber);
	push('BD', payload.bdSecNumber || payload.basicInformation?.bdSecNumber);
	push('CRD', payload.crd || payload.firmId || payload.individualId);

	if (!rows.length) {
		for (const [key, value] of Object.entries(payload)) {
			if (value == null || typeof value === 'object') continue;
			const str = String(value).trim();
			if (!str) continue;
			rows.push({ label: key, value: str });
			if (rows.length >= 12) break;
		}
	}

	return rows;
}

function maybeParseJson(value: unknown): unknown {
	if (typeof value !== 'string') return value;
	const text = value.trim();
	if (!text) return null;
	if (!(text.startsWith('{') || text.startsWith('['))) return value;
	try {
		return JSON.parse(text);
	} catch {
		return value;
	}
}

function unwrapRecordPayload(input: unknown): any {
	const parsed = maybeParseJson(input);
	if (parsed == null || typeof parsed !== 'object') return parsed;
	if (Array.isArray(parsed)) return parsed;

	const payload = parsed as Record<string, unknown>;
	if (payload.finraBrokerCheck && typeof payload.finraBrokerCheck === 'object') {
		return unwrapRecordPayload(payload.finraBrokerCheck);
	}
	if (payload.secInvestmentAdvisor && typeof payload.secInvestmentAdvisor === 'object') {
		return unwrapRecordPayload(payload.secInvestmentAdvisor);
	}

	if (payload.content != null) return unwrapRecordPayload(payload.content);
	if (payload.iacontent != null) return unwrapRecordPayload(payload.iacontent);

	const firstHit = Array.isArray((payload.hits as any)?.hits) ? (payload.hits as any).hits[0] : null;
	if (firstHit && typeof firstHit === 'object') {
		const source = (firstHit as any)._source;
		if (source && typeof source === 'object') {
			if ((source as any).content != null) return unwrapRecordPayload((source as any).content);
			if ((source as any).iacontent != null) return unwrapRecordPayload((source as any).iacontent);
			return unwrapRecordPayload(source);
		}
	}

	if ((payload as any)._source && typeof (payload as any)._source === 'object') {
		return unwrapRecordPayload((payload as any)._source);
	}

	return payload;
}

function toArray(value: unknown): any[] {
	return Array.isArray(value) ? value : [];
}

function toText(value: unknown): string {
	if (value == null) return '';
	if (typeof value === 'string') return value.trim();
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	return '';
}

function pickFirstNonEmpty(...values: unknown[]): string {
	for (const value of values) {
		const text = toText(value);
		if (text) return text;
	}
	return '';
}

function normalizeCrd(value: unknown): string {
	const text = toText(value);
	if (!text) return '';
	if (/^\d{1,10}$/.test(text)) return text;
	const extracted = extractNumericCrdsFromText(text)[0] || '';
	if (extracted) return extracted;
	const loose = text.match(/\b(\d{1,10})\b/);
	return loose?.[1] || '';
}

function pickFirstValidCrd(...values: unknown[]): string {
	for (const value of values) {
		const crd = normalizeCrd(value);
		if (crd) return crd;
	}
	return '';
}

function looksLikeGenericEntityLabel(value: unknown) {
	const text = toText(value);
	if (!text) return true;
	return /^(firm|individual)\s+\d{1,10}$/i.test(text) || /^employment\s+\d+$/i.test(text) || /^owner\s+\d+$/i.test(text) || /^result$/i.test(text);
}

function buildPersonNameFromRecord(record: Record<string, any>) {
	return buildPersonName(record?.firstName, record?.middleName, record?.lastName, record?.suffix);
}

function resolveEntityNodeLabel(record: Record<string, any> | null | undefined, entity: 'individual' | 'firm', crd?: string, indexFallback?: number) {
	const row = record || {};
	const basic = row?.basicInformation && typeof row.basicInformation === 'object' ? row.basicInformation : {};
	const personName = buildPersonNameFromRecord(row);
	const basicPersonName = buildPersonNameFromRecord(basic);
	const label = pickFirstNonEmpty(
		row?.legalName,
		row?.connectionName,
		row?.name,
		row?.fullName,
		row?.individualName,
		row?.orphan?.name,
		row?.orphan?.firmName,
		row?.firmName,
		row?.iaFirmName,
		basic?.legalName,
		basic?.connectionName,
		basic?.name,
		basic?.fullName,
		basic?.individualName,
		basic?.firmName,
		basic?.iaFirmName,
		row?.organizationName,
		row?.companyName,
		row?.doingBusinessAs,
		row?.dba,
		row?.employerName,
		row?.entityName,
		personName,
		basicPersonName,
	);

	if (label && !looksLikeGenericEntityLabel(label)) {
		return entity === 'firm' ? formatFirmName(label) : formatPersonName(label);
	}
	if (crd) return `${entity === 'firm' ? 'Firm' : 'Individual'} CRD #${crd}`;
	if (typeof indexFallback === 'number') return `${entity === 'firm' ? 'Firm' : 'Individual'} ${indexFallback + 1}`;
	return entity === 'firm' ? 'Firm' : 'Individual';
}

function formatAddress(value: unknown): string {
	if (!value) return '';
	if (typeof value === 'string') return value.trim();
	if (typeof value !== 'object' || Array.isArray(value)) return '';
	const address = value as Record<string, unknown>;
	const preferredKeys = ['address1', 'address2', 'address3', 'street1', 'street2', 'city', 'state', 'postalCode', 'zipCode', 'zip', 'country'];
	const parts: string[] = [];
	for (const key of preferredKeys) {
		const text = toText(address[key]);
		if (text) parts.push(text);
	}
	if (parts.length > 0) return parts.join(', ');
	return Object.values(address)
		.map((v) => toText(v))
		.filter(Boolean)
		.join(', ');
}

function extractCurrentBranchOfficeAddress(body: Record<string, any>): string {
	const employments = [...toArray(body?.currentEmployments), ...toArray(body?.currentIAEmployments), ...toArray(body?.currentEmployment)];
	for (const employment of employments) {
		const branches = toArray(employment?.branchOfficeLocations);
		const located = branches.find((b) => toText(b?.locatedAtFlag).toUpperCase() === 'Y') || branches[0];
		if (located) {
			const address = formatAddress(located);
			if (address) return address;
		}
	}
	return '';
}

function collectOtherNames(...lists: unknown[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const list of lists) {
		for (const item of toArray(list)) {
			const value = toText(item);
			if (!value) continue;
			const normalized = value.toLowerCase();
			if (seen.has(normalized)) continue;
			seen.add(normalized);
			out.push(value);
		}
	}
	return out;
}

function humanizeKey(key: string): string {
	if (/\s/.test(key)) return key;
	return key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
}

function isEmptyRawValue(value: unknown): boolean {
	if (value === null || value === undefined) return true;
	if (typeof value === 'string') return value.trim() === '';
	if (Array.isArray(value)) return value.length === 0;
	if (typeof value === 'object') return Object.keys(value as Record<string, unknown>).length === 0;
	return false;
}

function stringifyRawValue(value: unknown): string {
	if (typeof value === 'string') return value;
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	if (Array.isArray(value)) {
		if (!value.length) return '';
		if (value.every((v) => ['string', 'number', 'boolean'].includes(typeof v))) {
			return value.map((v) => String(v)).join(', ');
		}
		return JSON.stringify(value, null, 2);
	}
	if (value && typeof value === 'object') {
		return JSON.stringify(value, null, 2);
	}
	return '';
}

const DETAIL_SKIP_KEYS = new Set([
	'basicInformation',
	'firmAddressDetails',
	'iaFirmAddressDetails',
	'disclosures',
	'directOwners',
	'registrationStatus',
	'registeredSROs',
	'registeredStates',
	'registrations',
	'currentConnections',
	'previousConnections',
	'currentEmployments',
	'currentIAEmployments',
	'currentEmployment',
	'previousEmployments',
	'previousIAEmployments',
	'otherNames',
	'aliases',
	'stateExamCategory',
	'productExamCategory',
	'principalExamCategory',
	'stateExams',
	'productExams',
	'principalExams',
	'exams',
	'crs',
	'brochures',
	'noticeFilings',
	'secDocumentLinks',
	'bdDisclosureFlag',
	'iaDisclosureFlag',
]);

const HIDDEN_DETAIL_LABELS = new Set(['Exams Count', 'Registration Count', 'Broker Details', 'Has Finra Data', 'Has Sec Data']);

function shouldHideDetailLabel(label: string) {
	return HIDDEN_DETAIL_LABELS.has(label);
}

const LOCAL_HISTORY_KEY = 'finra_dashboard_history';
// Keep the local history indefinitely. Using a very large numeric sentinel so
// existing slice(0, LOCAL_HISTORY_MAX) calls keep all entries.
const LOCAL_HISTORY_MAX = Number.POSITIVE_INFINITY;

type LocalHistoryEntry = {
	id: string;
	entity: 'individual' | 'firm';
	sources: QueueCardSourceEntry[];
	fetchedAt: string;
	name?: string;
	visitCount?: number;
	lastVisitedAt?: string;
};

type SelectionLogEntry = { id: string; label: string; secondaryId: string; group: string };

type NewCrdEntry = {
	id: string;
	type: string;
	found: string;
	scopes: string[];
	date: string;
	name?: string | null;
	fullName?: string | null;
	firstName?: string | null;
	lastName?: string | null;
	firmName?: string | null;
	legalName?: string | null;
};

type SavedTemplate = {
	id: string;
	name: string;
	queries: string;
};

function extractDisplayNameFromNewCrd(entry: NewCrdEntry, entity: 'individual' | 'firm') {
	const combinedPersonName = [toText(entry.firstName), toText(entry.lastName)].filter(Boolean).join(' ').trim();
	const rawName = pickFirstNonEmpty(entry.name, entry.fullName, entry.firmName, entry.legalName, combinedPersonName);
	if (rawName) return rawName;
	return entity === 'firm' ? `Firm ${entry.id}` : `Individual ${entry.id}`;
}

function getQueueCardSources(card: QueueCard): { hasFinra: boolean; hasSec: boolean } {
	const sources = (card.sources || []).map((s) => String(s.source).toLowerCase());
	const hasFinra = sources.includes('finra');
	const hasSec = sources.includes('sec');
	if (!hasFinra && !hasSec) {
		return { hasFinra: true, hasSec: false };
	}
	return { hasFinra, hasSec };
}

function getNewCrdSources(entry: NewCrdEntry, entity: 'individual' | 'firm', localHistory?: LocalHistoryEntry[]): { hasFinra: boolean; hasSec: boolean } {
	const scopes = (entry.scopes || []).map((s) => String(s).toLowerCase());
	const typeStr = String(entry.type || '').toLowerCase();
	let hasFinra = scopes.includes('finra') || scopes.includes('bc') || typeStr.includes('finra');
	let hasSec = scopes.includes('sec') || scopes.includes('ia') || typeStr.includes('sec');

	if (localHistory) {
		const hist = localHistory.find((h) => h.id === entry.id && h.entity === entity);
		if (hist && Array.isArray(hist.sources)) {
			const histSources = hist.sources.map((s) => String(s.source).toLowerCase());
			if (histSources.includes('finra')) hasFinra = true;
			if (histSources.includes('sec')) hasSec = true;
		}
	}

	if (!hasFinra && !hasSec) {
		hasFinra = true;
	}
	return { hasFinra, hasSec };
}

function formatMainPanelTitle(options: { source: SearchResultSource; entity: 'individual' | 'firm'; id: string; name?: string | null; payload?: unknown }) {
	const sourceLabel = String(options.source).toUpperCase();
	const titleName = toText(options.name) || getRecordDisplayName(options.payload, options.entity, options.id);
	if (titleName) return titleName;
	return `${options.entity === 'firm' ? 'Firm' : 'Individual'} ${options.id}`;
}

function formatAddressCandidate(value: unknown): string {
	if (!value) return '';
	if (typeof value === 'string') return value.trim();
	if (typeof value !== 'object' || Array.isArray(value)) return '';
	const address = value as Record<string, any>;
	const parts = [address.address1, address.address2, address.street1, address.street2, address.city, address.state, address.zipCode || address.postalCode, address.country]
		.map((entry) => toText(entry))
		.filter(Boolean);
	return parts.join(', ');
}

function findNestedValueByKey(input: unknown, candidates: string[]): unknown {
	if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
	const record = input as Record<string, unknown>;
	for (const [key, value] of Object.entries(record)) {
		const normalized = String(key).trim().toLowerCase();
		if (candidates.some((candidate) => normalized === candidate.toLowerCase() || normalized.includes(candidate.toLowerCase()))) {
			return coerceStructuredValue(value);
		}
		const nestedValue = coerceStructuredValue(value);
		if (nestedValue && typeof nestedValue === 'object') {
			const nested = findNestedValueByKey(nestedValue, candidates);
			if (nested != null) return nested;
		}
	}
	return null;
}

function extractJurisdictionCards(body: Record<string, any>) {
	const normalizedBody = coerceStructuredValue(body) as Record<string, any> | undefined;
	const source =
		Array.isArray(normalizedBody) ? normalizedBody : (
			findNestedValueByKey(normalizedBody ?? body, ['jurisdictions', 'stateNoticeDetails', 'stateNoticeRecords', 'stateNoticeHistory', 'jurisdiction'])
		);
	const entries =
		Array.isArray(source) ? source
		: source && typeof source === 'object' ? [source]
		: [];
	return entries
		.filter((entry) => entry && typeof entry === 'object')
		.map((entry) => {
			const record = coerceStructuredValue(entry) as Record<string, any> | undefined;
			if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
			const title = pickFirstNonEmpty(record?.jurisdiction, record?.jurisdictionName, record?.name, record?.state);
			const meta = pickFirstNonEmpty(record?.status, record?.noticeStatus, record?.noticeStatusText);
			const subtitle = pickFirstNonEmpty(record?.effectiveDate, record?.effective_date, record?.dateFiled, record?.dateSubmitted, record?.noticeDate);
			return title ? { title, meta, subtitle } : null;
		})
		.filter(Boolean) as Array<{ title: string; meta: string; subtitle: string }>;
}

function extractBrochureCards(body: Record<string, any>) {
	const normalizedBody = coerceStructuredValue(body) as Record<string, any> | undefined;
	const brochureContainer = Array.isArray(normalizedBody) ? normalizedBody : findNestedValueByKey(normalizedBody ?? body, ['brochures', 'brochuredetails', 'brochureDetails']);
	const entries =
		Array.isArray(brochureContainer) ? brochureContainer
		: brochureContainer && typeof brochureContainer === 'object' && Array.isArray((brochureContainer as Record<string, any>).brochuredetails) ?
			(brochureContainer as Record<string, any>).brochuredetails
		:	[];
	return entries
		.filter((entry) => entry && typeof entry === 'object')
		.map((entry) => {
			const record = coerceStructuredValue(entry) as Record<string, any> | undefined;
			if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
			const title = pickFirstNonEmpty(record?.brochureName, record?.name, record?.brochureTitle);
			const meta = pickFirstNonEmpty(record?.brochureVersionID, record?.versionId, record?.version);
			const submitted = pickFirstNonEmpty(record?.dateSubmitted, record?.submittedDate, record?.date);
			const confirmed = pickFirstNonEmpty(record?.lastConfirmed, record?.confirmedDate);
			const subtitleParts = [submitted ? `Submitted: ${submitted}` : '', confirmed ? `Last Confirmed: ${confirmed}` : ''].filter(Boolean);
			const subtitle = subtitleParts.join(' • ');
			return title ? { title, meta: meta ? `ID #${meta}` : '', subtitle } : null;
		})
		.filter(Boolean) as Array<{ title: string; meta: string; subtitle: string }>;
}

export function extractRegistrationCards(body: Record<string, any>) {
	const normalizedBody = coerceStructuredValue(body) as Record<string, any> | undefined;
	const source = Array.isArray(normalizedBody) ? normalizedBody : findNestedValueByKey(normalizedBody ?? body, ['registrations', 'registrationDetails', 'registrationHistory']);
	const entries =
		Array.isArray(source) ? source
		: source && typeof source === 'object' ? [source]
		: [];
	return entries
		.filter((entry) => entry && typeof entry === 'object')
		.map((entry) => {
			const record = coerceStructuredValue(entry) as Record<string, any> | undefined;
			if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
			const title = pickFirstNonEmpty(record?.registrationName, record?.name, record?.title, record?.registrationTitle, record?.seriesName);
			const meta = pickFirstNonEmpty(record?.status, record?.registrationStatus, record?.state, record?.jurisdiction);
			const subtitle = pickFirstNonEmpty(record?.effectiveDate, record?.effectiveDateText, record?.date, record?.registrationDate);
			return title ? { title, meta, subtitle } : null;
		})
		.filter(Boolean) as Array<{ title: string; meta: string; subtitle: string }>;
}

export function extractConnectionCards(body: Record<string, any>, key: 'currentConnections' | 'previousConnections') {
	const normalizedBody = coerceStructuredValue(body) as Record<string, any> | undefined;
	const candidateKeys =
		key === 'currentConnections' ?
			[
				'currentConnections',
				'current_connections',
				'currentConnection',
				'activeConnections',
				'currentAssociatedIndividuals',
				'currentIndividuals',
				'currentConnectedIndividuals',
				'currentRegistrations',
			]
		:	[
				'previousConnections',
				'previous_connections',
				'previousConnection',
				'formerConnections',
				'previousAssociatedIndividuals',
				'previousIndividuals',
				'formerConnectedIndividuals',
				'previousRegistrations',
			];

	let source = Array.isArray(normalizedBody) ? normalizedBody : findNestedValueByKey(normalizedBody ?? body, candidateKeys);

	if (!source) {
		const rawConns = findNestedValueByKey(normalizedBody ?? body, ['connections', 'firmConnections', 'affiliatedFirms', 'associatedIndividuals']);
		if (Array.isArray(rawConns)) {
			if (key === 'currentConnections') {
				source = rawConns.filter(
					(c: any) =>
						c &&
						typeof c === 'object' &&
						c.isCurrent !== false &&
						!c.endDate &&
						!/previous|former|terminated|inactive/i.test(String(c.relationship || c.status || c.position || '')),
				);
			} else {
				source = rawConns.filter(
					(c: any) =>
						c &&
						typeof c === 'object' &&
						(c.isCurrent === false || !!c.endDate || /previous|former|terminated|inactive/i.test(String(c.relationship || c.status || c.position || ''))),
				);
			}
		}
	}

	const entries =
		Array.isArray(source) ? source
		: source && typeof source === 'object' ? [source]
		: [];
	return entries
		.filter((entry) => entry && typeof entry === 'object')
		.map((entry) => {
			const record = coerceStructuredValue(entry) as Record<string, any> | undefined;
			if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
			const crd = pickFirstValidCrd(record?.crdNumber, record?.crd, record?.individualId, record?.personId, record?.firmId, record?.organizationCrd, record?.sourceId);
			const entityType: 'individual' | 'firm' = record?.individualId || record?.personId || record?.firstName || record?.lastName || record?.individualName ? 'individual' : 'firm';
			const title = resolveEntityNodeLabel(record, entityType, crd);
			const meta = pickFirstNonEmpty(record?.relationship, record?.position, record?.title, record?.status, record?.ownershipCode);
			const startDate = pickFirstNonEmpty(record?.effectiveDate, record?.date, record?.startDate, record?.fromDate, record?.registrationBeginDate);
			const endDate = pickFirstNonEmpty(record?.endDate, record?.toDate, record?.registrationEndDate);
			const dateText = startDate && endDate ? `${startDate} - ${endDate}` : pickFirstNonEmpty(startDate, endDate);
			const addressText = pickFirstNonEmpty(
				record?.address,
				formatAddress(record?.officeAddress),
				formatAddress(record?.branchOfficeLocations?.[0]),
				formatAddress(record?.mailingAddress),
				[toText(record?.city), toText(record?.state)].filter(Boolean).join(', '),
			);
			const subtitle = [dateText, addressText].filter(Boolean).join(' • ');
			const result: { title: string; meta: string; subtitle: string; crd?: string; entity?: 'individual' | 'firm' } = {
				title: title || '',
				meta: meta || '',
				subtitle: subtitle || '',
			};
			if (crd) {
				result.crd = crd;
				result.entity = entityType;
			}
			return title ? result : null;
		})
		.filter(Boolean) as Array<{ title: string; meta: string; subtitle: string; crd?: string; entity?: 'individual' | 'firm' }>;
}

function extractDocumentLinkCards(body: Record<string, any>) {
	const normalizedBody = coerceStructuredValue(body) as Record<string, any> | undefined;
	const source = Array.isArray(normalizedBody) ? normalizedBody : findNestedValueByKey(normalizedBody ?? body, ['secDocumentLinks', 'documentLinks', 'secLinks', 'links']);
	const entries = Array.isArray(source) ? source : [];
	return entries
		.filter((entry) => entry && typeof entry === 'object')
		.map((entry) => {
			const record = coerceStructuredValue(entry) as Record<string, any> | undefined;
			if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
			const title = pickFirstNonEmpty(record?.label, record?.title, record?.name);
			const href = pickFirstNonEmpty(record?.href, record?.url, record?.link);
			return title && href ? { title, href } : null;
		})
		.filter(Boolean) as Array<{ title: string; href: string }>;
}

export function extractNoticeFilingsCards(body: Record<string, any>) {
	const normalizedBody = coerceStructuredValue(body) as Record<string, any> | undefined;
	const source =
		Array.isArray(normalizedBody) ? normalizedBody : findNestedValueByKey(normalizedBody ?? body, ['noticeFilings', 'noticeFiling', 'noticeFilingsDetails', 'noticeFilingDetails']);
	const entries =
		Array.isArray(source) ? source
		: source && typeof source === 'object' ? [source]
		: [];
	return entries
		.filter((entry) => entry && typeof entry === 'object')
		.map((entry) => {
			const record = coerceStructuredValue(entry) as Record<string, any> | undefined;
			if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
			const title = pickFirstNonEmpty(record?.jurisdiction, record?.state, record?.name);
			const meta = pickFirstNonEmpty(record?.status, record?.noticeStatus, record?.registrationStatus);
			const subtitle = pickFirstNonEmpty(record?.effectiveDate, record?.effectiveDateText, record?.effective, record?.date, record?.noticeDate);
			const detail = pickFirstNonEmpty(record?.description, record?.details, record?.summary);
			return title ? { title, meta, subtitle, detail } : null;
		})
		.filter(Boolean) as Array<{ title: string; meta: string; subtitle: string; detail: string }>;
}

function extractSearchResultAddress(item: SearchResult): string {
	const directAddress = pickFirstNonEmpty(
		formatAddressCandidate(item?.businessAddress),
		formatAddressCandidate(item?.officeAddress),
		formatAddressCandidate(item?.mailingAddress),
		formatAddressCandidate(item?.address),
		[toText(item?.city), toText(item?.state)].filter(Boolean).join(', '),
	);
	if (directAddress) return directAddress;

	const employments = [
		...(Array.isArray(item?.ind_current_employments) ? item.ind_current_employments : []),
		...(Array.isArray(item?.ind_ia_current_employments) ? item.ind_ia_current_employments : []),
		...(Array.isArray(item?.currentEmployments) ? item.currentEmployments : []),
		...(Array.isArray(item?.currentIAEmployments) ? item.currentIAEmployments : []),
	];

	for (const row of employments) {
		const address = pickFirstNonEmpty(
			formatAddressCandidate(row?.branchOfficeLocations?.[0]),
			formatAddressCandidate(row),
			[toText(row?.city), toText(row?.state)].filter(Boolean).join(', '),
		);
		if (address) return address;
	}

	return '';
}

function extractSearchResultDetail(item: SearchResult): string {
	return pickFirstNonEmpty(item?.bcScope, item?.iaScope, item?.status, item?.registrationStatus, item?.firm_bc_scope, item?.firm_ia_scope);
}

function OrphanProfileLinks({ parentCrd, parentType = 'firm' }: { parentCrd: string; parentType?: 'individual' | 'firm' }) {
	const [status, setStatus] = useState<{ finra: boolean; sec: boolean } | null>(null);
	const isParentIndividual = parentType === 'individual';

	useEffect(() => {
		let active = true;
		setStatus(null);
		fetch(isParentIndividual ? `/api/finra/individual/${parentCrd}` : `/api/finra/firm/${parentCrd}`)
			.then((res) => res.json())
			.then((data) => {
				if (active && data && typeof data === 'object') {
					setStatus({
						finra: Boolean(data.hasFinraData),
						sec: Boolean(data.hasSecData),
					});
				}
			})
			.catch(() => {
				if (active) setStatus({ finra: true, sec: true }); // Fallback
			});
		return () => {
			active = false;
		};
	}, [parentCrd, isParentIndividual]);

	if (!status) return <div style={{ fontSize: '13px', color: '#64748b' }}>Validating parent {isParentIndividual ? 'individual' : 'firm'} sources...</div>;

	if (!status.finra && !status.sec) return <div style={{ fontSize: '13px', color: '#64748b' }}>No external parent links available.</div>;

	return (
		<div className={styles.profileLinksRow}>
			{status.finra && (
				<a
					href={`https://brokercheck.finra.org/${isParentIndividual ? 'individual' : 'firm'}/summary/${parentCrd}`}
					target='_blank'
					rel='noopener noreferrer'
					className={styles.profileLinkBtn}>
					Parent {isParentIndividual ? 'individual' : 'firm'} FINRA profile ↗
				</a>
			)}
			{status.sec && (
				<a
					href={`https://adviserinfo.sec.gov/${isParentIndividual ? 'individual' : 'firm'}/summary/${parentCrd}`}
					target='_blank'
					rel='noopener noreferrer'
					className={styles.profileLinkBtn}>
					Parent {isParentIndividual ? 'individual' : 'firm'} SEC profile ↗
				</a>
			)}
		</div>
	);
}

function DashboardPageInner() {
	const pathname = usePathname();
	const searchParams = useSearchParams();
	const [crdInput, setCrdInput] = useState('');
	const [externalRawDir, setExternalRawDir] = useState('/home/lenny/Dev/webDev/Data-finra-sec/data/raw');
	const [busyAction, setBusyAction] = useState<DashboardAction | null>(null);
	const [result, setResult] = useState<ApiResponse | null>(null);
	const [mainJson, setMainJson] = useState<Record<string, any> | null>(null);
	const [mainJsonLabel, setMainJsonLabel] = useState('');
	const [recordViewLoading, setRecordViewLoading] = useState(false);
	const [currentRecordSource, setCurrentRecordSource] = useState<'finra' | 'sec' | null>(null);
	const [currentRecordEntity, setCurrentRecordEntity] = useState<'individual' | 'firm' | null>(null);
	const [currentRecordId, setCurrentRecordId] = useState<string | null>(null);
	const [newCrds, setNewCrds] = useState<NewCrdEntry[]>([]);
	const [searchQuery, setSearchQuery] = useState('');
	const [searchBusy, setSearchBusy] = useState(false);
	const [searchError, setSearchError] = useState<string | null>(null);
	const [searchResults, setSearchResults] = useState<SearchResultCard[]>([]);
	const [searchSkippedCount, setSearchSkippedCount] = useState(0);
	const [hasSearchRun, setHasSearchRun] = useState(false);
	const [crawlProgress, setCrawlProgress] = useState<{
		active: boolean;
		current: number;
		total: number;
		query: string;
		ok: number;
		new: number;
		updated: number;
		err: number;
	} | null>(null);
	const [queueElapsedSec, setQueueElapsedSec] = useState(0);
	const [terminalLogs, setTerminalLogs] = useState<{ id: string; text: string; type: 'info' | 'error' | 'warn' | 'success' }[]>([]);
	const [queueCards, setQueueCards] = useState<QueueCard[]>([]);
	const [queueCrdFilter, setQueueCrdFilter] = useState('');
	const [submittedQueueQueries, setSubmittedQueueQueries] = useState<string[]>([]);
	const [queueRunItems, setQueueRunItems] = useState<QueueRunItem[]>([]);
	const [queueMetaStats, setQueueMetaStats] = useState<{
		shownCount: number;
		totalCount: number;
		totalCacheKeys: number;
		filteredTotalCount?: number;
		sourceMode?: string;
		persistenceNotice?: string | null;
		inventoryTotals?: { people: number; firms: number; unique: number; source?: string };
	}>({
		shownCount: 0,
		totalCount: 0,
		totalCacheKeys: 0,
	});
	const [syncBannerText, setSyncBannerText] = useState<string | null>(null);
	const [activeCardSourceKey, setActiveCardSourceKey] = useState<string | null>(null);
	const [rightPaneCollapsed, setRightPaneCollapsed] = useState(false);
	const [jsonRenderBusy, setJsonRenderBusy] = useState(false);
	const [codeBlock, setCodeBlock] = useState('');
	const [jsonTree, setJsonTree] = useState<any>(null);
	const [recordUpdatedAt, setRecordUpdatedAt] = useState<string | null>(null);
	const [mainViewMode, setMainViewMode] = useState<'card' | 'json'>('card');
	const [top10Latest, setTop10Latest] = useState<Array<{ id: string; entity: 'individual' | 'firm'; fetchedAt: string; files?: number; sources?: QueueCardSourceEntry[] }>>([]);
	const [sessionHasFetched, setSessionHasFetched] = useState(false);
	const [localHistory, setLocalHistory] = useState<LocalHistoryEntry[]>([]);
	const [graphClickHistory, setGraphClickHistory] = useState<SelectionLogEntry[]>([]);
	const [isSelectionHistoryOpen, setIsSelectionHistoryOpen] = useState(true);
	const [isGraphClickHistoryOpen, setIsGraphClickHistoryOpen] = useState(true);
	const [newCrdsOpen, setNewCrdsOpen] = useState(true);
	const [savedTemplates, setSavedTemplates] = useState<SavedTemplate[]>([]);
	const [isSavingTemplate, setIsSavingTemplate] = useState(false);
	const [newTemplateName, setNewTemplateName] = useState('');
	const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null);
	const [editTemplateName, setEditTemplateName] = useState('');
	const [editTemplateQueries, setEditTemplateQueries] = useState('');

	const mergedDetailCacheRef = useRef(new Map<string, any>());
	const jsonStringCacheRef = useRef(new Map<string, string>());
	const activeLoadSourceKeyRef = useRef<string | null>(null);
	const jsonRenderInFlightKeyRef = useRef<string | null>(null);
	const refreshInFlightByCrdRef = useRef(new Map<string, Promise<any>>());
	const [connectionsLoadingFirmId, setConnectionsLoadingFirmId] = useState<string | null>(null);
	const connectionsInFlightByCrdRef = useRef(new Map<string, Promise<any>>());
	// The URL-driven auto-load effect below must only react to *external* navigation (initial
	// deep link / hard refresh, or a real browser back-forward). If it also reacted every time
	// `usePathname()` recomputes after our own syncSelectionToUrl() call (used to keep the URL
	// bar in sync with in-app clicks), it creates an infinite feedback loop: loading record A
	// writes the URL, which re-triggers the effect for a stale selection pointing back at record
	// B, which writes the URL again, alternating forever and freezing the tab. These refs let the
	// effect distinguish "real" navigation from its own echo.
	const initialRouteLoadDoneRef = useRef(false);
	const lastHandledPopNonceRef = useRef(0);
	const [popNonce, setPopNonce] = useState(0);

	useEffect(() => {
		const handlePopState = () => setPopNonce((n) => n + 1);
		window.addEventListener('popstate', handlePopState);
		return () => window.removeEventListener('popstate', handlePopState);
	}, []);

	const queueQueries = useMemo(() => parseQueueQueries(crdInput), [crdInput]);
	const parsedCrds = useMemo(() => queueQueries.filter((value) => /^\d{1,10}$/.test(value)), [queueQueries]);
	const queueQueryLines = useMemo(() => submittedQueueQueries, [submittedQueueQueries]);
	const visibleQueueCount = queueQueryLines.length;

	const routeSelection = useMemo(() => {
		if (!pathname) return null;
		const query = searchParams?.toString();
		const url = `http://localhost${pathname}${query ? `?${query}` : ''}`;
		return parseDashboardSelectionFromUrl(url);
	}, [pathname, searchParams]);

	const routeSelectionEntityIdKey = useMemo(() => {
		if (!routeSelection) return '';
		return `${routeSelection.entity}:${routeSelection.id}`;
	}, [routeSelection?.entity, routeSelection?.id]);

	const graphHref = useMemo(() => {
		const selectedHref = buildGraphHrefForEntity(currentRecordEntity, currentRecordId);
		if (selectedHref) return selectedHref;
		const routeHref = buildGraphHrefForEntity(routeSelection?.entity, routeSelection?.id);
		if (routeHref) return routeHref;
		const historyHref = getLatestGraphHrefFromHistory(localHistory);
		if (historyHref) return historyHref;
		return '/';
	}, [currentRecordEntity, currentRecordId, routeSelection, localHistory]);

	const handleGraphBackClick = useCallback(
		(event: MouseEvent<HTMLAnchorElement>) => {
			if (typeof window === 'undefined') return;
			event.preventDefault();
			window.location.assign(graphHref || '/');
		},
		[graphHref],
	);

	async function loadNewCrdsFromRedis() {
		try {
			const res = await fetch('/api/dashboard/refresh', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ action: 'list-new-crds' }),
			});
			const data = await res.json().catch(() => null);
			if (data?.ok) {
				setNewCrds(Array.isArray(data.newCrds) ? data.newCrds : []);
			}
		} catch (err) {
			console.error('Failed to load new CRDs:', err);
		}
	}

	const queueStatusLine = useMemo(() => {
		if (busyAction === 'fetch-crds') {
			const current = crawlProgress?.current ?? 1;
			const total = crawlProgress?.total ?? visibleQueueCount;
			return `Searching | Queue | queue ${current}/${Math.max(1, total)} | elapsed ${queueElapsedSec}s`;
		}
		if (sessionHasFetched) {
			return `Finished | queue - | elapsed ${queueElapsedSec}s`;
		}
		return 'Idle | - | queue - | elapsed 0s';
	}, [busyAction, crawlProgress?.current, crawlProgress?.total, visibleQueueCount, queueElapsedSec, sessionHasFetched]);

	useEffect(() => {
		if (busyAction !== 'fetch-crds') return;

		const timer = window.setInterval(() => {
			setQueueElapsedSec((current) => current + 1);
		}, 1000);

		return () => {
			window.clearInterval(timer);
		};
	}, [busyAction]);

	const handleSaveTemplate = () => {
		setIsSavingTemplate(true);
		setNewTemplateName(`Template ${savedTemplates.length + 1}`);
	};

	const handleConfirmSaveTemplate = () => {
		const name = newTemplateName.trim() || `Template ${savedTemplates.length + 1}`;
		const queries = crdInput.trim();
		if (!queries) return;

		const newTemplate: SavedTemplate = {
			id: `${Date.now()}`,
			name,
			queries,
		};
		const updated = [...savedTemplates, newTemplate];
		setSavedTemplates(updated);
		localStorage.setItem('finra_dashboard_templates', JSON.stringify(updated));
		setIsSavingTemplate(false);
		setNewTemplateName('');
	};

	const handleDeleteTemplate = (id: string) => {
		const updated = savedTemplates.filter((t) => t.id !== id);
		setSavedTemplates(updated);
		localStorage.setItem('finra_dashboard_templates', JSON.stringify(updated));
		if (editingTemplateId === id) {
			setEditingTemplateId(null);
		}
	};

	const handleStartEditTemplate = (tpl: SavedTemplate) => {
		setEditingTemplateId(tpl.id);
		setEditTemplateName(tpl.name);
		setEditTemplateQueries(tpl.queries);
	};

	const handleSaveEditTemplate = (id: string) => {
		const name = editTemplateName.trim() || `Template`;
		const queries = editTemplateQueries.trim();
		if (!queries) return;

		const updated = savedTemplates.map((t) => {
			if (t.id === id) {
				return { ...t, name, queries };
			}
			return t;
		});
		setSavedTemplates(updated);
		localStorage.setItem('finra_dashboard_templates', JSON.stringify(updated));
		setEditingTemplateId(null);
	};

	// Load recent CRDs on mount
	useEffect(() => {
		try {
			const raw = localStorage.getItem(LOCAL_HISTORY_KEY);
			if (raw) {
				setLocalHistory(JSON.parse(raw) as LocalHistoryEntry[]);
			}
		} catch (err) {
			console.error('Failed to load local history:', err);
		}

		try {
			const templatesRaw = localStorage.getItem('finra_dashboard_templates');
			if (templatesRaw) {
				setSavedTemplates(JSON.parse(templatesRaw) as SavedTemplate[]);
			}
		} catch (err) {
			console.error('Failed to load saved templates:', err);
		}

		try {
			const rawGraphLog = localStorage.getItem('finra_selection_log');
			if (rawGraphLog) {
				setGraphClickHistory(JSON.parse(rawGraphLog) as SelectionLogEntry[]);
			}
		} catch (err) {
			console.error('Failed to load graph selection log:', err);
		}

		void loadNewCrdsFromRedis();
	}, []);

	useEffect(() => {
		const intervalId = window.setInterval(() => {
			void loadNewCrdsFromRedis();
		}, 15000);

		return () => window.clearInterval(intervalId);
	}, []);

	const hasCurrentRecord = Boolean(mainJson || result || recordViewLoading);

	useEffect(() => {
		const payload = mainJson || result;
		if (!payload) {
			jsonRenderInFlightKeyRef.current = null;
			setCodeBlock('');
			setJsonTree(null);
			setJsonRenderBusy(false);
			return;
		}

		const cacheKey = mainJson ? `main:${mainJsonLabel}` : `result:${String((result as any)?.ok)}:${String((result as any)?.error || '')}`;
		const cached = jsonStringCacheRef.current.get(cacheKey);
		if (cached != null) {
			jsonRenderInFlightKeyRef.current = null;
			setCodeBlock(cached);
			setJsonRenderBusy(false);
			return;
		}

		if (jsonRenderInFlightKeyRef.current === cacheKey) {
			return;
		}
		jsonRenderInFlightKeyRef.current = cacheKey;

		setJsonRenderBusy(true);
		let cancelled = false;

		const compute = () => {
			if (cancelled) return;
			try {
				const text = renderJsonForDisplay(payload);
				const tree = buildJsonDisplayTree(normalizeRenderablePayload(payload));
				jsonStringCacheRef.current.set(cacheKey, text);
				if (!cancelled) {
					setCodeBlock(text);
					setJsonTree(tree);
				}
			} catch (error: any) {
				if (!cancelled) {
					setCodeBlock(String(error?.message || error || 'Failed to render JSON'));
					setJsonTree(null);
				}
			} finally {
				if (!cancelled) {
					jsonRenderInFlightKeyRef.current = null;
					setJsonRenderBusy(false);
				}
			}
		};

		if (typeof window !== 'undefined' && typeof (window as any).requestIdleCallback === 'function') {
			const idleId = (window as any).requestIdleCallback(compute, { timeout: 180 });
			return () => {
				cancelled = true;
				if (jsonRenderInFlightKeyRef.current === cacheKey) {
					jsonRenderInFlightKeyRef.current = null;
				}
				if (typeof (window as any).cancelIdleCallback === 'function') {
					(window as any).cancelIdleCallback(idleId);
				}
			};
		}

		const timeoutId = window.setTimeout(compute, 0);
		return () => {
			cancelled = true;
			if (jsonRenderInFlightKeyRef.current === cacheKey) {
				jsonRenderInFlightKeyRef.current = null;
			}
			window.clearTimeout(timeoutId);
		};
	}, [mainJson, result, mainJsonLabel]);

	useEffect(() => {
		if (!routeSelection || !routeSelectionEntityIdKey) return;

		const isAlreadySelectedEntity = currentRecordId === routeSelection.id && currentRecordEntity === routeSelection.entity;
		if (isAlreadySelectedEntity) {
			initialRouteLoadDoneRef.current = true;
			return;
		}

		// Only auto-load from the URL on the initial deep link / hard refresh, or in response to
		// a genuine browser back/forward navigation (popNonce change). Any other recomputation of
		// routeSelection is just this effect observing its own syncSelectionToUrl() write and must
		// be ignored, or in-app CRD clicks would fight with this effect forever (see comment near
		// initialRouteLoadDoneRef above).
		const isDeepLinkBootstrap = !initialRouteLoadDoneRef.current;
		const isRealPopNavigation = popNonce !== lastHandledPopNonceRef.current;
		if (!isDeepLinkBootstrap && !isRealPopNavigation) return;
		lastHandledPopNonceRef.current = popNonce;
		initialRouteLoadDoneRef.current = true;

		const activeLoadKey = activeLoadSourceKeyRef.current;
		if (activeLoadKey && activeLoadKey.startsWith(`${routeSelection.entity}:${routeSelection.id}:`)) return;

		const card: QueueCard = {
			id: routeSelection.id,
			entity: routeSelection.entity,
			files: Math.max(1, routeSelection.availableSources?.length || 1),
			sources: (routeSelection.availableSources || [routeSelection.source]).map((source) => ({
				source,
				status: 'unknown',
			})),
		};

		void loadQueueSourceJson(card, routeSelection.source);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [routeSelectionEntityIdKey, routeSelection?.source, currentRecordId, currentRecordEntity, popNonce]);

	const searchSummary = useMemo(() => {
		if (!searchQuery.trim()) return 'Search saved records by name';
		if (searchBusy) return 'Searching Redis...';
		if (searchError) return searchError;
		if (!searchResults.length) return 'No Redis results yet';
		if (searchSkippedCount > 0) {
			return `${searchResults.length} Redis result${searchResults.length === 1 ? '' : 's'} found • ${searchSkippedCount} skipped (missing CRD or corrupt)`;
		}
		return `${searchResults.length} Redis result${searchResults.length === 1 ? '' : 's'} found`;
	}, [searchBusy, searchError, searchQuery, searchResults.length, searchSkippedCount]);

	const searchPaneOpen = useMemo(() => {
		return searchBusy || Boolean(searchError) || hasSearchRun;
	}, [searchBusy, searchError, hasSearchRun]);

	const queueMetaText = useMemo(() => {
		const shown = Number(queueMetaStats.shownCount || queueCards.length || 0);
		const total = Number(queueMetaStats.totalCount || shown);
		const filteredTotal = Number(queueMetaStats.filteredTotalCount || shown);
		const filterSuffix = queueCrdFilter.trim().length > 0 ? ` Filtered: ${filteredTotal.toLocaleString()} matched.${filteredTotal === 0 ? ' (No cached match yet)' : ''}` : '';
		return `Showing recent results from ${shown.toLocaleString()} loaded records (${total.toLocaleString()} total cached records).${filterSuffix}`;
	}, [queueCards.length, queueMetaStats, queueCrdFilter]);

	const persistenceNotice = useMemo(() => {
		if (queueMetaStats.persistenceNotice) return queueMetaStats.persistenceNotice;
		if (queueMetaStats.sourceMode === 'local-fallback') {
			return 'Durable Redis persistence is unavailable here, so recent fetches may be temporary and not reload as saved cache cards.';
		}
		return null;
	}, [queueMetaStats.persistenceNotice, queueMetaStats.sourceMode]);

	const uniqueCrdCounts = useMemo(() => {
		if (queueMetaStats.inventoryTotals) {
			const cached = (queueMetaStats.inventoryTotals as any).cachedCrdCount || 0;
			const cachedParsed = cached && cached !== 'Not Found' && cached !== 'Error' ? parseInt(cached, 10) : NaN;
			return {
				individuals: queueMetaStats.inventoryTotals.people,
				firms: queueMetaStats.inventoryTotals.firms,
				total: !isNaN(cachedParsed) ? cachedParsed : queueMetaStats.inventoryTotals.unique,
				cachedCrdCount: cached,
			};
		}

		const individuals = new Set<string>();
		const firms = new Set<string>();
		queueCards.forEach((card) => {
			if (card.entity === 'individual') {
				individuals.add(card.id);
			} else if (card.entity === 'firm') {
				firms.add(card.id);
			}
		});
		return {
			individuals: individuals.size,
			firms: firms.size,
			total: individuals.size + firms.size,
			cachedCrdCount: undefined as string | number | undefined,
		};
	}, [queueCards, queueMetaStats.inventoryTotals]);

	const hasInventorySummary = useMemo(() => {
		return queueMetaStats.totalCount > 0 || queueMetaStats.totalCacheKeys > 0 || localHistory.length > 0 || uniqueCrdCounts.individuals > 0 || uniqueCrdCounts.firms > 0;
	}, [localHistory.length, queueMetaStats.totalCacheKeys, queueMetaStats.totalCount, uniqueCrdCounts.firms, uniqueCrdCounts.individuals]);

	const historyNameMap = useMemo(() => {
		const map = new Map<string, string>();
		for (const entry of localHistory) {
			if (!entry.name) continue;
			map.set(`${entry.entity}:${entry.id}`, entry.name);
		}
		return map;
	}, [localHistory]);

	const peopleCrdEntries = useMemo(() => {
		return newCrds
			.filter((item) => inferEntityTypeFromNewCrd(item) === 'individual')
			.sort((left, right) => Number(right.id) - Number(left.id))
			.slice(0, 20);
	}, [newCrds]);

	const firmCrdEntries = useMemo(() => {
		return newCrds
			.filter((item) => inferEntityTypeFromNewCrd(item) === 'firm')
			.sort((left, right) => Number(right.id) - Number(left.id))
			.slice(0, 20);
	}, [newCrds]);

	const orphanRecord = useMemo(() => {
		if (!mainJson || typeof mainJson !== 'object') return null;
		const obj = mainJson as any;
		if (obj.orphan && typeof obj.orphan === 'object') return obj.orphan;
		return null;
	}, [mainJson]);

	const detailedMainRecord = useMemo(() => {
		if (!mainJson || !currentRecordEntity || !currentRecordId) return null;

		const content = unwrapRecordPayload(mainJson);
		if (!content || typeof content !== 'object') return null;
		const body = content as Record<string, any>;
		const basic = body.basicInformation && typeof body.basicInformation === 'object' ? body.basicInformation : {};

		const mainAddress =
			formatAddress(body.iaFirmAddressDetails?.officeAddress) ||
			formatAddress(body.firmAddressDetails?.officeAddress) ||
			extractCurrentBranchOfficeAddress(body) ||
			formatAddress(body.address);
		const otherNames = collectOtherNames(basic.otherNames, body.otherNames, basic.aliases, body.aliases);

		const sortEmployment = (arr: any[]) => {
			return arr.sort((a, b) => {
				const getSortDate = (row: any) => {
					const d = pickFirstNonEmpty(row.registrationBeginDate, row.effectiveDate, row.startDate);
					return d ? new Date(d).getTime() : 0;
				};
				return getSortDate(b) - getSortDate(a);
			});
		};

		const currentEmployment = sortEmployment([...toArray(body.currentEmployments), ...toArray(body.currentIAEmployments), ...toArray(body.currentEmployment)]);
		const previousEmployment = sortEmployment([...toArray(body.previousEmployments), ...toArray(body.previousIAEmployments)]);
		const registrationCards = extractRegistrationCards(body);
		const currentConnectionCards = extractConnectionCards(body, 'currentConnections');
		const previousConnectionCards = extractConnectionCards(body, 'previousConnections');

		const stateExams = toArray(body.stateExamCategory).concat(toArray(body.stateExams));
		const productExams = toArray(body.productExamCategory).concat(toArray(body.productExams));
		const principalExams = toArray(body.principalExamCategory).concat(toArray(body.principalExams));

		const registrations = body.registrations && typeof body.registrations === 'object' ? body.registrations : {};
		const registeredSros = Array.from(
			new Set(
				toArray(body.registeredSROs)
					.map((row: any) => String(row?.sro || '').trim())
					.filter(Boolean),
			),
		).sort((a, b) => a.localeCompare(b));

		const additionalDetails: Array<{ label: string; value: string }> = [];
		for (const [key, value] of Object.entries(basic)) {
			if (isEmptyRawValue(value)) continue;
			if (key === 'otherNames' || key === 'aliases') continue;
			const rendered = stringifyRawValue(value);
			if (!rendered) continue;
			const label = humanizeKey(key);
			if (shouldHideDetailLabel(label)) continue;
			additionalDetails.push({ label, value: rendered });
		}
		for (const [key, value] of Object.entries(body)) {
			if (DETAIL_SKIP_KEYS.has(key) || isEmptyRawValue(value)) continue;
			const rendered = stringifyRawValue(value);
			if (!rendered) continue;
			const label = humanizeKey(key);
			if (shouldHideDetailLabel(label)) continue;
			additionalDetails.push({ label, value: rendered });
		}

		const mainObj = typeof mainJson === 'object' && mainJson !== null ? (mainJson as any) : {};
		const showFinra =
			mainObj.hasFinraData === true ? true
			: mainObj.hasFinraData === false ? false
			: currentRecordEntity === 'individual' ? hasIndividualSourceCoverage(body, 'finra')
			: hasFirmSourceCoverage(body, 'finra');
		const showSec =
			mainObj.hasSecData === true ? true
			: mainObj.hasSecData === false ? false
			: currentRecordEntity === 'individual' ? hasIndividualSourceCoverage(body, 'sec')
			: hasFirmSourceCoverage(body, 'sec');

		const profileLinks = [];
		if (showFinra) {
			profileLinks.push({
				label: 'FINRA profile ↗',
				href: `https://brokercheck.finra.org/${currentRecordEntity === 'firm' ? 'firm' : 'individual'}/summary/${currentRecordId}`,
			});
			if (currentRecordEntity === 'individual') {
				profileLinks.push({
					label: 'FINRA Detailed Report (PDF) ↗',
					href: `https://files.brokercheck.finra.org/individual/individual_${currentRecordId}.pdf`,
				});
			}
		}
		if (showSec) {
			profileLinks.push({
				label: 'SEC profile ↗',
				href: `https://adviserinfo.sec.gov/${currentRecordEntity === 'firm' ? 'firm' : 'individual'}/summary/${currentRecordId}`,
			});
		}

		const jurisdictionCards = extractJurisdictionCards(body);
		const brochureCards = extractBrochureCards(body);
		const documentLinkCards = extractDocumentLinkCards(body);
		const noticeFilingCards = extractNoticeFilingsCards(body);

		const crs = body.crs && typeof body.crs === 'object' ? body.crs : null;
		const bdDisclosureFlag = pickFirstNonEmpty(body.bdDisclosureFlag, body.bd_disclosure_flag, basic.bdDisclosureFlag);
		const iaDisclosureFlag = pickFirstNonEmpty(body.iaDisclosureFlag, body.ia_disclosure_flag, basic.iaDisclosureFlag);
		const brochuresPart2Exempt = pickFirstNonEmpty(body.brochures?.part2ExemptFlag, body.part2ExemptFlag);

		const bcScope = pickFirstNonEmpty(basic.bcScope, body.bcScope, basic.brokerCheckScope, body.brokerCheckScope, body.bc_scope);
		const iaScope = pickFirstNonEmpty(basic.iaScope, body.iaScope, basic.secScope, body.secScope, body.ia_scope);
		const finraActive =
			!showFinra ? ''
			: bcScope ? `FINRA: ${bcScope}`
			: 'FINRA: Active';
		const secActive =
			!showSec ? ''
			: iaScope ? `SEC: ${iaScope}`
			: 'SEC: Active';
		const subtitle = otherNames.length > 0 && currentRecordEntity === 'individual' ? otherNames[0] : '';

		const directOwners = toArray(body.directOwners).concat(toArray(body.directOwnersExecutiveOfficers));
		const indirectOwners = toArray(body.indirectOwners);

		return {
			name:
				pickFirstNonEmpty(basic.iaFirmName, basic.firmName, basic.fullName, basic.individualName) ||
				extractEntityDetailFromPayload(content, currentRecordEntity, currentRecordId)?.name ||
				`${currentRecordEntity === 'firm' ? 'Firm' : 'Individual'} ${currentRecordId}`,
			subtitle,
			hasFinraData: showFinra,
			hasSecData: showSec,
			finraActive,
			secActive,
			mainAddress,
			otherNames,
			profileLinks,
			currentEmployment,
			previousEmployment,
			registrationCards,
			currentConnectionCards,
			previousConnectionCards,
			stateExams,
			productExams,
			principalExams,
			registrations,
			registeredSros,
			additionalDetails,
			jurisdictionCards,
			brochureCards,
			documentLinkCards,
			noticeFilingCards,
			crs,
			bdDisclosureFlag,
			iaDisclosureFlag,
			brochuresPart2Exempt,
			directOwners,
			indirectOwners,
		};
	}, [mainJson, currentRecordEntity, currentRecordId]);

	const additionalDetailsSourceLabel = useMemo(() => {
		if (!mainJson || typeof mainJson !== 'object') {
			return currentRecordSource ? String(currentRecordSource).toUpperCase() : '';
		}

		const payload = mainJson as Record<string, any>;
		const hasFinraData = payload.hasFinraData === true;
		const hasSecData = payload.hasSecData === true;

		if (!hasFinraData && hasSecData) return 'SEC';
		if (hasFinraData && !hasSecData) return 'FINRA';

		return currentRecordSource ? String(currentRecordSource).toUpperCase() : '';
	}, [mainJson, currentRecordSource]);

	const displayCards = useMemo<QueueCard[]>(() => {
		const token = queueCrdFilter.trim();
		const tokens =
			token ?
				token
					.split(/[\s,;]+/g)
					.map((v) => v.trim())
					.filter(Boolean)
			:	[];
		const filtered = tokens.length ? localHistory.filter((e) => tokens.some((t) => e.id === t || e.id.includes(t))) : localHistory;
		return filtered
			.slice()
			.sort((a, b) => new Date(b.fetchedAt).getTime() - new Date(a.fetchedAt).getTime())
			.slice(0, 15)
			.map((e) => ({
				id: e.id,
				entity: e.entity,
				files: e.sources.length,
				sources: e.sources,
				name: e.name ?? null,
				kind: 'recent' as const,
				since: new Date(e.fetchedAt).toLocaleString(),
			}));
	}, [localHistory, queueCrdFilter]);

	const filteredNewCrds = useMemo(() => {
		const token = queueCrdFilter.trim();
		if (!token) return [] as Array<(typeof newCrds)[number]>;
		const tokens = token
			.split(/[\s,;]+/g)
			.map((value) => value.trim())
			.filter(Boolean);
		return newCrds.filter((item) => tokens.some((value) => item.id === value || item.id.includes(value)));
	}, [newCrds, queueCrdFilter]);

	function markRecordUpdatedAt(value?: unknown) {
		const raw = typeof value === 'string' ? value.trim() : '';
		if (raw) {
			setRecordUpdatedAt(raw);
			return;
		}
		setRecordUpdatedAt(new Date().toISOString());
	}

	function extractValidCrd(item: SearchResult, entity: 'individual' | 'firm') {
		const candidateKeys =
			entity === 'individual' ?
				['individualId', 'individual_id', 'crd', 'ind_crd', 'ind_source_id', 'sourceId', 'id']
			:	['firmId', 'firm_id', 'crd', 'firm_crd', 'firm_source_id', 'bdSecNumber', 'iaSecNumber', 'sourceId', 'id'];

		for (const key of candidateKeys) {
			const raw = item?.[key];
			if (raw == null) continue;
			const value = String(raw).trim();
			if (/^\d{1,10}$/.test(value)) return value;
		}

		return '';
	}

	function isCorruptSearchItem(item: unknown) {
		if (!item || typeof item !== 'object' || Array.isArray(item)) return true;
		const obj = item as SearchResult;
		const hasSignalField = [
			obj.individualId,
			obj.firmId,
			obj.crd,
			obj.ind_crd,
			obj.firm_crd,
			obj.ind_source_id,
			obj.firm_source_id,
			obj.name,
			obj.fullName,
			obj.firmName,
			obj.status,
		].some((value) => value != null && String(value).trim().length > 0);
		return !hasSignalField;
	}

	function recordHistoryEntry({
		id,
		entity,
		source,
		sources,
		name,
	}: {
		id: string;
		entity: 'individual' | 'firm';
		source?: SearchResultSource;
		sources?: SearchResultSource[];
		name?: string;
	}) {
		if (typeof window === 'undefined') return;
		const now = new Date().toISOString();
		const incomingName = toText(name);
		const incomingSources: SearchResultSource[] =
			sources && sources.length > 0 ? sources
			: source ? [source]
			: ['finra'];
		setLocalHistory((prev) => {
			const nextEntries = prev.filter((entry) => !(entry.entity === entity && entry.id === id));
			const existing = prev.find((entry) => entry.entity === entity && entry.id === id);
			const existingName = toText(existing?.name);
			const resolvedName =
				incomingName && !looksLikeGenericEntityLabel(incomingName) ? incomingName
				: existingName && !looksLikeGenericEntityLabel(existingName) ? existingName
				: incomingName || existingName || undefined;

			const updatedEntry: LocalHistoryEntry = {
				id,
				entity,
				// Replace rather than merge: incomingSources reflects freshly-validated coverage,
				// so stale/incorrect source tags from earlier visits must not persist.
				sources: incomingSources.map((src) => ({ source: src, status: 'ok' as const })),
				fetchedAt: existing?.fetchedAt || now,
				name: resolvedName,
				visitCount: (existing?.visitCount || 0) + 1,
				lastVisitedAt: now,
			};

			const combined = [updatedEntry, ...nextEntries].slice(0, LOCAL_HISTORY_MAX);
			try {
				localStorage.setItem(LOCAL_HISTORY_KEY, JSON.stringify(combined));
			} catch {
				// ignore persistence errors
			}
			return combined;
		});
	}

	async function setMainViewFromSearch(card: SearchResultCard) {
		const orderedSources: SearchResultSource[] = card.source === 'sec' ? ['sec', 'finra'] : ['finra', 'sec'];
		await loadQueueSourceJson(
			{
				id: card.id,
				entity: card.entity,
				files: orderedSources.length,
				sources: orderedSources.map((source) => ({ source, status: 'unknown' })),
				name: card.label || null,
			},
			card.source,
		);
	}

	async function openHistoryEntry(entry: LocalHistoryEntry) {
		const primarySource = entry.sources.find((item) => item.source === 'finra')?.source || entry.sources[0]?.source || 'finra';
		await loadQueueSourceJson(
			{
				id: entry.id,
				entity: entry.entity,
				files: entry.sources.length,
				sources: entry.sources,
				name: entry.name ?? null,
			},
			primarySource,
		);
	}

	function clearSelectionHistory() {
		setLocalHistory([]);
		if (typeof window !== 'undefined') {
			try {
				localStorage.removeItem(LOCAL_HISTORY_KEY);
			} catch {
				// ignore localStorage errors
			}
		}
	}

	async function openQueueCard(card: QueueCard) {
		const preferredSource = card.sources.find((entry) => entry.source === 'finra')?.source || card.sources[0]?.source || 'finra';
		await loadQueueSourceJson(card, preferredSource);
	}

	async function openNewCrdEntry(entry: NewCrdEntry) {
		const entity: 'individual' | 'firm' = inferEntityTypeFromNewCrd(entry);
		const historyMatch = localHistory.find((item) => item.entity === entity && item.id === entry.id);
		if (historyMatch) {
			await openHistoryEntry(historyMatch);
			return;
		}

		const sources: QueueCardSourceEntry[] = [];
		const scopeText = (entry.scopes || []).join(' ').toLowerCase();
		if (scopeText.includes('finra') || scopeText.includes('bc')) sources.push({ source: 'finra', status: 'unknown' });
		if (scopeText.includes('sec') || scopeText.includes('ia')) sources.push({ source: 'sec', status: 'unknown' });
		// If scopes didn't declare any source (unexpected), default to attempting FINRA first;
		// the real tags are recomputed from validated payload coverage after fetch, not from this guess.
		if (sources.length === 0) sources.push({ source: 'finra', status: 'unknown' });

		await loadQueueSourceJson(
			{
				id: entry.id,
				entity,
				files: sources.length,
				sources,
				name: historyNameMap.get(`${entity}:${entry.id}`) || extractDisplayNameFromNewCrd(entry, entity),
			},
			sources[0].source,
		);
	}

	function syncSelectionToUrl({ entity, id, source, availableSources = [source] }: UrlSelectionInput) {
		if (typeof window === 'undefined') return;
		const normalizedId = normalizeCrd(id);
		if (!normalizedId) return;

		const recordId = normalizedId;

		const nextPath = `/dashboard/${entity}/${encodeURIComponent(recordId)}`;
		window.history.replaceState({}, '', nextPath);
	}

	function isSelectedCardSource(card: QueueCard, source: SearchResultSource) {
		return currentRecordId === card.id && currentRecordEntity === card.entity && currentRecordSource === source;
	}

	function handleInternalDashboardLinkClick(event: MouseEvent<HTMLElement>) {
		const target = event.target as HTMLElement | null;
		const anchor = target?.closest?.('a[href]') as HTMLAnchorElement | null;
		if (!anchor) return;

		const rawHref = String(anchor.getAttribute('href') || '').trim();
		if (!rawHref) return;

		let hrefForParsing = rawHref;
		try {
			if (typeof window !== 'undefined') {
				const resolved = new URL(rawHref, window.location.origin);
				if (!resolved.pathname.startsWith('/dashboard/')) return;
				hrefForParsing = `${resolved.pathname}${resolved.search}${resolved.hash}`;
			} else if (!rawHref.startsWith('/dashboard/')) {
				return;
			}
		} catch {
			if (!rawHref.startsWith('/dashboard/')) return;
		}

		const parsed = parseDashboardSelectionFromUrl(`http://localhost${hrefForParsing}`);
		if (!parsed) return;

		event.preventDefault();
		event.stopPropagation();

		const orderedSources: SearchResultSource[] = parsed.source === 'sec' ? ['sec', 'finra'] : ['finra', 'sec'];

		const card: QueueCard = {
			id: parsed.id,
			entity: parsed.entity,
			files: orderedSources.length,
			sources: orderedSources.map((source) => ({ source, status: 'unknown' })),
		};

		void loadQueueSourceJson(card, parsed.source);
	}

	function extractPayloadFromDetail(detail: any, source: SearchResultSource) {
		if (!detail || typeof detail !== 'object') return null;

		const hasOrphan = Boolean(detail?.orphan && typeof detail.orphan === 'object');
		const candidate =
			source === 'finra' ?
				(detail?.sources?.finra?.bccontent ?? detail?.sources?.finra?.content ?? detail?.sources?.finra ?? detail?.finraNode ?? detail?.merged ?? detail?.bccontent ?? null)
			:	(detail?.sources?.sec?.iacontent ?? detail?.sources?.sec?.content ?? detail?.sources?.sec ?? detail?.finraNode ?? detail?.merged ?? detail?.iacontent ?? null);

		const candidateHasRealData =
			candidate &&
			typeof candidate === 'object' &&
			candidate.found !== false &&
			(Boolean(candidate.basicInformation) ||
				Boolean(candidate.content) ||
				Boolean(candidate.iacontent) ||
				Boolean(candidate.hits) ||
				Boolean(candidate.individualId) ||
				Boolean(candidate.firmId) ||
				Boolean(candidate.firstName) ||
				Boolean(candidate.lastName) ||
				Boolean(candidate.legalName) ||
				Boolean(candidate.firmName));

		if (candidateHasRealData) {
			return candidate;
		}

		if (hasOrphan) {
			return detail;
		}

		if (candidate && candidate.found !== false) return candidate;
		return null;
	}

	function resolveOrderedSourcesFromDetail(detail: any, requestedSource: SearchResultSource, declaredSources: SearchResultSource[]): SearchResultSource[] {
		const base = [requestedSource, ...declaredSources].filter((entry, index, arr) => (entry === 'finra' || entry === 'sec') && arr.indexOf(entry) === index);
		const hasFinraData = detail?.hasFinraData === true || Boolean(detail?.sources?.finra) || Boolean(detail?.finraNode?.bccontent || detail?.bccontent);
		const hasSecData = detail?.hasSecData === true || Boolean(detail?.sources?.sec) || Boolean(detail?.finraNode?.iacontent || detail?.iacontent);

		if (!hasFinraData && hasSecData) return ['sec', 'finra'];
		if (hasFinraData && !hasSecData) return ['finra', 'sec'];
		return base.length > 0 ? base : ['finra', 'sec'];
	}

	async function loadInventoryOnlyFromRedis() {
		try {
			const response = await fetch('/api/dashboard/refresh', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'list-cache-cards', maxCards: 1, crdFilter: '' }),
			});
			const payload = await response.json().catch(() => null);
			if (payload?.inventoryTotals) {
				setQueueMetaStats((current) => ({ ...current, inventoryTotals: payload.inventoryTotals }));
			}
		} catch {
			// ignore on mount
		}
	}

	async function loadQueueCardsFromRedis(filter = '') {
		try {
			const response = await fetch('/api/dashboard/refresh', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					action: 'list-cache-cards',
					maxCards: filter.trim() ? 200 : 20,
					crdFilter: filter,
				}),
			});

			const payload = await response.json().catch(() => null);
			if (payload?.ok === false) {
				setQueueCards([]);
				setQueueMetaStats({ shownCount: 0, totalCount: 0, totalCacheKeys: 0, filteredTotalCount: 0, persistenceNotice: null });
				return;
			}

			const cards = Array.isArray(payload?.cards) ? payload.cards : [];
			setQueueCards((current) => {
				const sourceMode = String(payload?.sourceMode || '');
				if (cards.length === 0 && sourceMode === 'local-fallback' && current.length > 0) {
					return current;
				}
				return cards as QueueCard[];
			});
			setQueueMetaStats({
				shownCount: Number(payload?.shownCount || cards.length || 0),
				totalCount: Number(payload?.totalCount || cards.length || 0),
				totalCacheKeys: Number(payload?.totalCacheKeys || 0),
				...(payload?.filteredTotalCount != null ? { filteredTotalCount: Number(payload.filteredTotalCount || 0) } : {}),
				...(payload?.sourceMode ? { sourceMode: String(payload.sourceMode) } : {}),
				...(payload?.persistenceNotice !== undefined ? { persistenceNotice: payload.persistenceNotice ? String(payload.persistenceNotice) : null } : {}),
				...(payload?.inventoryTotals ? { inventoryTotals: payload.inventoryTotals } : {}),
			});
		} catch {
			// keep existing cards on load errors
		}
	}

	useEffect(() => {
		void loadInventoryOnlyFromRedis();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	useEffect(() => {
		if (!sessionHasFetched && !queueCrdFilter.trim()) return;

		void loadQueueCardsFromRedis(queueCrdFilter);

		const intervalId = setInterval(() => {
			void loadQueueCardsFromRedis(queueCrdFilter);
		}, 15000);

		return () => clearInterval(intervalId);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [queueCrdFilter, sessionHasFetched]);

	function addCardsToLocalHistory(results: any[]) {
		if (typeof window === 'undefined') return;
		const now = new Date().toISOString();
		const map = new Map<string, LocalHistoryEntry>();

		for (const r of results) {
			if (r?.status !== 'ok') continue;
			if (!r?.newRecordSaved && !r?.newSourceSaved) continue;
			const id = String(r?.crd || '').trim();
			const entity: 'individual' | 'firm' = String(r?.type || '').toLowerCase() === 'firm' ? 'firm' : 'individual';
			const source = String(r?.source || '').toLowerCase() as SearchResultSource;
			if (!/^\d{1,10}$/.test(id)) continue;
			if (source !== 'finra' && source !== 'sec') continue;

			const key = `${entity}:${id}`;
			const existing = map.get(key) ?? { id, entity, sources: [], fetchedAt: now };
			const srcIdx = existing.sources.findIndex((s) => s.source === source);
			const srcEntry: QueueCardSourceEntry = { source, status: 'ok' };
			if (srcIdx >= 0) existing.sources[srcIdx] = srcEntry;
			else existing.sources.push(srcEntry);
			// Keep the first non-empty name we find across sources
			if (!existing.name && r?.name) existing.name = String(r.name).trim() || undefined;
			map.set(key, existing);
		}

		if (!map.size) return;

		setLocalHistory((prev) => {
			const newEntries = Array.from(map.values());
			const prevFiltered = prev.filter((e) => !map.has(`${e.entity}:${e.id}`));
			const combined = [...newEntries, ...prevFiltered].slice(0, LOCAL_HISTORY_MAX);
			try {
				localStorage.setItem(LOCAL_HISTORY_KEY, JSON.stringify(combined));
			} catch {
				/* ignore */
			}
			return combined;
		});
	}

	async function fetchMergedDetail(card: QueueCard) {
		const cacheKey = `${card.entity}:${card.id}`;
		const cached = mergedDetailCacheRef.current.get(cacheKey);
		if (cached) return cached;

		const route = card.entity === 'firm' ? `/api/finra/firm/${card.id}?merged=1&includeConnections=1` : `/api/finra/individual/${card.id}?merged=1&includePrevious=true`;
		try {
			const response = await fetch(route, {
				method: 'GET',
				headers: { Accept: 'application/json' },
				cache: 'default',
			});
			if (!response.ok) {
				return { found: false, error: `HTTP ${response.status}` };
			}
			const detail = await response.json();
			if (detail && typeof detail === 'object') {
				mergedDetailCacheRef.current.set(cacheKey, detail);
			}
			return detail;
		} catch (err: any) {
			return { found: false, error: err?.message || String(err) };
		}
	}

	async function fetchFallbackDetail(card: QueueCard) {
		const route = card.entity === 'firm' ? `/api/finra/firm/${card.id}?merged=1&includeConnections=1` : `/api/finra/individual/${card.id}?merged=1&includePrevious=true`;

		const response = await fetch(route, {
			method: 'GET',
			headers: { Accept: 'application/json' },
			cache: 'default',
		});

		return response.json();
	}

	function applyFirmConnectionsToState(firmId: string, currentConnections: any[], previousConnections: any[]) {
		const cacheKey = `firm:${firmId}`;
		const cached = mergedDetailCacheRef.current.get(cacheKey);
		if (cached && typeof cached === 'object') {
			for (const target of [cached, cached?.merged, cached?.sources?.finra, cached?.sources?.sec, cached?.finraNode]) {
				if (target && typeof target === 'object') {
					target.currentConnections = currentConnections;
					target.previousConnections = previousConnections;
				}
			}
		}

		setMainJson((prev) => {
			if (!prev) return prev;
			const prevCrd = String(prev?.basicInformation?.firmId || prev?.firmId || prev?.id || '').trim();
			if (prevCrd && prevCrd !== firmId) return prev;
			return {
				...prev,
				currentConnections,
				previousConnections,
			};
		});
	}

	function connectionsFromExpandPayload(firmId: string, data: any): { currentConnections: any[]; previousConnections: any[] } | null {
		if (!data || typeof data !== 'object') return null;
		const nodes = Array.isArray(data.nodes) ? data.nodes : [];
		const links = Array.isArray(data.links) ? data.links : [];
		if (!links.length) return null;

		const nodeById = new Map<string, any>(nodes.map((node: any) => [String(node?.id || ''), node]));
		const firmNodeId = `firm:${firmId}`;
		const currentConnections: any[] = [];
		const previousConnections: any[] = [];
		const seen = new Set<string>();

		for (const link of links) {
			const relationship = String(link?.relationship || '').trim();
			// dashboard-crds uses relationship: 'employment'; this app uses employed_by / previous_employed_by / controls.
			const isEmployment = relationship === 'employment' || relationship === 'employed_by' || relationship === 'previous_employed_by';
			const isControl = relationship === 'controls' || relationship === 'ownership' || relationship === 'owner';
			if (!isEmployment && !isControl) continue;

			const sourceId = String(link?.source?.id ?? link?.source ?? '').trim();
			const targetId = String(link?.target?.id ?? link?.target ?? '').trim();
			if (sourceId !== firmNodeId && targetId !== firmNodeId) continue;
			const otherId = sourceId === firmNodeId ? targetId : sourceId;
			const person = nodeById.get(otherId) || {};
			const crd = String(person?.crd || otherId.replace(/^(?:person|individual)[:_]/, '')).trim();
			if (!crd || !/^\d{1,10}$/.test(crd)) continue;

			const isCurrent =
				isControl ? true
				: relationship === 'previous_employed_by' ? false
				: link?.isCurrent !== undefined ? Boolean(link.isCurrent)
				: !String(link?.endDate || link?.registrationEndDate || '').trim();

			const dedupeKey = `${crd}:${isCurrent}`;
			if (seen.has(dedupeKey)) continue;
			seen.add(dedupeKey);

			const entry = {
				individualId: crd,
				name: String(person?.label || person?.name || `Person ${crd}`).trim(),
				relationship:
					isControl ? 'Control'
					: isCurrent ? 'Current registration'
					: 'Previous registration',
				startDate: link?.startDate || link?.registrationBeginDate || undefined,
				endDate: isCurrent ? undefined : link?.endDate || link?.registrationEndDate || undefined,
				isCurrent,
			};
			(isCurrent ? currentConnections : previousConnections).push(entry);
		}

		if (!currentConnections.length && !previousConnections.length) return null;
		return { currentConnections, previousConnections };
	}

	async function loadFirmConnections(firmId: string) {
		const existingPromise = connectionsInFlightByCrdRef.current.get(firmId);
		if (existingPromise) return existingPromise;

		const fetchPromise = (async () => {
			try {
				// Prefer expand (same path dashboard-crds uses for firm employee lists). It is
				// cached/CDN-friendly there and avoids the slow cold primed-bundle decode that
				// makes /connections 504 on Vercel when adj keys are missing.
				try {
					const expandRes = await fetch(`/api/finra/expand/${encodeURIComponent(`firm:${firmId}`)}?hops=1`, {
						method: 'GET',
						headers: { Accept: 'application/json' },
						cache: 'default',
					});
					if (expandRes.ok) {
						const expandData = await expandRes.json().catch(() => null);
						const fromExpand = connectionsFromExpandPayload(firmId, expandData);
						if (fromExpand) {
							applyFirmConnectionsToState(firmId, fromExpand.currentConnections, fromExpand.previousConnections);
							return { found: true, firmId, ...fromExpand, source: 'expand' };
						}
					}
				} catch (expandErr) {
					console.warn('Firm expand connections fallback failed', expandErr);
				}

				const response = await fetch(`/api/finra/firm/${encodeURIComponent(firmId)}/connections`, {
					method: 'GET',
					headers: { Accept: 'application/json' },
					cache: 'default',
				});
				if (!response.ok) return null;
				const data = await response.json().catch(() => null);
				if (!data || !data.found) return null;

				const { currentConnections = [], previousConnections = [] } = data;
				applyFirmConnectionsToState(firmId, currentConnections, previousConnections);
				return data;
			} catch (err) {
				console.warn('Failed to lazy load firm connections', err);
				return null;
			} finally {
				connectionsInFlightByCrdRef.current.delete(firmId);
				setConnectionsLoadingFirmId((current) => (current === firmId ? null : current));
			}
		})();

		connectionsInFlightByCrdRef.current.set(firmId, fetchPromise);
		return fetchPromise;
	}

	async function refreshSingleCardRecord(card: QueueCard) {
		const refreshKey = `${card.entity}:${card.id}`;
		const existing = refreshInFlightByCrdRef.current.get(refreshKey);
		if (existing) {
			return existing;
		}

		const refreshPromise = (async () => {
			const response = await fetch('/api/dashboard/refresh', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					action: 'fetch-crds',
					queries: [card.id],
					crds: [card.id],
					maxCrds: 1,
					includePayload: true,
				}),
			});

			return response.json().catch(() => null);
		})();

		refreshInFlightByCrdRef.current.set(refreshKey, refreshPromise);
		try {
			return await refreshPromise;
		} finally {
			refreshInFlightByCrdRef.current.delete(refreshKey);
		}
	}

	async function loadQueueSourceJson(card: QueueCard, source: SearchResultSource) {
		const sourceKey = `${card.entity}:${card.id}:${source}`;
		if (activeLoadSourceKeyRef.current === sourceKey) return;
		activeLoadSourceKeyRef.current = sourceKey;
		setActiveCardSourceKey(sourceKey);
		setRecordViewLoading(true);
		setMainJson(null);
		setResult(null);
		setJsonTree(null);
		setCodeBlock('');
		try {
			let orderedSources: SearchResultSource[] = [source, ...card.sources.map((entry) => entry.source).filter((candidate) => candidate !== source)];
			const cacheKey = `${card.entity}:${card.id}`;

			let payload: any = null;
			let resolvedSource: SearchResultSource = source;

			const mergedDetail = await fetchMergedDetail(card);
			orderedSources = resolveOrderedSourcesFromDetail(mergedDetail, source, orderedSources);
			for (const candidateSource of orderedSources) {
				payload = extractPayloadFromDetail(mergedDetail, candidateSource);
				if (payload) {
					resolvedSource = candidateSource;
					break;
				}
			}

			if (!payload) {
				const mergedFound = mergedDetail?.found === true;
				const mergedHasAnySource = Boolean(mergedDetail?.sources?.finra || mergedDetail?.sources?.sec || mergedDetail?.finraNode || mergedDetail?.merged);
				if (mergedFound || mergedHasAnySource) {
					const fallbackDetail = await fetchFallbackDetail(card);
					mergedDetailCacheRef.current.set(cacheKey, fallbackDetail);
					orderedSources = resolveOrderedSourcesFromDetail(fallbackDetail, source, orderedSources);
					for (const candidateSource of orderedSources) {
						payload = extractPayloadFromDetail(fallbackDetail, candidateSource);
						if (payload) {
							resolvedSource = candidateSource;
							break;
						}
					}
				}

				if (!payload) {
					const refreshPayload = await refreshSingleCardRecord(card);
					const refreshedItems = Array.isArray(refreshPayload?.results) ? refreshPayload.results : [];
					if (refreshedItems.length > 0) {
						mergedDetailCacheRef.current.delete(cacheKey);
						const refreshedDetail = await fetchMergedDetail(card);
						orderedSources = resolveOrderedSourcesFromDetail(refreshedDetail, source, orderedSources);
						for (const candidateSource of orderedSources) {
							payload = extractPayloadFromDetail(refreshedDetail, candidateSource);
							if (payload) {
								resolvedSource = candidateSource;
								break;
							}
						}
					}
				}
			}

			if (!payload) {
				setMainJson(null);
				setMainJsonLabel(`${source}:${card.entity}:${card.id}`);
				setCurrentRecordSource(source);
				setCurrentRecordEntity(card.entity);
				setCurrentRecordId(card.id);
				setResult({
					ok: false,
					error: `No ${String(source).toUpperCase()} payload found for ${card.entity} ${card.id} after merged/fallback lookup and auto-refresh retry.`,
				});
				return;
			}

			if (payload && typeof payload === 'object') {
				const payloadHasFinra = payload?.hasFinraData === true;
				const payloadHasSec = payload?.hasSecData === true;
				if (!payloadHasFinra && payloadHasSec) {
					resolvedSource = 'sec';
				} else if (payloadHasFinra && !payloadHasSec) {
					resolvedSource = 'finra';
				}
			}

			const detectedSourcesSet = new Set<SearchResultSource>();
			if (
				mergedDetail?.hasFinraData === true ||
				payload?.hasFinraData === true ||
				(card.entity === 'individual' ? hasIndividualSourceCoverage(payload, 'finra') : hasFirmSourceCoverage(payload, 'finra'))
			) {
				detectedSourcesSet.add('finra');
			}
			if (
				mergedDetail?.hasSecData === true ||
				payload?.hasSecData === true ||
				(card.entity === 'individual' ? hasIndividualSourceCoverage(payload, 'sec') : hasFirmSourceCoverage(payload, 'sec'))
			) {
				detectedSourcesSet.add('sec');
			}
			const isOrphanPayload = Boolean(payload?.orphan && typeof payload.orphan === 'object');
			// Fall back to the resolved source only when neither coverage check found a real association,
			// and this is not an orphan record, so at least one tag is shown instead of leaving normal cards blank.
			if (!isOrphanPayload && detectedSourcesSet.size === 0 && resolvedSource) detectedSourcesSet.add(resolvedSource);
			const detectedSources = Array.from(detectedSourcesSet);

			setMainJson(normalizePayloadForCleanView(payload) as Record<string, any>);
			setCurrentRecordSource(resolvedSource);
			setCurrentRecordEntity(card.entity);
			setCurrentRecordId(card.id);

			const hasExistingConnections =
				(Array.isArray(payload?.currentConnections) && payload.currentConnections.length > 0) ||
				(Array.isArray(payload?.previousConnections) && payload.previousConnections.length > 0);

			if (card.entity === 'firm' && !hasExistingConnections) {
				setConnectionsLoadingFirmId(card.id);
				void loadFirmConnections(card.id);
			} else {
				setConnectionsLoadingFirmId(null);
			}

			const detailName = extractEntityDetailFromPayload(payload, card.entity, card.id)?.name;
			const computedDisplayName = getRecordDisplayName(payload as Record<string, unknown>, card.entity, card.id);
			const resolvedRecordName =
				toText(card.name) ||
				(toText(detailName) && !looksLikeGenericEntityLabel(detailName) ? toText(detailName) : '') ||
				(toText(computedDisplayName) && !looksLikeGenericEntityLabel(computedDisplayName) ? toText(computedDisplayName) : '') ||
				resolveEntityNodeLabel(payload as Record<string, any>, card.entity, card.id);
			setMainJsonLabel(
				resolveMainRecordTitle({
					mainJsonLabel: formatMainPanelTitle({
						source: resolvedSource,
						entity: card.entity,
						id: card.id,
						name: resolvedRecordName,
						payload,
					}),
					fallbackName: resolvedRecordName || null,
					entity: card.entity,
					id: card.id,
				}),
			);
			markRecordUpdatedAt();
			recordHistoryEntry({
				id: card.id,
				entity: card.entity,
				source: resolvedSource,
				sources: detectedSources,
				name: resolvedRecordName || undefined,
			});
			syncSelectionToUrl({
				entity: card.entity,
				id: card.id,
				source: resolvedSource,
				availableSources: detectedSources.length > 0 ? detectedSources : card.sources.map((entry) => entry.source),
			});
		} catch (error: any) {
			setResult({ ok: false, error: error?.message || String(error) });
		} finally {
			setRecordViewLoading(false);
			setActiveCardSourceKey((current) => (current === sourceKey ? null : current));
			if (activeLoadSourceKeyRef.current === sourceKey) {
				activeLoadSourceKeyRef.current = null;
			}
		}
	}

	async function runAction(action: DashboardAction, overrideQueries?: string[]) {
		setBusyAction(action);
		setResult(null);
		setRecordUpdatedAt(null);
		const startedAt = Date.now();
		const pendingQueries =
			action === 'fetch-crds' ?
				overrideQueries && overrideQueries.length > 0 ?
					overrideQueries
				:	queueQueries
			:	[];
		setSubmittedQueueQueries(pendingQueries);
		setQueueRunItems(buildQueueRunItems(pendingQueries));
		const effectiveQueries = pendingQueries;

		if (action === 'fetch-crds') {
			setSessionHasFetched(true);
			setQueueElapsedSec(0);
			setTerminalLogs([]);

			type LocalQueueItem = { query: string; depth: number };
			const initialQueue: LocalQueueItem[] = effectiveQueries.map((q) => ({ query: q, depth: 0 }));
			const processed = new Set<string>();

			setCrawlProgress({ active: true, current: 0, total: initialQueue.length, query: '', ok: 0, new: 0, updated: 0, err: 0 });

			let totalSuccess = 0;
			let totalError = 0;
			let totalNew = 0;
			let totalUpdated = 0;
			let itemsProcessed = 0;

			const queue = [...initialQueue];

			while (queue.length > 0) {
				const item = queue.shift()!;
				const { query, depth } = item;

				if (processed.has(query)) continue;
				processed.add(query);

				itemsProcessed++;
				setCrawlProgress((p) => (p ? { ...p, current: itemsProcessed, total: itemsProcessed + queue.length, query } : null));

				setQueueRunItems((prev) => prev.map((entry) => (entry.query === query ? { ...entry, status: 'running', elapsedSec: 0 } : entry)));
				setTerminalLogs((prev) => [
					...prev,
					{
						id: createQueueTerminalLogId('start', itemsProcessed, depth),
						text: `>[${itemsProcessed}/${itemsProcessed + queue.length}] Depth ${depth} | Query: "${query}"`,
						type: 'info',
					},
				]);

				try {
					const response = await fetch('/api/dashboard/refresh', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ action: 'fetch-crds', queries: [query], maxCrds: 1, includePayload: true }),
					});
					const payload = await response.json().catch(() => null);
					if (!response.ok || !payload?.ok) throw new Error(payload?.error || `HTTP ${response.status}`);

					setQueueRunItems((prev) => prev.map((entry) => (entry.query === query ? { ...entry, status: 'complete', elapsedSec: 0, message: 'Success' } : entry)));

					const summary = payload.summary || {};
					const results = payload.results || [];
					let qNew = 0,
						qUpd = 0,
						qErr = 0;
					let qNewPeople = 0,
						qNewFirms = 0;

					const newLogs: { id: string; text: string; type: 'info' | 'error' | 'warn' | 'success' }[] = [];

					// Collect best name per CRD across sources
					const nameMap = new Map<string, string>();
					for (const r of results) {
						if (r?.name) {
							const key = `${r.type}:${r.crd}`;
							if (!nameMap.has(key)) nameMap.set(key, String(r.name).trim());
						}
					}

					for (const [resultIndex, r] of results.entries()) {
						let type: 'info' | 'error' | 'warn' | 'success' = 'info';
						const domain = r.source === 'finra' ? 'FINRA' : 'SEC';
						const nameLabel = nameMap.get(`${r.type}:${r.crd}`);
						const label = nameLabel ? `${r.crd} "${nameLabel}"` : r.crd;

						let msg = `  - ${domain} ${r.type} ${label}: `;

						if (r.status === 'error') {
							qErr++;
							type = 'error';
							msg += `Error (${r.error})`;
						} else if (r.status === 'skipped') {
							type = 'warn';
							msg += `Skipped (${r.skipReason})`;
						} else {
							if (r.newRecordSaved) {
								qNew++;
								if (String(r.type).toLowerCase() === 'firm') qNewFirms++;
								else qNewPeople++;
								msg += `Saved (New Record)`;
								type = 'success';
							} else if (r.newSourceSaved) {
								qUpd++;
								msg += `Saved (Updated Source)`;
								type = 'success';
							} else {
								msg += `Unchanged`;
								type = 'info';
							}
						}
						newLogs.push({ id: createQueueTerminalLogId(`result-${String(r.source)}-${String(r.crd)}`, itemsProcessed, resultIndex + 1), text: msg, type });
					}

					setTerminalLogs((prev) => [...prev, ...newLogs]);
					addCardsToLocalHistory(results);

					totalNew += qNew;
					totalUpdated += qUpd;
					totalSuccess += summary.successCount || 0;
					totalError += qErr;

					setCrawlProgress((p) => (p ? { ...p, ok: totalSuccess, new: totalNew, updated: totalUpdated, err: totalError } : null));

					// Recursion logic (Up to 3 levels deep)
					if (depth < 3) {
						const discovered = payload.discovered || [];
						const resolution = payload.resolution || [];

						const uniqueDiscovered = new Set<string>();

						for (const res of resolution) {
							if (Array.isArray(res.crds)) {
								for (const c of res.crds) uniqueDiscovered.add(c);
							}
						}
						for (const dCrd of discovered) {
							uniqueDiscovered.add(dCrd);
						}

						for (const dCrd of uniqueDiscovered) {
							if (!processed.has(dCrd) && !queue.some((qi) => qi.query === dCrd)) {
								// Global safety break to prevent runaway crawls
								if (processed.size < 500) {
									queue.push({ query: dCrd, depth: depth + 1 });
								}
							}
						}
					}

					if (qNew > 0) {
						setQueueMetaStats((current) => {
							const t = current.inventoryTotals ?? { people: 0, firms: 0, unique: 0, source: 'redis' as const };
							return {
								...current,
								inventoryTotals: {
									...t,
									unique: Number(t.unique || 0) + qNew,
									people: Number(t.people || 0) + qNewPeople,
									firms: Number(t.firms || 0) + qNewFirms,
								},
							};
						});
					}

					setTerminalLogs((prev) => [
						...prev,
						{
							id: createQueueTerminalLogId('done', itemsProcessed, depth),
							text: `  -> Query complete: ${qNew} new, ${qUpd} updated, ${qErr} errors`,
							type: qErr > 0 ? 'warn' : 'info',
						},
					]);
				} catch (err: any) {
					totalError++;
					setCrawlProgress((p) => (p ? { ...p, err: totalError } : null));
					const errText = String(err.message || err);
					if (errText.includes('no-valid-crds') || errText.includes('No valid CRDs')) {
						setTerminalLogs((prev) => [...prev, { id: createQueueTerminalLogId('error', itemsProcessed, depth), text: `  -> no valid CRDs`, type: 'warn' }]);
					} else {
						setTerminalLogs((prev) => [...prev, { id: createQueueTerminalLogId('error', itemsProcessed, depth), text: `  -> Request Failed: ${errText}`, type: 'error' }]);
					}
				}
			}

			setCrawlProgress((p) => (p ? { ...p, active: false } : null));
			void loadQueueCardsFromRedis(queueCrdFilter);
			setBusyAction(null);
			setTerminalLogs((prev) => [
				...prev,
				{ id: createQueueTerminalLogId('finish', initialQueue.length, 0), text: `\nFinished. Total OK: ${totalSuccess}, New: ${totalNew}, Err: ${totalError}`, type: 'success' },
			]);
			void loadNewCrdsFromRedis();
			return;
		}

		try {
			const body =
				action === 'list-new-crds' ?
					{
						action,
					}
				:	{
						action,
						externalRawDir,
					};

			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort('dashboard-request-timeout'), 15 * 60 * 1000);

			const response = await fetch('/api/dashboard/refresh', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify(body),
				signal: controller.signal,
			});
			clearTimeout(timeoutId);
			const contentType = response.headers.get('content-type');
			const rawText = await response.text();
			let payload: ApiResponse | null = null;
			if (contentType?.includes('application/json')) {
				payload = JSON.parse(rawText) as ApiResponse;
			}

			if (!response.ok || !payload) {
				throw new Error(
					describeDashboardRequestFailure({
						status: response.status,
						contentType,
						bodyText: rawText,
						elapsedSec: Math.max(0, Math.round((Date.now() - startedAt) / 1000)),
					}),
				);
			}

			if (payload.ok === false) {
				throw new Error(
					describeDashboardRequestFailure({
						status: response.status,
						contentType,
						bodyText: String(payload.error || rawText || ''),
						elapsedSec: Math.max(0, Math.round((Date.now() - startedAt) / 1000)),
					}),
				);
			}
			setResult(payload);
			markRecordUpdatedAt((payload as any)?.at);

			if (action === 'list-new-crds') {
				const newCrdsData = (payload as any)?.newCrds || [];
				setNewCrds(newCrdsData);
			}
		} catch (error: any) {
			setResult({ ok: false, error: error?.message || String(error) });
			markRecordUpdatedAt();
		} finally {
			setBusyAction(null);
		}
	}

	async function runRedisSearch() {
		const query = searchQuery.trim();
		if (!query) {
			setSearchResults([]);
			setSearchError(null);
			setSearchSkippedCount(0);
			setHasSearchRun(false);
			return;
		}

		setHasSearchRun(true);
		setSearchBusy(true);
		setSearchError(null);
		setSearchResults([]);
		setSearchSkippedCount(0);

		try {
			const [finraIndividualRes, finraFirmRes, secIndividualRes, secFirmRes] = await Promise.all([
				fetch(`/api/finra/search?type=individual&query=${encodeURIComponent(query)}&rows=8`),
				fetch(`/api/finra/search?type=firm&query=${encodeURIComponent(query)}&rows=8`),
				fetch(`/api/finra/sec-search?query=${encodeURIComponent(query)}&rows=8`),
				fetch(`/api/finra/sec-search-firm?query=${encodeURIComponent(query)}&rows=8`),
			]);

			const [finraIndividualJson, finraFirmJson, secIndividualJson, secFirmJson] = await Promise.all([
				finraIndividualRes.json(),
				finraFirmRes.json(),
				secIndividualRes.json(),
				secFirmRes.json(),
			]);

			const getItems = (payload: any) =>
				Array.isArray(payload?.results) ? payload.results
				: Array.isArray(payload?.currentPage) ? payload.currentPage
				: Array.isArray(payload?.hits?.hits) ? payload.hits.hits.map((hit: any) => hit?._source ?? hit)
				: [];

			const normalize = (items: SearchResult[], source: SearchResultSource, entity: 'individual' | 'firm') => {
				let skipped = 0;
				const cards: SearchResultCard[] = [];

				for (const item of items) {
					if (isCorruptSearchItem(item)) {
						skipped += 1;
						continue;
					}

					const id = extractValidCrd(item, entity);
					if (!id) {
						skipped += 1;
						continue;
					}

					const rawLabel =
						String(item?.name || item?.fullName || item?.firmName || item?.firstName || item?.lastName || item?.title || '').trim() ||
						`${entity === 'firm' ? 'Firm' : 'Individual'} CRD #${id}`;
					const label = entity === 'firm' ? formatFirmName(rawLabel) : formatPersonName(rawLabel);
					const scope = String(item?.bcScope || item?.iaScope || item?.status || item?.registrationStatus || '').trim();
					const address = extractSearchResultAddress(item);
					const detail = extractSearchResultDetail(item);
					cards.push({ id, label, scope, address, detail, source, entity, payload: item });
				}

				return { cards, skipped };
			};

			const finraIndividuals = normalize(getItems(finraIndividualJson), 'finra', 'individual');
			const finraFirms = normalize(getItems(finraFirmJson), 'finra', 'firm');
			const secIndividuals = normalize(getItems(secIndividualJson), 'sec', 'individual');
			const secFirms = normalize(getItems(secFirmJson), 'sec', 'firm');

			const skippedTotal = finraIndividuals.skipped + finraFirms.skipped + secIndividuals.skipped + secFirms.skipped;
			if (skippedTotal > 0) {
				console.warn('[dashboard] skipped search records due to missing CRD or corrupt payload', {
					query,
					skippedTotal,
				});
			}

			setSearchSkippedCount(skippedTotal);
			setSearchResults([...finraIndividuals.cards, ...finraFirms.cards, ...secIndividuals.cards, ...secFirms.cards]);
		} catch (error: any) {
			setSearchError(error?.message || String(error));
		} finally {
			setSearchBusy(false);
		}
	}

	function renderJsonTree(node: any, depth = 0) {
		if (!node) return null;
		if (node.type === 'primitive') {
			return (
				<div
					className={styles.jsonTreeLeaf}
					style={{ marginLeft: depth * 12 }}>
					{node.key && <span className={styles.jsonTreeKey}>{node.key}</span>}
					<span className={styles.jsonTreeValue}>{node.value}</span>
				</div>
			);
		}

		return (
			<div
				className={styles.jsonTreeGroup}
				style={{ marginLeft: depth * 10 }}>
				{node.key && <div className={styles.jsonTreeGroupHeader}>{node.key}</div>}
				{node.children?.map((child: any, index: number) => (
					<div key={`${child.key || 'child'}-${index}`}>{renderJsonTree(child, depth + 1)}</div>
				))}
			</div>
		);
	}

	function renderSearchResult(card: SearchResultCard, index: number) {
		const sourceLabel = card.source === 'finra' ? 'FINRA' : 'SEC';
		const rowAddress = card.address || card.detail || 'No address/details in cached index';
		const isSelected = currentRecordId === card.id && currentRecordEntity === card.entity;

		return (
			<div
				key={`${card.entity}:${card.id}:${card.source}:${index}`}
				className={`${styles.searchResultCard} ${isSelected ? styles.searchResultCardSelected : ''}`}
				aria-selected={isSelected}>
				<div className={styles.searchResultRow}>
					<span className={styles.searchResultName}>{card.label}</span>
					<span className={styles.searchResultCrd}>CRD #{card.id}</span>
					<span className={styles.searchResultAddress}>{rowAddress}</span>
					<button
						type='button'
						className={styles.searchSourceBtn}
						onClick={() => void setMainViewFromSearch(card)}>
						{sourceLabel}
					</button>
				</div>
			</div>
		);
	}

	return (
		<div className={styles.page}>
			<header className="fg-header">
				<div className="fg-header-bar">
					<div className="fg-header-brand">
						<h1 className="fg-title" style={{ fontSize: '14px' }}>FINRA/SEC</h1>
					</div>
					<div className="fg-header-controls"></div>
					<div className="fg-header-right-controls" style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
						<button
							type='button'
							className={styles.rightPaneToggle}
							onClick={() => setNewCrdsOpen((open) => !open)}
							aria-expanded={newCrdsOpen}>
							{newCrdsOpen ? 'Hide Panel' : 'Show Panel'}
						</button>
						<Link
							href={graphHref}
							onClick={handleGraphBackClick}
							className="fg-ghost-btn"
                            style={{ textDecoration: 'none' }}>
							Graph
						</Link>
					</div>
				</div>
			</header>
			<div className={`${styles.layout} ${!newCrdsOpen ? styles.layoutRightHidden : ''}`}>
				<section className={styles.centerPane}>
					<div className={styles.dashboardMainStack}>
						<div className={styles.dashboardContent}>
							{crawlProgress && crawlProgress.active && (
								<div className={styles.crawlBanner}>
									<div>
										<strong>Sequential Crawl:</strong> {crawlProgress.current} / {crawlProgress.total}
										<span style={{ opacity: 0.7, marginLeft: 8 }}>({crawlProgress.query})</span>
									</div>
									<div className={styles.crawlBannerStats}>
										<span>{crawlProgress.new} new</span>
										<span>{crawlProgress.updated} updated</span>
										<span>{crawlProgress.err} errors</span>
									</div>
								</div>
							)}

							{terminalLogs.length > 0 && (
								<div className={styles.terminalWindow}>
									{[...terminalLogs].reverse().map((log) => (
										<div
											key={log.id}
											className={`${styles.terminalLine} ${styles['terminalLine_' + log.type]}`}>
											{log.text}
										</div>
									))}
								</div>
							)}

							{hasCurrentRecord && (
								<>
									{recordViewLoading ?
										<div className={styles.searchSummary}>
											<VectorLoader
												size='lg'
												label={`Loading ${
													currentRecordEntity ?
														currentRecordEntity === 'firm' ?
															'firm'
														:	'individual'
													:	'record'
												} profile…`}
												sublabel={currentRecordId ? `CRD #${currentRecordId}` : undefined}
											/>
										</div>
									:	<>
											<div className={styles.recordHeaderRow}>
												<span className={`${styles.recordBadge} ${currentRecordEntity === 'firm' ? styles.recordBadgeFirm : styles.recordBadgeIndividual}`}>
													{currentRecordEntity ? String(currentRecordEntity).toUpperCase() : 'UNKNOWN'}
												</span>
												{currentRecordId && <span className={styles.recordBadgeCrd}>CRD {currentRecordId}</span>}
												{detailedMainRecord?.hasFinraData && <span className={styles.tagFinra}>FINRA</span>}
												{detailedMainRecord?.hasSecData && <span className={styles.tagSec}>SEC</span>}
												{detailedMainRecord?.finraActive && <span className={styles.recordBadgeActive}>{detailedMainRecord.finraActive}</span>}
												{detailedMainRecord?.secActive && <span className={styles.recordBadgeActive}>{detailedMainRecord.secActive}</span>}
												<div className={styles.mainViewToggle}>
													<button
														type='button'
														className={`${styles.mainViewToggleBtn} ${mainViewMode === 'card' ? styles.mainViewToggleBtnActive : ''}`}
														onClick={() => setMainViewMode('card')}>
														Info
													</button>
													<button
														type='button'
														className={`${styles.mainViewToggleBtn} ${mainViewMode === 'json' ? styles.mainViewToggleBtnActive : ''}`}
														onClick={() => setMainViewMode('json')}>
														Log
													</button>
												</div>
											</div>
											<h2 className={styles.recordTitle}>
												{orphanRecord ?
													currentRecordEntity === 'firm' ?
														formatFirmName(orphanRecord.firmName || mainJsonLabel)
													:	formatPersonName(orphanRecord.name || mainJsonLabel)
												:	mainJsonLabel}
											</h2>
											{detailedMainRecord?.subtitle && <div className={styles.recordSubtitle}>{detailedMainRecord.subtitle}</div>}
										</>
									}
								</>
							)}

							{syncBannerText && <div className={styles.statusLine}>{syncBannerText}</div>}

							{hasCurrentRecord && !recordViewLoading && mainViewMode === 'json' && (
								<div className={styles.jsonPanel}>
									{jsonRenderBusy && <div className={styles.searchSummary}>Rendering JSON…</div>}
									{jsonTree ?
										<div className={styles.jsonTreeList}>{renderJsonTree(jsonTree)}</div>
									:	<pre>{codeBlock}</pre>}
								</div>
							)}

							{hasCurrentRecord && !recordViewLoading && mainViewMode === 'card' && (
								<div className={styles.readableCardPanel}>
									{orphanRecord ?
										(() => {
											const isFirmOrphan = currentRecordEntity === 'firm';
											const parentType = String(orphanRecord.parentType || (isFirmOrphan ? 'individual' : 'firm')).toLowerCase();
											const parentIsIndividual = parentType === 'individual';
											const parentDashboardHref = `/dashboard/${parentIsIndividual ? 'individual' : 'firm'}/${orphanRecord.parentCrd}`;
											const parentLabel = parentIsIndividual ? 'Individual' : 'Firm';
											return (
												<>
													<div className={styles.detailList}>
														{orphanRecord.officeAddress && (
															<div className={styles.detailTextRow}>
																<strong>Main Address:</strong> {formatAddress(orphanRecord.officeAddress)}
															</div>
														)}
														{orphanRecord.mailingAddress && (
															<div className={styles.detailTextRow}>
																<strong>Mailing:</strong> {formatAddress(orphanRecord.mailingAddress)}
															</div>
														)}
														{orphanRecord.phone && (
															<div className={styles.detailTextRow}>
																<strong>Phone:</strong> {orphanRecord.phone}
															</div>
														)}
													</div>

													<section
														className={styles.detailSection}
														style={{ marginTop: '24px' }}>
														<h4 className={styles.detailSectionTitle}>Profile Links</h4>
														<OrphanProfileLinks
															parentCrd={String(orphanRecord.parentCrd)}
															parentType={parentIsIndividual ? 'individual' : 'firm'}
														/>
													</section>

													<section className={styles.detailSection}>
														<h4 className={styles.detailSectionTitle}>General Information</h4>
														<div className={styles.detailList}>
															{!isFirmOrphan && orphanRecord.name && (
																<div className={styles.detailRow}>
																	<div className={styles.detailTextRow}>
																		<strong>Name:</strong> {formatPersonName(orphanRecord.name)}
																	</div>
																</div>
															)}
															<div className={styles.detailRow}>
																<div className={styles.detailTextRow}>
																	<strong>{isFirmOrphan ? 'Firm' : 'Individual'} CRD:</strong> {currentRecordId}
																</div>
															</div>
															{orphanRecord.position && (
																<div className={styles.detailRow}>
																	<div className={styles.detailTextRow}>
																		<strong>Position:</strong> {orphanRecord.position}
																	</div>
																</div>
															)}
															{!isFirmOrphan && orphanRecord.firmName && (
																<div className={styles.detailRow}>
																	<div className={styles.detailTextRow}>
																		<strong>Affiliated Firm:</strong> {formatFirmName(orphanRecord.firmName)}
																	</div>
																</div>
															)}
															{isFirmOrphan && orphanRecord.name && (
																<div className={styles.detailRow}>
																	<div className={styles.detailTextRow}>
																		<strong>Scraped From:</strong> {formatPersonName(orphanRecord.name)}
																	</div>
																</div>
															)}
															{orphanRecord.parentCrd && (
																<div className={styles.detailRow}>
																	<div className={styles.detailTextRow}>
																		<strong>Parent {parentLabel} CRD:</strong>{' '}
																		<Link
																			href={parentDashboardHref}
																			className={styles.detailInlineTag}>
																			{parentLabel} #{orphanRecord.parentCrd}
																		</Link>
																	</div>
																</div>
															)}
														</div>
													</section>

													{!isFirmOrphan && orphanRecord.firmName && orphanRecord.parentCrd && (
														<section className={styles.detailSection}>
															<h4 className={styles.detailSectionTitle}>Current Employment (1)</h4>
															<div className={styles.detailList}>
																<Link
																	href={parentDashboardHref}
																	className={`${styles.detailRow} ${styles.detailRowInteractive}`}>
																	<div className={styles.detailRowMain}>
																		<span className={styles.detailRowName}>{formatFirmName(orphanRecord.firmName)}</span>
																		<span className={styles.detailInlineTag}>CRD#{orphanRecord.parentCrd}</span>
																	</div>
																	<div className={styles.detailRowMeta}>{orphanRecord.position}</div>
																</Link>
															</div>
														</section>
													)}

													{isFirmOrphan && orphanRecord.name && orphanRecord.parentCrd && (
														<section className={styles.detailSection}>
															<h4 className={styles.detailSectionTitle}>Scraped From (1)</h4>
															<div className={styles.detailList}>
																<Link
																	href={parentDashboardHref}
																	className={`${styles.detailRow} ${styles.detailRowInteractive}`}>
																	<div className={styles.detailRowMain}>
																		<span className={styles.detailRowName}>{formatPersonName(orphanRecord.name)}</span>
																		<span className={styles.detailInlineTag}>CRD#{orphanRecord.parentCrd}</span>
																	</div>
																	<div className={styles.detailRowMeta}>{orphanRecord.position}</div>
																</Link>
															</div>
														</section>
													)}

													<div className={styles.orphanNoticeAlert}>
														{isFirmOrphan ?
															<>
																No independent BrokerCheck/SEC record exists for Firm CRD {currentRecordId}. This firm was scraped from{' '}
																<Link
																	href={parentDashboardHref}
																	className={styles.detailInlineTag}>
																	Individual CRD#{orphanRecord.parentCrd}
																</Link>
																's employment history{orphanRecord.position ? ` as "${orphanRecord.position}"` : ''}, and has no live CRD of its own.
															</>
														:	<>
																No independent BrokerCheck/SEC record exists for CRD {currentRecordId}. This person was scraped from{' '}
																<Link
																	href={parentDashboardHref}
																	className={styles.detailInlineTag}>
																	Firm CRD#{orphanRecord.parentCrd}
																</Link>
																's own detail record as "{orphanRecord.position}", and has no live CRD of its own.
															</>
														}
													</div>
												</>
											);
										})()
									: detailedMainRecord ?
										<>
											{detailedMainRecord.otherNames.length > 0 && (
												<div className={styles.detailOtherNamesBlock}>
													<div className={styles.detailOtherNamesHeading}>OTHER NAMES</div>
													<div
														className={styles.headerOtherNamesRow}
														style={{ margin: 0 }}>
														{detailedMainRecord.otherNames.map((name) => (
															<span
																key={name}
																className={styles.headerOtherNameTag}>
																{formatOtherName(name, currentRecordEntity === 'firm')}
															</span>
														))}
													</div>
												</div>
											)}
											{(detailedMainRecord.mainAddress || detailedMainRecord.otherNames.length > 0) && (
												<div className={styles.detailAddressCard}>
													{detailedMainRecord.mainAddress && (
														<div className={styles.detailAddressLine}>
															<strong style={{ color: 'var(--text-secondary)' }}>Main Address:</strong> {detailedMainRecord.mainAddress}
														</div>
													)}
												</div>
											)}

											<section className={styles.detailSection}>
												<h4 className={styles.detailSectionTitle}>Profile Links</h4>
												<div className={styles.detailLinkRow}>
													{detailedMainRecord.profileLinks.map((link) => (
														<a
															key={link.href}
															href={link.href}
															target='_blank'
															rel='noopener noreferrer'
															className={styles.detailLinkBtn}>
															{link.label}
														</a>
													))}
												</div>
											</section>

											{detailedMainRecord.documentLinkCards.length > 0 && (
												<section className={styles.detailSection}>
													<h4 className={styles.detailSectionTitle}>SEC Document Links</h4>
													<div className={styles.detailLinkRow}>
														{detailedMainRecord.documentLinkCards.map((link) => (
															<a
																key={link.href}
																href={link.href}
																target='_blank'
																rel='noopener noreferrer'
																className={styles.detailLinkBtn}>
																{link.title} ↗
															</a>
														))}
													</div>
												</section>
											)}

											{(detailedMainRecord.bdDisclosureFlag || detailedMainRecord.iaDisclosureFlag) && (
												<section className={styles.detailSection}>
													<h4 className={styles.detailSectionTitle}>Disclosures</h4>
													<div className={styles.detailRawList}>
														{detailedMainRecord.bdDisclosureFlag && (
															<div className={styles.detailRawItem}>
																<div className={styles.detailRawLabel}>BD Disclosure Flag</div>
																<div className={styles.detailRawValue}>{detailedMainRecord.bdDisclosureFlag}</div>
															</div>
														)}
														{detailedMainRecord.iaDisclosureFlag && (
															<div className={styles.detailRawItem}>
																<div className={styles.detailRawLabel}>IA Disclosure Flag</div>
																<div className={styles.detailRawValue}>{detailedMainRecord.iaDisclosureFlag}</div>
															</div>
														)}
													</div>
												</section>
											)}

											{detailedMainRecord.crs && (
												<section className={styles.detailSection}>
													<h4 className={styles.detailSectionTitle}>Form CRS</h4>
													<div className={styles.detailRawList}>
														{detailedMainRecord.crs.crsType && (
															<div className={styles.detailRawItem}>
																<div className={styles.detailRawLabel}>CRS Type</div>
																<div className={styles.detailRawValue}>{detailedMainRecord.crs.crsType}</div>
															</div>
														)}
														{detailedMainRecord.crs.fileId && (
															<div className={styles.detailRawItem}>
																<div className={styles.detailRawLabel}>File ID</div>
																<div className={styles.detailRawValue}>{detailedMainRecord.crs.fileId}</div>
															</div>
														)}
													</div>
												</section>
											)}

											{detailedMainRecord.currentEmployment.length > 0 && (
												<section className={styles.detailSection}>
													<h4 className={styles.detailSectionTitle}>Current Employment ({detailedMainRecord.currentEmployment.length})</h4>
													<div className={styles.detailList}>
														{detailedMainRecord.currentEmployment.map((row, idx) => {
															const crd = pickFirstValidCrd(row.crdNumber, row.crd, row.firmId);
															const address = formatAddress(row.branchOfficeLocations?.[0]) || (row.city && row.state ? `${row.city}, ${row.state}` : '');
															const startDate = pickFirstNonEmpty(row.registrationBeginDate, row.effectiveDate, row.startDate);
															const dateStr = startDate ? `Since ${startDate}` : '';
															const metaParts = [address, dateStr].filter(Boolean);
															const metaLine = metaParts.length > 0 ? metaParts.join(' • ') : pickFirstNonEmpty(row.position, row.currentRegistration, row.status);

															const content = (
																<>
																	<div className={styles.detailRowMain}>
																		<span className={styles.detailRowName}>{resolveEntityNodeLabel(row, 'firm', crd, idx)}</span>
																		{crd && <span className={styles.detailInlineTag}>CRD#{crd}</span>}
																	</div>
																	<div className={styles.detailRowMeta}>{metaLine}</div>
																</>
															);

															if (crd) {
																return (
																	<Link
																		href={`/dashboard/firm/${crd}`}
																		key={`cur-emp-${idx}`}
																		className={`${styles.detailRow} ${styles.detailRowInteractive} ${styles.currentEmploymentRow}`}>
																		{content}
																	</Link>
																);
															}

															return (
																<div
																	key={`cur-emp-${idx}`}
																	className={`${styles.detailRow} ${styles.currentEmploymentRow}`}>
																	{content}
																</div>
															);
														})}
													</div>
												</section>
											)}

											{detailedMainRecord.previousEmployment.length > 0 && (
												<section className={styles.detailSection}>
													<h4 className={styles.detailSectionTitle}>Previous Employment ({detailedMainRecord.previousEmployment.length})</h4>
													<div className={styles.detailList}>
														{detailedMainRecord.previousEmployment.map((row, idx) => {
															const crd = pickFirstValidCrd(row.crdNumber, row.crd, row.firmId);
															const address = formatAddress(row.branchOfficeLocations?.[0]) || (row.city && row.state ? `${row.city}, ${row.state}` : '');
															const startDate = pickFirstNonEmpty(row.registrationBeginDate, row.effectiveDate, row.startDate);
															const endDate = pickFirstNonEmpty(row.registrationEndDate, row.endDate);

															let dateStr = '';
															if (startDate && endDate) dateStr = `${startDate} - ${endDate}`;
															else if (startDate) dateStr = startDate;

															const metaParts = [address, dateStr].filter(Boolean);
															const metaLine = metaParts.length > 0 ? metaParts.join(' • ') : pickFirstNonEmpty(row.position, row.currentRegistration, row.status);

															const content = (
																<>
																	<div className={styles.detailRowMain}>
																		<span className={styles.detailRowName}>{resolveEntityNodeLabel(row, 'firm', crd, idx)}</span>
																		{crd && <span className={styles.detailInlineTag}>CRD#{crd}</span>}
																	</div>
																	<div className={styles.detailRowMeta}>{metaLine}</div>
																</>
															);

															if (crd) {
																return (
																	<Link
																		href={`/dashboard/firm/${crd}`}
																		key={`prev-emp-${idx}`}
																		className={`${styles.detailRow} ${styles.detailRowInteractive}`}>
																		{content}
																	</Link>
																);
															}

															return (
																<div
																	key={`prev-emp-${idx}`}
																	className={styles.detailRow}>
																	{content}
																</div>
															);
														})}
													</div>
												</section>
											)}

											{detailedMainRecord.directOwners?.length > 0 && (
												<section className={styles.detailSection}>
													<h4 className={styles.detailSectionTitle}>Direct Owners & Executive Officers ({detailedMainRecord.directOwners.length})</h4>
													<div className={styles.detailList}>
														{detailedMainRecord.directOwners.map((row, idx) => {
															const crd = pickFirstValidCrd(row.crdNumber, row.crd, row.individualId);
															const name = resolveEntityNodeLabel(row, 'individual', crd, idx);
															const position = pickFirstNonEmpty(row.position, row.title);

															const content = (
																<>
																	<div className={styles.detailRowMain}>
																		<span className={styles.detailRowName}>{name}</span>
																		{crd && <span className={styles.detailInlineTag}>CRD#{crd}</span>}
																	</div>
																	{position && <div className={styles.detailRowMeta}>{position}</div>}
																</>
															);

															if (crd) {
																return (
																	<Link
																		href={`/dashboard/individual/${crd}`}
																		key={`dir-owner-${idx}`}
																		className={`${styles.detailRow} ${styles.detailRowInteractive} ${styles.currentEmploymentRow}`}>
																		{content}
																	</Link>
																);
															}

															return (
																<div
																	key={`dir-owner-${idx}`}
																	className={styles.detailRow}>
																	{content}
																</div>
															);
														})}
													</div>
												</section>
											)}

											{detailedMainRecord.indirectOwners?.length > 0 && (
												<section className={styles.detailSection}>
													<h4 className={styles.detailSectionTitle}>Indirect Owners ({detailedMainRecord.indirectOwners.length})</h4>
													<div className={styles.detailList}>
														{detailedMainRecord.indirectOwners.map((row, idx) => {
															const crd = pickFirstValidCrd(row.crdNumber, row.crd, row.individualId);
															const name = resolveEntityNodeLabel(row, 'individual', crd, idx);
															const position = pickFirstNonEmpty(row.position, row.title);

															const content = (
																<>
																	<div className={styles.detailRowMain}>
																		<span className={styles.detailRowName}>{name}</span>
																		{crd && <span className={styles.detailInlineTag}>CRD#{crd}</span>}
																	</div>
																	{position && <div className={styles.detailRowMeta}>{position}</div>}
																</>
															);

															if (crd) {
																return (
																	<Link
																		href={`/dashboard/individual/${crd}`}
																		key={`indir-owner-${idx}`}
																		className={`${styles.detailRow} ${styles.detailRowInteractive} ${styles.currentEmploymentRow}`}>
																		{content}
																	</Link>
																);
															}

															return (
																<div
																	key={`indir-owner-${idx}`}
																	className={styles.detailRow}>
																	{content}
																</div>
															);
														})}
													</div>
												</section>
											)}

											{detailedMainRecord.stateExams.length > 0 && (
												<section className={styles.detailSection}>
													<h4 className={styles.detailSectionTitle}>🏛️ STATE EXAM CATEGORY ({detailedMainRecord.stateExams.length})</h4>
													<div className={styles.detailExamGrid}>
														{detailedMainRecord.stateExams.map((row, idx) => (
															<div
																key={`state-exam-${idx}`}
																className={styles.detailExamCardState}>
																<div className={styles.detailExamTop}>
																	<span className={styles.detailExamBadgeState}>{pickFirstNonEmpty(row.examCategory, row.examCode, row.category, 'Exam')}</span>
																	{pickFirstNonEmpty(row.examTakenDate, row.dateTaken, row.date) && (
																		<span className={styles.detailExamDate}>📅 {pickFirstNonEmpty(row.examTakenDate, row.dateTaken, row.date)}</span>
																	)}
																</div>
																<div className={styles.detailExamName}>{pickFirstNonEmpty(row.examName, row.description, row.categoryName)}</div>
																{pickFirstNonEmpty(row.examScope, row.scope) && <div className={styles.detailExamScope}>Scope: {pickFirstNonEmpty(row.examScope, row.scope)}</div>}
															</div>
														))}
													</div>
												</section>
											)}

											{detailedMainRecord.productExams.length > 0 && (
												<section className={styles.detailSection}>
													<h4 className={styles.detailSectionTitle}>📜 PRODUCT EXAM CATEGORY ({detailedMainRecord.productExams.length})</h4>
													<div className={styles.detailExamGrid}>
														{detailedMainRecord.productExams.map((row, idx) => (
															<div
																key={`prod-exam-${idx}`}
																className={styles.detailExamCardProduct}>
																<div className={styles.detailExamTop}>
																	<span className={styles.detailExamBadgeProduct}>{pickFirstNonEmpty(row.examCategory, row.examCode, row.category, 'Exam')}</span>
																	{pickFirstNonEmpty(row.examTakenDate, row.dateTaken, row.date) && (
																		<span className={styles.detailExamDate}>📅 {pickFirstNonEmpty(row.examTakenDate, row.dateTaken, row.date)}</span>
																	)}
																</div>
																<div className={styles.detailExamName}>{pickFirstNonEmpty(row.examName, row.description, row.categoryName)}</div>
																{pickFirstNonEmpty(row.examScope, row.scope) && <div className={styles.detailExamScope}>Scope: {pickFirstNonEmpty(row.examScope, row.scope)}</div>}
															</div>
														))}
													</div>
												</section>
											)}

											{detailedMainRecord.principalExams.length > 0 && (
												<section className={styles.detailSection}>
													<h4 className={styles.detailSectionTitle}>👔 PRINCIPAL EXAM CATEGORY ({detailedMainRecord.principalExams.length})</h4>
													<div className={styles.detailExamGrid}>
														{detailedMainRecord.principalExams.map((row, idx) => (
															<div
																key={`princ-exam-${idx}`}
																className={styles.detailExamCardPrincipal}>
																<div className={styles.detailExamTop}>
																	<span className={styles.detailExamBadgePrincipal}>{pickFirstNonEmpty(row.examCategory, row.examCode, row.category, 'Exam')}</span>
																	{pickFirstNonEmpty(row.examTakenDate, row.dateTaken, row.date) && (
																		<span className={styles.detailExamDate}>📅 {pickFirstNonEmpty(row.examTakenDate, row.dateTaken, row.date)}</span>
																	)}
																</div>
																<div className={styles.detailExamName}>{pickFirstNonEmpty(row.examName, row.description, row.categoryName)}</div>
																{pickFirstNonEmpty(row.examScope, row.scope) && <div className={styles.detailExamScope}>Scope: {pickFirstNonEmpty(row.examScope, row.scope)}</div>}
															</div>
														))}
													</div>
												</section>
											)}

											{detailedMainRecord.brochureCards.length > 0 && (
												<section className={styles.detailSection}>
													<h4 className={styles.detailSectionTitle}>Brochures ({detailedMainRecord.brochureCards.length})</h4>
													{detailedMainRecord.brochuresPart2Exempt && (
														<div
															className={styles.detailTextRow}
															style={{ marginBottom: '6px' }}>
															<strong>Part 2 Exempt:</strong> {detailedMainRecord.brochuresPart2Exempt}
														</div>
													)}
													<div className={styles.detailGrid}>
														{detailedMainRecord.brochureCards.map((item, idx) => (
															<div
																key={`brochure-${idx}`}
																className={styles.detailGridCard}>
																<div className={styles.detailRowMain}>
																	<span className={styles.detailRowName}>{item.title}</span>
																	{item.meta && <span className={styles.detailInlineTag}>{item.meta}</span>}
																</div>
																{item.subtitle && <div className={styles.detailRowMeta}>{item.subtitle}</div>}
															</div>
														))}
													</div>
												</section>
											)}

											{detailedMainRecord.noticeFilingCards.length > 0 && (
												<section className={styles.detailSection}>
													<h4 className={styles.detailSectionTitle}>Notice Filings ({detailedMainRecord.noticeFilingCards.length})</h4>
													<div className={styles.detailGrid}>
														{detailedMainRecord.noticeFilingCards.map((item, idx) => (
															<div
																key={`notice-filing-${idx}`}
																className={styles.detailGridCard}>
																<div className={styles.detailRowMain}>
																	<span className={styles.detailRowName}>{item.title}</span>
																	{item.meta && <span className={styles.detailInlineTag}>{item.meta}</span>}
																</div>
																{item.subtitle && <div className={styles.detailRowMeta}>Effective Date: {item.subtitle}</div>}
															</div>
														))}
													</div>
												</section>
											)}

											{detailedMainRecord.jurisdictionCards.length > 0 && (
												<section className={styles.detailSection}>
													<h4 className={styles.detailSectionTitle}>Registered States ({detailedMainRecord.jurisdictionCards.length})</h4>
													<div className={styles.detailTagList}>
														{detailedMainRecord.jurisdictionCards.map((item, idx) => (
															<span
																key={`${item.title}-${idx}`}
																className={styles.detailTagState}>
																{item.title}
															</span>
														))}
													</div>
												</section>
											)}

											{detailedMainRecord.additionalDetails.length > 0 && (
												<section className={styles.detailSection}>
													<h4 className={styles.detailSectionTitle}>Additional {additionalDetailsSourceLabel} Details</h4>
													<div className={styles.detailRawList}>
														{detailedMainRecord.additionalDetails.map((entry) => (
															<div
																key={`${entry.label}:${entry.value}`}
																className={styles.detailRawItem}>
																<div className={styles.detailRawLabel}>{entry.label}</div>
																<div className={styles.detailRawValue}>{entry.value}</div>
															</div>
														))}
													</div>
												</section>
											)}

											{detailedMainRecord.registeredSros.length > 0 && (
												<section className={styles.detailSection}>
													<h4 className={styles.detailSectionTitle}>Registered SROs ({detailedMainRecord.registeredSros.length})</h4>
													<div className={styles.detailTagList}>
														{detailedMainRecord.registeredSros.map((tag) => (
															<span
																key={tag}
																className={styles.detailTagSro}>
																{tag}
															</span>
														))}
													</div>
												</section>
											)}

											{currentRecordEntity === 'firm' && connectionsLoadingFirmId === currentRecordId ?
												<section className={styles.detailSection}>
													<div className={styles.detailSectionHeaderWithBadge}>
														<h4 className={styles.detailSectionTitle}>Current & Previous Connections</h4>
														<span className={styles.loadingPillBadge}>
															<span className={styles.pulsingDot} />
															Loading…
														</span>
													</div>
													<div className={styles.connectionLoadingCard}>
														<VectorLoader
															size='md'
															label='Discovering network connections across FINRA & SEC registries…'
															sublabel='Analyzing associated representatives, previous registrations, and ownership graph links.'
														/>
														<div className={styles.connectionSkeletonList}>
															<div className={styles.connectionSkeletonRow} />
															<div className={styles.connectionSkeletonRow} />
															<div className={styles.connectionSkeletonRow} />
														</div>
													</div>
												</section>
											:	<>
													{detailedMainRecord.currentConnectionCards.length > 0 && (
														<section className={styles.detailSection}>
															<h4 className={styles.detailSectionTitle}>Current Connections ({detailedMainRecord.currentConnectionCards.length})</h4>
															<div className={styles.detailList}>
																{detailedMainRecord.currentConnectionCards.map((item, idx) => {
																	const content = (
																		<>
																			<div className={styles.detailRowMain}>
																				<span className={`${styles.detailRowName} ${styles.currentConnectionName}`}>{item.title}</span>
																				{item.crd && <span className={styles.detailInlineTag}>CRD#{item.crd}</span>}
																				{item.meta && <span className={`${styles.detailInlineTag} ${styles.currentConnectionTag}`}>{item.meta}</span>}
																			</div>
																			{item.subtitle && <div className={`${styles.detailRowMeta} ${styles.currentConnectionMeta}`}>{item.subtitle}</div>}
																		</>
																	);

																	if (item.crd) {
																		return (
																			<Link
																				href={`/dashboard/${item.entity || 'firm'}/${item.crd}`}
																				key={`current-conn-${idx}`}
																				className={`${styles.detailRow} ${styles.detailRowInteractive} ${styles.currentEmploymentRow} ${styles.currentConnectionRow}`}>
																				{content}
																			</Link>
																		);
																	}

																	return (
																		<div
																			key={`current-conn-${idx}`}
																			className={`${styles.detailRow} ${styles.currentConnectionRow}`}>
																			{content}
																		</div>
																	);
																})}
															</div>
														</section>
													)}

													{detailedMainRecord.previousConnectionCards.length > 0 && (
														<section className={styles.detailSection}>
															<h4 className={styles.detailSectionTitle}>Previous Connections ({detailedMainRecord.previousConnectionCards.length})</h4>
															<div className={styles.detailList}>
																{detailedMainRecord.previousConnectionCards.map((item, idx) => {
																	const content = (
																		<>
																			<div className={styles.detailRowMain}>
																				<span className={styles.detailRowName}>{item.title}</span>
																				{item.crd && <span className={styles.detailInlineTag}>CRD#{item.crd}</span>}
																				{item.meta && <span className={styles.detailInlineTag}>{item.meta}</span>}
																			</div>
																			{item.subtitle && <div className={styles.detailRowMeta}>{item.subtitle}</div>}
																		</>
																	);

																	if (item.crd) {
																		return (
																			<Link
																				href={`/dashboard/${item.entity || 'firm'}/${item.crd}`}
																				key={`prev-conn-${idx}`}
																				className={`${styles.detailRow} ${styles.detailRowInteractive}`}>
																				{content}
																			</Link>
																		);
																	}

																	return (
																		<div
																			key={`prev-conn-${idx}`}
																			className={styles.detailRow}>
																			{content}
																		</div>
																	);
																})}
															</div>
														</section>
													)}
												</>
											}
										</>
									:	<div className={styles.readableCardEmpty}>No readable fields found for this record.</div>}
								</div>
							)}

							{!hasCurrentRecord && <div className={styles.searchSummary}>No node selected yet. Search for a specific CRD below.</div>}

							<div className={`${styles.searchBarWrap} ${searchPaneOpen ? styles.searchBarWrapExpanded : ''}`}>
								<div className={`${styles.searchResultsPane} ${searchPaneOpen ? styles.searchResultsPaneOpen : ''}`}>
									<div className={styles.searchSummary}>{searchSummary}</div>
									{searchResults.length > 0 ?
										<div className={styles.searchResultsList}>{searchResults.map(renderSearchResult)}</div>
									: searchPaneOpen && !searchBusy ?
										<div className={styles.searchResultsEmpty}>No Redis results yet for this query.</div>
									:	null}
								</div>
								<div className={styles.searchDock}>
									<div className={styles.searchDockTitleRow}>
										<div className={styles.searchTitle}>REDIS SEARCH ({searchResults.length.toLocaleString()})</div>
										<div className={styles.searchDockMeta}>
											<span style={{ marginRight: '8px', color: '#10b981', fontWeight: 600, padding: '2px 6px', backgroundColor: 'rgba(16, 185, 129, 0.1)', borderRadius: '4px' }}>
												LOCAL REDIS ONLINE
											</span>{' '}
											Redis CRDs: {uniqueCrdCounts.total.toLocaleString()}
										</div>
									</div>
									<div className={styles.searchRow}>
										<input
											value={searchQuery}
											onChange={(event) => setSearchQuery(event.target.value)}
											spellCheck={false}
											autoCorrect='off'
											autoCapitalize='none'
											onKeyDown={(event) => {
												if (event.key === 'Enter') {
													event.preventDefault();
													runRedisSearch();
												}
											}}
											className={styles.input}
											placeholder='Search Redis-saved records by name...'
										/>
									</div>
									<div className={styles.searchDockActions}>
										<button
											type='button'
											className={styles.primaryBtn}
											onClick={runRedisSearch}
											disabled={searchBusy}>
											{searchBusy ? 'Searching…' : 'Search Redis'}
										</button>
									</div>
								</div>
							</div>
						</div>
					</div>
				</section>

				<aside className={styles.middlePane}>
					<div
						className={styles.middlePaneHeader}
						style={{ cursor: 'pointer', userSelect: 'none' }}
						onClick={() => setIsSelectionHistoryOpen(!isSelectionHistoryOpen)}>
						<div className={styles.middlePaneTitle}>SELECTION HISTORY {isSelectionHistoryOpen ? '▼' : '▶'}</div>
						<div className={styles.middlePaneActions}>
							<span className={styles.middlePaneCount}>{displayCards.length}</span>
							<button
								type='button'
								className={styles.middlePaneClearBtn}
								onClick={(e) => {
									e.stopPropagation();
									clearSelectionHistory();
								}}>
								CLEAR
							</button>
						</div>
					</div>

					{isSelectionHistoryOpen && (
						<div
							className={styles.middlePaneList}
							style={{ flex: 1, minHeight: 0 }}>
							{displayCards.length > 0 ?
								displayCards.map((card) =>
									(() => {
										const isActiveRecord = currentRecordId === card.id && currentRecordEntity === card.entity;
										const storedName = toText(card.name);
										const computedCardName =
											storedName && !looksLikeGenericEntityLabel(storedName) ? storedName
											: isActiveRecord && toText(mainJsonLabel) ? toText(mainJsonLabel)
											: `${card.entity === 'firm' ? 'Firm' : 'Individual'} CRD #${card.id}`;
										const { hasFinra, hasSec } = getQueueCardSources(card);

										return (
											<button
												type='button'
												key={`${card.entity}:${card.id}`}
												className={`${styles.middlePaneItem} ${isActiveRecord ? styles.middlePaneItemSelected : ''}`}
												aria-selected={isActiveRecord}
												onClick={() => void openQueueCard(card)}>
												<div className={styles.middlePaneItemTop}>
													<span className={styles.middlePaneItemBadge}>{card.entity === 'firm' ? 'FIRM' : 'IND'}</span>
													<span className={styles.middlePaneItemName}>{computedCardName}</span>
													<div className={styles.cardTags}>
														{hasFinra && <span className={styles.tagFinra}>FINRA</span>}
														{hasSec && <span className={styles.tagSec}>SEC</span>}
													</div>
												</div>
												<div className={styles.middlePaneItemMeta}>CRD #{card.id}</div>
											</button>
										);
									})(),
								)
							:	<div className={styles.middlePaneEmpty}>No selection history yet.</div>}
						</div>
					)}

					<div
						className={styles.middlePaneHeader}
						style={{
							marginTop: isSelectionHistoryOpen ? '16px' : '0',
							paddingTop: isSelectionHistoryOpen ? '16px' : '0',
							borderTop: isSelectionHistoryOpen ? '1px solid var(--border)' : 'none',
							cursor: 'pointer',
							userSelect: 'none',
						}}
						onClick={() => setIsGraphClickHistoryOpen(!isGraphClickHistoryOpen)}>
						<div className={styles.middlePaneTitle}>GRAPH CLICK HISTORY {isGraphClickHistoryOpen ? '▼' : '▶'}</div>
						<div className={styles.middlePaneActions}>
							<span className={styles.middlePaneCount}>{graphClickHistory.length}</span>
						</div>
					</div>

					{isGraphClickHistoryOpen && (
						<div
							className={styles.middlePaneList}
							style={{ flex: 1, minHeight: 0 }}>
							{graphClickHistory.length > 0 ?
								graphClickHistory
									.slice()
									.reverse()
									.map((entry, idx) => {
										const entityForLink = entry.group === 'firm' ? 'firm' : 'individual';
										const extractedCrd = entry.secondaryId.replace(/[^0-9]/g, '');
										const isActiveRecord = currentRecordId === extractedCrd && currentRecordEntity === entityForLink;

										return (
											<button
												type='button'
												key={idx}
												className={`${styles.middlePaneItem} ${isActiveRecord ? styles.middlePaneItemSelected : ''}`}
												aria-selected={isActiveRecord}
												style={{ display: 'flex', flexDirection: 'column', width: '100%', textAlign: 'left' }}
												onClick={() =>
													void openQueueCard({
														id: extractedCrd,
														entity: entityForLink,
														files: 0,
														sources: [],
														name: entry.label,
													})
												}>
												<div className={styles.middlePaneItemTop}>
													<span className={styles.middlePaneItemBadge}>{entityForLink === 'firm' ? 'FIRM' : 'IND'}</span>
													<span className={styles.middlePaneItemName}>{entry.label}</span>
												</div>
												<div className={styles.middlePaneItemMeta}>CRD #{extractedCrd}</div>
											</button>
										);
									})
							:	<div className={styles.middlePaneEmpty}>No graph clicks yet.</div>}
						</div>
					)}
				</aside>

				<div
					className={styles.rightColumn}
					data-right-open={String(newCrdsOpen)}>


					<aside
						className={`${styles.rightPane} ${!newCrdsOpen ? styles.rightPaneCompact : ''}`}
						aria-hidden={!newCrdsOpen}>
						{newCrdsOpen && (
							<>
								<div className={styles.rightPaneCountCard}>{uniqueCrdCounts.total.toLocaleString()} unique CRDs saved in Redis</div>

								<div className={styles.rightPaneSection}>
									<div className={styles.rightPaneSectionTitle}>PEOPLE</div>
									<div className={styles.rightPaneList}>
										{peopleCrdEntries.length > 0 ?
											peopleCrdEntries.map((entry) => {
												const isSelected = currentRecordId === entry.id && currentRecordEntity === 'individual';
												const { hasFinra, hasSec } = getNewCrdSources(entry, 'individual', localHistory);
												return (
													<button
														type='button'
														key={`people-${entry.id}`}
														className={`${styles.rightPaneItem} ${isSelected ? styles.rightPaneItemSelected : ''}`}
														aria-selected={isSelected}
														onClick={() => void openNewCrdEntry(entry)}>
														<div className={styles.rightPaneItemTop}>
															<div className={styles.rightPaneItemTitleRow}>
																<svg
																	className={styles.itemEntityIcon}
																	viewBox='0 0 24 24'
																	fill='none'
																	stroke='currentColor'
																	strokeWidth='2'
																	strokeLinecap='round'
																	strokeLinejoin='round'
																	aria-hidden='true'>
																	<path d='M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2' />
																	<circle
																		cx='12'
																		cy='7'
																		r='4'
																	/>
																</svg>
																<span className={styles.rightPaneItemTitle}>
																	{toText(entry.name) ||
																		historyNameMap.get(`individual:${entry.id}`) ||
																		getRecordDisplayName(entry as unknown as Record<string, unknown>, 'individual', entry.id) ||
																		extractDisplayNameFromNewCrd(entry, 'individual')}
																</span>
															</div>
															<div className={styles.cardTags}>
																{hasFinra && <span className={styles.tagFinra}>FINRA</span>}
																{hasSec && <span className={styles.tagSec}>SEC</span>}
															</div>
														</div>
														<div className={styles.rightPaneItemMeta}>CRD #{entry.id}</div>
													</button>
												);
											})
										:	<div className={styles.rightPaneEmpty}>No people queued yet.</div>}
									</div>
								</div>

								<div className={styles.rightPaneSection}>
									<div className={styles.rightPaneSectionTitle}>FIRMS</div>
									<div className={styles.rightPaneList}>
										{firmCrdEntries.length > 0 ?
											firmCrdEntries.map((entry) => {
												const isSelected = currentRecordId === entry.id && currentRecordEntity === 'firm';
												const { hasFinra, hasSec } = getNewCrdSources(entry, 'firm', localHistory);
												return (
													<button
														type='button'
														key={`firm-${entry.id}`}
														className={`${styles.rightPaneItem} ${isSelected ? styles.rightPaneItemSelected : ''}`}
														aria-selected={isSelected}
														onClick={() => void openNewCrdEntry(entry)}>
														<div className={styles.rightPaneItemTop}>
															<div className={styles.rightPaneItemTitleRow}>
																<svg
																	className={styles.itemEntityIcon}
																	viewBox='0 0 24 24'
																	fill='none'
																	stroke='currentColor'
																	strokeWidth='2'
																	strokeLinecap='round'
																	strokeLinejoin='round'
																	aria-hidden='true'>
																	<rect
																		x='4'
																		y='2'
																		width='16'
																		height='20'
																		rx='2'
																		ry='2'
																	/>
																	<path d='M9 22v-4h6v4' />
																	<path d='M8 6h.01' />
																	<path d='M16 6h.01' />
																	<path d='M12 6h.01' />
																	<path d='M12 10h.01' />
																	<path d='M12 14h.01' />
																	<path d='M16 10h.01' />
																	<path d='M16 14h.01' />
																	<path d='M8 10h.01' />
																	<path d='M8 14h.01' />
																</svg>
																<span className={styles.rightPaneItemTitle}>
																	{toText(entry.name) ||
																		historyNameMap.get(`firm:${entry.id}`) ||
																		getRecordDisplayName(entry as unknown as Record<string, unknown>, 'firm', entry.id) ||
																		extractDisplayNameFromNewCrd(entry, 'firm')}
																</span>
															</div>
															<div className={styles.cardTags}>
																{hasFinra && <span className={styles.tagFinra}>FINRA</span>}
																{hasSec && <span className={styles.tagSec}>SEC</span>}
															</div>
														</div>
														<div className={styles.rightPaneItemMeta}>CRD #{entry.id}</div>
													</button>
												);
											})
										:	<div className={styles.rightPaneEmpty}>No firms queued yet.</div>}
									</div>
								</div>
							</>
						)}
					</aside>
				</div>
			</div>
			<div className={styles.hiddenValues}>
				<input
					type='text'
					value={externalRawDir}
					onChange={(event) => setExternalRawDir(event.target.value)}
				/>
			</div>
		</div>
	);
}

export default function DashboardPage() {
	return (
		<Suspense
			fallback={
				<div className={styles.page}>
					<div className={styles.layout}>
						<section className={styles.centerPane}>
							<div className={styles.searchSummary}>
								<VectorLoader
									size='lg'
									label='Loading dashboard…'
								/>
							</div>
						</section>
					</div>
				</div>
			}>
			<DashboardPageInner />
		</Suspense>
	);
}
