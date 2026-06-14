import { describe, expect, it } from 'vitest';

import { shouldUseLocalFallback } from '../../src/app/api/dashboard/refresh/route';

describe('shouldUseLocalFallback', () => {
	it('never falls back to local cache cards for dashboard card listings', () => {
		expect(shouldUseLocalFallback(0, false)).toBe(false);
		expect(shouldUseLocalFallback(10, true)).toBe(false);
		expect(shouldUseLocalFallback(5000, false)).toBe(false);
	});
});
