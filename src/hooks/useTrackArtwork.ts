import { useCallback, useEffect, useRef, useState } from 'react'
import { useFlashListContext } from '@shopify/flash-list'
import { unknownTrackImageUri } from '@/constants/images'
import { ArtworkTrack, repairNeteaseArtwork, updateTrackArtwork, subscribeArtworkRefresh } from '@/helpers/neteaseArtwork'
import { getFullArtwork, getThumbnailArtwork, neteaseArtworkKey, usableArtwork } from '@/utils/imageUtils'

let manualRefreshSequence = Date.now()

function isVisibleTrack(track: ArtworkTrack, list: ReturnType<typeof useFlashListContext<ArtworkTrack>>) {
	const ref = list?.getRef()
	if (!ref) return false
	const { startIndex, endIndex } = ref.computeVisibleIndices()
	for (let index = startIndex; index <= endIndex; index++) {
		const item = ref.props.data?.[index]
		if (neteaseArtworkKey(track) && neteaseArtworkKey(item) === neteaseArtworkKey(track)) return true
	}
	return false
}

/** Recycled/pre-rendered cells may be mounted outside the visible range. */
export function useTrackArtwork(
	track: ArtworkTrack | null | undefined,
	current = false,
	options: { fullSize?: boolean; onConfirmed?: (track: ArtworkTrack, uri: string) => void } = {},
) {
	const id = track?.id
	const platform = track?.platform
	const artwork = track?.artwork
	const list = useFlashListContext<ArtworkTrack>()
	const visibilityKey = neteaseArtworkKey(track) ?? `${platform}:${id}`
	const [visibility, setVisibility] = useState({ key: visibilityKey, value: false })
	const visible = !!track && (current || (visibility.key === visibilityKey && visibility.value))
	const identity = `${visibilityKey}:${artwork ?? ''}`
	const [state, setState] = useState({ identity, uri: usableArtwork(artwork) })
	const displayed = state.identity === identity ? state : { identity, uri: usableArtwork(artwork) }
	const attempt = useRef({ identity, failed: new Set<string>(), exhausted: false, retries: 0, confirmed: '' })
	if (attempt.current.identity !== identity) attempt.current = { identity, failed: new Set(), exhausted: false, retries: 0, confirmed: '' }
	const [retry, setRetry] = useState(0)
	const [manualRevision, setManualRevision] = useState(0)
	const imageToken = `${identity}:${displayed.uri ?? ''}:${manualRevision}`
	const activeImage = useRef(imageToken)
	const deadline = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
	activeImage.current = imageToken
	useEffect(() => subscribeArtworkRefresh({ id, platform }, uri => {
		activeImage.current = ''
		attempt.current = { identity, failed: new Set(), exhausted: false, retries: 0, confirmed: '' }
		setState({ identity, uri })
		setManualRevision(++manualRefreshSequence)
	}), [id, platform, identity])
	useEffect(() => {
		activeImage.current = imageToken
		return () => { activeImage.current = '' }
	}, [imageToken])

	useEffect(() => {
		if (current || !neteaseArtworkKey({ id, platform })) return
		const check = () => {
			const value = isVisibleTrack({ id, platform }, list)
			setVisibility(previous => previous.key === visibilityKey && previous.value === value
				? previous : { key: visibilityKey, value })
		}
		check()
		const timer = setInterval(check, 500)
		return () => clearInterval(timer)
	}, [list, current, id, platform, visibilityKey])

	const failImage = useCallback(() => {
		if (!displayed.uri || activeImage.current !== imageToken) return
		activeImage.current = ''
		attempt.current.failed.add(displayed.uri)
		if (attempt.current.confirmed === displayed.uri) attempt.current.confirmed = ''
		setState({ identity, uri: undefined })
	}, [displayed.uri, identity, imageToken])
	useEffect(() => {
		if (!visible || !displayed.uri || !/^https?:/.test(displayed.uri) || !neteaseArtworkKey({ id, platform }) || attempt.current.confirmed === displayed.uri) return
		deadline.current = setTimeout(() => {
			if (current || isVisibleTrack({ id, platform }, list)) failImage()
		}, 8000)
		return () => { clearTimeout(deadline.current); deadline.current = undefined }
	}, [imageToken, displayed.uri, failImage, visible, current, list, id, platform])

	// Race exact-ID metadata against local CDN candidates, never against a successful image.
	const failedImage = attempt.current.failed.size > 0
	useEffect(() => {
		if (!visible || !failedImage || !neteaseArtworkKey({ id, platform })) return
		const session = attempt.current
		let cancelled = false
		const isActive = () => !cancelled && attempt.current === session && (current || isVisibleTrack({ id, platform }, list))
		void repairNeteaseArtwork({ id, platform, artwork }, [...session.failed], { detailOnly: true, isActive }).then(result => {
			if (!isActive() || (session.confirmed && !session.failed.has(session.confirmed))) return
			const candidate = result.candidates?.find(uri => !session.failed.has(uri))
			if (candidate) setState({ identity, uri: candidate })
		})
		return () => { cancelled = true }
	}, [visible, failedImage, identity, retry, current, list, id, platform, artwork])

	useEffect(() => {
		const session = attempt.current
		if (!visible) { session.exhausted = false; session.retries = 0; session.failed.clear(); return }
		if (displayed.uri || !neteaseArtworkKey({ id, platform }) || session.exhausted) return
		if (!current && !isVisibleTrack({ id, platform }, list)) return
		let cancelled = false
		let timer: ReturnType<typeof setTimeout> | undefined
		void repairNeteaseArtwork({ id, platform, artwork }, [...session.failed], {
			isActive: () => !cancelled && attempt.current === session && (current || isVisibleTrack({ id, platform }, list)),
		}).then(result => {
			if (cancelled || attempt.current !== session) return
			session.exhausted = !result.artwork
			setState({ identity, uri: result.artwork || undefined })
			if (!result.artwork && result.retryable && session.retries < 2) {
				session.retries++
				timer = setTimeout(() => {
					session.exhausted = false
					session.failed.clear()
					setRetry(value => value + 1)
				}, Math.max(1000, (result.retryAt ?? Date.now() + 1000) - Date.now()))
			}
		})
		return () => { cancelled = true; if (timer !== undefined) clearTimeout(timer) }
	}, [visible, current, list, displayed.uri, identity, id, platform, artwork, retry])

	const uri = displayed.uri
		? (options.fullSize ? getFullArtwork(displayed.uri)! : getThumbnailArtwork(displayed.uri)!)
		: unknownTrackImageUri
	return {
		source: { uri: manualRevision && /^https?:/.test(uri)
			? `${uri}${uri.includes('?') ? '&' : '?'}cymusicArtworkRetry=${manualRevision}` : uri },
		onError: failImage,
		onLoad: () => {
			if (!track || !displayed.uri || activeImage.current !== imageToken) return
			clearTimeout(deadline.current)
			deadline.current = undefined
			if (attempt.current.confirmed !== displayed.uri) {
				attempt.current.confirmed = displayed.uri
				updateTrackArtwork(track, displayed.uri)
			}
			if (current) options.onConfirmed?.(track, displayed.uri)
		},
	}
}
