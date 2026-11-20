# 📻 Quran Radio

<p align="center">
  <strong>استمع إلى القرآن الكريم مباشرةً من مجموعة متنوعة من القرّاء والروايات والإذاعات.</strong>
  <br />
  <em>Live Quran radio, recitations and Islamic audio streams — in one simple Android app.</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Platform-Android-3DDC84?logo=android&logoColor=white" alt="Android" />
  <img src="https://img.shields.io/badge/Built%20with-Capacitor-119EFF?logo=capacitor&logoColor=white" alt="Capacitor" />
  <img src="https://img.shields.io/badge/Language-Multilingual-blue" alt="Multilingual" />
  <img src="https://img.shields.io/badge/Release-V1-informational" alt="Release V1" />
</p>

<p align="center">
  <a href="https://github.com/KhaledMohammad1/radioapk/releases">⬇️ Download APK</a>
  ·
  <a href="https://github.com/KhaledMohammad1/radioapk/issues">🐛 Report a bug</a>
  ·
  <a href="https://github.com/KhaledMohammad1/radioapk/actions">⚙️ Build status</a>
</p>

---

## ✨ About

**Quran Radio** is an Android application for listening to live Quran recitations and selected Islamic audio broadcasts. Browse stations by category, search for a reciter or narration, and keep listening while using other apps or when your screen is off.

The interface is designed with Arabic as its primary language and includes multiple interface languages.

## 🌟 Features

- **Live Quran streams** from a collection of reciters and radio stations.
- **Renowned reciters**, including Mahmoud Khalil Al-Hussary, Mohamed Siddiq Al-Minshawi, Abdul Basit Abdus Samad, and others.
- **Multiple riwayat and recitation styles**, including available streams for Hafs, Warsh, Qalun and other narrations.
- **Dedicated categories** for recitations, radio broadcasts, Islamic content and Eid takbeerat.
- **Search** by reciter, narration or station.
- **Background playback** with Android media notification and lock-screen controls.
- **Playback controls** including play/pause, next/previous station and volume.
- **Automatic reconnection** when a live stream is interrupted, with alternate stream URLs where available.
- **Light and dark themes**.
- **Multiple interface languages**.
- **In-app update notification** when a newer published release is available.

> Stream availability and audio quality depend on the external stream providers and your internet connection.

## 📥 Download & Install

1. Open the [Releases page](https://github.com/KhaledMohammad1/radioapk/releases).
2. Download the latest APK asset.
3. Open the downloaded APK on your Android device and follow the installation prompts.
4. If Android asks for permission to install apps from that source, allow it for your browser or file manager, then retry.

Only install APK files that you have downloaded from this repository's official Releases page.

## 📱 Compatibility

- Android application.
- Requires an internet connection to listen to live streams.
- The minimum supported Android version is determined by the app's current Gradle configuration.

## 🧰 Built With

| Technology | Purpose |
| --- | --- |
| HTML, CSS & JavaScript | Application interface and client-side logic |
| [Capacitor](https://capacitorjs.com/) | Android application runtime and native integration |
| [Android Media3 / ExoPlayer](https://developer.android.com/media/media3) | Native audio playback |
| [Gradle](https://gradle.org/) | Android build system |
| [GitHub Actions](https://github.com/features/actions) | Automated APK builds and releases |

## 🏗️ Build From Source

### Requirements

- Node.js 22
- Java Development Kit (JDK) 21
- Android SDK
- Git

### Build

```bash
git clone https://github.com/KhaledMohammad1/radioapk.git
cd radioapk

npm ci
npx cap sync android

cd android
./gradlew assembleDebug
```

The debug APK is generated at:

```
android/app/build/outputs/apk/debug/app-debug.apk
```

For a signed release build, configure the signing secret described below and run the repository's GitHub Actions workflow.

## 🤖 Automated Builds & Releases

This repository uses **GitHub Actions**:

- A push to the `main` or `master` branch triggers an Android release APK build.
- The generated APK is uploaded as a workflow artifact named `QuranRadio-APK`.
- Workflow artifacts are retained for 90 days.
- A manual **workflow_dispatch** run publishes the latest successful, unexpired APK artifact as a GitHub Release. It does not rebuild the app.

See the [Actions workflow](https://github.com/KhaledMohammad1/radioapk/actions/workflows/build-apk.yml).

### Required repository secret

To build a signed release APK, configure this GitHub Actions repository secret:

- `KEYSTORE_BASE64` — Base64-encoded release keystore used by the Android signing step.

Never commit keystores, passwords, signing keys or other secrets to the repository.

### Versioning

- The user-facing app version name is currently **V1**.
- Android's internal `versionCode` increases with each workflow run so newer APKs can be installed as updates.
- Release tags use the build number (for example, `build-23`) to keep each release uniquely identifiable.

## 📂 Project Structure

```
.
├── .github/
│   └── workflows/
│       └── build-apk.yml    # Build and publish workflow
├── android/                 # Native Android project
├── www/
│   ├── index.html           # App entry point
│   ├── app.js               # Interface, stations and playback logic
│   ├── style.css            # App styles
│   └── config.json          # Generated update configuration
├── package.json
└── README.md
```

## 🔐 Privacy & Network

- The app needs internet access to load live audio streams and check for published updates.
- Playback preferences and selected app settings are stored locally on the device.
- Audio streams are provided by external services. Their availability and their own privacy practices are outside this project's control.
- This project does not claim ownership of third-party stream content or services.

## 🐞 Support & Feedback

Found a bug, a broken stream or have an idea for an improvement?

- [Open an issue](https://github.com/KhaledMohammad1/radioapk/issues)
- Include your Android version, app version, and a short description of the problem.
- For stream issues, mention the station or reciter concerned.

## 📜 Disclaimer

Quran Radio is an independent project. Reciter names, radio services and stream endpoints may belong to or be operated by their respective owners. Their inclusion does not imply affiliation, sponsorship or endorsement.

---

<p align="center">
  Made with care for everyone who loves listening to the Holy Quran.
  <br />
  <sub>If you find this project useful, consider giving the repository a ⭐.</sub>
</p>
