import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/graphStore', () => ({
	getFullGraph: vi.fn(),
	saveGraph: vi.fn(),
}));

vi.mock('@/lib/seedStore', () => ({
	rememberRecentSeed: vi.fn(),
}));

import { getFullGraph, saveGraph } from '@/lib/graphStore';
import { rememberRecentSeed } from '@/lib/seedStore';
import { buildMainAppGraphArtifactsFromFetchedPayload, publishFetchedRecordsToMainApp } from '@/app/api/dashboard/refresh/route';

describe('buildMainAppGraphArtifactsFromFetchedPayload', () => {
	it('builds a person node plus employment firm links from a fetched individual payload', () => {
		const payload = {
			hits: {
				hits: [
					{
						_source: {
							content: JSON.stringify({
								basicInformation: {
									individualId: 5740531,
									firstName: 'GIANNI',
									lastName: 'VERMA',
									bcScope: 'Active',
									iaScope: 'Active',
								},
								registrationCount: {
									approvedFinraRegistrationCount: 1,
									approvedIAStateRegistrationCount: 1,
								},
								currentEmployments: [{ firm_id: '7691', firm_name: 'Alpha Capital' }],
								currentIAEmployments: [{ firm_id: '7691', firm_name: 'Alpha Capital' }],
								previousEmployments: [],
								previousIAEmployments: [],
							}),
						},
					},
				],
			},
		};

		const artifacts = buildMainAppGraphArtifactsFromFetchedPayload(payload, {
			crd: '5740531',
			source: 'finra',
			type: 'individual',
		});

		expect(artifacts.nodes.some((node) => node.id === 'person:5740531' && node.label === 'GIANNI VERMA')).toBe(true);
		expect(artifacts.nodes.some((node) => node.id === 'firm:7691' && node.group === 'firm')).toBe(true);
		expect(artifacts.links.some((link) => link.source === 'person:5740531' && link.target === 'firm:7691' && link.relationship === 'employed_by')).toBe(true);
	});
});

describe('publishFetchedRecordsToMainApp', () => {
	beforeEach(() => {
		vi.mocked(rememberRecentSeed).mockReset();
		vi.mocked(saveGraph).mockReset();
		vi.mocked(getFullGraph).mockResolvedValue({
			nodes: [
				{
					id: 'person:5740531',
					label: 'Old Label',
					group: 'individual',
					crd: '5740531',
					basicInformation: {
						individualId: '5740531',
						firstName: 'OLD',
						lastName: 'NAME',
					},
				},
			],
			links: [],
			meta: { generated: '2026-01-01T00:00:00.000Z' },
		});
	});

	it('remembers successful fetches and merges them into the graph store', async () => {
		const payload = {
			hits: {
				hits: [
					{
						_source: {
							content: JSON.stringify({
								basicInformation: {
									individualId: 5740531,
									firstName: 'GIANNI',
									lastName: 'VERMA',
									bcScope: 'Active',
								},
								registrationCount: {
									approvedFinraRegistrationCount: 1,
								},
								currentEmployments: [{ firm_id: '7691', firm_name: 'Alpha Capital' }],
								previousEmployments: [],
								currentIAEmployments: [],
								previousIAEmployments: [],
							}),
						},
					},
				],
			},
		};

		const summary = await publishFetchedRecordsToMainApp([
			{
				crd: '5740531',
				source: 'finra',
				type: 'individual',
				status: 'ok',
				payload,
			},
		]);

		expect(rememberRecentSeed).toHaveBeenCalledWith('individual', '5740531');
		expect(summary).toMatchObject({ rememberedSeeds: 1, nodesAdded: 1, nodesUpdated: 1, linksAdded: 1 });
		expect(saveGraph).toHaveBeenCalledTimes(1);
		const savedGraph = vi.mocked(saveGraph).mock.calls[0][0] as any;
		expect(savedGraph.nodes.some((node: any) => node.id === 'person:5740531' && node.label === 'GIANNI VERMA')).toBe(true);
		expect(savedGraph.nodes.some((node: any) => node.id === 'firm:7691')).toBe(true);
		expect(savedGraph.links.some((link: any) => link.source === 'person:5740531' && link.target === 'firm:7691')).toBe(true);
	});

	it('ignores errored records for main-app publishing', async () => {
		const summary = await publishFetchedRecordsToMainApp([
			{
				crd: '1234567',
				source: 'sec',
				type: 'individual',
				status: 'error',
				payload: null,
			},
		]);

		expect(summary).toEqual({ rememberedSeeds: 0, nodesAdded: 0, nodesUpdated: 0, linksAdded: 0 });
		expect(rememberRecentSeed).not.toHaveBeenCalled();
		expect(saveGraph).not.toHaveBeenCalled();
	});
});
