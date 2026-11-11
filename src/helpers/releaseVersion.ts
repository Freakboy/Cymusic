/** Stable release tags only; /releases/latest does not include prereleases. */
export function isNewerRelease(tag: unknown, current: string, currentBuild?: string): boolean {
	if (typeof tag !== 'string') throw new Error('Invalid release tag')
	const release = /^v?(\d+)\.(\d+)\.(\d+)(?:-build(\d+(?:\.\d+)*))?$/.exec(tag)
	const installed = /^(\d+)\.(\d+)\.(\d+)$/.exec(current)
	if (!release || !installed) throw new Error('Invalid release version')
	const compare = (a: string[], b: string[]) => {
		for (let i = 0; i < Math.max(a.length, b.length); i++) {
			const left = Number(a[i] ?? 0), right = Number(b[i] ?? 0)
			if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right)) throw new Error('Invalid release version')
			if (left !== right) return left > right ? 1 : -1
		}
		return 0
	}
	const versionOrder = compare(release.slice(1, 4), installed.slice(1, 4))
	if (versionOrder !== 0) return versionOrder > 0
	if (!release[4] || !currentBuild || !/^\d+(?:\.\d+)*$/.test(currentBuild)) return false
	return compare(release[4].split('.'), currentBuild.split('.')) > 0
}
