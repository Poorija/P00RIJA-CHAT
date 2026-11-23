# Contributing

Thank you for looking. A few things make a change easy to take.

## Before you write code

- Read [HANDOFF.md](HANDOFF.md) (what costs a day each) and
  [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) (how to run and check it).
- For a change to how messages or calls are protected, open an issue first and
  describe the attack or the weakness: what an attacker holds, what they do, what
  they get. A change that adds a way to be weaker without anybody noticing will
  not be taken, however convenient.

## The change

- **Tests first for a fix.** Write a suite in `tests/e2e/` that plays what went
  wrong and fails; then make it pass. The security suites are the pattern.
- **Both languages.** Every string a person reads is `t('persian', 'english')`.
- **The interface lives in `css/ui/`.** Do not edit `css/styles.css` and do not
  add `!important` to a source file: the build adds it
  ([docs/DESIGN.md](docs/DESIGN.md)). Use logical properties so that right to
  left works.
- **Run what you touched**, then `npm run test:all`. A suite that fails in bulk
  at its first network step is usually the way it was started, not your change
  (the three kinds of suite are in `docs/DEVELOPMENT.md`).
- Keep a change to one thing, and say in the commit what was wrong and what is
  now true, rather than what you did.

## Reporting a vulnerability

Do not open a public issue. See [SECURITY.md](SECURITY.md).

## License

By contributing you agree that your contribution is licensed under the
GNU Affero General Public License, version 3 only.
