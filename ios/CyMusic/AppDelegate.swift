internal import Expo
import CarPlay
import React
import ReactAppDependencyProvider
import UIKit

@main
class AppDelegate: ExpoAppDelegate {
  var window: UIWindow?

  var reactNativeDelegate: ExpoReactNativeFactoryDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

  public override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    let delegate = ReactNativeDelegate()
    let factory = ExpoReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory

#if os(iOS) || os(tvOS)
    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
#endif

    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  // Linking API
  public override func application(
    _ app: UIApplication,
    open url: URL,
    options: [UIApplication.OpenURLOptionsKey: Any] = [:]
  ) -> Bool {
    return super.application(app, open: url, options: options) || RCTLinkingManager.application(app, open: url, options: options)
  }

  // Universal Links
  public override func application(
    _ application: UIApplication,
    continue userActivity: NSUserActivity,
    restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void
  ) -> Bool {
    let result = RCTLinkingManager.application(application, continue: userActivity, restorationHandler: restorationHandler)
    return super.application(application, continue: userActivity, restorationHandler: restorationHandler) || result
  }
}

class ReactNativeDelegate: ExpoReactNativeFactoryDelegate {
  // Extension point for config-plugins

  override func sourceURL(for bridge: RCTBridge) -> URL? {
    // needed to return the correct URL for expo-dev-client.
    bridge.bundleURL ?? bundleURL()
  }

  override func bundleURL() -> URL? {
#if DEBUG
    return RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: ".expo/.virtual-metro-entry")
#else
    return Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
  }
}

// Expo still owns creation of the window and React runtime in didFinishLaunching.
final class PhoneSceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?
  private var app: AppDelegate? { UIApplication.shared.delegate as? AppDelegate }

  func scene(_ scene: UIScene, willConnectTo session: UISceneSession,
             options connectionOptions: UIScene.ConnectionOptions) {
    guard let scene = scene as? UIWindowScene, let window = app?.window else { return }
    // There is only one Expo root; do not move it to a second phone window.
    guard window.windowScene == nil || window.windowScene === scene else {
      UIApplication.shared.requestSceneSessionDestruction(session, options: nil, errorHandler: nil)
      return
    }
    self.window = window
    window.windowScene = scene
    window.makeKeyAndVisible()
    self.scene(scene, openURLContexts: connectionOptions.urlContexts)
    connectionOptions.userActivities.forEach { self.scene(scene, continue: $0) }
  }

  func scene(_ scene: UIScene, openURLContexts contexts: Set<UIOpenURLContext>) {
    for context in contexts {
      var options: [UIApplication.OpenURLOptionsKey: Any] = [.openInPlace: context.options.openInPlace]
      if let source = context.options.sourceApplication { options[.sourceApplication] = source }
      if let annotation = context.options.annotation { options[.annotation] = annotation }
      _ = app?.application(UIApplication.shared, open: context.url, options: options)
    }
  }

  func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
    _ = app?.application(UIApplication.shared, continue: userActivity, restorationHandler: { _ in })
  }

  func sceneDidBecomeActive(_ scene: UIScene) { app?.applicationDidBecomeActive(UIApplication.shared) }
  func sceneWillResignActive(_ scene: UIScene) { app?.applicationWillResignActive(UIApplication.shared) }
  func sceneWillEnterForeground(_ scene: UIScene) { app?.applicationWillEnterForeground(UIApplication.shared) }
  func sceneDidEnterBackground(_ scene: UIScene) { app?.applicationDidEnterBackground(UIApplication.shared) }

  func sceneDidDisconnect(_ scene: UIScene) {
    if window?.windowScene === scene { window?.windowScene = nil }
    window = nil
  }
}

@available(iOS 14.0, *)
final class CarPlaySceneDelegate: UIResponder, CPTemplateApplicationSceneDelegate {
  private var interfaceController: CPInterfaceController?
  private var observers: [NSObjectProtocol] = []
  private var collections: [[String: Any]] = []
  private var lists: [String: CPListTemplate] = [:]
  private var listOffsets: [String: Int] = [:]
  private var playlistOffset = 0
  private var playlists: CPListTemplate?
  private var selectionTask: UIBackgroundTaskIdentifier = .invalid
  private var selectionID: String?

  func templateApplicationScene(_ scene: CPTemplateApplicationScene,
                                didConnect interfaceController: CPInterfaceController) {
    self.interfaceController = interfaceController
    let favorites = CPListTemplate(title: "收藏", sections: [])
    let queue = CPListTemplate(title: "当前队列", sections: [])
    let playlists = CPListTemplate(title: "已存歌单", sections: [])
    self.playlists = playlists
    lists = ["favorites": favorites, "queue": queue]
    for (template, image) in [(favorites, "heart"), (queue, "music.note.list"), (playlists, "folder")] {
      template.tabTitle = template.title
      template.tabImage = UIImage(systemName: image)
      let nowPlaying = CPBarButton(title: "正在播放") { [weak self] _ in self?.showNowPlaying() }
      template.trailingNavigationBarButtons = [nowPlaying]
    }
    observers = [
      NotificationCenter.default.addObserver(forName: Notification.Name("CyMusicCarPlaySnapshot"),
        object: nil, queue: .main) { [weak self] _ in self?.reload() },
      NotificationCenter.default.addObserver(forName: Notification.Name("CyMusicCarPlayNowPlaying"),
        object: nil, queue: .main) { [weak self] _ in self?.showNowPlaying() },
      NotificationCenter.default.addObserver(forName: Notification.Name("CyMusicCarPlayHandled"),
        object: nil, queue: .main) { [weak self] notification in
          guard let self, notification.userInfo?["id"] as? String == self.selectionID else { return }
          self.endSelectionTask()
        }
    ]
    reload()
    interfaceController.setRootTemplate(CPTabBarTemplate(templates: [favorites, queue, playlists]),
                                        animated: false, completion: nil)
  }

  private func reload() {
    if let json = UserDefaults.standard.string(forKey: "CyMusicCarPlaySnapshot"),
       let data = json.data(using: .utf8),
       let snapshot = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] {
      collections = snapshot
    }
    for (id, template) in lists {
      template.updateSections([CPListSection(items: songItems(id: id, offset: listOffsets[id] ?? 0))])
    }
    playlists?.updateSections([CPListSection(items: playlistItems(offset: playlistOffset))])
  }

  private func emptyItem() -> CPListItem {
    let item = CPListItem(text: "暂无歌曲", detailText: "请在手机端同步音乐库")
    item.isEnabled = false
    return item
  }

  private func playlistItems(offset: Int) -> [CPListItem] {
    let stored = collections.filter { ($0["id"] as? String)?.hasPrefix("playlist:") == true }
    let pageSize = max(1, CPListTemplate.maximumItemCount - 2)
    let offset = max(0, min(offset, max(0, stored.count - 1) / pageSize * pageSize))
    playlistOffset = offset
    var items = stored.dropFirst(offset).prefix(pageSize).compactMap { collection -> CPListItem? in
      guard let id = collection["id"] as? String else { return nil }
      let title = collection["title"] as? String ?? "歌单"
      let item = CPListItem(text: title, detailText: "\((collection["tracks"] as? [Any])?.count ?? 0) 首")
      item.handler = { [weak self] _, completion in
        defer { completion() }
        guard let self else { return }
        let list = CPListTemplate(title: title, sections: [CPListSection(items: self.songItems(id: id, offset: 0))])
        self.lists[id] = list
        self.interfaceController?.pushTemplate(list, animated: true, completion: nil)
      }
      return item
    }
    if offset > 0 {
      let previous = CPListItem(text: "上一页", detailText: nil)
      previous.handler = { [weak self] _, completion in
        defer { completion() }
        guard let self else { return }
        self.playlists?.updateSections([CPListSection(items: self.playlistItems(offset: max(0, offset - pageSize)))])
      }
      items.insert(previous, at: 0)
    }
    if offset + pageSize < stored.count {
      let next = CPListItem(text: "下一页", detailText: nil)
      next.handler = { [weak self] _, completion in
        defer { completion() }
        guard let self else { return }
        self.playlists?.updateSections([CPListSection(items: self.playlistItems(offset: offset + pageSize))])
      }
      items.append(next)
    }
    return items.isEmpty ? [emptyItem()] : items
  }

  private func songItems(id: String, offset: Int) -> [CPListItem] {
    guard let collection = collections.first(where: { $0["id"] as? String == id }),
          let tracks = collection["tracks"] as? [[String: Any]] else {
      listOffsets[id] = 0
      return [emptyItem()]
    }
    let pageSize = max(1, CPListTemplate.maximumItemCount - 2)
    let offset = max(0, min(offset, max(0, tracks.count - 1) / pageSize * pageSize))
    listOffsets[id] = offset
    var items = tracks.enumerated().dropFirst(offset).prefix(pageSize).map { index, track in
      let item = CPListItem(text: track["title"] as? String ?? "未知歌曲", detailText: track["artist"] as? String)
      item.handler = { [weak self] _, completion in
        defer { completion() }
        // Capture the displayed queue, not an index into a later JS snapshot.
        guard let data = try? JSONSerialization.data(withJSONObject: tracks),
              let json = String(data: data, encoding: .utf8) else { return }
        let event: [String: Any] = ["id": UUID().uuidString, "queueJSON": json,
                                    "index": index, "createdAt": Date().timeIntervalSince1970]
        self?.endSelectionTask()
        self?.selectionID = event["id"] as? String
        self?.selectionTask = UIApplication.shared.beginBackgroundTask(withName: "CarPlay selection") { [weak self] in
          self?.endSelectionTask()
        }
        UserDefaults.standard.set(event, forKey: "CyMusicCarPlayPending")
        NotificationCenter.default.post(name: Notification.Name("CyMusicCarPlaySelect"), object: nil)
      }
      return item
    }
    if offset > 0 {
      let previous = CPListItem(text: "上一页", detailText: nil)
      previous.handler = { [weak self] _, completion in
        defer { completion() }
        guard let self else { return }
        self.lists[id]?.updateSections([CPListSection(items: self.songItems(id: id, offset: max(0, offset - pageSize)))])
      }
      items.insert(previous, at: 0)
    }
    if offset + pageSize < tracks.count {
      let next = CPListItem(text: "下一页", detailText: nil)
      next.handler = { [weak self] _, completion in
        defer { completion() }
        guard let self else { return }
        self.lists[id]?.updateSections([CPListSection(items: self.songItems(id: id, offset: offset + pageSize))])
      }
      items.append(next)
    }
    return items.isEmpty ? [emptyItem()] : items
  }

  private func showNowPlaying() {
    guard let controller = interfaceController,
          controller.topTemplate !== CPNowPlayingTemplate.shared else { return }
    controller.pushTemplate(CPNowPlayingTemplate.shared, animated: true, completion: nil)
  }

  private func endSelectionTask() {
    if selectionTask != .invalid { UIApplication.shared.endBackgroundTask(selectionTask) }
    selectionTask = .invalid
    selectionID = nil
  }

  func templateApplicationScene(_ scene: CPTemplateApplicationScene,
                                didDisconnect interfaceController: CPInterfaceController) {
    observers.forEach { NotificationCenter.default.removeObserver($0) }
    observers = []
    endSelectionTask()
    lists = [:]
    listOffsets = [:]
    playlistOffset = 0
    playlists = nil
    self.interfaceController = nil
  }

  deinit { observers.forEach { NotificationCenter.default.removeObserver($0) } }
}
