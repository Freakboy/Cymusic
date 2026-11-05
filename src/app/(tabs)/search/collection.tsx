import { SearchList } from '@/components/SearchList'
import { useThemeColors } from '@/hooks/useAppTheme'
import { useSourceSearchText } from '@/locales/sourceSearch'
import type { Track } from '@/player/types'
import axios from 'axios'
import { Stack, useLocalSearchParams } from 'expo-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { View } from 'react-native'

const PAGE_SIZE = 100

export default function SearchCollection() {
	const { id, kind, title } = useLocalSearchParams<{ id: string; kind: string; title: string }>()
	const colors = useThemeColors()
	const text = useSourceSearchText()
	const [tracks, setTracks] = useState<Track[]>([])
	const [loading, setLoading] = useState(true)
	const [error, setError] = useState(false)
	const [hasMore, setHasMore] = useState(false)
	const session = useRef({
		generation: 0,
		offset: 0,
		total: null as number | null,
		pending: false,
		controller: null as AbortController | null,
	})
	const load = useCallback(async () => {
		const state = session.current
		if (state.pending) return
		state.pending = true
		const generation = state.generation
		const offset = state.offset
		const controller = new AbortController()
		state.controller = controller
		setLoading(true)
		setError(false)
		try {
			if (!id || !['albums', 'playlists'].includes(kind)) throw new Error('Invalid collection')
			const url =
				kind === 'albums'
					? `https://i.y.qq.com/v8/fcg-bin/fcg_v8_album_info_cp.fcg?albummid=${encodeURIComponent(id)}&format=json&song_begin=${offset}&song_num=${PAGE_SIZE}`
					: `https://c.y.qq.com/v8/fcg-bin/fcg_v8_playlist_cp.fcg?id=${encodeURIComponent(id)}&format=json&newsong=1&song_begin=${offset}&song_num=${PAGE_SIZE}`
			const { data } = await axios.get(url, { signal: controller.signal, timeout: 15000 })
			if (generation !== state.generation || controller.signal.aborted) return
			const collection = kind === 'albums' ? data.data : (data.data?.cdlist ?? data.cdlist)?.[0]
			const list = kind === 'albums' ? collection?.list : collection?.songlist
			if (data.code !== 0 || !Array.isArray(list)) throw new Error('Invalid collection response')
			const total = Number(
				collection.total_song_num ??
					collection.total ??
					collection.songnum ??
					collection.cur_song_num,
			)
			if (
				!Number.isSafeInteger(total) ||
				total < 0 ||
				(list.length === 0 && offset < total) ||
				offset + list.length > total ||
				(collection.song_begin != null && Number(collection.song_begin) !== offset)
			) {
				throw new Error('Incomplete collection page')
			}
			if (state.total !== null && state.total !== total) {
				// The collection changed during pagination. Retry from the beginning.
				state.offset = 0
				state.total = null
				setTracks([])
				throw new Error('Collection changed')
			}
			const songs: Track[] = list.map((raw) => {
				const item = raw.musicData || raw.songInfo || raw
				const mid = item.mid || item.songmid
				if (!mid) throw new Error('Missing song ID')
				return {
					id: String(mid),
					songmid: String(mid),
					platform: 'tx',
					title: item.title || item.songname,
					artist: (item.singer || []).map((s: { name: string }) => s.name).join(', '),
					artwork: `https://y.gtimg.cn/music/photo_new/T002R500x500M000${item.album?.mid || item.albummid}.jpg`,
				}
			})
			if (generation !== state.generation || controller.signal.aborted) return
			state.offset = offset + list.length
			state.total = total
			setHasMore(state.offset < total)
			setTracks((previous) => {
				if (generation !== state.generation) return previous
				const seen = new Set<string>()
				return [...previous, ...songs].filter((track) => {
					if (seen.has(track.id)) return false
					seen.add(track.id)
					return true
				})
			})
		} catch {
			if (generation === state.generation && !controller.signal.aborted) setError(true)
		} finally {
			if (generation === state.generation) {
				state.pending = false
				setLoading(false)
			}
		}
	}, [id, kind])
	useEffect(() => {
		const state = session.current
		state.generation++
		state.offset = 0
		state.total = null
		state.pending = false
		setTracks([])
		setHasMore(false)
		void load()
		return () => {
			state.generation++
			state.controller?.abort()
		}
	}, [load])
	return (
		<View style={{ flex: 1, backgroundColor: colors.background }}>
			<Stack.Screen
				options={{
					title: title || (kind === 'albums' ? text.albums : text.playlists),
					headerSearchBarOptions: undefined,
				}}
			/>
			<SearchList
				id="search-collection"
				tracks={tracks}
				hasMore={hasMore}
				isLoading={loading}
				onLoadMore={() => {
					if (!error && hasMore) void load()
				}}
				error={error ? text.searchError : undefined}
				onRetry={() => {
					void load()
				}}
			/>
		</View>
	)
}
