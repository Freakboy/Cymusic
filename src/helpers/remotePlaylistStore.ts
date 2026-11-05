import { playListsStore } from '@/player/PlayerStore'
import PersistStatus from '@/store/PersistStatus'
import { fetchRemotePlaylist, findBoundPlaylist, getPlaylistReference, mergeRemotePlaylist, type RemotePlaylistResult } from './userApi/remotePlaylist'

export type PlaylistImportMode = 'update' | 'copy' | 'merge'

function save(playlists: IMusic.PlayList[]) {
	PersistStatus.set('music.playLists', playlists)
	playListsStore.setValue(playlists)
}

export function importRemotePlaylist(latest: RemotePlaylistResult, mode: PlaylistImportMode = 'update', overrides?: { name?: string; artwork?: string }) {
	const playlists = playListsStore.getValue() || []
	const existing = findBoundPlaylist(playlists, latest.remoteBinding)
	let result: IMusic.PlayList = latest
	if (mode === 'copy') {
		let suffix = 1
		while (playlists.some((item) => item.id === `${latest.id}:copy:${suffix}`)) suffix++
		result = { ...latest, id: `${latest.id}:copy:${suffix}`, name: `${latest.name} (副本)`, title: `${latest.title} (副本)`,
			platform: 'local', remoteBinding: undefined, customName: true }
	} else if (existing) {
		result = mergeRemotePlaylist(existing, latest, mode === 'merge')
	}
	if (overrides?.name?.trim()) result = { ...result, name: overrides.name.trim(), title: overrides.name.trim(), customName: true }
	if (overrides?.artwork) result = { ...result, artwork: overrides.artwork, coverImg: overrides.artwork, customCover: true }
	if (playlists.some((item) => item.id === result.id && item !== existing)) throw new Error('本地歌单 ID 已被占用')
	if (!existing || mode === 'copy') {
		save([...playlists, result])
	} else {
		save(playlists.map((item) => item.id === existing.id ? result : item))
	}
	return result
}

const refreshing = new Map<string, Promise<IMusic.PlayList>>()

export function refreshRemotePlaylist(playlistId: string): Promise<IMusic.PlayList> {
	const pending = refreshing.get(playlistId)
	if (pending) return pending
	const task = (async () => {
		const initial = (playListsStore.getValue() || []).find((item) => item.id === playlistId)
		const reference = initial && getPlaylistReference(initial)
		if (!reference) throw new Error('此歌单未绑定远端来源')
		const latest = await fetchRemotePlaylist(reference)
		// Re-read after the request to preserve edits/additions made while it was in flight.
		const playlists = playListsStore.getValue() || []
		const existing = playlists.find((item) => item.id === playlistId)
		if (!existing) throw new Error('歌单已被删除')
		const result = mergeRemotePlaylist(existing, latest)
		if (playlists.some((item) => item.id === result.id && item !== existing)) throw new Error('本地歌单 ID 已被占用')
		save(playlists.map((item) => item.id === playlistId ? result : item))
		return result
	})()
	refreshing.set(playlistId, task)
	void task.finally(() => refreshing.delete(playlistId)).catch(() => {})
	return task
}
