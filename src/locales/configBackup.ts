import { nowLanguage } from '@/utils/i18n'

const zh = {
	exportStages: { COLLECT: '无法整理配置，请检查音源或歌单数据。', VALIDATE: '导出内容校验失败或超过备份限制。',
		CACHE: '缓存目录不可用。', WRITE: '无法写入配置文件，请检查存储空间。', SHARE: 'iOS 文件分享失败，请重试或检查运行环境。', CLEANUP: '临时备份清理失败，缓存中可能仍有敏感文件。' },
	section: '配置备份', export: '导出配置 JSON', import: '导入配置 JSON',
	exportTitle: '分享配置备份',
	exportUnsupported: '配置 JSON 文件导出目前仅支持 iOS；Android 导出暂未实现。不会将配置作为文本分享。',
	exportWarning: '备份包含设置、音源脚本、歌单和收藏。脚本可能包含密钥或其他敏感内容，歌单和收藏也可能泄露个人信息。请只分享给可信的人。备份不含播放地址、headers、缓存、本机文件或当前播放进度。',
	previewTitle: '确认导入配置',
	preview: 'MMKV 设置 %{settings} 项 · local-config 设置 %{localSettings} 项\n音源 %{sources} 个 · 歌单 %{playlists} 个\n歌曲 %{songs} 首 · 收藏 %{favorites} 首',
	importWarning: '确认后将替换现有音源、歌单和收藏，并应用备份中包含的设置；未包含的设置保持不变。音源脚本可能执行危险操作，请仅导入可信备份。脚本将保持禁用且不选中，不会自动运行；需到音源管理手动启用并选择。不会自动播放或启动下载。当前播放队列、本机文件和缓存不变。',
	confirm: '确认导入', share: '继续分享', cancel: '取消',
	done: '配置已导入', doneMessage: '设置、音源、歌单和收藏已同步，无需重启。音源已禁用，请在音源管理中检查后手动启用并选择。',
	error: '配置备份失败', errorMessage: '文件可能无效、版本不兼容、内容超限，或文件读写/分享失败。请使用本应用导出的 JSON（最大 10 MiB、200 个歌单、合计 20000 首歌曲、100 个音源、每份脚本最多 512 KiB）。',
	busy: '音源正在加载或测试，请结束后再导入配置。',
}
const en: typeof zh = {
	exportStages: { COLLECT: 'Could not collect configuration; check sources and playlists.', VALIDATE: 'Export validation failed or backup limits were exceeded.',
		CACHE: 'Cache directory unavailable.', WRITE: 'Could not write backup; check available storage.', SHARE: 'iOS file sharing failed; retry or check the runtime environment.', CLEANUP: 'Temporary backup cleanup failed; sensitive files may remain in cache.' },
	section: 'Configuration backup', export: 'Export configuration JSON', import: 'Import configuration JSON',
	exportTitle: 'Share configuration backup',
	exportUnsupported: 'Configuration JSON file export is currently iOS-only. Android export is deferred; configuration will not be shared as text.',
	exportWarning: 'The backup includes settings, source scripts, playlists and favorites. Scripts may contain API keys or other secrets; your music library may also reveal personal information. Share only with trusted people. Playback URLs, headers, caches, device files and playback progress are excluded.',
	previewTitle: 'Confirm configuration import',
	preview: '%{settings} MMKV settings · %{localSettings} local-config settings\n%{sources} sources · %{playlists} playlists\n%{songs} songs · %{favorites} favorites',
	importWarning: 'Confirmation replaces existing sources, playlists and favorites, and applies included settings; omitted settings stay unchanged. Source scripts may perform dangerous actions: import only trusted backups. Scripts remain disabled and unselected and do not run automatically; review, enable and select them manually in Source Management. No playback or downloads will start. The current queue, device files and caches stay unchanged.',
	confirm: 'Confirm import', share: 'Continue sharing', cancel: 'Cancel',
	done: 'Configuration imported', doneMessage: 'Settings, sources, playlists and favorites are synchronized; no restart is needed. Sources are disabled. Review, enable and select them manually in Source Management.',
	error: 'Configuration backup failed', errorMessage: 'Invalid file, unsupported version, exceeded limits, or file/sharing failure. Use JSON exported by this app (maximum 10 MiB, 200 playlists, 20000 total songs, 100 sources and 512 KiB per script).',
	busy: 'A source is loading or being tested. Finish it before importing configuration.',
}
export function configBackupText() { return nowLanguage.getValue()?.startsWith('en') ? en : zh }
