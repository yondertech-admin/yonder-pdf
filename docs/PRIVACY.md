# Privacy

**Your documents stay on your computer.** Yonder PDF has no accounts and no document backend. Files are read when you open them and written when you save. Nothing about your documents, your usage, or your machine is uploaded.

**Ads keep the app free.** The banner at the bottom of the window loads a page from `https://ads.yondertech.net` inside a sandboxed frame (`sandbox="allow-scripts allow-popups"`, no same-origin access). That frame cannot read your documents, the file system, or anything else in the app. Loading it reveals your IP address and a generic browser identifier to that host and to whichever ad network it embeds, exactly like visiting a web page. When you are offline a static message is shown instead. The frame is never loaded in fullscreen, while printing, or while the signature dialog is open.

**Updates come from GitHub.** The app checks the GitHub Releases page of the open-source project for new versions. On macOS (until builds are notarized) it only tells you; it does not download or install.

**No analytics, no crash reporting.** We collect no usage data.

**Local data.** Recent-file paths, preferences and saved signature images are stored in the app's settings folder (`~/Library/Application Support/Yonder PDF` on macOS, `%APPDATA%\Yonder PDF` on Windows, `~/.config/Yonder PDF` on Linux). Delete that folder to remove them.

**Signing.** In this version "signing" places an image of your signature in the document (visual signing). It is not a certificate-based digital signature and carries no cryptographic identity. Certificate-based signing with an audit trail is planned; see `DESIGN.md` §7.

Questions: admin@yondertech.net
