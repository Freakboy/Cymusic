import React, { useCallback, useEffect, useMemo, useRef } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native'
import type { FlatList as NativeFlatList, FlatListProps } from 'react-native'

import { ThemeColors } from '@/constants/tokens'
import LyricManager from '@/helpers/lyricManager'
import myTrackPlayer, { lyricsStatusStore, nowLyricState, nowTranslationLyricState } from '@/helpers/trackPlayerIndex'
import { useThemeColors } from '@/hooks/useAppTheme'
import useDelayFalsy from '@/hooks/useDelayFalsy'
import PersistStatus from '@/store/PersistStatus'
import i18n from '@/locales/commentsFeature'
import delay from '@/utils/delay'
import { musicIsPaused } from '@/utils/trackUtils'
import { useIsPlaying } from '@rntp/player'
import { FlatList } from 'react-native-gesture-handler'
import rpx from '../../utils/rpx'
import LyricItemComponent from './lyricItem'
const LyricFlatList = FlatList as React.ForwardRefExoticComponent<
	FlatListProps<ILyric.IParsedLrcItem> & React.RefAttributes<NativeFlatList<ILyric.IParsedLrcItem>>
>
const ITEM_HEIGHT = rpx(92)
const AUTO_SCROLL_THROTTLE_MS = 900
const AUTO_SCROLL_MIN_INDEX_DELTA = 2

interface IItemHeights {
	blankHeight?: number
	[k: number]: number
}

interface IProps {
	onTurnPageClick?: () => void
}

const fontSizeMap = {
	0: rpx(24),
	1: rpx(30),
	2: rpx(36),
	3: rpx(42),
} as Record<number, number>

export default function Lyric(_props: IProps) {
	void _props
	const colors = useThemeColors()
	const styles = useMemo(() => createStyles(colors), [colors])
	// const lrcSource = {
	// 	rawLrc: nowLyricState.useValue() || '[00:00.00]暂无歌词',
	// } as ILyric.ILyricSource
	// const musicItem = myTrackPlayer.getCurrentMusic()
	// const parser = new LyricParser(lrcSource, musicItem, {})
	// const lyrics = parser.getLyric()
	// console.log('lyrics', lyrics)
	const lyricsStatus = lyricsStatusStore.useValue()
	const rawLyric = nowLyricState.useValue()
	const rawTranslation = nowTranslationLyricState.useValue()
	const currentMusic = myTrackPlayer.useCurrentMusic()
	const loading = lyricsStatus.status === 'loading'
	useEffect(() => {
		void LyricManager.refreshLyric()
	}, [rawLyric, rawTranslation, currentMusic])
	const { meta, lyrics, translationLyrics } = LyricManager.useLyricState()
	// console.log('lyrics', lyrics)
	const currentLrcItem = LyricManager.useCurrentLyric()
	const showTranslation = PersistStatus.useValue('lyric.showTranslation', false) === true
	const displayMode = PersistStatus.useValue('lyric.displayMode') ?? (showTranslation ? 'bilingual' : 'original')
	const fontSizeKey = PersistStatus.useValue('lyric.detailFontSize', 1)
	const { width, fontScale } = useWindowDimensions()
	const fontSizeStyle = useMemo(
		() => ({
			fontSize: fontSizeMap[fontSizeKey!],
		}),
		[fontSizeKey],
	)

	const [draggingIndex, setDraggingIndex] = useDelayFalsy<number | undefined>(undefined, 2000)
	const playing = useIsPlaying()

	const listRef = useRef<NativeFlatList<ILyric.IParsedLrcItem> | null>(null)

	// 是否展示拖拽
	const dragShownRef = useRef(false)

	// 用来缓存高度
	const { key: layoutKey, heights: itemHeights } = useMemo(() => ({
		key: JSON.stringify([lyrics, translationLyrics, displayMode, fontSizeKey, width, fontScale]),
		heights: {} as IItemHeights,
	}), [lyrics, translationLyrics, displayMode, fontSizeKey, width, fontScale])
	const lastAutoScrollAtRef = useRef(0)
	const lastAutoScrollIndexRef = useRef(-1)

	// 设置空白组件，获取组件高度
	const blankComponent = useMemo(() => {
		return (
			<View
				style={styles.empty}
				onLayout={(evt) => {
					itemHeights.blankHeight = evt.nativeEvent.layout.height
				}}
			/>
		)
	}, [styles.empty, itemHeights])

	const handleLyricItemLayout = useCallback((index: number, height: number) => {
		itemHeights[index] = height
	}, [itemHeights])

	const clampLyricIndex = useCallback((index: number, listLength: number) => {
		if (listLength <= 0) {
			return 0
		}
		return Math.min(Math.max(index, 0), listLength - 1)
	}, [])

	const scrollToLyricIndex = useCallback(
		(index: number, listLength: number, force = false) => {
			if (!listRef.current || listLength <= 0) {
				return
			}
			const targetIndex = clampLyricIndex(index, listLength)
			const now = Date.now()
			const indexDelta = Math.abs(targetIndex - lastAutoScrollIndexRef.current)
			const shouldSkip =
				!force &&
				now - lastAutoScrollAtRef.current < AUTO_SCROLL_THROTTLE_MS &&
				indexDelta < AUTO_SCROLL_MIN_INDEX_DELTA
			if (shouldSkip) {
				return
			}

			listRef.current.scrollToIndex({
				index: targetIndex,
				viewPosition: 0.5,
			})
			lastAutoScrollAtRef.current = now
			lastAutoScrollIndexRef.current = targetIndex
		},
		[clampLyricIndex],
	)

	// 滚到当前item
	const scrollToCurrentLrcItem = useCallback(() => {
		const lyricState = LyricManager.getLyricState()
		const lyricItems = lyricState.lyrics
		if (lyricItems.length === 0) {
			return
		}
		const currentLrcItem = LyricManager.getCurrentLyric()
		const targetIndex = currentLrcItem?.index === -1 || !currentLrcItem ? 0 : currentLrcItem.index ?? 0
		scrollToLyricIndex(targetIndex, lyricItems.length, true)
	}, [scrollToLyricIndex])

	// const delayedScrollToCurrentLrcItem = useMemo(() => {
	// 	let sto: number

	// 	return () => {
	// 		if (sto) {
	// 			clearTimeout(sto)
	// 		}
	// 		sto = setTimeout(() => {
	// 			if (isMountedRef.current) {
	// 				scrollToCurrentLrcItem()
	// 			}
	// 		}, 200) as any
	// 	}
	// }, [])

	useEffect(() => {
		// 暂停且拖拽才返回
		if (
			lyrics.length === 0 ||
			draggingIndex !== undefined ||
			(draggingIndex === undefined && musicIsPaused(playing)) ||
			lyrics[lyrics.length - 1].time < 1
		) {
			return
		}
		const targetIndex = currentLrcItem?.index === -1 || !currentLrcItem ? 0 : currentLrcItem.index ?? 0
		scrollToLyricIndex(targetIndex, lyrics.length)
	}, [currentLrcItem, lyrics, draggingIndex, playing, scrollToLyricIndex])

	useEffect(() => {
		scrollToCurrentLrcItem()
	}, [scrollToCurrentLrcItem, layoutKey])

	const getItemLayout = useCallback((_: unknown, index: number) => {
		const headerHeight = itemHeights.blankHeight ?? 0
		let offset = headerHeight
		for (let i = 0; i < index; i++) {
			offset += itemHeights[i] ?? ITEM_HEIGHT
		}
		const length = itemHeights[index] ?? ITEM_HEIGHT
		return {
			length,
			offset,
			index,
		}
	}, [itemHeights])

	const onScrollBeginDrag = useCallback(() => {
		dragShownRef.current = true
	}, [])

	const onScrollEndDrag = useCallback(async () => {
		if (draggingIndex !== undefined) {
			setDraggingIndex(undefined)
		}
		dragShownRef.current = false
	}, [draggingIndex, setDraggingIndex])

	const onScroll = useCallback((e: any) => {
		if (dragShownRef.current) {
			const offset = e.nativeEvent.contentOffset.y + e.nativeEvent.layoutMeasurement.height / 2

			let height = itemHeights.blankHeight ?? 0
			if (offset <= height) {
				setDraggingIndex(0)
				return
			}
			for (let i = 0; i < lyrics.length; ++i) {
				height += itemHeights[i] ?? ITEM_HEIGHT
				if (height > offset) {
					setDraggingIndex(i)
					return
				}
			}
		}
	}, [lyrics.length, setDraggingIndex, itemHeights])

	const handleLyricItemPress = useCallback(
		async (index: number) => {
			if (index >= 0 && index < lyrics.length) {
				const time = lyrics[index].time + +(meta?.offset ?? 0)
				if (time !== undefined && !isNaN(time)) {
					myTrackPlayer.seekTo(time)
					await myTrackPlayer.play()
				}
			}
		},
		[lyrics, meta?.offset],
	)

	const listHeader = useMemo(() => (
		<>
			{blankComponent}
			<View style={styles.lyricMeta}></View>
		</>
	), [blankComponent, styles.lyricMeta])

	const translationsByLine = useMemo(() => {
		let translationIndex = 0
		return lyrics.map((item, index) => {
			if (!translationLyrics?.length) return undefined
			while (translationIndex + 1 < translationLyrics.length &&
				Math.abs(translationLyrics[translationIndex + 1].time - item.time) <=
				Math.abs(translationLyrics[translationIndex].time - item.time)) {
				++translationIndex
			}
			const entry = translationLyrics[translationIndex]
			const distance = Math.abs(entry.time - item.time)
			// Allow timestamp rounding, but do not borrow a neighbouring line's translation.
			if (distance > 0.25 ||
				(index > 0 && Math.abs(lyrics[index - 1].time - entry.time) < distance) ||
				(index + 1 < lyrics.length && Math.abs(lyrics[index + 1].time - entry.time) < distance)) {
				return undefined
			}
			return entry.lrc
		})
	}, [lyrics, translationLyrics])

	const renderLyricItem = useCallback(({ item, index }: { item: ILyric.IParsedLrcItem; index: number }) => {
		const translation = translationsByLine[index]
		return (
			<LyricItemComponent
				index={index}
				text={displayMode === 'translation' && translation ? translation : item.lrc}
				translation={displayMode === 'bilingual' ? translation : undefined}
				fontSize={fontSizeStyle.fontSize}
				onLayout={handleLyricItemLayout}
				light={draggingIndex === index}
				highlight={currentLrcItem?.index === index}
				onPress={() => handleLyricItemPress(index)}
			/>
		)
	}, [fontSizeStyle.fontSize, handleLyricItemLayout, draggingIndex, currentLrcItem?.index, handleLyricItemPress, displayMode, translationsByLine])

	return (
		<>
			<View style={styles.fwflex1}>
				{rawLyric?.trim() && lyrics?.length ? (
					<LyricFlatList
						key={layoutKey}
						ref={(_) => {
							listRef.current = _
						}}
						viewabilityConfig={{
							itemVisiblePercentThreshold: 100,
						}}
						onScrollToIndexFailed={({ index }) => {
							delay(120).then(() => {
								scrollToLyricIndex(index ?? 0, lyrics.length, true)
							})
						}}
						fadingEdgeLength={120}
					ListHeaderComponent={listHeader}
					ListFooterComponent={blankComponent}
					onScrollBeginDrag={onScrollBeginDrag}
					onMomentumScrollEnd={onScrollEndDrag}
					onScroll={onScroll}
					scrollEventThrottle={32}
					style={styles.wrapper}
					data={lyrics}
					initialNumToRender={30}
					overScrollMode="never"
					extraData={currentLrcItem?.index ?? -1}
					getItemLayout={getItemLayout}
					renderItem={renderLyricItem}
					/>
				) : (
					<View style={styles.fullCenter}>
						{loading && <ActivityIndicator size="large" color={colors.loading} />}
						<Text style={[styles.white, fontSizeStyle]}>{i18n.t(`commentsFeature.${loading ? 'lyricsLoading' : lyricsStatus.status === 'instrumental' ? 'lyricsInstrumental' : lyricsStatus.status === 'error' ? 'lyricsFailed' : 'lyricsUnavailable'}`)}</Text>
						{!loading && lyricsStatus.status === 'error' && lyricsStatus.retryable && (
							<Pressable accessibilityRole="button" onPress={async () => {
								await myTrackPlayer.retryCurrentLyrics()
							}}>
								<Text style={styles.searchLyric}>{i18n.t('commentsFeature.retry')}</Text>
							</Pressable>
						)}
					</View>
				)}
			</View>
		</>
	)
}

const createStyles = (colors: ThemeColors) =>
	StyleSheet.create({
	wrapper: {
		width: '100%',
		marginVertical: rpx(48),
		flex: 1,
	},
	fwflex1: {
		width: '100%',
		flex: 1,
	},
	empty: {
		paddingTop: '70%',
	},
	white: {
		color: colors.text,
	},
	lyricMeta: {
		position: 'absolute',
		width: '100%',
		flexDirection: 'row',
		justifyContent: 'center',
		alignItems: 'center',
		left: 0,
		paddingHorizontal: rpx(48),
		bottom: rpx(48),
	},
	lyricMetaText: {
		color: colors.text,
		opacity: 0.8,
		maxWidth: '80%',
	},
	linkText: {
		color: colors.primary,
		textDecorationLine: 'underline',
	},
	fullCenter: {
		width: '100%',
		flex: 1,
		justifyContent: 'center',
		alignItems: 'center',
	},

	singleLine: {
		width: '67%',
		height: 1,
		backgroundColor: colors.separator,
		opacity: 0.4,
	},
	playIcon: {
		width: rpx(90),
		textAlign: 'right',
		color: colors.text,
	},
	searchLyric: {
		width: rpx(180),
		marginTop: rpx(14),
		paddingVertical: rpx(10),
		textAlign: 'center',
		alignSelf: 'center',
		color: colors.primary,
		textDecorationLine: 'underline',
	},
	})
