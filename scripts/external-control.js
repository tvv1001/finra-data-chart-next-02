// Central switch to enable/disable external API calls for the repo.
// Set DISABLE_EXTERNAL_API_CALLS=1 in the environment to disable any script that
// checks this guard from making outbound network requests.

function externalApisEnabled() {
	return !(process.env.DISABLE_EXTERNAL_API_CALLS === '1');
}

function assertExternalApisEnabled(scriptName) {
	if (!externalApisEnabled()) {
		console.warn(`${scriptName || 'script'}: External API calls are disabled via DISABLE_EXTERNAL_API_CALLS=1; exiting.`);
		// Exit with non-error when intentionally disabled so callers can handle it.
		process.exit(0);
	}
}

module.exports = { externalApisEnabled, assertExternalApisEnabled };
