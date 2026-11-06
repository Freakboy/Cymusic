import { TracksList } from '@/components/TracksList'
import { SearchList } from '@/components/SearchList'
import { screenPadding } from '@/constants/tokens'
import searchAll from '@/helpers/searchAll'
import { generateTracksListId } from '@/helpers/miscellaneous'
import { songsNumsToLoadStore } from '@/helpers/trackPlayerIndex'
import { useThemeColors } from '@/hooks/useAppTheme'
import { useSourceSearchText } from '@/locales/sourceSearch'
import type { Track } from '@/player/types'
import { useLibraryStore, useTracks, useTracksLoading } from '@/store/library'
import { useDefaultStyles } from '@/styles'
import i18n from '@/utils/i18n'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from 'react-native'

const SongsScreen = () => {
	const colors = useThemeColors()
	const defaultStyles = useDefaultStyles()
	const text = useSourceSearchText()
	const [search, setSearch] = useState('')
	const [revision, setRevision] = useState(0)
	const input = useRef('')
	const [results, setResults] = useState<Track[]>([])
	const [searchLoading, setSearchLoading] = useState(false)
	const [error, setError] = useState(false)
	const [hasMore, setHasMore] = useState(false)
	const generation = useRef(0)
	const controller = useRef<AbortController | null>(null)
	const pending = useRef(false)
	const page = useRef(0)
	const searching = !!search.trim()
	const handleSearchChange = (value: string) => {
		if (input.current === value) return
		input.current = value
		generation.current++
		controller.current?.abort()
		pending.current = true
		setSearch(value)
		setRevision((value) => value + 1)
	}
	const fetchResults = useCallback(
		async (currentPage: number) => {
			if (!search.trim() || pending.current) return
			const request = ++generation.current
			const active = new AbortController()
			controller.current = active
			pending.current = true
			setSearchLoading(true)
			setError(false)
			try {
				const result = await searchAll(search, currentPage, 'songs', active.signal)
				if (request !== generation.current) return
				setResults((previous) => {
					if (request !== generation.current) return previous
					const seen = new Set<string>()
					return (currentPage === 1 ? result.data : [...previous, ...result.data]).filter(
						(item) => {
							const key = `${item.platform || 'tx'}:${item.id}`
							if (seen.has(key)) return false
							seen.add(key)
							return true
						},
					)
				})
				setHasMore(result.hasMore)
				page.current = currentPage
			} catch {
				if (request === generation.current && !active.signal.aborted) setError(true)
			} finally {
				if (request === generation.current) {
					pending.current = false
					setSearchLoading(false)
				}
			}
		},
		[search],
	)
	useEffect(() => {
		const requestGeneration = generation
		const activeController = controller
		requestGeneration.current++
		pending.current = false
		page.current = 0
		setResults([])
		setHasMore(false)
		setError(false)
		setSearchLoading(!!search.trim())
		const timer = setTimeout(() => {
			if (search.trim()) void fetchResults(1)
		}, 350)
		return () => {
			requestGeneration.current++
			clearTimeout(timer)
			activeController.current?.abort()
		}
	}, [search, revision, fetchResults])

	const tracks = useTracks()
	const songsNumsToLoad = songsNumsToLoadStore.useValue()
	const isLoading = useTracksLoading()
	const { fetchTracks } = useLibraryStore()

	const handleLoadMore = useCallback(() => {
		fetchTracks()
	}, [fetchTracks])

	return (
		<View style={defaultStyles.container}>
			<View
				style={{
					flexDirection: 'row',
					alignItems: 'center',
					gap: 8,
					paddingHorizontal: screenPadding.horizontal,
					paddingVertical: 8,
				}}
			>
				<TextInput
					value={search}
					onChangeText={handleSearchChange}
					placeholder={text.songSearch}
					accessibilityLabel={text.songSearch}
					placeholderTextColor={colors.placeholder}
					autoCapitalize="none"
					autoCorrect={false}
					returnKeyType="search"
					style={{
						flex: 1,
						minHeight: 44,
						borderRadius: 8,
						paddingHorizontal: 12,
						fontSize: 16,
						color: colors.text,
						backgroundColor: colors.surfaceMuted,
					}}
				/>
				<Pressable
					onPress={() => handleSearchChange('')}
					accessibilityRole="button"
					accessibilityLabel={text.clearSearch}
					style={{ minHeight: 44, minWidth: 44, alignItems: 'center', justifyContent: 'center' }}
				>
					<Text style={{ color: colors.primary }}>{text.clearSearch}</Text>
				</Pressable>
			</View>
			{searching ? (
				<SearchList
					id="home-search"
					tracks={results}
					onLoadMore={() => {
						if (!searchLoading && !error && hasMore) void fetchResults(page.current + 1)
					}}
					hasMore={hasMore}
					isLoading={searchLoading}
					error={error ? text.searchError : undefined}
					onRetry={() => void fetchResults(page.current + 1)}
					emptyMessage={text.empty}
				/>
			) : !tracks.length ? (
				<View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
					{isLoading ? (
						<ActivityIndicator size="large" color={colors.loading} />
					) : (
						<Text style={{ color: colors.textMuted, fontSize: 16 }}>
							{i18n.t('find.noMoreResults')}
						</Text>
					)}
				</View>
			) : (
				<ScrollView
					contentInsetAdjustmentBehavior="never"
					keyboardShouldPersistTaps="handled"
					keyboardDismissMode="on-drag"
					style={{ paddingHorizontal: screenPadding.horizontal }}
					onScroll={({ nativeEvent }) => {
						const { layoutMeasurement, contentOffset, contentSize } = nativeEvent
						const paddingToBottom = 60
						const isCloseToBottom =
							layoutMeasurement.height + contentOffset.y >= contentSize.height - paddingToBottom

						if (isCloseToBottom) {
							handleLoadMore()
						}
					}}
					scrollEventThrottle={400}
				>
					<TracksList
						id={generateTracksListId('songs')}
						tracks={tracks}
						scrollEnabled={false}
						numsToPlay={songsNumsToLoad}
					/>
					{isLoading && tracks.length > 0 && (
						<View style={{ paddingVertical: 20, alignItems: 'center' }}>
							<ActivityIndicator size="small" color={colors.loading} />
						</View>
					)}
				</ScrollView>
			)}
		</View>
	)
}

export default SongsScreen
