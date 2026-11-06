import { SearchList } from '@/components/SearchList'
import { ThemeColors } from '@/constants/tokens'
import { useThemeColors } from '@/hooks/useAppTheme'
import searchAll, { SearchType } from '@/helpers/searchAll'
import { useSourceSearchText } from '@/locales/sourceSearch'
import i18n from '@/utils/i18n'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
	Animated,
	useWindowDimensions,
	Pressable,
	StyleSheet,
	Text,
	TextInput,
	View,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import type { Track } from '@/player/types'

const SearchlistsScreen = () => {
	const text = useSourceSearchText()
	const [search, setSearch] = useState('')
	// Batched A -> B -> A edits still need a fresh request generation.
	const [revision, setRevision] = useState(0)
	const input = useRef('')
	const SEGMENT_WIDTH = (useWindowDimensions().width - 36) / 4
	const colors = useThemeColors()
	const styles = useMemo(() => createStyles(colors), [colors])
	// const router = useRouter()
	const [searchResults, setSearchResults] = useState<Track[]>([])
	const page = useRef(0)
	const pending = useRef(false)
	const controller = useRef<AbortController | null>(null)
	const [error, setError] = useState(false)
	const [isLoading, setIsLoading] = useState(false)
	const [hasMore, setHasMore] = useState(false)
	const searchRequestRef = useRef(0)
	const [searchType, setSearchType] = useState<SearchType>('songs')
	const slideAnim = useRef(new Animated.Value(0)).current
	useEffect(() => {
		Animated.spring(slideAnim, {
			toValue: ['songs', 'artists', 'albums', 'playlists'].indexOf(searchType) * SEGMENT_WIDTH,
			useNativeDriver: true,
			tension: 100,
			friction: 10,
		}).start()
	}, [searchType, SEGMENT_WIDTH, slideAnim])
	const handleSearchChange = (value: string) => {
		if (input.current === value) return
		input.current = value
		++searchRequestRef.current
		pending.current = true
		controller.current?.abort()
		setSearch(value)
		setRevision((value) => value + 1)
	}

	const fetchSearchResults = useCallback(
		async (currentPage: number) => {
			if (!search.trim() || pending.current) {
				return
			}

			const requestId = ++searchRequestRef.current
			const requestController = new AbortController()
			controller.current = requestController
			pending.current = true
			setError(false)
			setIsLoading(true)

			try {
				const { data, hasMore: moreResults } = await searchAll(
					search,
					currentPage,
					searchType,
					requestController.signal,
				)

				if (requestId === searchRequestRef.current) {
					setHasMore(moreResults)
					setSearchResults((prevResults) => {
						if (requestId !== searchRequestRef.current) return prevResults
						const seen = new Set<string>()
						return (currentPage === 1 ? data : [...prevResults, ...data]).filter((item) => {
							const key = `${item.platform || searchType}:${item.id}`
							if (seen.has(key)) return false
							seen.add(key)
							return true
						})
					})

					page.current = currentPage
				}
			} catch {
				if (requestId === searchRequestRef.current && !requestController.signal.aborted)
					setError(true)
			} finally {
				if (requestId === searchRequestRef.current) {
					pending.current = false
					setIsLoading(false)
				}
			}
		},
		[search, searchType],
	)
	useEffect(() => {
		const generation = searchRequestRef
		const activeController = controller
		page.current = 0
		pending.current = false
		setError(false)
		setHasMore(false)
		setSearchResults([])
		generation.current++
		setIsLoading(!!search.trim())
		const timer = setTimeout(() => {
			if (search.trim()) void fetchSearchResults(1)
		}, 350)

		return () => {
			generation.current++
			clearTimeout(timer)
			activeController.current?.abort()
		}
	}, [search, searchType, revision, fetchSearchResults])

	const handleLoadMore = useCallback(() => {
		if (!isLoading && !error && hasMore && search.trim()) {
			void fetchSearchResults(page.current + 1)
		}
	}, [isLoading, error, hasMore, fetchSearchResults, search])

	const handleSearchTypeChange = (type: SearchType) => {
		if (type === searchType) return
		++searchRequestRef.current
		pending.current = true
		controller.current?.abort()
		setSearchType(type)
		setRevision((value) => value + 1)
	}

	return (
		<SafeAreaView style={styles.safeArea} edges={['left', 'right']}>
			<View style={styles.contentContainer}>
				<View style={styles.searchRow}>
					<TextInput
						style={styles.searchInput}
						value={search}
						onChangeText={handleSearchChange}
						placeholder={text.songSearch}
						accessibilityLabel={text.songSearch}
						placeholderTextColor={colors.placeholder}
						autoCapitalize="none"
						autoCorrect={false}
						returnKeyType="search"
					/>
					<Pressable
						accessibilityRole="button"
						accessibilityLabel={text.clearSearch}
						onPress={() => handleSearchChange('')}
						style={styles.clearButton}
					>
						<Text style={{ color: colors.primary }}>{text.clearSearch}</Text>
					</Pressable>
				</View>
				<View style={styles.segmentedControlContainer}>
					<View style={styles.segmentedControl}>
						<Animated.View
							style={[
								styles.activeSegment,
								{
									position: 'absolute',
									width: SEGMENT_WIDTH,
									transform: [{ translateX: slideAnim }],
								},
							]}
						/>
						{(['songs', 'artists', 'albums', 'playlists'] as SearchType[]).map((type) => (
							<Pressable
								key={type}
								style={[styles.segment, { borderTopLeftRadius: 8, borderBottomLeftRadius: 8 }]}
								onPress={() => handleSearchTypeChange(type)}
							>
								<Text style={[styles.segmentText, searchType === type && styles.activeSegmentText]}>
									{type === 'albums' || type === 'playlists' ? text[type] : i18n.t(`find.${type}`)}
								</Text>
							</Pressable>
						))}
					</View>
				</View>
				<SearchList
					tracks={searchResults}
					id={'search'}
					onLoadMore={handleLoadMore}
					hasMore={hasMore}
					isLoading={isLoading}
					error={error ? text.searchError : undefined}
					onRetry={() => void fetchSearchResults(page.current + 1)}
					emptyMessage={search.trim() ? text.empty : text.prompt}
				/>
			</View>
		</SafeAreaView>
	)
}

const createStyles = (colors: ThemeColors) =>
	StyleSheet.create({
		container: {
			flex: 1,
			backgroundColor: colors.background,
		},
		safeArea: {
			flex: 1,
			backgroundColor: colors.background,
		},
		contentContainer: {
			flex: 1,
			backgroundColor: colors.background,
			paddingTop: 8,
		},
		searchRow: {
			flexDirection: 'row',
			alignItems: 'center',
			marginHorizontal: 16,
			marginBottom: 8,
			gap: 8,
		},
		searchInput: {
			flex: 1,
			minHeight: 44,
			borderRadius: 8,
			paddingHorizontal: 12,
			fontSize: 16,
			color: colors.text,
			backgroundColor: colors.surfaceMuted,
		},
		clearButton: {
			minHeight: 44,
			minWidth: 44,
			justifyContent: 'center',
			alignItems: 'center',
		},
		segmentedControlContainer: {
			paddingHorizontal: 16,
			marginTop: 0,
			paddingBottom: 4,
		},
		segmentedControl: {
			flexDirection: 'row',
			backgroundColor: colors.surfaceMuted,
			borderRadius: 8,
			padding: 2,
			position: 'relative',
		},
		segment: {
			minHeight: 44,
			flex: 1,
			paddingVertical: 6,
			alignItems: 'center',
			justifyContent: 'center',
			zIndex: 1,
		},
		activeSegment: {
			backgroundColor: colors.surfaceElevated,
			borderRadius: 6,
			shadowColor: colors.shadow,
			shadowOffset: {
				width: 0,
				height: 1,
			},
			shadowOpacity: 0.15,
			shadowRadius: 2,
			elevation: 2,
			position: 'absolute',
			top: 2,
			bottom: 2,
			zIndex: 0,
		},
		segmentText: {
			fontSize: 15,
			color: colors.textMuted,
		},
		activeSegmentText: {
			color: colors.primary,
			fontWeight: '500',
		},
	})

export default SearchlistsScreen
