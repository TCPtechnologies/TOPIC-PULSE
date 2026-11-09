# Topic Pulse (web)

Website version of the Topic Pulse Android app: the same topics, feeds and settings, from a PC.
Notifications are only sent to the Android app.

Live site: https://tcptechnologies.github.io/TOPIC-PULSE/

- Static HTML, CSS and JavaScript, no build step. Hosted free on GitHub Pages.
- Sign-in: Firebase Authentication with Google.
- Data: Cloud Firestore (read directly, protected by security rules).
- Topic creation and source edits: the Topic Pulse backend on Cloud Run.

The values in `config.js` are public by design. Access is controlled by Firebase Auth,
Firestore security rules, and the API key's allowed websites.

Run locally: `python -m http.server 8000` in this folder, then open http://localhost:8000.
