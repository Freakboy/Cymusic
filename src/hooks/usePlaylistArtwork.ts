import { useRef, useState } from 'react'
import { unknownTrackImageUri } from '@/constants/images'
import { usableArtwork } from '@/utils/imageUtils'

/** Defaults are display-only: do not overwrite a remotely refreshable cover. */
export function usePlaylistArtwork(playlist?: { id?: string; coverImg?: string; artwork?: string } | null) {
	const candidates = [...new Set([usableArtwork(playlist?.coverImg), usableArtwork(playlist?.artwork)].filter((uri): uri is string => !!uri))]
	const identity = JSON.stringify([playlist?.id, candidates])
	const [failures, setFailures] = useState<{ identity: string; urls: string[] }>({ identity, urls: [] })
	const failed = failures.identity === identity ? failures.urls : []
	const uri = candidates.find(value => !failed.includes(value)) ?? unknownTrackImageUri
	const token = JSON.stringify([identity, uri])
	const current = useRef(token)
	current.current = token
	return {
		source: { uri },
		placeholder: { uri: unknownTrackImageUri },
		onError: () => {
			if (current.current !== token || uri === unknownTrackImageUri) return
			setFailures({ identity, urls: [...failed, uri] })
		},
	}
}
