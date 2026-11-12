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
	const page = useRef(0)
	const busy = useRef(false)
	const [hasMore, setHasMore] = useState(kind === 'playlists')
	useEffect(() => {
		if (!visible || loaded.current) return
		const controller = new AbortController()
		const requestedPage = page.current
		busy.current = true
		setLoading(true)
		setError(false)
		void fetchSearchHot(kind, controller.signal, requestedPage)
			.then((data) => {
				if (controller.signal.aborted) return
				loaded.current = true
				setTracks(previous => {
					if (requestedPage === 0) return data
					const seen = new Set(previous.map(track => track.id))
					return [...previous, ...data.filter(track => !seen.has(track.id))]
				})
				setHasMore(kind === 'playlists' && data.length === 10 && requestedPage < 99)
			})
			.catch(() => {
				if (!controller.signal.aborted) setError(true)
			})
			.finally(() => {
				if (!controller.signal.aborted) { busy.current = false; setLoading(false) }
			})
		return () => { controller.abort(); busy.current = false }
	}, [kind, visible, revision])
	const retry = useCallback(() => {
		loaded.current = false
		setRevision((value) => value + 1)
	}, [])
	const refresh = useCallback(() => {
		page.current = 0
		loaded.current = false
		setRevision(value => value + 1)
	}, [])
	const loadMore = () => {
		if (!visible || busy.current || !loaded.current || !hasMore || kind !== 'playlists') return
		page.current += 1
		loaded.current = false
		busy.current = true
		setRevision(value => value + 1)
	}
	return { tracks, loading, error, retry, refresh, loadMore, hasMore }
}
