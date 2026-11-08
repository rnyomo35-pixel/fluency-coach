# 🎙 English Fluency Coach

A native-iOS (Capacitor) app that fights overthinking: one tap, a topic that
appears **at the same instant the clock starts** (no time to plan), speak
freely, stop yourself when the thought is finished — then an instant
Gemini-powered scorecard.

- **Blind draw:** a single `Start Speaking (Blind Draw)` button reveals the
  topic in the same tick as the stopwatch and the microphone.
- **No hard cutoff:** an upward stopwatch with a soft 15–30 s target and a
  `Stop & Evaluate` button — the attempt ends when *you* say it ends.

- **App ID:** `com.fluencycoach.app` · WebView app (no server) · **Capacitor 6** + `@capacitor-community/speech-recognition`
- **Works off-device for speech**, but evaluation needs internet (Gemini API).

---

## Project structure

```
.
├─ package.json                  Capacitor + plugin deps
├─ capacitor.config.json         appId, webDir: "www"
├─ www/                          ← the app UI (vanilla JS, no bundler)
│  ├─ index.html
│  ├─ css/styles.css             warm graphite + brass premium theme
│  └─ js/
│     ├─ topics.js               50-question topic bank (avoid-repeat picker)
│     └─ app.js                  stopwatch, speech capture, Gemini call, scorecard
└─ ios/                          ← native Xcode workspace (generated)
   └─ App/
      ├─ App.xcworkspace         ← **open this file in Xcode**
      ├─ App/App/Info.plist      microphone + speech-recognition privacy texts
      └─ App/public/             synced copy of www/ (cap sync)
```

## How it works

1. **API key** — ⚙️ icon opens a secure modal; the Gemini key is saved in the
   device's `localStorage` (key `gemini_api_key`), masked with `type="password"`.
2. **Blind draw** — the topic comes from `www/js/topics.js` (daily life,
   philosophy, tech, funny hypotheticals, science), never repeating the previous
   one, and is revealed only once the attempt has already begun.
3. **Start Speaking (Blind Draw)** — one tap draws the topic, starts the upward
   stopwatch and iOS native speech recognition (`SFSpeechRecognizer` via the
   Capacitor plugin) in the same tick. The ring fills to a soft 20 s target and
   the clock keeps counting; **Stop & Evaluate** ends the attempt whenever the
   thought is finished, and the transcript is sent.
4. **Gemini 3.8 Flash** (falls back to 3.5 Flash-Lite) — `generateContent` with `responseMimeType: application/json`
   and a strict `responseSchema` → `{ score (1–10), mistakes[], c1_rephrase, feedback }`.
5. **Scorecard** — score ring, your transcript, mistakes with corrections,
   C1-level rephrase and a rapid-fire tip.

Web fallback: in a desktop browser it uses Web Speech API instead of the plugin
(Chrome recommended). iOS speech-to-text is only available through the native
plugin, which is why Capacitor matters here.

---

## Building for iOS (on a Mac — this is mandatory)

Capacitor's iOS platform must be compiled with Xcode, which only runs on macOS:

1. Copy this whole folder to a Mac.
2. Install Xcode (App Store) + Xcode Command Line Tools, then CocoaPods:
   ```bash
   sudo gem install cocoapods        # or: brew install cocoapods
   ```
3. Install dependencies and run the pod step (skipped on Windows — needed once):
   ```bash
   npm install
   npx cap sync ios
   sudo pod install --project-directory=ios/App
   ```
4. Open the workspace in Xcode:
   ```bash
   npx cap open ios           # opens ios/App/App.xcworkspace
   ```
5. Signing with your **free Apple ID**:
   - Xcode → Settings → Accounts → **+** → sign in with your Apple ID.
   - Select the `App` target → **Signing & Capabilities** → Team: *your personal
     team* → Bundle ID stays `com.fluencycoach.app` → check *Automatically manage
     signing*.
   - Plug the iPhone in, select it as the run destination, press ▶ (Run).
     On the phone: Settings → General → VPN & Device Management → trust your
     developer profile. Allow microphone in the popup.

### Free-account limits to expect
Simulator runs are free; **running free-signed apps on a physical device**
is permitted but apps expire after **7 days** (just re-run from Xcode to refresh).

---

## Getting the .ipa without a Mac (GitHub Actions)

Xcode runs only on macOS, so a Windows machine cannot compile the iOS app. The
workflow in `.github/workflows/ios-ipa.yml` builds an **unsigned** `.ipa` on a
free GitHub Actions macOS runner, and AltStore re-signs it with your own Apple ID
on install — so no certificates, no paid account and no Mac are required.

1. Push this folder to a GitHub repository (`.gitignore` keeps `node_modules`,
   `Pods` and build output out of it):
   ```bash
   git init && git add . && git commit -m "Fluency Coach"
   git branch -M main
   git remote add origin https://github.com/<you>/<repo>.git
   git push -u origin main
   ```
2. On GitHub: **Actions → Build unsigned .ipa → Run workflow**. The first run
   takes a while (it installs CocoaPods); later runs are quicker.
3. Open the finished run → **Artifacts → FluencyCoach-ipa** → download the zip,
   unzip it, and `FluencyCoach.ipa` is inside.
4. Continue with **Sideloading with AltStore** below.

A tag push (`git tag v1.0.0 && git push --tags`) triggers the same build.

With access to a Mac, the identical build is one command:

```bash
bash scripts/build-ipa.sh            # -> build/FluencyCoach.ipa
```

Both paths produce an unsigned app bundle named `FluencyCoach.ipa` whose home
screen name is **Fluency Coach** (from `CFBundleDisplayName`).

---

## Exporting an .ipa for AltStore sideloading

AltStore installs **.ipa** files and re-signs them with your Apple ID via AltServer.
An unsigned `.ipa` from the workflow above is exactly what it expects.

**Option A — build the .ipa directly in Xcode:**

1. In Xcode: select target `App` → device destination **Any iOS Device (arm64)**.
2. Menu **Product → Archive** (destination must not be a physical/simulator device type that blocks archiving).
3. In the Archives window (Window → Organizer), pick the archive → **Distribute App**.
4. Choose:
   - Distribution method: **Custom** (or "Ad Hoc"/"Development") — anything native-managed
   - Re-sign from: **Automatically manage signing** with your personal team
5. Export → you get a folder containing `App.ipa` (rename to
   `FluencyCoach.ipa` if you like).

**Option B — derive the .ipa from the Xcode build products** (alternative, no Organizer):
Build on a physical device (▶ Run), then in `~/Library/Developer/Xcode/DerivedData/App-*/Build/Products/`,
zip `YourApp.app` and rename the zip to `.ipa`.

**Sideloading with AltStore:**

1. On PC/Mac: install **AltServer** (altstore.io), sign in with the *same*
   Apple ID you used in Xcode.
2. Copy `FluencyCoach.ipa` to your iPhone (AirDrop, iCloud, Files).
3. Phone: open AltStore → My Apps → **+** → pick the .ipa → it signs & installs.
4. Trust the developer profile under Settings (if asked) and open the app.

**7-day expiry (free accounts):** AltServer re-signs automatically while the
phone is online and AltServer is running on the PC/Mac; or just re-sideload the
ipa manually after a week.

---

## Development commands

```bash
npm start                 # serve www/ locally (dev in desktop browser)
npx cap sync ios          # copy www → ios + update plugins (run after edits)
npx cap open ios          # open Xcode workspace
```

If you edit files under `www/`, always `npx cap sync ios` before rebuilding in Xcode.

---

## Note on the API key

The key is entered in the app's Settings screen and stored in device
`localStorage` only — never inside the repo. Keep your key private; anyone with
it can bill your Google AI Studio account.
