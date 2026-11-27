import widgetHtml from './assets/widget.html';
import widgetCss from './assets/styles.css';
import circleOpenSvg from './assets/circle-open.svg';

const ATOMIC_SERVER = 'https://atomic.place';

/**
 * RemoteStorage connect widget
 * @constructor
 *
 * @param {object}  remoteStorage          - remoteStorage instance
 * @param {object}  options                - Widget options
 * @param {object}  options.solidProviders - Specify valid Solid providers for the Solid backend
 * @param {boolean} options.leaveOpen      - Do not minimize widget when user clicks outside of it (default: false)
 * @param {number}  options.autoCloseAfter - Time after which the widget closes  automatically in ms (default: 1500)
 * @param {boolean} options.skipInitial    - Don't show the initial connect hint, but show sign-in screen directly instead (default: false)
 * @param {boolean} options.logging        - Enable logging (default: false)
 * @param {boolean,string} options.modalBackdrop - Show a dark, transparent backdrop when opening the widget for connecting an account. (default 'onlySmallScreens')
 */
class Widget {
  constructor (remoteStorage, options={}) {
    this.rs = remoteStorage;
    this.lwsOpenID = options.lwsOpenID;
    if (options.guestData && (typeof options.guestData.export !== 'function' || typeof options.guestData.import !== 'function')) {
      throw new TypeError('options.guestData requires export and import functions');
    }
    this.guestData = options.guestData;

    this.solidProviders = options.solidProviders || {};
    this.leaveOpen         = options.leaveOpen ? options.leaveOpen : false;
    this.autoCloseAfter    = options.autoCloseAfter ? options.autoCloseAfter : 1500;
    this.skipInitial       = options.skipInitial ? options.skipInitial : false;
    this.logging           = options.logging ? options.logging : false;
    this.parentContainerEl = null;
    this.subscriptions = [];

    if (options.hasOwnProperty('modalBackdrop')) {
      if (typeof options.modalBackdrop !== 'boolean' && options.modalBackdrop !== 'onlySmallScreens') {
        throw 'options.modalBackdrop has to be true/false or "onlySmallScreens"'
      }
      this.modalBackdrop  = options.modalBackdrop;
    } else {
      this.modalBackdrop  = 'onlySmallScreens';
    }

    // true if we have remoteStorage connection's info
    this.active = false;

    // remoteStorage is connected!
    this.online = false;

    // widget is minimized ?
    this.closed = false;

    this.lastSynced = null;
    this.lastSyncedUpdateLoop = null;
  }

  log (...msg) {
    if (this.logging) {
      console.debug('[RS-WIDGET] ', ...msg);
    }
  }

  // handle events !
  eventHandler (event, msg) {
    this.log('EVENT: ', event);
    switch (event) {
      case 'ready':
        this.setState(this.state);
        break;
      case 'pod-not-selected':
        const podURLs = this.rs.solid?.getPodURLs();
        if (!podURLs || this.rs.connected || this.selectingPod) break;
        this.open();

        if (podURLs.length === 0) {
          this.handleNoPod();
        }
        else if (podURLs.length === 1) {
          this.selectPod(podURLs[0]);
        }
        else {
          this.populatePodOptions();
          this.setState('choose-pod');
        }
        break;
      case 'sync-started':
        this.handleSyncStarted();
        break;
      // For backward compatibility with rs.js <= 2.0.0-beta.6
      case 'sync-req-done':
        this.handleSyncStarted();
        break;
      case 'sync-done':
        if (this.online && !msg?.completed) return;
        this.syncInProgress = false;
        this.rsSyncButton.classList.remove("rs-rotate");
        this.updateLastSyncedStatus();
        if (!this.closed && this.shouldCloseWhenSyncDone) {
          setTimeout(this.close.bind(this), this.autoCloseAfter);
        }
        break;
      case 'disconnected':
        this.enableConnectButton();
        this.enableSolidConnectButton();
        this.active = false;
        this.setOnline();
        this.setBackendClass(); // removes all backend CSS classes
        this.open();
        this.setInitialState();
        break;
      case 'connected':
        this.enableSolidConnectButton();
        this.active = true;
        this.online = true;
        if (this.rs.hasFeature('Sync')) {
          this.shouldCloseWhenSyncDone = true;

        } else {
          this.rsSyncButton.classList.add('rs-hidden');
          setTimeout(this.close.bind(this), this.autoCloseAfter);
        }
        let connectedUser = this.rs.remote.userAddress;
        this.rsConnectedUser.textContent = connectedUser;
        this.setBackendClass(this.rs.backend);
        this.rsConnectedLabel.textContent = this.rs.backend === 'nextgraph' ? 'Saved on this device' : 'Connected';
        this.rsImport.hidden = this.rs.backend !== 'nextgraph';
        this.setState('connected');
        break;
      case 'network-offline':
        this.setOffline();
        break;
      case 'network-online':
        this.setOnline();
        break;
      case 'error':
        this.setBackendClass(this.rs.backend);
        if (this.rs.backend === 'nextgraph') {
          this.open();
          if (this.active) {
            this.rsConnectedLabel.textContent = 'Needs attention';
            const reload = this.rs.nextgraph?.requiresReload;
            this.rsImport.querySelector('[role=status]').textContent = reload
              ? 'Reload this app to reopen Nextgraph after the save error. Keep your export file.'
              : msg?.message || String(msg);
            this.rsImport.querySelector('input').disabled = !!reload;
          }
          else { this.showChooseOrSignIn(); this.rsStorageError.textContent = msg?.message || String(msg); }
          break;
        }
        if (this.solidConnecting || (this.rs.backend === 'solid' && !this.rs.connected && msg?.name !== 'Unauthorized')) {
          this.handleSolidError(msg);
          break;
        }

        if (this.rs.backend === 'onedrive' && !this.rs.connected && msg?.name !== 'Unauthorized') {
          this.handleUnauthorized({message: msg?.message || String(msg)});
          break;
        }
        if (msg?.name === 'DiscoveryError') {
          this.handleDiscoveryError(msg);
        } else if (msg?.name === 'SyncError') {
          this.handleSyncError(msg);
        } else if (msg?.name === 'Unauthorized') {
          this.handleUnauthorized(msg);
        } else {
          console.debug(`Encountered unhandled error: "${msg}"`);
        }
        break;
    }
  }

  setState (state) {
    if (!state) return;
    this.log('Setting state ', state);

    let lastSelected = this.parentContainerEl.querySelector('.rs-box.rs-selected');
    if (lastSelected) {
      lastSelected.classList.remove('rs-selected');
      lastSelected.setAttribute('aria-hidden', 'true');
    }

    let toSelect = this.parentContainerEl.querySelector('.rs-box.rs-box-'+state);
    if (toSelect) {
      toSelect.classList.add('rs-selected');
      toSelect.setAttribute('aria-hidden', 'false');
    }

    let currentStateClass = this.rsWidget.className.match(/rs-state-\S+/g)[0];
    this.rsWidget.classList.remove(currentStateClass);
    this.rsWidget.classList.add(`rs-state-${state || this.state}`);

    this.state = state;
  }

  /**
   * Set widget to its inital state
   *
   * @private
   */
  setInitialState () {
    if (this.skipInitial) {
      this.showChooseOrSignIn();
    } else {
      this.setState('initial');
    }
  }

  /**
   * Create the widget element and add styling.
   *
   * @returns {object} The widget's DOM element
   *
   * @private
   */
  createHtmlTemplate () {
    const element = document.createElement('div');
    element.id = "remotestorage-widget";
    element.innerHTML = widgetHtml;

    const style = document.createElement('style');
    style.innerHTML = widgetCss;
    element.appendChild(style);

    return element;
  }

  /**
   * Sets the `rs-modal` class on the widget element.
   * Done by default for small screens (max-width 420px).
   *
   * @private
   */
  setModalClass () {
    if (this.modalBackdrop) {
      if (this.modalBackdrop === 'onlySmallScreens'
          && !this.isSmallScreen()) {
        return;
      }
      this.rsWidget.classList.add('rs-modal');
    }
  }

  /**
   * Save all interactive DOM elements as variables for later access.
   *
   * @throws {Error} If parent container element not found
   * @private
   */
  setupElements () {
    if (!this.parentContainerEl) {
      throw new Error("Parent container element not found");
    }

    this.rsWidget = this.parentContainerEl.querySelector('.rs-widget');
    this.rsBackdrop = this.parentContainerEl.querySelector('.remotestorage-widget-modal-backdrop');
    this.rsInitial = this.parentContainerEl.querySelector('.rs-box-initial');
    this.rsChoose = this.parentContainerEl.querySelector('.rs-box-choose');
    this.rsConnected = this.parentContainerEl.querySelector('.rs-box-connected');
    this.rsSignIn = this.parentContainerEl.querySelector('.rs-box-sign-in');

    this.rsConnectedLabel = this.parentContainerEl.querySelector('.rs-box-connected .rs-sub-headline');
    this.rsChooseRemoteStorageButton = this.parentContainerEl.querySelector('button.rs-choose-rs');
    this.rsChooseDropboxButton = this.parentContainerEl.querySelector('button.rs-choose-dropbox');
    this.rsChooseGoogleDriveButton = this.parentContainerEl.querySelector('button.rs-choose-googledrive');
    this.rsErrorBox = this.parentContainerEl.querySelector('.rs-box-error .rs-error-message');
    this.rsSolid = this.parentContainerEl.querySelector('.rs-box-solid');
    this.rsChooseLWSButton = this.parentContainerEl.querySelector('.rs-choose-lws');
    this.rsChooseAtomicButton = this.parentContainerEl.querySelector('.rs-choose-atomic');
    this.rsAtomicForm = this.parentContainerEl.querySelector('.rs-atomic-form');
    this.rsAtomicServer = this.rsAtomicForm.elements['rs-atomic-server'];
    this.rsAtomicServer.value = ATOMIC_SERVER;
    this.rsAtomicApprove = this.rsAtomicForm.querySelector('.rs-atomic-approve');
    this.rsAtomicStatus = this.rsAtomicForm.querySelector('[role=status]');
    this.rsAtomicError = this.rsAtomicForm.querySelector('[role=alert]');
    this.rsChooseNextGraphButton = this.parentContainerEl.querySelector('.rs-choose-nextgraph');
    this.rsNextGraphForm = this.parentContainerEl.querySelector('.rs-nextgraph-form');
    this.rsNextGraphError = this.rsNextGraphForm.querySelector('[role=alert]');
    this.rsNextGraphForm.elements['rs-nextgraph-wallet'].value = this.rs.nextgraph?.getWalletURL?.() || 'https://nextgraph.net';
    this.rsExportButton = this.parentContainerEl.querySelector('.rs-export-guest');
    this.rsImport = this.parentContainerEl.querySelector('.rs-nextgraph-import');
    if (this.guestData?.accept) this.rsImport.querySelector('input').accept = this.guestData.accept;
    this.rsChooseAtomicButton.hidden = !this.rs.atomic?.requestAppKey;
    this.rsChooseNextGraphButton.hidden = !this.rs.nextgraph;
    this.rsExportButton.hidden = !this.rs.nextgraph;
    this.rsImport.hidden = true;
    this.rsChooseOneDriveButton = this.parentContainerEl.querySelector('.rs-choose-onedrive');
    this.rsLWSForm = this.parentContainerEl.querySelector('.rs-lws-form');
    this.rsLWSError = this.rsLWSForm.querySelector('[role=alert]');
    this.rsStorageError = this.parentContainerEl.querySelector('.rs-storage-error');
    this.rsChooseLWSButton.hidden = !this.rs.lws;
    this.rsChooseOneDriveButton.hidden = !this.rs.onedrive || !this.rs.apiKeys?.onedrive;
    if (this.rs.lws && this.lwsOpenID) this.rs.lws.configureOpenID(this.lwsOpenID);
    this.rsChooseSolidButton = this.parentContainerEl.querySelector('button.rs-choose-solid');
    this.rsSolidOptions = [this.parentContainerEl.querySelector('button.rs-option-solid')];
    this.rsSolidPodOptions = [this.parentContainerEl.querySelector('button.rs-choose-pod')];
    this.rsSolidForm = this.parentContainerEl.querySelector('.rs-solid-form');
    this.rsProviderInput = this.rsSolidForm.querySelector('input[name=rs-provider-address]');
    this.rsSolidConnectButton = this.parentContainerEl.querySelector('.rs-solid-connect');

    // check if apiKeys is set for Dropbox or Google [googledrive, dropbox]
    // to show/hide relative buttons only if needed
    if (! (this.rs.apiKeys || {}).hasOwnProperty('googledrive')) {
      this.rsChooseGoogleDriveButton.parentNode.removeChild(this.rsChooseGoogleDriveButton);
    }

    if (! (this.rs.apiKeys || {}).hasOwnProperty('dropbox')) {
      this.rsChooseDropboxButton.parentNode.removeChild(this.rsChooseDropboxButton);
    }

    const providers = this.solidProviders.providers || [];
    const template = this.rsSolidOptions[0];
    this.rsSolidOptions = providers.map(provider => {
      const button = template.cloneNode(true);
      button.lastElementChild.textContent = provider.name;
      template.before(button);
      return button;
    });
    template.remove();
    this.solidEnabled = providers.length > 0 || this.solidProviders.allowAnyProvider === true;
    this.rsChooseSolidButton.hidden = !this.solidEnabled;
    this.rsSolidForm.hidden = !this.solidProviders.allowAnyProvider;

    this.rsSignInForm = this.parentContainerEl.querySelector('.rs-sign-in-form');
    this.rsAddressInput = this.rsSignInForm.querySelector('input[name=rs-user-address]');
    this.rsConnectButton = this.parentContainerEl.querySelector('.rs-connect');

    this.rsDisconnectButton = this.parentContainerEl.querySelector('.rs-disconnect');
    this.rsSyncButton = this.parentContainerEl.querySelector('.rs-sync');
    this.rsLogo = this.parentContainerEl.querySelector('.rs-widget-icon');

    this.rsErrorReconnectLink = this.parentContainerEl.querySelector('.rs-box-error a.rs-reconnect');
    this.rsErrorDisconnectButton = this.parentContainerEl.querySelector('.rs-box-error button.rs-disconnect');

    this.rsConnectedUser = this.parentContainerEl.querySelector('.rs-connected-text h1.rs-user');
  }

  /**
   * Setup all event handlers
   *
   * @private
   */
  listen (name, handler) {
    const guarded = (...args) => { if (!this.destroyed) handler(...args); };
    this.rs.on(name, guarded);
    this.subscriptions.push([name, guarded]);
  }

  destroy () {
    this.atomicRequest?.abort();
    this.destroyed = true;
    for (const [name, handler] of this.subscriptions) {
      this.rs.removeEventListener(name, handler);
    }
    this.subscriptions = [];
    document.removeEventListener('click', this.outsideClick);
    this.domElement?.remove();
    this.domElement = null;
  }

  setupHandlers () {
    // Older builds without Solid do not declare this event.
    if (this.solidEnabled) {
      this.listen('pod-not-selected', () => this.eventHandler('pod-not-selected'));
      this.listen('features-loaded', () => this.restorePodSelection());
    }
    this.listen('features-loaded', () => {
      const wasHidden = this.rsChooseAtomicButton.hidden;
      this.rsChooseAtomicButton.hidden = !this.rs.atomic?.requestAppKey;
      if (wasHidden && !this.rsChooseAtomicButton.hidden && !this.active && this.skipInitial && this.state === 'sign-in') {
        this.showChooseOrSignIn();
      }
    });
    this.listen('connected', () => this.eventHandler('connected'));
    this.listen('ready', () => this.eventHandler('ready'));
    this.listen('disconnected', () => this.eventHandler('disconnected'));
    this.listen('network-online', () => this.eventHandler('network-online'));
    this.listen('network-offline', () => this.eventHandler('network-offline'));
    this.listen('error', (error) => this.eventHandler('error', error));

    this.listen('sync-started', msg => this.eventHandler('sync-started', msg));
    this.listen('sync-req-done', msg => this.eventHandler('sync-req-done', msg));
    this.listen('sync-done', msg => this.eventHandler('sync-done', msg));
    this.setEventListeners();
    this.setClickHandlers();
  }

  /**
   * Append widget to the DOM.
   *
   * If a parentElement is specified, the widget will be appended to that
   * element, otherwise it will be appended to the document's body. The parent
   * element can be given either as a simple element ID or as a valid HTML
   * element.
   *
   * @param  {String,HTMLElement} [parentElement] - Parent element
   * @throws {Error} If the element is not found or is of an unknown type.
   */
  attach (element) {
    if (this.domElement?.isConnected) return;
    this.destroy();
    this.destroyed = false;
    const domElement = this.domElement = this.createHtmlTemplate(element);

    this.parentContainerEl;

    if (element instanceof HTMLElement) {
      this.parentContainerEl = element;
    } else if (typeof element === "string") {
      this.parentContainerEl = document.getElementById(element);
      if (!this.parentContainerEl) {
        throw new Error("Failed to find target DOM element with id=\"" + element + "\"");
      }
    } else if (element) {
      throw new Error("Unknown element type. Expected instance of HTMLElement or type of string.");
    } else {
      this.parentContainerEl = document.body;
    }
    this.parentContainerEl.appendChild(domElement);

    this.setupElements();
    this.setInitialState();
    this.setModalClass();
    this.setupHandlers();
    this.restorePodSelection();
    this.resumeLWS();
  }

  async requestAtomicAccess () {
    this.atomicRequest?.abort();
    const request = new AbortController();
    this.atomicRequest = request;
    this.rsAtomicApprove.hidden = true;
    this.rsAtomicStatus.textContent = '';
    this.rsAtomicError.textContent = '';

    try {
      const server = new URL(this.rsAtomicServer.value);
      const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(server.hostname);
      if ((server.protocol !== 'https:' && !(loopback && server.protocol === 'http:')) ||
          server.username || server.password || server.pathname !== '/' || server.search || server.hash) {
        throw new Error('Enter an HTTPS Atomic server URL, or a local HTTP server for development.');
      }

      const { publicKey, waitForGrant } = await this.rs.atomic.requestAppKey(server.origin, { signal: request.signal });
      if (request.signal.aborted) return;
      const approval = new URL('/app/connect-agent', server.origin === ATOMIC_SERVER ? 'https://app.atomic.place' : server.origin);
      approval.searchParams.set('key', publicKey);
      approval.searchParams.set('name', window.location.host || document.title);
      approval.searchParams.set('write', '1');
      this.rsAtomicApprove.href = approval.href;
      this.rsAtomicApprove.hidden = false;
      this.rsAtomicStatus.textContent = 'Open Atomic to approve this app. Then return here.';
      await waitForGrant();
    } catch (error) {
      if (request.signal.aborted) return;
      this.rsAtomicApprove.hidden = true;
      this.rsAtomicStatus.textContent = '';
      this.rsAtomicError.textContent = error.message || String(error);
    } finally {
      if (this.atomicRequest === request) this.atomicRequest = undefined;
    }
  }

  async resumeLWS () {
    if (!this.rs.lws || !this.lwsOpenID) return;
    try { await this.rs.lws.handleIncomingRedirect(); }
    catch (error) { this.setState('lws'); this.rsLWSError.textContent = error.message; }
  }

  showNextGraphConflicts () {
    const container = this.rsImport.querySelector('.rs-document-conflicts');
    container.replaceChildren();
    try {
      if (this.rs.nextgraph.requiresReload) { container.textContent = 'Reload this app to reopen Nextgraph after the save error.'; return; }
      const conflicts = this.rs.nextgraph.listConflicts();
      if (!conflicts.length) { container.textContent = 'No document conflicts.'; return; }
      for (const conflict of conflicts) {
        const group = document.createElement('fieldset');
        const title = document.createElement('legend'); title.textContent = conflict.path; group.append(title);
        const help = document.createElement('p'); help.textContent = 'Choose the version to keep. Both versions remain in document history.'; group.append(help);
        for (const revision of conflict.revisions) {
          const label = document.createElement('p');
          label.textContent = (revision.deleted ? 'Deleted' : revision.file.contentType) + ' — ' + new Date(revision.created).toLocaleString();
          const details = document.createElement('details'), summary = document.createElement('summary');
          summary.textContent = 'View stored version'; details.append(summary);
          const preview = document.createElement('pre');
          // Byte envelopes can be downloaded without interpreting untrusted HTML.
          preview.textContent = revision.id; details.append(preview);
          if (!revision.deleted) {
            const download = document.createElement('button'); download.type = 'button'; download.textContent = 'Download version';
            download.addEventListener('click', () => {
              const raw = atob(revision.file.data.replace(/-/g, '+').replace(/_/g, '/'));
              const bytes = Uint8Array.from(raw, char => char.charCodeAt(0));
              const url = URL.createObjectURL(new Blob([bytes], {type:'application/octet-stream'}));
              const link = document.createElement('a'); link.href = url; link.download = conflict.path.split('/').pop(); link.click();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
            });
            details.append(download);
          }
          const choose = document.createElement('button'); choose.type = 'button'; choose.textContent = revision.deleted ? 'Keep deletion' : 'Keep this version';
          choose.addEventListener('click', async () => {
            choose.disabled = true;
            try { await this.rs.nextgraph.resolveConflict(conflict.path, revision.id, conflict.revisions.map(record => record.id)); this.showNextGraphConflicts(); this.rs.startSync(); }
            catch (error) { help.textContent = error.message || String(error); choose.disabled = false; }
          });
          group.append(label, details, choose);
        }
        container.append(group);
      }
    } catch (error) { container.textContent = error.message || String(error); }
  }

  restorePodSelection () {
    if (this.solidEnabled && this.rs.backend === 'solid' && !this.rs.connected &&
        this.rs.solid?.getPodURLs() !== null && !this.rs.solid?.getPodURL?.()) {
      this.eventHandler('pod-not-selected');
    }
  }

  setEventListeners () {
    this.rsLWSForm.addEventListener('submit', async event => {
      event.preventDefault();
      const button = this.rsLWSForm.querySelector('[type=submit]');
      button.disabled = true; this.rsLWSError.textContent = '';
      try {
        this.rs.lws.setStorageURL(this.rsLWSForm.elements['rs-lws-address'].value.trim());
        await this.rs.lws.connect();
      } catch (error) {
        if (!error.redirecting) this.rsLWSError.textContent = error.message || String(error);
      } finally { button.disabled = false; }
    });
    this.rsSignInForm.addEventListener('submit', (e) => {
      e.preventDefault();
      let userAddress = this.parentContainerEl.querySelector('input[name=rs-user-address]').value.trim();
      this.disableConnectButton();
      this.rs.connect(userAddress);
    });

    this.rsSolidForm.addEventListener('submit', (e) => {
      e.preventDefault();
      this.connectSolid(this.rsProviderInput.value.trim());
    });
  }

  /**
   * Read solid pod URLs from the remote storage instance and fill the pod options.
   *
   * @private
   */
  populatePodOptions () {
    const podURLs = this.rs.solid.getPodURLs() || [];
    const template = this.rsSolidPodOptions[0];
    const parent = template.parentElement;
    parent.replaceChildren();
    this.rsSolidPodOptions = podURLs.map(url => {
      const button = template.cloneNode(true);
      button.lastElementChild.textContent = url;
      button.addEventListener('click', () => this.selectPod(url));
      parent.appendChild(button);
      return button;
    });
  }

  async selectPod (url) {
    if (this.selectingPod) return;
    this.selectingPod = true;
    try {
      await this.rs.solid.setPodURL(url);
    } catch (error) {
      this.handleSolidError(error);
    } finally {
      this.selectingPod = false;
    }
  }

  async connectSolid (url) {
    const message = this.rsSolid.querySelector('.rs-sign-in-error');
    message.textContent = '';
    message.classList.remove('rs-visible');
    message.classList.add('rs-hidden');
    this.disableSolidConnectButton();
    this.solidConnecting = true;
    try {
      if (!this.rs.solid) throw new Error('Solid storage is not available yet. Please try again.');
      this.rs.solid.setAuthURL(url);
      await this.rs.solid.connect();
    } catch (error) {
      this.handleSolidError(error);
    }
  }

  enableSolidConnectButton () {
    this.solidConnecting = false;
    this.rsSolidConnectButton.disabled = false;
    this.rsSolidConnectButton.textContent = 'Connect';
    this.rsSolidConnectButton.classList.remove('rs-connecting');
  }

  handleSolidError (error) {
    this.enableSolidConnectButton();
    this.open();
    this.setState('solid');
    const message = this.rsSolid.querySelector('.rs-sign-in-error');
    message.textContent = error.message || String(error);
    message.classList.remove('rs-hidden');
    message.classList.add('rs-visible');

  }

  /**
   * Show the screen for choosing a backend if there is more than one backend
   * to choose from. Otherwise it directly shows the remoteStorage connect
   * screen.
   *
   * @private
   */
  showChooseOrSignIn () {
    if (this.rsWidget.classList.contains('rs-modal')) {
      this.rsBackdrop.style.display = 'block';
      this.rsBackdrop.classList.add('visible');
    }
    // choose backend only if some providers are declared
    if ((this.rs.apiKeys && Object.keys(this.rs.apiKeys).length > 0) ||
    this.solidEnabled || this.rs.lws || this.rs.onedrive || this.rs.nextgraph || this.rs.atomic?.requestAppKey) {
      this.setState('choose');
    } else {
      this.setState('sign-in');
    }
  }

  setClickHandlers () {
    // Initial button
    this.rsInitial.addEventListener('click', () => this.showChooseOrSignIn() );

    this.rsChooseAtomicButton.addEventListener('click', () => {
      this.setState('atomic');
      this.rsAtomicServer.focus();
    });
    this.rsAtomicForm.addEventListener('submit', event => {
      event.preventDefault();
      void this.requestAtomicAccess();
    });
    this.rsAtomicForm.querySelector('.rs-atomic-back').addEventListener('click', () => {
      this.atomicRequest?.abort();
      this.rsAtomicApprove.hidden = true;
      this.rsAtomicStatus.textContent = '';
      this.rsAtomicError.textContent = '';
      this.showChooseOrSignIn();
    });
    this.rsChooseNextGraphButton.addEventListener('click', () => {
      this.rsNextGraphError.textContent = '';
      this.setState('nextgraph');
      this.rsNextGraphForm.elements['rs-nextgraph-wallet'].focus({ preventScroll: true });
      // Collapsing a tall provider chooser moves this form upwards. Wait for
      // layout transitions before scrolling; focusing during that transition
      // can otherwise leave the form above the viewport on a long mobile page.
      const animations = this.rsWidget.getAnimations?.({ subtree: true }) || [];
      Promise.allSettled(animations.filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished)).then(() => {
        if (this.state !== 'nextgraph' || !this.rsNextGraphForm.isConnected) return;
        const bounds = this.rsNextGraphForm.getBoundingClientRect();
        if (bounds.top < 0 || bounds.bottom > window.innerHeight) this.rsNextGraphForm.scrollIntoView({ block: 'nearest' });
      });
    });
    this.parentContainerEl.querySelector('.rs-nextgraph-back').addEventListener('click', () => this.showChooseOrSignIn());
    this.rsNextGraphForm.addEventListener('submit', async event => {
      event.preventDefault();
      const button = this.rsNextGraphForm.querySelector('[type=submit]');
      button.disabled = true; this.rsNextGraphError.textContent = '';
      try {
        const wallet = this.rsNextGraphForm.elements['rs-nextgraph-wallet'].value.trim();
        if (wallet !== 'https://nextgraph.net' && !this.rs.nextgraph.getWalletURL) throw Error('Update remoteStorage.js to select another NextGraph wallet server.');
        if (await this.guestData?.beforeConnect?.() === false) return;
        await this.rs.nextgraph.connect(wallet);
      }
      catch (error) { this.rsNextGraphError.textContent = error.message || String(error); }
      finally { button.disabled = false; }
    });
    this.rsExportButton.addEventListener('click', async () => {
      this.rsExportButton.disabled = true; this.rsStorageError.textContent = '';
      try {
        const snapshot = this.guestData ? null : await this.rs.nextgraph.exportSnapshot();
        const exported = this.guestData ? await this.guestData.export() : {
          filename: 'remotestorage-guest-data.json', type: 'application/json', body: JSON.stringify(snapshot)
        };
        if (!exported || typeof exported.filename !== 'string' || !exported.filename ||
            typeof exported.type !== 'string' || exported.body === undefined) {
          throw new TypeError('Guest export requires a filename, type and body');
        }
        const url = URL.createObjectURL(new Blob([exported.body], {type:exported.type}));
        const link = document.createElement('a'); link.href = url; link.download = exported.filename; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        this.rsStorageError.textContent = snapshot
          ? 'Exported ' + snapshot.records.length + ' documents. Keep this file until import succeeds.'
          : 'Exported guest data from this app. Keep this file until import succeeds.';
      } catch (error) { this.rsStorageError.textContent = error.message || String(error); }
      finally { this.rsExportButton.disabled = false; }
    });
    this.rsImport.querySelector('.rs-show-conflicts').addEventListener('click', () => this.showNextGraphConflicts());
    this.rsImport.querySelector('input').addEventListener('change', async event => {
      const input = event.target, message = this.rsImport.querySelector('[role=status]');
      const file = input.files[0]; if (!file) return;
      input.disabled = true; message.textContent = 'Importing…';
      try {
        if (this.guestData) {
          const result = await this.guestData.import(file);
          message.textContent = result?.message || 'Imported guest data into this app. Keep your export file.';
          return;
        }
        if (file.size > 50 * 1024 * 1024) throw new Error('Import files must be smaller than 50 MiB.');
        const results = await this.rs.nextgraph.importSnapshot(JSON.parse(await file.text()));
        const imported = results.filter(item => item.statusCode === 201).length;
        message.textContent = 'Imported ' + imported + ' of ' + results.length + ' documents. Existing documents were kept. Keep your export file.';
        this.rs.startSync();
      } catch (error) { message.textContent = error.message || String(error); }
      finally { input.disabled = false; input.value = ''; }
    });

    // Choose RS button
    this.rsChooseRemoteStorageButton.addEventListener('click', () => {
      this.setState('sign-in');
      this.rsAddressInput.focus();
    });

    // Choose Dropbox button
    this.rsChooseDropboxButton.addEventListener('click', () => this.rs["dropbox"].connect() );

    // Choose Google Drive button
    this.rsChooseGoogleDriveButton.addEventListener('click', () => this.rs["googledrive"].connect() );

    this.rsChooseLWSButton.addEventListener('click', () => {
      this.setState('lws'); this.rsLWSForm.elements['rs-lws-address'].focus();
    });
    this.parentContainerEl.querySelector('.rs-lws-back').addEventListener('click', () => this.showChooseOrSignIn());
    this.rsChooseOneDriveButton.addEventListener('click', async () => {
      this.rsChooseOneDriveButton.disabled = true; this.rsStorageError.textContent = '';
      try { await this.rs.onedrive.connect(); }
      catch (error) { this.rsStorageError.textContent = error.message || String(error); }
      finally { this.rsChooseOneDriveButton.disabled = false; }
    });

    // Choose Solid button
    this.rsChooseSolidButton.addEventListener('click', () => {
      this.setState('solid');
      if (this.solidProviders.allowAnyProvider) this.rsProviderInput.focus();
    });

    for (let i = 0; i < this.rsSolidOptions.length; i++) {
      this.rsSolidOptions[i].addEventListener('click', () => {
        this.connectSolid(this.solidProviders.providers[i].authURL);
      });
    }

    // Disconnect button
    this.rsDisconnectButton.addEventListener('click', () => this.rs.disconnect() );

    this.rsErrorReconnectLink.addEventListener('click', () => this.rs.reconnect() );
    this.rsErrorDisconnectButton.addEventListener('click', () => this.rs.disconnect() );

    // Sync button
    if (this.rs.hasFeature('Sync')) {
      this.rsSyncButton.addEventListener('click', () => {
        if (this.rsSyncButton.classList.contains('rs-rotate')) {
          this.rs.stopSync();
          this.rsSyncButton.classList.remove("rs-rotate");
        } else {
          this.rsConnectedLabel.textContent = 'Synchronizing';
          this.rs.startSync();
          this.rsSyncButton.classList.add("rs-rotate");
        }
      });
    }

    // Reduce to icon only if connected and clicked outside of widget
    this.outsideClick = () => this.close();
    document.addEventListener('click', this.outsideClick);

    // Clicks on the widget stop the above event
    this.rsWidget.addEventListener('click', e => e.stopPropagation() );

    // Click on the logo to toggle the widget's open/close state
    this.rsLogo.addEventListener('click', () => this.toggle() );
  }

  /**
   * Toggle between the widget's open/close state.
   *
   * When then widget is open and in initial state, it will show the backend
   * chooser screen.
   */
  toggle () {
    if (this.closed) {
      this.open();
    } else {
      if (this.state === 'initial') {
        this.showChooseOrSignIn();
      } else {
        this.close();
      }
    }
  }

  /**
   * Open the widget.
   */
  open () {
    this.closed = false;
    this.rsWidget.classList.remove('rs-closed');
    this.shouldCloseWhenSyncDone = false; // prevent auto-closing when user opened the widget

    let selected = this.parentContainerEl.querySelector('.rs-box.rs-selected');
    if (selected) {
      selected.setAttribute('aria-hidden', 'false');
    }
  }

  /**
   * Close the widget to only show the icon.
   *
   * If the ``leaveOpen`` config is true or there is no storage connected,
   * the widget will not close.
   */
  close () {
    if (this.destroyed) return;
    // don't do anything when we have an error
    if (this.state === 'error') { return; }

    if (!this.leaveOpen && this.active) {
      this.closed = true;
      this.rsWidget.classList.add('rs-closed');
      let selected = this.parentContainerEl.querySelector('.rs-box.rs-selected');
      if (selected) {
        selected.setAttribute('aria-hidden', 'true');
      }
    } else if (this.active) {
      this.setState('connected');
    } else {
      this.setInitialState();
    }

    if (this.rsWidget.classList.contains('rs-modal')) {
      this.rsBackdrop.classList.remove('visible');
      setTimeout(() => {
        this.rsBackdrop.style.display = 'none';
      }, 300);
    }
  }

  /**
   * Disable the connect button and indicate connect activity
   *
   * @private
   */
  disableConnectButton () {
    this.rsConnectButton.disabled = true;
    this.rsConnectButton.classList.add('rs-connecting');
    const circleSpinner = circleOpenSvg;
    this.rsConnectButton.innerHTML = `Connecting ${circleSpinner}`;
  }

  /**
   * Disable the Solid connect button and indicate connect activity
   *
   * @private
   */
  disableSolidConnectButton () {
    this.rsSolidConnectButton.disabled = true;
    this.rsSolidConnectButton.classList.add('rs-connecting');
    const circleSpinner = circleOpenSvg;
    this.rsSolidConnectButton.innerHTML = `Connecting ${circleSpinner}`;
  }

  /**
   * (Re)enable the connect button and reset to original state
   *
   * @private
   */
  enableConnectButton () {
    this.rsConnectButton.disabled = false;
    this.rsConnectButton.textContent = 'Connect';
    this.rsConnectButton.classList.remove('rs-connecting');
  }

  /**
   * Mark the widget as offline.
   *
   * This will not do anything when no account is connected.
   *
   * @private
   */
  setOffline () {
    if (this.online) {
      this.rsWidget.classList.add('rs-offline');
      this.rsConnectedLabel.textContent = 'Offline';
      this.online = false;
    }
  }

  /**
   * Mark the widget as online.
   *
   * @private
   */
  setOnline () {
    if (!this.online) {
      this.rsWidget.classList.remove('rs-offline');
      if (this.active) {
        this.rsConnectedLabel.textContent = 'Connected';
      }
    }
    this.online = true;
  }

  /**
   * Set the remoteStorage backend type to show the appropriate icon.
   * If no backend is given, all existing backend CSS classes will be removed.
   *
   * @param {string} [backend]
   *
   * @private
   */
  setBackendClass (backend) {
    this.rsWidget.classList.remove('rs-backend-remotestorage');
    this.rsWidget.classList.remove('rs-backend-dropbox');
    this.rsWidget.classList.remove('rs-backend-googledrive');
    this.rsWidget.classList.remove('rs-backend-solid', 'rs-backend-lws', 'rs-backend-onedrive', 'rs-backend-nextgraph', 'rs-backend-atomic');

    if (backend) {
      this.rsWidget.classList.add(`rs-backend-${backend}`);
    }
  }

  showErrorBox (errorMsg) {
    this.rsErrorBox.textContent = errorMsg;
    this.setState('error');
  }

  hideErrorBox () {
    this.rsErrorBox.innerHTML = '';
    this.close();
  }

  handleSyncStarted () {
    this.syncInProgress = true;
    this.rsSyncButton.classList.add("rs-rotate");
    setTimeout(() => {
      if (!this.syncInProgress) return;
      this.rsConnectedLabel.textContent = 'Synchronizing';
    }, 1000);
  }

  handleDiscoveryError (error) {
    let msgContainer = this.parentContainerEl.querySelector('.rs-sign-in-error');
    msgContainer.textContent = error.message;
    msgContainer.classList.remove('rs-hidden');
    msgContainer.classList.add('rs-visible');
    this.enableConnectButton();
  }

  handleSyncError (error) {
    this.setOffline();
  }

  handleUnauthorized (error) {
    if (error.code && error.code === 'access_denied') {
      this.rs.disconnect();
    } else {
      this.open();
      this.showErrorBox(error.message + " ");
      this.rsErrorBox.appendChild(this.rsErrorReconnectLink);
      this.rsErrorReconnectLink.classList.remove('rs-hidden');
    }
  }

  handleNoPod () {
    this.open();
    this.showErrorBox('This account has no pods.');
    this.rsErrorBox.appendChild(this.rsErrorDisconnectButton);
    this.rsErrorDisconnectButton.classList.remove('rs-hidden');
  }

  updateLastSyncedStatus () {
    if (this.rs.backend === 'nextgraph') {
      this.rsConnectedLabel.textContent = this.rs.nextgraph.deliveryState === 'needs-attention' ? 'Needs attention' : 'Saved on this device';
      return;
    }
    const now = new Date();
    if (this.online) {
      this.lastSynced = now;
      this.rsConnectedLabel.textContent = 'Synced';
    } else {
      if (!this.rsWidget.classList.contains('rs-state-unauthorized')) {
        this.rsConnectedLabel.textContent = 'Offline';
      }
    }
  }

  isSmallScreen () {
    return window.innerWidth < 421;
  }
}

Widget.SOLID_COMMUNITY = {
  name: 'Solid Community',
  authURL: 'https://solidcommunity.net'
};

Widget.INRUPT = {
  name: 'Inrupt',
  authURL: 'https://login.inrupt.com'
};

export default Widget;
