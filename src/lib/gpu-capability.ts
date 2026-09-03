/**
 * GPU capability tiers for graph visuals.
 *
 * - dedicated: discrete NVIDIA/AMD/Intel Arc → full SVG filters / effects
 * - integrated: iGPU (AMD Radeon 7xxM, Intel UHD/Iris, Apple, etc.) → safe mode
 * - software: llvmpipe / SwiftShader / etc. → safe mode
 * - unknown: probe failed → safe mode (accommodate weaker/unknown clients)
 *
 * Overrides: ?safe_gpu=0|1 or localStorage finra_safe_gpu=0|1
 */

export type GpuCapabilityTier = 'dedicated' | 'integrated' | 'software' | 'unknown';

export const SAFE_GPU_STORAGE_KEY = 'finra_safe_gpu';
export const GPU_TIER_STORAGE_KEY = 'finra_gpu_tier';

const SOFTWARE_RE = /llvmpipe|swiftshader|software|microsoft basic render|softpipe|opensource software/;
const DEDICATED_NVIDIA_RE = /\b(geforce|rtx|gtx|quadro|tesla|titan)\b/;
const DEDICATED_AMD_RE = /\b(radeon\s*rx|radeon\s*pro|radeon\s*vii|radeon\s*hd\s*[5-9]|rx\s?\d{3,4})\b/;
const DEDICATED_INTEL_ARC_RE = /\b(intel\s*arc|arc\s*(a|b)\d)\b/;
const INTEGRATED_RE =
	/\b(uhd|iris|hd graphics|radeon\s*graphics|radeon\s*\d{2,3}m|radeonsi|phoenix|rembrandt|raphael|hawk.?point|strix|apple\s*m\d|adreno|mali|xclipse|nvidia\s*graphics)\b/;

export function normalizeGpuBlob(renderer = '', vendor = '') {
	return `${renderer} ${vendor}`.toLowerCase().replace(/\s+/g, ' ').trim();
}

export function classifyGpuCapability(renderer = '', vendor = ''): GpuCapabilityTier {
	const blob = normalizeGpuBlob(renderer, vendor);
	if (!blob) return 'unknown';
	if (SOFTWARE_RE.test(blob)) return 'software';

	// Discrete cards first — hybrid laptops often report the active dGPU here.
	if (DEDICATED_NVIDIA_RE.test(blob) || DEDICATED_AMD_RE.test(blob) || DEDICATED_INTEL_ARC_RE.test(blob)) {
		return 'dedicated';
	}

	// Generic "nvidia" without GeForce/RTX can still be a dGPU (some ANGLE strings).
	if (/\bnvidia\b/.test(blob) && !INTEGRATED_RE.test(blob)) {
		return 'dedicated';
	}

	if (INTEGRATED_RE.test(blob) || /\b(amd|radeon|mesa|intel)\b/.test(blob)) {
		return 'integrated';
	}

	return 'unknown';
}

export function shouldEnableSafeGpuForTier(tier: GpuCapabilityTier): boolean {
	// Full visuals only when we positively know a dedicated GPU is driving WebGL.
	return tier !== 'dedicated';
}

export type SafeGpuOverride = 'force-on' | 'force-off' | null;

export function readSafeGpuOverride(search = '', storageGet?: (key: string) => string | null): SafeGpuOverride {
	try {
		const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
		const forced = params.get('safe_gpu') || params.get('safeGpu');
		if (forced === '1' || forced === 'true') return 'force-on';
		if (forced === '0' || forced === 'false') return 'force-off';
	} catch {
		/* ignore */
	}
	try {
		const stored = storageGet?.(SAFE_GPU_STORAGE_KEY) ?? null;
		if (stored === '1' || stored === 'true') return 'force-on';
		if (stored === '0' || stored === 'false') return 'force-off';
	} catch {
		/* ignore */
	}
	return null;
}

export function resolveSafeGpuEnabled(options: {
	renderer?: string;
	vendor?: string;
	search?: string;
	storageGet?: (key: string) => string | null;
}): { enabled: boolean; tier: GpuCapabilityTier; override: SafeGpuOverride } {
	const override = readSafeGpuOverride(options.search || '', options.storageGet);
	const tier = classifyGpuCapability(options.renderer || '', options.vendor || '');
	if (override === 'force-on') return { enabled: true, tier, override };
	if (override === 'force-off') return { enabled: false, tier, override };
	return { enabled: shouldEnableSafeGpuForTier(tier), tier, override };
}

/** Probe WebGL renderer strings in the browser. */
export function probeWebGlGpuInfo(): { renderer: string; vendor: string } {
	if (typeof document === 'undefined') return { renderer: '', vendor: '' };
	try {
		const canvas = document.createElement('canvas');
		const gl = (canvas.getContext('webgl') || canvas.getContext('experimental-webgl')) as WebGLRenderingContext | null;
		if (!gl || typeof gl.getExtension !== 'function') return { renderer: '', vendor: '' };
		const dbg = gl.getExtension('WEBGL_debug_renderer_info');
		if (dbg) {
			return {
				renderer: String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || ''),
				vendor: String(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) || ''),
			};
		}
		return {
			renderer: String(gl.getParameter(gl.RENDERER) || ''),
			vendor: String(gl.getParameter(gl.VENDOR) || ''),
		};
	} catch {
		return { renderer: '', vendor: '' };
	}
}

export function applySafeGpuDomState(enabled: boolean, tier?: GpuCapabilityTier) {
	if (typeof document === 'undefined') return;
	document.documentElement.classList.toggle('fg-safe-gpu', enabled);
	document.body?.classList.toggle('fg-safe-gpu', enabled);
	if (tier) {
		document.documentElement.dataset.gpuTier = tier;
	}
	document.documentElement.dataset.safeGpu = enabled ? '1' : '0';
}

/**
 * Inline boot script (pre-paint). Keep in sync with classifyGpuCapability / resolveSafeGpuEnabled.
 * Uses persisted tier when present so dedicated-GPU users keep full effects without waiting on WebGL.
 */
export const SAFE_GPU_BOOT_SCRIPT = `
(function () {
  try {
    var root = document.documentElement;
    var params = new URLSearchParams(window.location.search || '');
    var forced = params.get('safe_gpu') || params.get('safeGpu');
    var stored = null;
    var storedTier = null;
    try {
      stored = window.localStorage.getItem('finra_safe_gpu');
      storedTier = window.localStorage.getItem('finra_gpu_tier');
    } catch (e) {}

    function setState(enabled, tier) {
      root.classList.toggle('fg-safe-gpu', !!enabled);
      root.dataset.safeGpu = enabled ? '1' : '0';
      if (tier) root.dataset.gpuTier = tier;
    }

    if (forced === '1' || forced === 'true') { setState(true, storedTier || 'unknown'); return; }
    if (forced === '0' || forced === 'false') { setState(false, storedTier || 'dedicated'); return; }
    if (stored === '1' || stored === 'true') { setState(true, storedTier || 'unknown'); return; }
    if (stored === '0' || stored === 'false') { setState(false, storedTier || 'dedicated'); return; }

    // Persisted positive dedicated detection → full capability before first paint.
    if (storedTier === 'dedicated') { setState(false, 'dedicated'); return; }
    // Persisted non-dedicated → safe before first paint (avoids filter SIGILL on iGPU/software).
    if (storedTier === 'integrated' || storedTier === 'software' || storedTier === 'unknown') {
      setState(true, storedTier);
      return;
    }

    // First visit on Linux: start safe until WebGL probe confirms a dedicated GPU
    // (avoids SVG-filter SIGILL on iGPU/software). Dedicated NVIDIA/AMD is persisted
    // after probe so later loads get full effects before first paint.
    var ua = navigator.userAgent || '';
    var platform = navigator.platform || '';
    var isLinux = /linux/i.test(platform) || /Linux/.test(ua);
    if (isLinux) { setState(true, 'unknown'); return; }

    // Non-Linux first visit: optimistic full capability until probe.
    setState(false, 'unknown');
  } catch (error) {
    try { document.documentElement.classList.add('fg-safe-gpu'); } catch (e) {}
  }
})();
`;
