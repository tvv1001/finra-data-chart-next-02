import { describe, expect, it } from 'vitest';
import { matchesConnectionsFilter, matchesFilterTags, shouldPreviewUnfilteredConnections } from '@/lib/filterTags';

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
