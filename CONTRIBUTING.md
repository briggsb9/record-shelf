# Contributing to Record Shelf

Thanks for helping improve Record Shelf. Bug reports, accessibility feedback, documentation fixes and focused pull requests are welcome.

## Before opening an issue

- Search the existing issues first.
- Include the platform, Record Shelf version, expected behaviour and actual behaviour.
- Add reproduction steps and screenshots where useful, but remove private file paths, NAS names and personal metadata.
- Use the process in [SECURITY.md](SECURITY.md) instead of a public issue for security vulnerabilities.

## Development setup

Record Shelf requires Node.js 22 or later. For Android development, also install JDK 21 and Android SDK 36.

```bash
git clone https://github.com/briggsb9/record-shelf.git
cd record-shelf
npm ci
npm run dev
```

Useful checks before submitting a pull request:

```bash
npm run build
npm run android:sync
```

If the Android toolchain is installed, also run:

```bash
cd android
./gradlew --no-daemon testDebugUnitTest assembleDebug
```

## Pull requests

- Keep changes focused and explain the user-facing reason for them.
- Preserve the album-first design and keyboard, touch and screen-size accessibility.
- Do not commit music, personal catalogue data, credentials, generated installers or local development data.
- Update the README when behaviour, requirements or release instructions change.

By contributing, you agree that your contribution is licensed under the repository's [MIT License](LICENSE).
