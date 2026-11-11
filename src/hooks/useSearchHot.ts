import { fetchSearchHot, HotKind } from '@/helpers/searchHot'
import type { Track } from '@/player/types'
import { useCallback, useEffect, useRef, useState } from 'react'

// Each section owns its own request, loading/error state and retry generation.
export function useSearchHot(kind: HotKind, visible: boolean) {
	const [tracks, setTracks] = useState<Track[]>([])
	const [loading, setLoading] = useState(false)
	const [error, setError] = useState(false)
	const [revision, setRevision] = useState(0)
	const loaded = useRef(false)
	useEffect(() => {
		if (!visible || loaded.current) return
		const controller = new AbortController()
		setLoading(true)
		setError(false)
		void fetchSearchHot(kind, controller.signal)
			.then((data) => {
				if (controller.signal.aborted) return
				loaded.current = true
				setTracks(data)
			})
			.catch(() => {
				if (!controller.signal.aborted) setError(true)
			})
			.finally(() => {
				if (!controller.signal.aborted) setLoading(false)
			})
		return () => controller.abort()
	}, [kind, visible, revision])
	const retry = useCallback(() => {
		loaded.current = false
		setRevision((value) => value + 1)
	}, [])
	return { tracks, loading, error, retry }
}
