# remotestorage-widget

[![npm](https://img.shields.io/npm/v/remotestorage-widget.svg)](https://www.npmjs.com/package/remotestorage-widget)

A ready-to-use connect/sync widget, as add-on library for
[remoteStorage.js](https://github.com/remotestorage/remotestorage.js/).

## Usage

```js
import RemoteStorage from 'remotestoragejs';
import Widget from 'remotestorage-widget';

// ...

const remoteStorage = new RemoteStorage(/* options */);

remoteStorage.access.claim('bookmarks', 'rw');

const widget = new Widget(remoteStorage);
widget.attach();

// ...
```

## Configuration

The widget has some configuration options to customize the behavior:

| Option | Description | Type | Default |
|---|---|---|---|
| `leaveOpen` | Keep the widget open when user clicks outside of it | Boolean | `false` |
| `autoCloseAfter` | Timeout after which the widget closes automatically (in milliseconds). The widget only closes when a storage is connected. | Number | `1500` |
| `skipInitial` | Don't show the initial connect hint, but show sign-in screen directly instead | Boolean | `false` |
| `logging` | Enable logging for debugging purposes | Boolean | `false` |
| `modalBackdrop` | Show a dark, transparent backdrop when opening the widget for connecting an account. `true` shows backdrop everywhere, `false` turns it off everywhere. Default is to only show it on small screens. | Boolean, String | `"onlySmallScreens"` |
| `solidProviders` | Enables the Solid option. You can either provide a list of auth URLs under the `providers` key with `name` and `authURL` keys or set `allowAnyProvider` to `true` in order to allow the user to type in any identity provider URL. `Widget.SOLID_COMMUNITY` and `Widget.INRUPT` are predefined for convenience. | Object | undefined |

Example:

```js
const widget = new Widget(remoteStorage, { autoCloseAfter: 2000 });
```

## Available Functions

`attach(elementID)` - Attach the widget to the DOM and display it. You can
use an optional element ID that the widget should be attached to.
Otherwise it will be attached to the body.

While the `attach()` method is required for the widget to be actually
shown, the following functions are usually not needed. They allow for
fine-tuning the experience.

`close()` - Close/minimize the widget to only show the icon.

`open()` - Open the widget when it's minimized.

`toggle()` - Switch between open and closed state.

## Development / Customization

Install deps:

    npm install

Build, run and watch demo/test app:

    npm start

The demo app will then be served at http://localhost:8008

## Solid integration

Enable Solid with `solidProviders: { allowAnyProvider: true }` and an rs.js build
that includes its Solid backend and the `pod-not-selected` event. Alternatively,
provide named issuers with `solidProviders.providers` and omit `allowAnyProvider`
to hide the free-form issuer field.

The widget handles provider login, single-pod selection, a choice of multiple
pods, no-pod errors, authorization renewal and disconnect. Provider and pod names
are rendered as text. Call `destroy()` when removing a widget to release its
listeners; `attach()` can attach it again after a route replaces its container.

## Tests

Run `npm ci`, `npx playwright install chromium`, `npm run build`, and `npm test`.
Set `CHROMIUM_PATH` to use an existing Chromium installation.

`npm run test:solid` additionally tests real OAuth, private module storage,
reload, a fresh browser context, deletion and disconnect against Community Solid
Server. Set `RS_SOLID_SOURCE` to a checkout of rs.js commit
`f2e11650ade5832374b6dc3cdbf0dec03fb28dd9`, run `npm ci && npm run build:js && npm run build:solid` in that
checkout, then `npm ci` in its `examples/solid` directory. Start
`node tests/server.cjs` there with `RS_SOLID_TEST_PASSWORD` set to a disposable
password. Run the widget's `npm run test:solid` with the same environment.
The server uses a disposable test account and in-memory pod. Both suites run in
`.github/workflows/test.yml`; no personal storage credentials are required.
