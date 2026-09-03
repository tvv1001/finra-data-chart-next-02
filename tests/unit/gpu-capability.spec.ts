import { describe, expect, it } from 'vitest';
import {
	classifyGpuCapability,
	resolveSafeGpuEnabled,
	shouldEnableSafeGpuForTier,
} from '../../src/lib/gpu-capability';

describe('gpu-capability', () => {
	it('classifies dedicated NVIDIA (e.g. RTX 4060) for full visual capability', () => {
		expect(
			classifyGpuCapability('ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Laptop GPU, OpenGL ES 3.2)', 'Google Inc. (NVIDIA)'),
		).toBe('dedicated');
		expect(shouldEnableSafeGpuForTier('dedicated')).toBe(false);
	});

	it('classifies dedicated AMD Radeon RX for full visual capability', () => {
		expect(classifyGpuCapability('ANGLE (AMD, AMD Radeon RX 7800 XT, OpenGL ES 3.2)', 'Google Inc. (AMD)')).toBe('dedicated');
		expect(shouldEnableSafeGpuForTier('dedicated')).toBe(false);
	});

	it('classifies AMD integrated graphics for safe mode', () => {
		expect(
			classifyGpuCapability('ANGLE (AMD, AMD Radeon 780M Graphics (radeonsi phoenix ACO), OpenGL ES 3.2)', 'Google Inc. (AMD)'),
		).toBe('integrated');
		expect(shouldEnableSafeGpuForTier('integrated')).toBe(true);
	});

	it('classifies Intel UHD / Iris as integrated', () => {
		expect(classifyGpuCapability('ANGLE (Intel, Mesa Intel(R) UHD Graphics 620, OpenGL ES 3.2)', 'Google Inc. (Intel)')).toBe(
			'integrated',
		);
	});

	it('classifies software renderers as software', () => {
		expect(classifyGpuCapability('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device), ...)', 'Google Inc.')).toBe('software');
		expect(classifyGpuCapability('llvmpipe (LLVM 15.0.7, 256 bits)', 'Mesa')).toBe('software');
		expect(shouldEnableSafeGpuForTier('software')).toBe(true);
	});

	it('honors URL and storage overrides over tier', () => {
		const dedicated = resolveSafeGpuEnabled({
			renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4060, OpenGL ES 3.2)',
			vendor: 'Google Inc. (NVIDIA)',
			search: '?safe_gpu=1',
		});
		expect(dedicated.enabled).toBe(true);
		expect(dedicated.tier).toBe('dedicated');
		expect(dedicated.override).toBe('force-on');

		const forcedOff = resolveSafeGpuEnabled({
			renderer: 'llvmpipe',
			vendor: 'Mesa',
			search: '',
			storageGet: (key) => (key === 'finra_safe_gpu' ? '0' : null),
		});
		expect(forcedOff.enabled).toBe(false);
		expect(forcedOff.override).toBe('force-off');
	});

	it('defaults unknown / empty probe to safe mode', () => {
		expect(classifyGpuCapability('', '')).toBe('unknown');
		expect(shouldEnableSafeGpuForTier('unknown')).toBe(true);
		expect(resolveSafeGpuEnabled({ renderer: '', vendor: '' }).enabled).toBe(true);
	});
});
