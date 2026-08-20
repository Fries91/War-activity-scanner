// ==UserScript==
// @name         WRATH War Intelligence - Auto Update
// @namespace    fries91.torn.prewarintel
// @version      3.5.0
// @description  WRATH War Intelligence with exact war selection, stable Torn header spy icon, and automatic updates.
// @author       Fries91
// @match        https://www.torn.com/*
// @match        https://torn.com/*
// @icon         https://www.torn.com/favicon.ico
// @updateURL    https://raw.githubusercontent.com/Fries91/War-activity-scanner/main/war-activity-scanner.user.js
// @downloadURL  https://raw.githubusercontent.com/Fries91/War-activity-scanner/main/war-activity-scanner.user.js
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      raw.githubusercontent.com
// @connect      api.torn.com
// @run-at       document-idle
// ==/UserScript==

(async () => {
  'use strict';
  if (window.top !== window.self) return;

  const VERSION = '3.5.0';
  const CACHE_KEY = `wrath-war-intel-payload-${VERSION}`;
  const BASE = 'https://raw.githubusercontent.com/Fries91/War-activity-scanner/main/';
  const PARTS = [1,2,3,4,5].map(n => `${BASE}war-activity-scanner.v3.5.payload.${n}.txt?v=${VERSION}`);

  function getText(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET', url, timeout: 20000,
        onload: r => r.status >= 200 && r.status < 300 ? resolve(r.responseText || '') : reject(new Error(`Payload HTTP ${r.status}`)),
        onerror: () => reject(new Error('Could not download WRATH War Intelligence payload.')),
        ontimeout: () => reject(new Error('WRATH War Intelligence payload request timed out.'))
      });
    });
  }

  try {
    let b64 = GM_getValue(CACHE_KEY, '');
    if (!b64 || b64.length < 25000) {
      const pieces = await Promise.all(PARTS.map(getText));
      b64 = pieces.join('').replace(/\s+/g, '');
      if (b64.length < 25000) throw new Error('Downloaded payload was incomplete.');
      GM_setValue(CACHE_KEY, b64);
    }

    if (typeof DecompressionStream !== 'function') throw new Error('This TornPDA/WebView version does not support script decompression.');
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    const code = await new Response(stream).text();
    (0, eval)(code);
  } catch (err) {
    console.error('WRATH War Intelligence failed to start:', err);
    alert(`WRATH War Intelligence could not start.\n\n${err?.message || err}`);
  }
})();
