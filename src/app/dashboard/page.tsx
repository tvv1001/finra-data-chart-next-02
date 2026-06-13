'use client';

import { useMemo, useState } from 'react';

type DashboardAction = 'fetch-crds' | 'sync-and-deploy-primed';

type ApiResponse = {
	ok: boolean;
	error?: string;
	[key: string]: unknown;
};

function parseCrds(input: string) {
	return input
		.split(/[\s,]+/g)
		.map((value) => value.trim())
		.filter(Boolean)
		.filter((value) => /^\d{1,10}$/.test(value));
}

export default function DashboardPage() {
	const [adminSecret, setAdminSecret] = useState('');
	const [crdInput, setCrdInput] = useState('7691, 109984, 137222');
	const [externalRawDir, setExternalRawDir] = useState('/home/lenny/Dev/webDev/Data-finra-sec/data/raw');
	const [busyAction, setBusyAction] = useState<DashboardAction | null>(null);
	const [result, setResult] = useState<ApiResponse | null>(null);

	const parsedCrds = useMemo(() => parseCrds(crdInput), [crdInput]);

	async function runAction(action: DashboardAction) {
		if (!adminSecret.trim()) {
			setResult({ ok: false, error: 'Enter ADMIN_SECRET first.' });
			return;
		}

		setBusyAction(action);
		setResult(null);

		try {
			const body =
				action === 'fetch-crds' ?
					{
						action,
						crds: parsedCrds,
						maxCrds: 100,
					}
				:	{
						action,
						externalRawDir,
					};

			const response = await fetch('/api/dashboard/refresh', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'x-admin-secret': adminSecret,
				},
				body: JSON.stringify(body),
			});

			const payload = (await response.json()) as ApiResponse;
			setResult(payload);
		} catch (error: any) {
			setResult({ ok: false, error: error?.message || String(error) });
		} finally {
			setBusyAction(null);
		}
	}

	return (
		<div className='fg-loading-shell'>
			<header className='fg-header'>
				<div className='fg-header-bar'>
					<div className='fg-header-brand'>
						<h1 className='fg-title'>FINRA Dashboard</h1>
					</div>
					<div className='fg-header-right-controls'>
						<a
							href='/'
							className='fg-home-link'>
							Back to Graph
						</a>
					</div>
				</div>
			</header>

			<main style={{ padding: 16, maxWidth: 980, margin: '0 auto', width: '100%' }}>
				<div className='fg-empty-card'>
					<p className='fg-empty-eyebrow'>Redis-connected refresh controls</p>
					<h2 style={{ marginTop: 0 }}>Fetch new FINRA/SEC data and deploy cache bundles</h2>

					<div style={{ display: 'grid', gap: 12 }}>
						<label style={{ display: 'grid', gap: 6 }}>
							<span>Admin Secret</span>
							<input
								type='password'
								className='fg-fetch-input'
								placeholder='ADMIN_SECRET'
								value={adminSecret}
								onChange={(event) => setAdminSecret(event.target.value)}
							/>
						</label>

						<label style={{ display: 'grid', gap: 6 }}>
							<span>CRDs (comma or space separated)</span>
							<input
								type='text'
								className='fg-fetch-input'
								placeholder='7691, 109984, 137222'
								value={crdInput}
								onChange={(event) => setCrdInput(event.target.value)}
							/>
						</label>

						<label style={{ display: 'grid', gap: 6 }}>
							<span>External raw source directory</span>
							<input
								type='text'
								className='fg-fetch-input'
								placeholder='/home/lenny/Dev/webDev/Data-finra-sec/data/raw'
								value={externalRawDir}
								onChange={(event) => setExternalRawDir(event.target.value)}
							/>
						</label>

						<div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
							<button
								type='button'
								className='fg-btn-primary fg-action-btn'
								disabled={busyAction !== null || parsedCrds.length === 0}
								onClick={() => runAction('fetch-crds')}>
								{busyAction === 'fetch-crds' ? 'Fetching…' : 'Fetch CRDs → cache + Redis'}
							</button>

							<button
								type='button'
								className='fg-ghost-btn'
								disabled={busyAction !== null}
								onClick={() => runAction('sync-and-deploy-primed')}>
								{busyAction === 'sync-and-deploy-primed' ? 'Deploying…' : 'Sync external raw + deploy primed bundles'}
							</button>
						</div>

						<div className='fg-meta'>Parsed CRDs: {parsedCrds.length ? parsedCrds.join(', ') : 'none'}</div>
					</div>
				</div>

				<div style={{ marginTop: 16 }}>
					<h3 style={{ marginBottom: 8 }}>Response</h3>
					<pre
						className='fg-log-body'
						style={{
							display: 'block',
							maxHeight: 420,
							overflow: 'auto',
							padding: 12,
							borderRadius: 8,
							background: 'rgba(15, 23, 42, 0.9)',
							color: '#e2e8f0',
						}}>
						{result ? JSON.stringify(result, null, 2) : 'Run an action to see output.'}
					</pre>
				</div>
			</main>
		</div>
	);
}
