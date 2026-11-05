import { NativeModule, requireNativeModule } from 'expo'

export type CarPlaySelection = {
	id: string
	queueJSON: string
	index: number
	createdAt: number
}

declare class CyMusicNowPlaying extends NativeModule<{ onCarPlaySelect: () => void }> {
	setCarPlaySnapshot(json: string): Promise<void>
	getPendingCarPlaySelection(): Promise<CarPlaySelection | null>
	completeCarPlaySelection(id: string, playing: boolean): Promise<void>
}

export default requireNativeModule<CyMusicNowPlaying>('CyMusicNowPlaying')
