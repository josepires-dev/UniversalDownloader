const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const contentScript = fs.readFileSync(
    path.join(__dirname, '..', 'instagram-content.js'),
    'utf8'
);
const HOST_TAG = 'ud-instagram-download';

class FakeElement {
    constructor(tagName, options = {}) {
        this.tagName = tagName.toLowerCase();
        this.parentElement = null;
        this.children = [];
        this.dataset = {};
        this.attributes = {};
        this.style = { cssText: '' };
        this.listeners = {};
        this.href = options.href || '';
        this.rect = options.rect || { left: 0, top: 0, right: 800, bottom: 700 };
        this.textContent = '';
        this.disabled = false;
        this.shadowRoot = null;
        this._innerHTML = '';
        this._classes = new Set();
        this.classList = {
            toggle: (cls, force) => { if (force) this._classes.add(cls); else this._classes.delete(cls); },
            add: (cls) => this._classes.add(cls),
            remove: (cls) => this._classes.delete(cls),
            contains: (cls) => this._classes.has(cls),
        };
    }

    get isConnected() {
        let node = this;
        while (node.parentElement) node = node.parentElement;
        return node.tagName === 'html';
    }

    get innerHTML() { return this._innerHTML; }
    set innerHTML(html) {
        this._innerHTML = html;
        this.children = [];
        const tagRe = /<(button|div|a)\b[^>]*>/gi;
        let m;
        while ((m = tagRe.exec(html)) !== null) {
            const el = new FakeElement(m[1]);
            const roleMatch = m[0].match(/role="([^"]+)"/);
            if (roleMatch) el.attributes.role = roleMatch[1];
            const clsMatch = m[0].match(/class="([^"]+)"/);
            if (clsMatch) el._parsedClass = clsMatch[1];
            el.parentElement = this;
            this.children.push(el);
        }
    }

    append(...nodes) {
        for (const node of nodes) {
            node.parentElement = this;
            this.children.push(node);
        }
    }

    remove() {
        if (!this.parentElement) return;
        this.parentElement.children = this.parentElement.children
            .filter((child) => child !== this);
        this.parentElement = null;
    }

    setAttribute(name, value) {
        this.attributes[name] = String(value);
    }

    hasAttribute(name) {
        return Object.hasOwn(this.attributes, name);
    }

    getAttribute(name) {
        if (name === 'href') return this.href || null;
        return this.attributes[name] ?? null;
    }

    addEventListener(name, callback) {
        this.listeners[name] = callback;
    }

    closest(selector) {
        let current = this;
        while (current) {
            if (selector === 'article' && current.tagName === 'article') return current;
            current = current.parentElement;
        }
        return null;
    }

    attachShadow() {
        this.shadowRoot = new FakeElement('#shadow-root');
        return this.shadowRoot;
    }

    setPointerCapture() {}

    querySelector(selector) {
        return this.querySelectorAll(selector)[0] || null;
    }

    querySelectorAll(selector) {
        const parts = selector.split(',').map(s => s.trim());
        const matches = [];
        const visit = (node) => {
            for (const child of node.children) {
                let matched = false;
                for (const part of parts) {
                    if (part === HOST_TAG && child.tagName === HOST_TAG) matched = true;
                    else if (part === 'video' && child.tagName === 'video') matched = true;
                    else if (part === 'img' && child.tagName === 'img') matched = true;
                    else if (part === '[role="status"]' && child.attributes.role === 'status') matched = true;
                    else if (part === 'button' && child.tagName === 'button') matched = true;
                    else if (part === 'a[href]' && child.tagName === 'a' && child.href) matched = true;
                    else if (part === 'article' && child.tagName === 'article') matched = true;
                    else if (part.startsWith('.') && child._parsedClass === part.slice(1)) matched = true;
                    if (matched) break;
                }
                if (matched) matches.push(child);
                visit(child);
            }
        };
        visit(this);
        return matches;
    }

    contains(other) {
        let node = other;
        while (node) {
            if (node === this) return true;
            node = node.parentElement;
        }
        return false;
    }

    getBoundingClientRect() {
        return {
            ...this.rect,
            width: this.rect.right - this.rect.left,
            height: this.rect.bottom - this.rect.top
        };
    }
}

function createHarness(pathname, setup) {
    const body = new FakeElement('body');
    const root = new FakeElement('html');
    root.clientWidth = 1200;
    root.clientHeight = 800;
    root.append(body);

    const document = {
        body,
        documentElement: root,
        createElement: (tagName) => new FakeElement(tagName),
        querySelectorAll: (selector) => root.querySelectorAll(selector)
    };
    const location = {
        origin: 'https://www.instagram.com',
        pathname,
        href: `https://www.instagram.com${pathname}`
    };
    const listeners = new Map();
    const window = {
        innerWidth: 1200,
        innerHeight: 800,
        addEventListener: (name, callback) => listeners.set(name, callback),
        clearTimeout: () => {},
        setTimeout: (callback) => {
            callback();
            return 1;
        }
    };
    const chrome = {
        runtime: {
            onMessage: { addListener: () => {} },
            sendMessage: async (message) => {
                sentMessages.push(message);
                return { ok: true, filename: 'download.zip' };
            }
        },
        storage: {
            local: {
                get: () => Promise.resolve({}),
                set: () => Promise.resolve()
            }
        }
    };
    const sentMessages = [];
    let mutationCallback;
    class FakeMutationObserver {
        constructor(callback) {
            mutationCallback = callback;
        }

        observe() {}
    }

    setup?.({ body, root, document, location });
    vm.runInNewContext(contentScript, {
        document,
        location,
        window,
        chrome,
        MutationObserver: FakeMutationObserver,
        getComputedStyle: (el) => {
            const ov = el._overflowStyle || 'visible';
            return { overflow: ov, overflowX: ov, overflowY: ov };
        },
        requestAnimationFrame: (cb) => { cb(); return 1; },
        innerHeight: 800,
        Math,
        String,
        Object,
        RegExp,
        console,
        URL,
        Date,
        Error,
        Set,
        Map
    });

    // Find the host element in the tree
    const findHost = () => root.querySelectorAll(HOST_TAG);

    return {
        body,
        document,
        root,
        location,
        hosts: findHost,
        sentMessages,
        rescan: () => mutationCallback?.([{ target: body }])
    };
}

function addAnchor(parent, href) {
    const anchor = new FakeElement('a', { href });
    parent.append(anchor);
    return anchor;
}

// ---------- Tests ----------

test('feed: creates a single fixed-position host element for a post with media', () => {
    const harness = createHarness('/', ({ body }) => {
        const article = new FakeElement('article', {
            rect: { left: 200, top: 80, right: 900, bottom: 720 }
        });
        article.append(new FakeElement('img'));
        body.append(article);
        addAnchor(article, '/p/post-123/');
    });

    const hosts = harness.hosts();
    assert.equal(hosts.length, 1);
    // The host is appended to documentElement, positioned fixed
    assert.match(hosts[0].style.cssText, /position:fixed/);
    assert.match(hosts[0].style.cssText, /left:/);

    // Re-scanning should not create duplicates
    harness.rescan();
    assert.equal(harness.hosts().length, 1);
});

test('feed: nested comment articles do not create extra buttons', () => {
    const harness = createHarness('/', ({ body }) => {
        const article = new FakeElement('article');
        article.append(new FakeElement('img'));
        body.append(article);
        addAnchor(article, '/p/post-123/');
        const comments = new FakeElement('div');
        article.append(comments);
        const comment = new FakeElement('article');
        comments.append(comment);
        comment.append(new FakeElement('img'));
        addAnchor(comment, '/p/post-123/');
    });

    // Only one host, not one per article
    assert.equal(harness.hosts().length, 1);
});

test('standalone post page shows one button', () => {
    const harness = createHarness('/p/post-456/', ({ body }) => {
        const article = new FakeElement('article');
        body.append(article);
        addAnchor(article, '/p/post-456/');
    });

    assert.equal(harness.hosts().length, 1);
    assert.match(harness.hosts()[0].style.cssText, /position:fixed/);

    harness.rescan();
    assert.equal(harness.hosts().length, 1);
});

test('individual Reels URL shows one button and downloads that URL', async () => {
    const reelUrl = 'https://www.instagram.com/reels/DdnACMMuMd6/';
    const harness = createHarness('/reels/DdnACMMuMd6/');

    assert.equal(harness.hosts().length, 1);
    assert.match(harness.hosts()[0].style.cssText, /position:fixed/);

    // Click the download button inside the shadow DOM
    const btn = harness.hosts()[0].shadowRoot.querySelector('button');
    assert.ok(btn, 'button should exist in shadow DOM');
    await btn.listeners.click();
    assert.equal(harness.sentMessages.length, 1);
    assert.ok(harness.sentMessages[0].payload.url.includes('DdnACMMuMd6'));
});

test('Reels tab with video creates one button', () => {
    const harness = createHarness('/reels/', ({ body }) => {
        const container = new FakeElement('div');
        body.append(container);
        container.append(new FakeElement('video'));
        addAnchor(container, '/reel/reel-789/');
    });

    assert.equal(harness.hosts().length, 1);
    assert.match(harness.hosts()[0].style.cssText, /position:fixed/);
});

test('Story URL shows one button', () => {
    const harness = createHarness('/stories/person/12345/');

    assert.equal(harness.hosts().length, 1);
    assert.match(harness.hosts()[0].style.cssText, /position:fixed/);
});

test('clipToOverflow: hides off-screen carousel slide and selects visible one', () => {
    // Simulate a carousel with overflow:hidden container
    // Visible slide is within the container, hidden slide is scrolled out
    const harness = createHarness('/', ({ body }) => {
        const article = new FakeElement('article');
        body.append(article);
        addAnchor(article, '/p/carousel-1/');

        // Carousel container with overflow:hidden
        const carousel = new FakeElement('div', {
            rect: { left: 200, top: 100, right: 700, bottom: 600 }
        });
        carousel._overflowStyle = 'hidden';
        article.append(carousel);

        // Visible slide (within carousel bounds)
        const visibleImg = new FakeElement('img', {
            rect: { left: 200, top: 100, right: 700, bottom: 600 }
        });
        carousel.append(visibleImg);

        // Hidden slide (scrolled off to the right, outside carousel bounds)
        const hiddenImg = new FakeElement('img', {
            rect: { left: 700, top: 100, right: 1200, bottom: 600 }
        });
        carousel.append(hiddenImg);
    });

    // Should have a host
    assert.equal(harness.hosts().length, 1);
    const css = harness.hosts()[0].style.cssText;
    assert.match(css, /position:fixed/);
    // The button left position should be based on the visible image (right=700),
    // not the hidden one (right=1200)
    const leftMatch = css.match(/left:(\d+)px/);
    assert.ok(leftMatch, 'should have left position');
    const left = parseInt(leftMatch[1]);
    // Button should be near the right edge of visible image (700 - 44 - 12 = 644)
    assert.ok(left < 700, `left (${left}) should be less than 700 (visible image right edge)`);
});
