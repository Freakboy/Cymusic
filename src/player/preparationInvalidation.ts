const listeners = new Set<() => void>()

export function onPreparationInvalidated(listener: () => void) {
	listeners.add(listener)
	return () => {
		listeners.delete(listener)
	}
}

export function invalidatePlaybackPreparation() {
	for (const listener of listeners) listener()
}
