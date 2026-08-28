import { describe, expect, it } from 'vitest';
import { matchesConnectionsFilter, matchesFilterTags, partitionConnectionsByFilter, shouldPreviewUnfilteredConnections } from '@/lib/filterTags';

describe('matchesConnectionsFilter', () => {
	it('matches tags when enabled', () => {
		expect(matchesConnectionsFilter('Jane Doe CRD#123', ['jane'], '', true)).toBe(true);
		expect(matchesConnectionsFilter('Jane Doe CRD#123', ['smith'], '', true)).toBe(false);
	});

	it('ignores tags when the checkbox is off', () => {
		expect(matchesConnectionsFilter('Jane Doe CRD#123', ['smith'], 'nope', false)).toBe(true);
	});

	it('ignores tags during empty-focus preview', () => {
		expect(matchesConnectionsFilter('Jane Doe CRD#123', ['smith'], '', true, true)).toBe(true);
	});

	it('keeps OR tag matching via matchesFilterTags', () => {
		expect(matchesFilterTags('alpha beta', ['zzz', 'beta'])).toBe(true);
	});
});

describe('shouldPreviewUnfilteredConnections', () => {
	it('previews the full list on empty focus', () => {
		expect(shouldPreviewUnfilteredConnections({ focused: true, liveText: '', justCommitted: false })).toBe(true);
	});

	it('applies tags after the first typed character', () => {
		expect(shouldPreviewUnfilteredConnections({ focused: true, liveText: 'j', justCommitted: false })).toBe(false);
	});

	it('stays filtered after Enter commits a tag', () => {
		expect(shouldPreviewUnfilteredConnections({ focused: true, liveText: '', justCommitted: true })).toBe(false);
	});
});

describe('partitionConnectionsByFilter', () => {
	it('keeps unmatched items after matched ones instead of dropping them', () => {
		const items = [
			{ name: 'Alice Smith' },
			{ name: 'Bob Jones' },
			{ name: 'Carol Smith' },
		];
		const result = partitionConnectionsByFilter(items, (item) => item.name, ['smith'], '', true, false);
		expect(result.matched.map((item) => item.name)).toEqual(['Alice Smith', 'Carol Smith']);
		expect(result.unmatched.map((item) => item.name)).toEqual(['Bob Jones']);
		expect(result.ordered.map((item) => item.name)).toEqual(['Alice Smith', 'Carol Smith', 'Bob Jones']);
	});

	it('treats every item as matched when filtering is disabled', () => {
		const items = [{ name: 'Alice' }, { name: 'Bob' }];
		const result = partitionConnectionsByFilter(items, (item) => item.name, ['zzz'], '', false, false);
		expect(result.matched).toHaveLength(2);
		expect(result.unmatched).toHaveLength(0);
	});
});
