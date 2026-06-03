import { describe, expect, it } from 'vitest';
import {
	collectNodeLocationRecords,
	isInternationalLocationRecord,
	isValidLocationStateFilter,
	nodeMatchesLocationSearch,
	normalizeLocationStateFilter,
} from '@/lib/locationSearch';

describe('location search helpers', () => {
	it('normalizes US states and the INT sentinel', () => {
		expect(normalizeLocationStateFilter('ca')).toBe('CA');
		expect(normalizeLocationStateFilter('California')).toBe('CA');
		expect(normalizeLocationStateFilter('int')).toBe('INT');
		expect(isValidLocationStateFilter('XX')).toBe(false);
	});

	it('matches a ZIP code against structured office addresses', () => {
		const node = {
			firmAddressDetails: {
				officeAddress: {
					street1: '123 Main St',
					city: 'New York',
					state: 'NY',
					postalCode: '10001',
					country: 'US',
				},
			},
		};

		expect(nodeMatchesLocationSearch(node, { locationQuery: '10001' })).toBe(true);
		expect(nodeMatchesLocationSearch(node, { locationQuery: '10002' })).toBe(false);
	});

	it('matches city queries only when the state filter also matches', () => {
		const node = {
			currentEmployments: [
				{
					branch_city: 'Dallas',
					branch_state: 'TX',
					branch_zip: '75001',
				},
			],
		};

		expect(nodeMatchesLocationSearch(node, { locationQuery: 'Dallas', stateFilter: 'TX' })).toBe(true);
		expect(nodeMatchesLocationSearch(node, { locationQuery: 'Dallas', stateFilter: 'CA' })).toBe(false);
	});

	it('treats non-US province and postal formats as international', () => {
		const node = {
			firmAddressDetails: {
				officeAddress: {
					street1: '151 Yonge St',
					city: 'Toronto',
					state: 'ON',
					postalCode: 'M5C 2W7',
					country: 'Canada',
				},
			},
		};

		const records = collectNodeLocationRecords(node);
		expect(records).toHaveLength(1);
		expect(isInternationalLocationRecord(records[0])).toBe(true);
		expect(nodeMatchesLocationSearch(node, { locationQuery: 'Toronto', stateFilter: 'INT' })).toBe(true);
	});

	it('does not treat a missing state alone as international', () => {
		const node = {
			firmAddressDetails: {
				officeAddress: {
					city: 'Unknown',
					postalCode: '',
					country: '',
				},
			},
		};

		expect(nodeMatchesLocationSearch(node, { locationQuery: 'Unknown', stateFilter: 'INT' })).toBe(false);
	});
});
