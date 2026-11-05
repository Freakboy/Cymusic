import ExpoModulesCore

public final class CyMusicNowPlayingModule: Module {
  private var observer: NSObjectProtocol?

  public func definition() -> ModuleDefinition {
    Name("CyMusicNowPlaying")
    Events("onCarPlaySelect")

    OnCreate { [weak self] in
      self?.observer = NotificationCenter.default.addObserver(
        forName: Notification.Name("CyMusicCarPlaySelect"), object: nil, queue: .main
      ) { [weak self] _ in
        // JS pulls the durable pending request; events are only wake-up signals.
        self?.sendEvent("onCarPlaySelect", [:])
      }
    }

    OnDestroy { [weak self] in
      guard let self else { return }
      if let observer = self.observer { NotificationCenter.default.removeObserver(observer) }
    }

    AsyncFunction("setCarPlaySnapshot") { (json: String) in
      guard let data = json.data(using: .utf8),
            (try? JSONSerialization.jsonObject(with: data)) is [[String: Any]] else {
        throw NSError(domain: "CyMusicCarPlay", code: 1,
                      userInfo: [NSLocalizedDescriptionKey: "Invalid library snapshot"])
      }
      UserDefaults.standard.set(json, forKey: "CyMusicCarPlaySnapshot")
      NotificationCenter.default.post(name: Notification.Name("CyMusicCarPlaySnapshot"), object: nil)
    }.runOnQueue(.main)

    AsyncFunction("getPendingCarPlaySelection") { () -> [String: Any]? in
      UserDefaults.standard.dictionary(forKey: "CyMusicCarPlayPending")
    }.runOnQueue(.main)

    AsyncFunction("completeCarPlaySelection") { (id: String, playing: Bool) in
      NotificationCenter.default.post(name: Notification.Name("CyMusicCarPlayHandled"),
                                      object: nil, userInfo: ["id": id])
      let pending = UserDefaults.standard.dictionary(forKey: "CyMusicCarPlayPending")
      guard pending?["id"] as? String == id else { return }
      UserDefaults.standard.removeObject(forKey: "CyMusicCarPlayPending")
      if playing {
        NotificationCenter.default.post(name: Notification.Name("CyMusicCarPlayNowPlaying"), object: nil)
      }
    }.runOnQueue(.main)

  }
}
